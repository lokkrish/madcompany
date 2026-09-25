import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McError, loadConfig } from '../config.js';
import { ensureDir, isHiddenPath, safeJoin } from '../paths.js';
import { buildRegistry, hqEntries, writeRegistry } from '../refs/ids.js';
import { Store, describeEvent } from './store.js';
import { createCore } from './core.js';
import { createNotices } from './notices.js';
import { createViewWriter } from './views.js';
import { buildMcpServer } from './mcp.js';
import { renderCode, renderMarkdown } from './render.js';
import { setMemberModel, MODEL_CHOICES, hireMember, removeMember, addPerson, removePerson } from '../setup.js';
import { ROLES, TEMPLATES, DEPARTMENTS } from '../roles.js';
import { createAccess, readCookie } from '../auth.js';
import { createLibrary } from './library.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(here, '..', '..', 'ui');
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')).version;
const RAW = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.html', '.htm', '.pdf']);
const MIME = { '.pdf': 'application/pdf', '.htm': 'text/html; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

// CLI operations HQ accepts from `npx madcompany ...` (header-gated, see guard()).
const CLI_OPS = new Set(['status', 'startDay', 'requestEndDay', 'stopNow', 'endDay', 'createTicket', 'updateTicket', 'assign', 'markMerged', 'reopen', 'post', 'canMerge', 'epicBranch', 'integrationEnv', 'ticket', 'decide', 'dashboard', 'env', 'minutes', 'addLink']);

export function createHq({ paths, port = 4317, quiet = false, share = false, bind = null }) {
  const config = loadConfig(paths);
  const store = new Store(paths.events);
  const core = createCore({ store, config, paths });
  const notices = createNotices(core);
  const library = createLibrary({ paths, config, store });
  // Claude artifacts published while HQ was off were queued by the hook
  const pending = path.join(paths.run, 'pending-links.jsonl');
  if (fs.existsSync(pending)) {
    for (const line of fs.readFileSync(pending, 'utf8').split('\n')) {
      try {
        if (line.trim()) core.addLink('cli', JSON.parse(line));
      } catch {
        // skip a bad line
      }
    }
    fs.rmSync(pending, { force: true });
  }
  let fileRegistry = {};
  const refreshRegistry = () => {
    fileRegistry = buildRegistry(paths.root);
    writeRegistry(paths.ids, fileRegistry);
  };
  const registry = () => ({ ...fileRegistry, ...hqEntries(store.state) });
  const views = createViewWriter(core, { onWritten: refreshRegistry });
  views.flush();
  writePolicy(paths, config);

  const sse = new Set();
  let sseTimer = null;
  store.on('event', () => {
    if (sseTimer) return;
    sseTimer = setTimeout(() => {
      sseTimer = null;
      for (const res of sse) res.write(`event: change\ndata: ${store.state.seq}\n\n`);
    }, 120);
  });

  let server;
  const actualPort = () => server?.address()?.port ?? port;
  const access = createAccess(paths);
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
  // a tunnel on this machine (ngrok, cloudflared…) connects from loopback too, and may
  // rewrite Host to localhost, so anything that came through a proxy is not local
  const PROXIED = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'cf-connecting-ip'];
  const fromThisMachine = (req) =>
    LOOPBACK.has(req.socket.remoteAddress) && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host ?? '') && !PROXIED.some((h) => h in req.headers);
  const OWNER = () => ({ id: 'you', name: config.owner, role: 'owner' });
  const LEVEL = { viewer: 1, member: 2, owner: 3 };

  /** Who is asking. Locally that's you; in shared mode everyone signs in with their link. */
  function whoIs(req) {
    if (!share && fromThisMachine(req)) return OWNER();
    const person = access.verify(readCookie(req, 'mc_auth'));
    if (!person) return null;
    if (person === 'you') return OWNER();
    const p = config.people.find((x) => x.id === person);
    return p ? { id: p.id, name: p.name, role: p.role } : null;
  }

  function guard(req, res, { widget = false, local = false } = {}) {
    const host = req.headers.host ?? '';
    // agents, the CLI and the feedback widget only ever talk to HQ from this machine
    if (local && !fromThisMachine(req)) return deny(res, 403, 'Only from this machine');
    if (!share && !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return deny(res, 421, 'Wrong host');
    const o = req.headers.origin;
    if (!o) return true;
    const same = share ? [`http://${host}`, `https://${host}`] : [`http://127.0.0.1:${actualPort()}`, `http://localhost:${actualPort()}`];
    if (same.includes(o)) return true;
    if (widget && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return true;
    return deny(res, 403, 'Cross-origin request refused');
  }

  // team.yaml edited outside HQ (CLI, your editor): pick it up on the next request
  let teamMtime = fs.statSync(paths.team).mtimeMs;
  function maybeReload() {
    try {
      const m = fs.statSync(paths.team).mtimeMs;
      if (m !== teamMtime) {
        teamMtime = m;
        refreshTeam();
      }
    } catch {
      // mid-write or invalid: keep the last good team
    }
  }

  function refreshTeam() {
    const fresh = loadConfig(paths);
    teamMtime = fs.statSync(paths.team).mtimeMs;
    config.team.splice(0, config.team.length, ...fresh.team);
    config.people.splice(0, config.people.length, ...fresh.people);
    config.leadId = fresh.leadId;
    config.max_parallel = fresh.max_parallel;
  }
  const busyAgents = () => [...new Set(Object.values(store.state.tickets).filter((t) => ['in_progress', 'blocked', 'in_review'].includes(t.status)).map((t) => t.assignee))];

  async function handle(req, res) {
    maybeReload();
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/api/feedback' && req.method === 'OPTIONS') {
      if (!guard(req, res, { widget: true, local: true })) return;
      res.writeHead(204, { 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', vary: 'Origin' });
      return res.end();
    }
    const localOnly = ['/mcp', '/api/cli', '/api/refresh-ids', '/api/feedback', '/widget.js'].includes(p);
    if (!guard(req, res, { widget: p === '/api/feedback' || p === '/widget.js', local: localOnly })) return;
    if (p === '/api/cli' && req.headers['x-madcompany-cli'] !== '1') return deny(res, 403, 'CLI only');

    // the app shell and sign-in need no identity; everything with data does
    const isStatic = req.method === 'GET' && (p === '/' || p === '/index.html' || /^\/[a-z-]+\.(js|css|svg)$/.test(p));
    if (p === '/api/login' && req.method === 'POST') {
      const body = await readJson(req);
      const person = access.verify(body.token);
      const known = person === 'you' || config.people.some((x) => x.id === person);
      if (!person || !known) return json(res, 401, { error: 'That sign-in link is not valid any more. Ask the owner for a new one.' });
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('set-cookie', `mc_auth=${encodeURIComponent(body.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${secure}`);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      res.setHeader('set-cookie', 'mc_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
      return json(res, 200, { ok: true });
    }
    const who = localOnly || isStatic || p === '/api/health' ? null : whoIs(req);
    if (!localOnly && !isStatic && p !== '/api/health' && !who) return json(res, 401, { error: 'Sign in with your link from the HQ owner.', share });
    const need = (level) => (LEVEL[who?.role] ?? 0) >= level || (deny(res, 403, level === 3 ? 'Only an owner can do that.' : 'Viewers can read but not change anything.'), false);

    if (p === '/mcp') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Use POST' });
      const body = await readJson(req);
      const mcp = buildMcpServer({ core, notices, registry, version: VERSION });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET') {
      if (p === '/api/health') return json(res, 200, { ok: true, version: VERSION, project: config.project, ...(share ? { share: true } : { root: paths.root }) });
      if (p === '/api/me') return json(res, 200, { ...who, share });
      if (p === '/api/roles') return json(res, 200, { roles: ROLES, templates: TEMPLATES, departments: DEPARTMENTS });
      if (p === '/api/people') return json(res, 200, { people: [{ ...OWNER(), hasLink: access.hasLink('you') }, ...config.people.map((x) => ({ ...x, hasLink: access.hasLink(x.id) }))] });
      if (p === '/api/state') return json(res, 200, snapshot());
      if (p === '/api/ids') return json(res, 200, registry());
      if (p === '/api/file') return fileView(res, url.searchParams.get('path') ?? '');
      if (p === '/api/library') return json(res, 200, library.overview());
      if (p === '/api/search') return json(res, 200, { q: url.searchParams.get('q') ?? '', results: library.search(url.searchParams.get('q')) });
      if (p.startsWith('/api/session/')) {
        const sess = library.session(decodeURIComponent(p.slice(13)));
        return sess ? json(res, 200, sess) : json(res, 404, { error: 'No such conversation' });
      }
      if (p.startsWith('/api/memory/')) return json(res, 200, core.memoryRead(decodeURIComponent(p.slice(12))));
      if (p === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`event: change\ndata: ${store.state.seq}\n\n`);
        sse.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => {
          clearInterval(ping);
          sse.delete(res);
        });
        return;
      }
      if (p.startsWith('/shots/')) return sendFile(res, path.join(paths.shots, path.basename(p)));
      if (p.startsWith('/raw/')) {
        const rel = decodeURIComponent(p.slice(5));
        const abs = safeJoin(paths.root, rel);
        const ext = path.extname(abs ?? '').toLowerCase();
        if (!abs || isHiddenPath(rel) || !RAW.has(ext) || !insideRoot(abs)) return json(res, 404, { error: 'Not found' });
        // mockups and SVGs run sandboxed: they can't reach HQ's API or your cookies
        const sandbox = ['.html', '.htm', '.svg'].includes(ext) ? { 'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups' } : {};
        return sendFile(res, abs, sandbox);
      }
      if (p === '/widget.js') return sendFile(res, path.join(UI_DIR, 'widget.js'), { 'access-control-allow-origin': '*' });
      if (p === '/' || p === '/index.html') return sendFile(res, path.join(UI_DIR, 'index.html'));
      if (/^\/[a-z-]+\.(js|css|svg)$/.test(p)) return sendFile(res, path.join(UI_DIR, p.slice(1)));
      return json(res, 404, { error: 'Not found' });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (p === '/api/messages') return need(2) && ok(res, () => core.post(who.id, { channel: body.channel, text: body.text }));
      if (p === '/api/answer') return need(2) && ok(res, () => core.answer(who.id, body.q, body.answer));
      if (p === '/api/change') return need(2) && ok(res, () => core.change({ text: body.text }, who.id));
      if (p === '/api/links') return need(2) && ok(res, () => core.addLink(who.id, body));
      if (p === '/api/team/model') {
        return need(3) && ok(res, () => {
          const out = setMemberModel(paths, body.id, body.model);
          config.team.find((m) => m.id === out.id).model = out.model;
          store.append('team.model', who.id, { agent: out.id, model: out.model });
          return out;
        });
      }
      if (p === '/api/team/hire') {
        return need(3) && ok(res, () => {
          const out = hireMember(paths, body);
          refreshTeam();
          store.append('team.hire', who.id, out);
          return out;
        });
      }
      if (p === '/api/team/remove') {
        return need(3) && ok(res, () => {
          const out = removeMember(paths, body.id, { busy: busyAgents() });
          refreshTeam();
          store.append('team.remove', who.id, out);
          return out;
        });
      }
      if (p === '/api/people') {
        return need(3) && ok(res, () => {
          const person = addPerson(paths, body);
          refreshTeam();
          return { person, link: `/#/login/${access.issue(person.id)}` };
        });
      }
      if (p === '/api/people/link') {
        return need(3) && ok(res, () => {
          if (body.id !== 'you' && !config.people.some((x) => x.id === body.id)) throw new McError(`No person "${body.id}".`);
          return { link: `/#/login/${access.issue(body.id)}` };
        });
      }
      if (p === '/api/people/remove') {
        return need(3) && ok(res, () => {
          removePerson(paths, body.id);
          access.revoke(body.id);
          refreshTeam();
          return { ok: true };
        });
      }
      if (p === '/api/workday') {
        if (!need(3)) return;
        const fn = { end: core.requestEndDay, stop: core.stopNow }[body.action];
        if (!fn) return json(res, 400, { error: 'action must be end or stop' });
        return ok(res, () => fn(who.id));
      }
      if (p === '/api/feedback') {
        res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
        return ok(res, () => core.feedback(body));
      }
      if (p === '/api/cli') {
        if (!CLI_OPS.has(body.op)) return json(res, 400, { error: `Unknown op ${body.op}` });
        return ok(res, () => core[body.op](...(body.args ?? [])));
      }
      if (p === '/api/refresh-ids') return ok(res, () => (refreshRegistry(), { count: Object.keys(fileRegistry).length }));
    }
    return json(res, 404, { error: 'Not found' });
  }

  function snapshot() {
    const s = store.state;
    return {
      seq: s.seq,
      dashboard: core.dashboard(),
      config: { project: config.project, owner: config.owner, lead: config.leadId, preview: config.preview, max_parallel: config.max_parallel, models: MODEL_CHOICES, share },
      people: [OWNER(), ...config.people],
      tickets: s.tickets,
      messages: s.messages.slice(-2000),
      decisions: s.decisions,
      questions: s.questions,
      facts: s.facts,
      minutes: s.minutes,
      links: s.links,
      designs: s.designs,
      epics: s.epics,
      envs: s.envs,
      integration: core.integrationEnv(),
      notices: notices.all().slice(-50),
      recent: store.events
        .slice(-60)
        .map((e) => ({ ts: e.ts, by: e.by, text: describeEvent(e) }))
        .filter((e) => e.text && e.by !== 'cli')
        .slice(-12)
        .reverse(),
    };
  }

  function insideRoot(abs) {
    try {
      const real = fs.realpathSync(abs);
      const base = fs.realpathSync(paths.root);
      return real === base || real.startsWith(base + path.sep);
    } catch {
      return false;
    }
  }

  function fileView(res, rel) {
    rel = rel.replace(/^\/+/, '');
    const abs = safeJoin(paths.root, rel);
    if (!abs || isHiddenPath(rel)) return json(res, 403, { error: 'Not allowed' });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: `No file ${rel}` });
    // a symlink inside the project must not reveal files outside it
    if (!insideRoot(abs)) return json(res, 403, { error: 'Not allowed' });
    const size = fs.statSync(abs).size;
    if (MIME[path.extname(abs).toLowerCase()]?.startsWith('image/')) return json(res, 200, { path: rel, kind: 'image', src: `/raw/${encodeURI(rel)}` });
    if (/\.(html?|pdf)$/i.test(abs)) return json(res, 200, { path: rel, kind: abs.toLowerCase().endsWith('.pdf') ? 'pdf' : 'html', src: `/raw/${encodeURI(rel)}` });
    if (size > 2 * 1024 * 1024) return json(res, 200, { path: rel, kind: 'too-big', size });
    const text = fs.readFileSync(abs, 'utf8');
    if (abs.endsWith('.md')) return json(res, 200, { path: rel, kind: 'markdown', html: renderMarkdown(text, { file: rel, registry: registry() }) });
    return json(res, 200, { path: rel, kind: 'text', html: renderCode(text) });
  }

  server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!quiet) console.error(err);
      if (!res.headersSent) json(res, 500, { error: err.message });
      else res.end();
    });
  });
  server.requestTimeout = 0; // mc_wait can hold a request for minutes

  return {
    core,
    store,
    notices,
    views,
    server,
    registry,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, share ? bind ?? '0.0.0.0' : '127.0.0.1', () => {
          ensureDir(paths.run);
          fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, port: actualPort(), share, started: new Date().toISOString() }));
          resolve(actualPort());
        });
      });
    },
    close() {
      for (const r of sse) r.end();
      try {
        const lock = JSON.parse(fs.readFileSync(paths.lock, 'utf8'));
        if (lock.pid === process.pid) fs.rmSync(paths.lock, { force: true });
      } catch {
        // no lock
      }
      views.flush();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/** Policy the pre-tool hook reads (it runs without loading any dependencies). */
export function writePolicy(paths, config) {
  ensureDir(paths.run);
  fs.writeFileSync(paths.policy, JSON.stringify({ allowPush: Boolean(config.allow_push), root: paths.root }));
}

function deny(res, code, msg) {
  json(res, code, { error: msg });
  return false;
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function ok(res, fn) {
  try {
    return json(res, 200, fn() ?? { ok: true });
  } catch (err) {
    if (err instanceof McError) return json(res, 400, { error: err.message });
    throw err;
  }
}

function sendFile(res, abs, headers = {}) {
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'content-type': MIME[path.extname(abs).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...headers });
  fs.createReadStream(abs).pipe(res);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 5 * 1024 * 1024) throw new McError('Request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new McError('Invalid JSON');
  }
}
