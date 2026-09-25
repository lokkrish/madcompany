import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'node:http';
import { tmpProject } from './helpers.js';
import { parseTeam, loadConfig } from '../src/config.js';
import { applyTemplate, hireMember, removeMember, init } from '../src/setup.js';
import { TEMPLATES } from '../src/roles.js';
import { createHq } from '../src/hq/server.js';
import { createAccess } from '../src/auth.js';

test('role types fill in title, department, domain, model and duties', () => {
  const cfg = parseTeam('team:\n  - id: lead\n  - id: sec\n    type: security-engineer\n  - id: b1\n    type: backend-developer\n    model: haiku\n');
  const sec = cfg.team.find((m) => m.id === 'sec');
  assert.equal(sec.role, 'Security engineer');
  assert.equal(sec.dept, 'Quality');
  assert.equal(sec.profile, 'reviewer');
  assert.equal(sec.model, 'opus');
  assert.ok(sec.duties.length);
  assert.equal(cfg.team.find((m) => m.id === 'b1').model, 'haiku', 'team.yaml wins over role defaults');
  assert.equal(cfg.team[0].dept, 'Leadership');
  assert.throws(() => parseTeam('team:\n  - id: lead\n  - id: x\n    type: wizard\n'), /type "wizard" is unknown/);
  assert.throws(() => parseTeam('team:\n  - id: lead\npeople:\n  - id: lead\n'), /taken/);
});

