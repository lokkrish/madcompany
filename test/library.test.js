import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDemo } from '../src/demo.js';
import { mcPaths } from '../src/paths.js';
import { createHq } from '../src/hq/server.js';

let hq;
let base;
let root;
const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-claude-home-'));

before(async () => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-lib-')), 'demo');
  await createDemo(root, { log: () => {} });
  // a Claude Code transcript for this project, as Claude Code stores it
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  const dir = path.join(claudeHome, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const line = (o) => JSON.stringify({ sessionId: 'abc12345-0000-4000-8000-000000000001', timestamp: '2026-09-20T10:00:00Z', ...o });
  fs.writeFileSync(
    path.join(dir, 'abc12345-0000-4000-8000-000000000001.jsonl'),
    [
      line({ type: 'user', message: { role: 'user', content: '<command-message>bmad-create-prd</command-message>\n<command-name>/bmad-create-prd</command-name>' } }),
      line({ type: 'user', isMeta: true, message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x' }] } }),
      line({ type: 'user', message: { role: 'user', content: 'Tasks must roll over to tomorrow, and I want offline mode later.' } }),
      line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Noted: roll-over in MVP, offline after.' }, { type: 'tool_use', name: 'Write', input: {} }] } }),
      line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } }),
      line({ type: 'assistant', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'subagent chatter' }] } }),
      'not json',
    ].join('\n'),
  );
  hq = createHq({ paths: mcPaths(root), port: 0, quiet: true });
  base = `http://127.0.0.1:${await hq.listen()}`;
});

after(async () => {
  await hq.close();
  delete process.env.CLAUDE_CONFIG_DIR;
});

const get = async (p) => (await fetch(`${base}${p}`)).json();
const cat = (lib, id) => lib.categories.find((c) => c.id === id);
const group = (c, label) => c.groups.find((g) => g.label === label)?.items ?? [];

test('the Library sorts everything into planning-stage categories', async () => {
  const lib = await get('/api/library');
  assert.deepEqual(
    lib.categories.map((c) => c.id),
    ['discovery', 'requirements', 'ux', 'architecture', 'delivery', 'meetings', 'conversations', 'links', 'records', 'other'],
  );
  assert.equal(group(cat(lib, 'discovery'), 'Product brief')[0].title, 'Product Brief: Tiny Tasks');
  assert.equal(group(cat(lib, 'requirements'), 'PRD')[0].path, '_bmad-output/planning-artifacts/prd.md');
  const ux = cat(lib, 'ux');
  assert.equal(group(ux, 'UX design')[0].path, '_bmad-output/planning-artifacts/ux-design-specification.md');
  assert.equal(group(ux, 'Mockups')[0].title, 'Tiny Tasks: design directions');
  assert.equal(group(ux, 'Screenshots').length, 2);
  const arch = cat(lib, 'architecture');
  assert.equal(group(arch, 'Architecture')[0].title, 'Architecture: Tiny Tasks');
  assert.equal(group(arch, 'API contracts')[0].status, 'agreed', 'design docs carry their status');
  assert.equal(group(cat(lib, 'delivery'), 'Epics & stories')[0].path, '_bmad-output/planning-artifacts/epics.md');
  const meetings = cat(lib, 'meetings');
  assert.deepEqual(meetings.groups.map((g) => g.label), ['Planning', 'UI sprints']);
  const links = cat(lib, 'links');
  assert.equal(links.groups[0].label, 'Claude artifacts', 'Claude artifacts come first');
  assert.equal(links.groups[0].items.length, 2, 'one saved, one found in chat');
  assert.ok(links.groups[0].items.some((l) => l.sources?.[0]?.label === '#general'));
  assert.ok(group(cat(lib, 'records'), 'Decisions & answers').length >= 2);
  assert.equal(cat(lib, 'other').count, 1, 'only README is uncategorised');
});

test('minutes are written as files with working links and a clickable ID', async () => {
  const lib = await get('/api/library');
  const mom = cat(lib, 'meetings').groups[0].items[0];
  assert.equal(mom.id, 'MOM-1');
  const text = fs.readFileSync(path.join(root, mom.file), 'utf8');
  assert.match(text, /^# <a id="mom-1"><\/a>MOM-1: Planning kickoff/);
  assert.match(text, /\[PRD\]\(\.\.\/\.\.\/_bmad-output\/planning-artifacts\/prd\.md\)/);
  const ids = await get('/api/ids');
  assert.match(ids['mom-1'].hq, /^#\/file\/\.madcompany\/meetings\/.+\?a=mom-1$/);
  assert.equal(ids['l-1'].external, true);
});

test('your Claude Code conversations are listed and readable, without tool noise', async () => {
  const lib = await get('/api/library');
  const [sess] = group(cat(lib, 'conversations'), 'Claude Code sessions');
  assert.equal(sess.title, '/bmad-create-prd · Tasks must roll over to tomorrow, and I want offline mode later.');
  assert.deepEqual(sess.commands, ['/bmad-create-prd']);
  const full = await get(`/api/session/${sess.id}`);
  assert.deepEqual(full.messages.map((m) => m.role), ['you', 'you', 'claude']);
  assert.equal(full.messages[2].text, 'Noted: roll-over in MVP, offline after.');
  assert.equal((await fetch(`${base}/api/session/..%2F..%2Fetc`)).status, 404);
});

test('search finds things across files, meetings, conversations, decisions and links', async () => {
  const { results } = await get('/api/search?q=roll%20over');
  const types = new Set(results.map((r) => r.type));
  for (const t of ['Meeting', 'Question', 'Conversation']) assert.ok(types.has(t), t);
  const arch = (await get('/api/search?q=fastify')).results;
  assert.ok(arch.some((r) => r.type === 'Planning' && r.path.endsWith('architecture.md')));
  assert.ok((await get('/api/search?q=figma')).results.some((r) => r.type === 'Link'));
  assert.deepEqual((await get('/api/search?q=x')).results, []);
});

test('mockups open sandboxed; links can be saved from HQ', async () => {
  const f = await get('/api/file?path=_bmad-output/planning-artifacts/ux-design-directions.html');
  assert.equal(f.kind, 'html');
  const raw = await fetch(`${base}${f.src}`);
  assert.equal(raw.status, 200);
  assert.match(raw.headers.get('content-security-policy'), /^sandbox/);
  assert.equal((await fetch(`${base}/raw/.madcompany/team.yaml`)).status, 404);
  const res = await fetch(`${base}/api/links`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ title: 'Loom walkthrough', url: 'https://www.loom.com/share/demo' }) });
  assert.equal(res.status, 200);
  const bad = await fetch(`${base}/api/links`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ url: 'javascript:alert(1)' }) });
  assert.equal(bad.status, 400);
  const lib = await get('/api/library');
  assert.equal(group(cat(lib, 'links'), 'Videos')[0].title, 'Loom walkthrough');
});
