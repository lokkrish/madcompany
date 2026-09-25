import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpProject } from './helpers.js';
import { discoverTools, serversFor, suggestions, toolUsage, writePolicy } from '../src/tools.js';
import { decide } from '../src/hook.js';
import { parseTeam, loadConfig } from '../src/config.js';
import { init, staff } from '../src/setup.js';
import { createHq } from '../src/hq/server.js';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'hook.js');
const write = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
};

/** A project and a fake home with MCP servers and a plugin, configured the ways Claude Code allows. */
function setup() {
  const { root, paths } = tmpProject({ git: true });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-home-'));
  write(path.join(root, '.mcp.json'), {
    mcpServers: {
      madcompany: { type: 'http', url: 'http://127.0.0.1:4317/mcp' },
      playwright: { command: 'npx', args: ['-y', '@playwright/mcp@latest', '--token', 'sk_live_SECRET1'], env: { API_KEY: 'sk_live_SECRET2' } },
      weather: { type: 'http', url: 'https://mcp.weather.example/mcp?apiKey=SECRET3' },
    },
  });
  write(path.join(root, '.claude', 'settings.json'), { enabledMcpjsonServers: ['madcompany', 'playwright'], permissions: { deny: ['mcp__github__delete_repository', 'Bash(rm:*)'] } });
  write(path.join(home, '.claude.json'), {
    oauthAccount: { emailAddress: 'someone@example.com' },
    mcpServers: { github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', headers: { Authorization: 'Bearer SECRET4' } } },
    projects: { [root]: { mcpServers: { supabase: { type: 'http', url: 'https://mcp.supabase.com/mcp' } } } },
  });
  const plugin = path.join(home, '.claude', 'plugins', 'cache', 'acme', 'toolkit', '1.0.0');
  write(path.join(plugin, '.claude-plugin', 'plugin.json'), { name: 'toolkit', description: 'Review and deploy helpers', mcpServers: { vercel: { type: 'http', url: 'https://mcp.vercel.com' } } });
  write(path.join(plugin, 'skills', 'review-pr', 'SKILL.md'), '---\nname: review-pr\ndescription: Review a pull request for bugs\n---\n');
  write(path.join(plugin, 'agents', 'security.md'), '---\nname: security-reviewer\ndescription: Looks for security issues\n---\n');
  fs.mkdirSync(path.join(plugin, 'hooks'));
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'toolkit@acme': [{ scope: 'user', installPath: plugin, version: '1.0.0' }] } });
  write(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'toolkit@acme': true, 'unused@acme': false } });
  return { root, paths, home };
}

test('discovery finds project, personal and plugin MCP servers, plugins and skills, and never their secrets', () => {
  const { root, home } = setup();
  const t = discoverTools(root, { home });
  const byName = Object.fromEntries(t.servers.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(byName).sort(), ['github', 'playwright', 'supabase', 'vercel', 'weather'], "madcompany's own server isn't listed");
  assert.equal(byName.playwright.scope, 'project');
  assert.equal(byName.playwright.target, 'npx @playwright/mcp@latest');
  assert.equal(byName.playwright.approved, true);
  assert.equal(byName.weather.approved, null, 'waiting for your OK in Claude Code');
  assert.equal(byName.weather.target, 'mcp.weather.example');
  assert.equal(byName.github.scope, 'user');
  assert.equal(byName.supabase.scope, 'local');
  assert.equal(byName.vercel.prefix, 'mcp__plugin_toolkit_vercel__');
  assert.equal(byName.github.known.title, 'GitHub');
  const p = t.plugins.find((x) => x.id === 'toolkit@acme');
  assert.deepEqual([p.skills, p.agents.map((a) => a.name), p.servers, p.hooks], [['review-pr'], ['security-reviewer'], ['vercel'], true]);
  assert.ok(!t.plugins.some((x) => x.id === 'unused@acme'), 'disabled plugins are left out');
  assert.ok(t.skills.some((s) => s.name === 'review-pr' && s.source === 'plugin toolkit'));
  assert.deepEqual(t.denied, ['mcp__github__delete_repository']);
  const all = JSON.stringify(t);
  for (const secret of ['SECRET1', 'SECRET2', 'SECRET3', 'SECRET4', 'someone@example.com']) assert.ok(!all.includes(secret), `${secret} must not leak`);
});

test('servers go to the right people: by role, by domain words, or as assigned', () => {
  const { root, home } = setup();
  const { servers } = discoverTools(root, { home });
  const cfg = parseTeam('team:\n  - id: lead\n  - id: qa\n    type: qa-engineer\n  - id: tester\n    domain: [E2E tests]\n  - id: data\n    type: data-engineer\ntools:\n  assign:\n    data: [supabase]\n');
  const names = (id) => serversFor(cfg.team.find((m) => m.id === id), servers, cfg).map((s) => s.name).sort();
  assert.deepEqual(names('qa'), ['playwright']);
  assert.deepEqual(names('tester'), ['playwright'], 'a member without a role type is matched on its domain');
  assert.deepEqual(names('data'), ['supabase']);
  assert.deepEqual(names('lead'), ['github']);
});

