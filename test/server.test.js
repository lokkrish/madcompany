import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tmpProject } from './helpers.js';
import { createHq } from '../src/hq/server.js';

let hq;
let base;
let ctx;

before(async () => {
  ctx = tmpProject();
  fs.mkdirSync(path.join(ctx.root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, 'docs', 'prd.md'), '# PRD\n\n- <a id="fr1"></a>FR1: Users can sign up.\n- <a id="fr2"></a>FR2: See FR1.\n\n<script>alert(1)</script>\n');
  fs.writeFileSync(path.join(ctx.root, '.env'), 'SECRET=1');
  hq = createHq({ paths: ctx.paths, port: 0, quiet: true });
  const port = await hq.listen();
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await hq.close();
});

async function mcpClient() {
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}
const call = async (client, name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { error: r.isError ? r.content[0].text : null, data: r.isError ? null : JSON.parse(r.content[0].text) };
};

test('MCP: agents can list tools and run a ticket through the flow', async () => {
  const client = await mcpClient();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['sf_claim', 'sf_block', 'sf_submit', 'sf_wait', 'sf_escalate', 'sf_lookup', 'sf_ticket']) assert.ok(names.includes(n), n);

  assert.ok((await call(client, 'sf_start_day', { as: 'lead' })).data.workday.state === 'on');
  const t = await call(client, 'sf_create_ticket', { as: 'lead', title: 'Signup API', epic: 'E1', refs: ['FR1'] });
  assert.equal(t.data.ticket.id, 'APP-1');
  const denied = await call(client, 'sf_create_ticket', { as: 'arjun', title: 'x' });
  assert.match(denied.error, /Only the lead/);
  const claim = await call(client, 'sf_claim', { as: 'arjun', id: 'APP-1' });
  assert.equal(claim.data.git.base, 'epic/1');
  const info = await call(client, 'sf_ticket', { as: 'qa', id: 'APP-1' });
  assert.equal(info.data.git.review, 'git switch --detach sf/app-1 && git diff epic/1...sf/app-1');
  const look = await call(client, 'sf_lookup', { as: 'arjun', ref: 'FR-1' });
  assert.equal(look.data.link, '[FR-1](docs/prd.md#fr1)');
  await client.close();
});

test('MCP: sf_wait returns notices when the human posts', async () => {
  const client = await mcpClient();
  await call(client, 'sf_wait', { as: 'lead', seconds: 5 }); // drain
  const waiting = call(client, 'sf_wait', { as: 'lead', seconds: 10 });
  await new Promise((r) => setTimeout(r, 100));
  const post = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ channel: 'general', text: 'Please prioritise signup @lead' }) });
  assert.equal(post.status, 200);
  const got = await waiting;
  assert.ok(got.data.notices.some((n) => n.kind === 'human'));
  await client.close();
});

test('security: foreign origins and hosts are refused; secrets and traversal are hidden', async () => {
  const evil = await fetch(`${base}/api/messages`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"channel":"general","text":"hi"}' });
  assert.equal(evil.status, 403);
  const evilMcp = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
  assert.equal(evilMcp.status, 403);
  const cli = await fetch(`${base}/api/cli`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"op":"stopNow","args":["cli"]}' });
  assert.equal(cli.status, 403, 'CLI endpoint needs the CLI header');
  assert.equal((await fetch(`${base}/api/file?path=.env`)).status, 403);
  assert.equal((await fetch(`${base}/api/file?path=../../etc/passwd`)).status, 403);
  fs.symlinkSync('/etc/hostname', path.join(ctx.root, 'docs', 'escape.md'));
  assert.equal((await fetch(`${base}/api/file?path=docs/escape.md`)).status, 403);
  // a DNS-rebinding style Host header
  const res = await new Promise((resolve) => {
    import('node:http').then(({ request }) => {
      const r = request(`${base}/api/health`, { headers: { host: 'attacker.example' } }, resolve);
      r.end();
    });
  });
  assert.equal(res.statusCode, 421);
});

test('widget feedback is accepted from a local dev server origin', async () => {
  const pre = await fetch(`${base}/api/feedback`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } });
  assert.equal(pre.status, 204);
  const res = await fetch(`${base}/api/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost:3000' }, body: JSON.stringify({ text: 'Make the button bigger', route: '/signup', selector: 'button.primary' }) });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.match(out.ticket.id, /^APP-\d+$/);
});

test('file viewer renders markdown with clickable IDs and escapes raw HTML', async () => {
  const res = await (await fetch(`${base}/api/file?path=docs/prd.md`)).json();
  assert.equal(res.kind, 'markdown');
  assert.match(res.html, /<a id="fr1" class="anchor">/);
  assert.match(res.html, /href="#\/file\/docs\/prd\.md\?a=fr1"/);
  assert.ok(!res.html.includes('<script>'));
});

test('state, views and registry are written for humans and git', async () => {
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.ok(state.dashboard.team.length === 4);
  hq.views.flush();
  const board = fs.readFileSync(path.join(ctx.paths.log, 'board.md'), 'utf8');
  assert.match(board, /## <a id="app-1"><\/a>APP-1: Signup API/);
  const ids = JSON.parse(fs.readFileSync(ctx.paths.ids, 'utf8'));
  assert.equal(ids.fr1.file, 'docs/prd.md');
  assert.equal(ids['app-1'].file, '.storyfront/log/board.md');
  assert.ok(fs.existsSync(path.join(ctx.paths.chat, 'general.md')));
});
