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
import { setMemberModel, MODEL_CHOICES } from '../setup.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(here, '..', '..', 'ui');
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', '..', 'package.json'), 'utf8')).version;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

// CLI operations HQ accepts from `npx madcompany ...` (header-gated, see guard()).
const CLI_OPS = new Set(['status', 'startDay', 'requestEndDay', 'stopNow', 'endDay', 'createTicket', 'updateTicket', 'assign', 'markMerged', 'reopen', 'post', 'canMerge', 'epicBranch', 'integrationEnv', 'ticket', 'decide', 'dashboard', 'env']);

export function createHq({ paths, port = 4317, quiet = false }) {
  const config = loadConfig(paths);
  const store = new Store(paths.events);
  const core = createCore({ store, config, paths });
  const notices = createNotices(core);
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

  const origin = () => [`http://127.0.0.1:${actualPort()}`, `http://localhost:${actualPort()}`];
  let server;
  const actualPort = () => server?.address()?.port ?? port;

  function guard(req, res, { widget = false, cli = false } = {}) {
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return deny(res, 421, 'Wrong host');
    const o = req.headers.origin;
    if (cli && req.headers['x-madcompany-cli'] !== '1') return deny(res, 403, 'CLI only');
    if (!o) return true;
    if (origin().includes(o)) return true;
    if (widget && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)) return true;
    return deny(res, 403, 'Cross-origin request refused');
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    if (p === '/api/feedback' && req.method === 'OPTIONS') {
      if (!guard(req, res, { widget: true })) return;
      res.writeHead(204, { 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', vary: 'Origin' });
      return res.end();
    }
    if (!guard(req, res, { widget: p === '/api/feedback' || p === '/widget.js', cli: p === '/api/cli' })) return;

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
      if (p === '/api/health') return json(res, 200, { ok: true, version: VERSION, project: config.project, root: paths.root });
      if (p === '/api/state') return json(res, 200, snapshot());
      if (p === '/api/ids') return json(res, 200, registry());
      if (p === '/api/file') return fileView(res, url.searchParams.get('path') ?? '');
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
        if (!abs || isHiddenPath(rel) || !MIME[path.extname(abs).toLowerCase()]?.startsWith('image/')) return json(res, 404, { error: 'Not found' });
        return sendFile(res, abs);
      }
      if (p === '/widget.js') return sendFile(res, path.join(UI_DIR, 'widget.js'), { 'access-control-allow-origin': '*' });
      if (p === '/' || p === '/index.html') return sendFile(res, path.join(UI_DIR, 'index.html'));
      if (/^\/[a-z-]+\.(js|css|svg)$/.test(p)) return sendFile(res, path.join(UI_DIR, p.slice(1)));
      return json(res, 404, { error: 'Not found' });
    }

    if (req.method === 'POST') {
      const body = await readJson(req);
      if (p === '/api/messages') return ok(res, () => core.post('you', { channel: body.channel, text: body.text }));
      if (p === '/api/answer') return ok(res, () => core.answer('you', body.q, body.answer));
      if (p === '/api/change') return ok(res, () => core.change({ text: body.text }));
      if (p === '/api/team/model') {
        return ok(res, () => {
          const out = setMemberModel(paths, body.id, body.model);
          config.team.find((m) => m.id === out.id).model = out.model;
          store.append('team.model', 'you', { agent: out.id, model: out.model });
          return out;
        });
      }
      if (p === '/api/workday') {
        const fn = { end: core.requestEndDay, stop: core.stopNow }[body.action];
        if (!fn) return json(res, 400, { error: 'action must be end or stop' });
        return ok(res, () => fn('you'));
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
      config: { project: config.project, owner: config.owner, lead: config.leadId, preview: config.preview, max_parallel: config.max_parallel, models: MODEL_CHOICES },
      tickets: s.tickets,
      messages: s.messages.slice(-2000),
      decisions: s.decisions,
      questions: s.questions,
      facts: s.facts,
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

  function fileView(res, rel) {
    rel = rel.replace(/^\/+/, '');
    const abs = safeJoin(paths.root, rel);
    if (!abs || isHiddenPath(rel)) return json(res, 403, { error: 'Not allowed' });
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return json(res, 404, { error: `No file ${rel}` });
    // a symlink inside the project must not reveal files outside it
    if (!safeJoin(fs.realpathSync(paths.root), path.relative(fs.realpathSync(paths.root), fs.realpathSync(abs)))) return json(res, 403, { error: 'Not allowed' });
    const size = fs.statSync(abs).size;
    if (MIME[path.extname(abs).toLowerCase()]?.startsWith('image/')) return json(res, 200, { path: rel, kind: 'image', src: `/raw/${encodeURI(rel)}` });
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
        server.listen(port, '127.0.0.1', () => {
          ensureDir(paths.run);
          fs.writeFileSync(paths.lock, JSON.stringify({ pid: process.pid, port: actualPort(), started: new Date().toISOString() }));
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