test('the hook lets read-only MCP tools run, sends pushes, deploys and remote writes to Human help, and logs names only', () => {
  const { root, paths } = setup();
  const policy = { tools: { auto_allow: true, allow: ['mcp__github__create_pull_request'], human: ['mcp__supabase__list_projects'] }, denied: ['mcp__github__delete_repository'] };
  const d = (tool) => decide({ tool_name: tool, tool_input: {} }, { root, policy });
  assert.ok(d('mcp__github__get_file_contents').allow);
  assert.ok(d('mcp__playwright__browser_click').allow, 'local servers are fully allowed');
  assert.match(d('mcp__github__push_files'), /human's to run[\s\S]*mc_human_help/);
  assert.match(d('mcp__plugin_toolkit_vercel__deploy_to_vercel'), /deploys/);
  assert.match(d('mcp__linear__create_issue'), /people outside the team can see/);
  assert.ok(d('mcp__github__create_pull_request').allow, 'tools.allow in team.yaml');
  assert.match(d('mcp__supabase__list_projects'), /tools\.human/);
  assert.equal(d('mcp__github__delete_repository'), null, 'your own deny rule stays in charge');
  assert.equal(d('mcp__madcompany__mc_status'), null);
  assert.ok(d('mcp__stripe__list_payments').allow, 'a read that mentions payments is still a read');
  assert.ok(d('mcp__gmail__get_email_settings').allow);
  assert.match(d('mcp__github__get_or_create_label'), /people outside the team/, 'a "get" that creates is a write');
  assert.match(d('mcp__gmail__send_email'), /sends/);
  assert.equal(d('mcp__research__summarise_notes'), null, 'names that merely contain "eas" are not Expo');
  assert.match(d('mcp__plugin_kit_fly__scale_app'), /people outside the team/);
  assert.equal(decide({ tool_name: 'mcp__github__get_me' }, { root, policy: { tools: { auto_allow: false } } }), null);

  // the real hook process: JSON "allow" on stdout, exit 2 with the reason on stderr
  writePolicy(paths, loadConfig(paths));
  const run = (tool, extra = {}) => spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: { query: 'SELECT secret_value' }, cwd: root, ...extra }), encoding: 'utf8' });
  const ok = run('mcp__github__search_code', { agent_type: 'mc-qa' });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).hookSpecificOutput.permissionDecision, 'allow');
  const no = run('mcp__github__merge_pull_request');
  assert.equal(no.status, 2);
  assert.match(no.stderr, /Human help|mc_human_help/);
  run('Skill', { tool_input: { skill: 'review-pr' } });
  const usage = toolUsage(paths);
  assert.deepEqual(usage.recent.map((c) => [c.tool, c.decision, c.agent]), [['skill:review-pr', 'default', null], ['mcp__github__merge_pull_request', 'human', null], ['mcp__github__search_code', 'allow', 'qa']]);
  assert.ok(!fs.readFileSync(path.join(paths.run, 'tool-calls.jsonl'), 'utf8').includes('secret_value'), 'inputs are never logged');
});

test('agents learn their tools, the lead gets them in the briefing, and HQ shows them', async () => {
  const { root, paths, home } = setup();
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    init(paths, { log: () => {}, skills: false });
    fs.writeFileSync(paths.team, `${fs.readFileSync(paths.team, 'utf8')}\n  - id: tester\n    type: qa-engineer\n`.replace(/max_parallel: \d/, (m) => `${m}\ntools:\n  allow: [mcp__github__create_pull_request]`));
    staff(paths, { log: () => {} });
    const qa = fs.readFileSync(path.join(root, '.claude', 'agents', 'mc-tester.md'), 'utf8');
    assert.match(qa, /## Your tools[\s\S]*\*\*playwright\*\* \(Playwright\): Drive a real browser[\s\S]*All its tools are allowed/);
    assert.match(qa, /The project also has/);
    const policy = JSON.parse(fs.readFileSync(paths.policy, 'utf8'));
    assert.deepEqual(policy.tools.allow, ['mcp__github__create_pull_request']);

    const hq = createHq({ paths, port: 0, quiet: true });
    const base = `http://127.0.0.1:${await hq.listen()}`;
    try {
      const t = await (await fetch(`${base}/api/tools`)).json();
      const pw = t.servers.find((s) => s.name === 'playwright');
      assert.ok(pw.users.includes('tester'));
      assert.match(t.servers.find((s) => s.name === 'github').policy, /anything that writes/);
      assert.ok(t.suggestions.some((s) => s.key === 'context7'), 'Context7 is worth adding to any project');
      assert.ok(!t.suggestions.some((s) => s.key === 'playwright'), 'already there');
      const brief = hq.core.startDay('lead');
      assert.ok(brief.tools.plugin_skills.some((x) => x.startsWith('review-pr')));
      assert.ok(brief.tools.plugin_agents.some((x) => x.startsWith('security-reviewer')));
      const mine = hq.core.toolsFor('tester');
      assert.deepEqual(mine.yours.map((x) => x.name), ['playwright']);
    } finally {
      await hq.close();
    }
  } finally {
    process.env.HOME = oldHome;
  }
});

test('suggestions follow the stack, the mode and your Library', () => {
  const s = suggestions({ servers: [], scan: { services: ['Stripe', 'Sentry'], frameworks: ['Next.js'] }, mode: 'mvp', links: [{ url: 'https://www.figma.com/design/x' }] });
  assert.deepEqual(s.map((x) => x.key).sort(), ['chrome-devtools', 'context7', 'figma', 'playwright', 'sentry', 'stripe']);
  assert.match(s.find((x) => x.key === 'stripe').why, /uses Stripe/);
});
