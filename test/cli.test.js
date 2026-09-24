import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sfPaths } from '../src/paths.js';
import { init, staff } from '../src/setup.js';
import { connect } from '../src/client.js';
import { mergeTicket, snapshot } from '../src/git.js';
import { loadConfig } from '../src/config.js';
import { createDemo } from '../src/demo.js';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'storyfront.js');

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cli-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(root, 'README.md'), '# app\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return { root, g, paths: sfPaths(root) };
}

test('init merges into existing settings and never clobbers them', () => {
  const { root, paths } = repo();
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(make *)'] }, model: 'opus' }));
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { other: { type: 'stdio', command: 'x' } } }));
  init(paths, { log: () => {} });
  init(paths, { log: () => {} }); // idempotent
  const st = JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(st.model, 'opus');
  assert.ok(st.permissions.allow.includes('Bash(make *)') && st.permissions.allow.includes('mcp__storyfront'));
  assert.equal(st.hooks.PreToolUse.length, 1);
  const mcp = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers.other && mcp.mcpServers.storyfront.url.endsWith('/mcp'));
  assert.ok(fs.existsSync(path.join(root, '.claude', 'skills', 'sf-start', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(paths.bin, 'hook.mjs')));
  const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.equal(gi.match(/\.storyfront\/run\//g).length, 1);
});

test('staff writes one subagent per non-lead member and removes leavers', () => {
  const { root, paths } = repo();
  init(paths, { log: () => {} });
  staff(paths, { log: () => {} });
  const agents = fs.readdirSync(path.join(root, '.claude', 'agents')).sort();
  assert.deepEqual(agents, ['sf-arjun.md', 'sf-lena.md', 'sf-maya.md', 'sf-qa.md']);
  const arjun = fs.readFileSync(path.join(root, '.claude', 'agents', 'sf-arjun.md'), 'utf8');
  assert.match(arjun, /^---\nname: sf-arjun\n/);
  assert.match(arjun, /isolation: worktree/);
  assert.match(arjun, /as: "arjun"/);
  fs.writeFileSync(paths.team, fs.readFileSync(paths.team, 'utf8').replace(/\n  - id: qa[\s\S]*$/, '\n'));
  staff(paths, { log: () => {} });
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'agents', 'sf-qa.md')));
  assert.ok(fs.existsSync(path.join(paths.agents, 'arjun', 'work.md')));
});

test('merge queue: merges an approved ticket, reverts and reopens on failing checks', async () => {
  const { root, g, paths } = repo();
  init(paths, { log: () => {}, skills: false });
  fs.writeFileSync(paths.team, fs.readFileSync(paths.team, 'utf8').replace('checks:\n', 'checks:\n  - test ! -f broken.txt\n'));
  g('add', '-A');
  g('commit', '-q', '-m', 'storyfront');
  const c = await connect(paths);
  const core = c.core;
  core.startDay('lead');
  core.createTicket('lead', { title: 'Good', epic: 'E1' });
  core.createTicket('lead', { title: 'Bad', epic: 'E1' });
  core.claim('arjun', 'APP-1');
  assert.throws(() => core.submit('arjun', 'APP-1', { summary: 'x', checks: { test: 'pass' } }), /sf\/app-1 doesn't exist/);
  g('branch', 'sf/app-1', 'main');
  assert.throws(() => core.submit('arjun', 'APP-1', { summary: 'x', checks: { test: 'pass' } }), /no commits beyond main/);
  g('branch', '-D', 'sf/app-1');
  for (const [id, file] of [['APP-1', 'good.txt'], ['APP-2', 'broken.txt']]) {
    if (id !== 'APP-1') core.claim('arjun', id);
    g('switch', '-q', '-c', `sf/${id.toLowerCase()}`, 'main');
    fs.writeFileSync(path.join(root, file), 'x');
    g('add', file);
    g('commit', '-q', '-m', `feat: ${file}`);
    g('switch', '-q', 'main');
    core.submit('arjun', id, { summary: 'done', checks: { test: 'pass' } });
    core.review('qa', id, { verdict: 'approve' });
  }
  const cfg = loadConfig(paths);
  const ok = await mergeTicket(paths, c, cfg, 'APP-1', { log: () => {} });
  assert.equal(ok.ok, true);
  assert.equal(core.ticket('APP-1').status, 'done');
  assert.ok(core.ticket('APP-1').commits.some((x) => /feat: good.txt/.test(x)));
  const wt = path.join(paths.worktrees, 'epic-1');
  assert.ok(fs.existsSync(path.join(wt, 'good.txt')));

  const bad = await mergeTicket(paths, c, cfg, 'APP-2', { log: () => {} });
  assert.equal(bad.ok, false);
  assert.equal(core.ticket('APP-2').status, 'todo');
  assert.match(core.ticket('APP-2').worklog.at(-1).text, /Checks failed/);
  assert.ok(!fs.existsSync(path.join(wt, 'broken.txt')), 'merge was reverted');
  await assert.rejects(() => mergeTicket(paths, c, cfg, 'APP-2', { log: () => {} }), /is todo, not in review/);

  await c.close();
  fs.writeFileSync(path.join(root, 'README.md'), '# user change, not ours\n');
  snapshot(paths, { log: () => {} });
  assert.match(g('log', '-1', '--format=%s'), /storyfront: snapshot/);
  assert.match(g('status', '--porcelain'), /README\.md/, 'snapshot leaves your other changes alone');
});

test('demo project and CLI commands work end to end', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-demo-')), 'demo');
  await createDemo(dir, { log: () => {} });
  const run = (...a) => execFileSync('node', [BIN, ...a], { cwd: dir, encoding: 'utf8' });
  assert.match(run('status'), /Tiny Tasks · workday on/);
  assert.match(run('env', 'arjun'), /DATABASE_NAME=sf_arjun/);
  assert.match(run('ids'), /IDs →/);
  const refs = spawnSync('node', [BIN, 'refs', 'check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(refs.status, 0, refs.stdout);
  assert.throws(() => run('bogus'), /Unknown command/);
});