test('templates staff a 5, 10 or 20-person company', () => {
  assert.deepEqual(Object.values(TEMPLATES).map((t) => t.team.length), [5, 10, 20]);
  const { paths, root } = tmpProject({ git: true });
  init(paths, { log: () => {}, skills: false });
  fs.writeFileSync(paths.team, `# keep me\n${fs.readFileSync(paths.team, 'utf8')}`);
  applyTemplate(paths, 'large', { busy: [] });
  const cfg = loadConfig(paths);
  assert.equal(cfg.team.length, 20);
  assert.equal(cfg.max_parallel, 6);
  const agents = fs.readdirSync(path.join(root, '.claude', 'agents'));
  assert.equal(agents.length, 19, 'everyone but the lead becomes a subagent');
  const sec = fs.readFileSync(path.join(root, '.claude', 'agents', 'mc-security.md'), 'utf8');
  assert.match(sec, /disallowedTools: Edit, Write/);
  assert.match(sec, /## Your role\n\n- Review auth/);
  assert.match(fs.readFileSync(paths.team, 'utf8'), /# keep me/, 'your comments survive');
  assert.throws(() => applyTemplate(paths, 'small', { busy: ['architect'] }), /architect still have tickets/);
  applyTemplate(paths, 'small', { busy: ['architect'], force: true });
  assert.equal(loadConfig(paths).team.length, 5);
});

test('hiring suggests the next id; the lead and busy agents cannot be removed', () => {
  const { paths } = tmpProject({ git: true });
  init(paths, { log: () => {}, skills: false });
  applyTemplate(paths, 'medium', { busy: [] });
  assert.equal(hireMember(paths, { type: 'backend-developer' }).id, 'backend-3');
  assert.equal(hireMember(paths, { type: 'security-engineer', model: 'sonnet' }).id, 'security');
  assert.equal(loadConfig(paths).team.find((m) => m.id === 'security').model, 'sonnet');
  assert.throws(() => hireMember(paths, { type: 'tech-lead' }), /Pick a role/);
  assert.throws(() => removeMember(paths, 'lead'), /lead can't be removed/);
  assert.throws(() => removeMember(paths, 'backend-1', { busy: ['backend-1'] }), /Reassign/);
  removeMember(paths, 'backend-2');
  assert.ok(!loadConfig(paths).team.some((m) => m.id === 'backend-2'));
});

// ---------- multi-user HQ ----------

function call(base, p, { method = 'GET', body, cookie, host, origin, headers: extra = {} } = {}) {
  const u = new URL(p, base);
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', ...extra };
    if (cookie) headers.cookie = cookie;
    if (host) headers.host = host;
    if (origin) headers.origin = origin;
    const r = request({ host: '127.0.0.1', port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, json, cookie: (res.headers['set-cookie'] ?? [])[0]?.split(';')[0] });
      });
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

test('shared HQ: everyone signs in, and permissions follow their role', async () => {
  const { paths } = tmpProject({ git: true });
  const hq = createHq({ paths, port: 0, quiet: true, share: true });
  const port = await hq.listen();
  const base = `http://127.0.0.1:${port}`;
  const host = `192.168.1.20:${port}`; // how a teammate reaches it
  try {
    assert.equal((await call(base, '/', { host })).status, 200, 'the app shell loads');
    assert.equal((await call(base, '/api/state', { host })).status, 401);
    assert.equal((await call(base, '/api/login', { method: 'POST', host, body: { token: 'nope' } })).status, 401);

    const access = createAccess(paths);
    const owner = (await call(base, '/api/login', { method: 'POST', host, body: { token: access.issue('you') } })).cookie;
    assert.match(owner, /^mc_auth=/);
    assert.equal((await call(base, '/api/state', { host, cookie: owner })).status, 200);

    const inv = await call(base, '/api/people', { method: 'POST', host, cookie: owner, body: { id: 'priya', name: 'Priya', role: 'member' } });
    assert.equal(inv.status, 200);
    const priya = (await call(base, '/api/login', { method: 'POST', host, body: { token: inv.json.link.split('/').pop() } })).cookie;
    const view = await call(base, '/api/people', { method: 'POST', host, cookie: owner, body: { id: 'sam', name: 'Sam (client)', role: 'viewer' } });
    const sam = (await call(base, '/api/login', { method: 'POST', host, body: { token: view.json.link.split('/').pop() } })).cookie;

    assert.equal((await call(base, '/api/me', { host, cookie: priya })).json.name, 'Priya');
    const posted = await call(base, '/api/messages', { method: 'POST', host, cookie: priya, body: { channel: 'general', text: 'Can we try a darker header? @lead' } });
    assert.equal(posted.status, 200);
    assert.equal(hq.store.state.messages.at(-1).by, 'priya');
    assert.ok(hq.notices.all().some((n) => n.kind === 'human' && /Priya wrote/.test(n.text)));

    assert.equal((await call(base, '/api/messages', { method: 'POST', host, cookie: sam, body: { channel: 'general', text: 'hi' } })).status, 403, 'viewers read only');
    assert.equal((await call(base, '/api/state', { host, cookie: sam })).status, 200);
    assert.equal((await call(base, '/api/workday', { method: 'POST', host, cookie: priya, body: { action: 'stop' } })).status, 403, 'only owners stop the team');
    assert.equal((await call(base, '/api/team/hire', { method: 'POST', host, cookie: priya, body: { type: 'qa-engineer' } })).status, 403);

    // answers from teammates are recorded under their name and become facts
    const q = hq.core.escalate('lead', { question: 'Dark mode in MVP?', options: ['Yes', 'No'] });
    assert.equal((await call(base, '/api/answer', { method: 'POST', host, cookie: priya, body: { q: q.id, answer: 'No' } })).status, 200);
    assert.equal(hq.store.state.questions[q.id].answeredBy, 'priya');
    assert.equal(hq.store.state.facts.length, 1);

    // agents and the CLI only from this machine, and never through a tunnel's hostname
    assert.equal((await call(base, '/mcp', { method: 'POST', host, body: {} })).status, 403);
    assert.equal((await call(base, '/api/cli', { method: 'POST', host, body: { op: 'status', args: ['cli'] } })).status, 403);
    assert.equal((await call(base, '/api/messages', { method: 'POST', host, cookie: owner, origin: 'https://evil.example', body: { channel: 'general', text: 'x' } })).status, 403);
    // a tunnel that rewrites Host to localhost still isn't "this machine"
    assert.equal((await call(base, '/api/cli', { method: 'POST', host: `localhost:${port}`, headers: { 'x-forwarded-for': '203.0.113.9', 'x-madcompany-cli': '1' }, body: { op: 'status', args: ['cli'] } })).status, 403);
    assert.equal((await call(base, '/api/cli', { method: 'POST', host: `localhost:${port}`, headers: { 'x-madcompany-cli': '1' }, body: { op: 'status', args: ['cli'] } })).status, 200);

    // removing someone ends their access
    assert.equal((await call(base, '/api/people/remove', { method: 'POST', host, cookie: owner, body: { id: 'priya' } })).status, 200);
    assert.equal((await call(base, '/api/state', { host, cookie: priya })).status, 401);
  } finally {
    await hq.close();
  }
});

test('local HQ stays sign-in free for you, and hiring from HQ updates the running team', async () => {
  const { paths } = tmpProject({ git: true });
  const hq = createHq({ paths, port: 0, quiet: true });
  const base = `http://127.0.0.1:${await hq.listen()}`;
  try {
    const me = await call(base, '/api/me');
    assert.equal(me.json.role, 'owner');
    hq.core.startDay('lead');
    hq.core.env('arjun');
    const hired = await call(base, '/api/team/hire', { method: 'POST', body: { type: 'devops-engineer' } });
    assert.equal(hired.json.id, 'devops');
    assert.ok(hq.core.teamView().some((m) => m.id === 'devops' && m.dept === 'Operations'));
    assert.equal((await call(base, '/api/team/remove', { method: 'POST', body: { id: 'lena' } })).status, 200);
    const again = await call(base, '/api/team/hire', { method: 'POST', body: { type: 'mobile-developer', id: 'lena-2' } });
    assert.equal(again.status, 200);
    const ports = ['arjun', 'devops', 'lena-2'].map((id) => hq.core.env(id).ports.web);
    assert.equal(new Set(ports).size, 3, 'a new hire never reuses someone else’s ports');
  } finally {
    await hq.close();
  }
});
