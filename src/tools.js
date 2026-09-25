import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyMcp, LOCAL_SERVERS } from './hook.js';
import { ensureDir } from './paths.js';

/**
 * The MCP servers, plugins and skills this project's Claude Code sessions
 * have, found from the same files Claude Code reads, plus what each is good
 * for and who on the team should use it. Only names, types and hosts leave
 * this module: never env values, headers, command arguments or URL queries,
 * which is where MCP configs keep their secrets.
 */

// Well-known servers: what they're for, which roles use them, and how you add one.
export const CATALOGUE = [
  { key: 'playwright', match: /playwright/i, title: 'Playwright', for: 'Drive a real browser: click through screens, fill forms, take screenshots.', roles: ['qa-engineer', 'web-developer', 'ux-designer', 'ui-designer'], words: ['e2e', 'screenshot', 'browser', 'test', 'ui'], add: 'claude mcp add playwright -- npx @playwright/mcp@latest', when: ['web', 'ui'] },
  { key: 'chrome-devtools', match: /chrome[-_]?devtools/i, title: 'Chrome DevTools', for: 'Debug the running web app: console errors, network calls, performance.', roles: ['web-developer', 'qa-engineer'], words: ['web', 'next.js', 'frontend', 'performance'], add: 'claude mcp add chrome-devtools -- npx chrome-devtools-mcp@latest', when: ['web'] },
  { key: 'context7', match: /context7/i, title: 'Context7', for: 'Current docs and examples for the libraries the app uses, instead of outdated memory.', roles: '*', words: [], add: 'claude mcp add --transport http context7 https://mcp.context7.com/mcp', when: ['always'] },
  { key: 'figma', match: /figma/i, title: 'Figma', for: 'Read designs, components and tokens from your Figma files.', roles: ['ux-designer', 'ui-designer', 'web-developer', 'mobile-developer'], words: ['design', 'screens', 'ui'], add: 'claude mcp add --transport http figma https://mcp.figma.com/mcp', when: ['figma'] },
  { key: 'github', match: /github/i, title: 'GitHub', for: 'Issues, pull requests, code search and CI results.', roles: ['tech-lead', 'devops-engineer'], words: ['ci', 'github'], add: 'claude mcp add --transport http github https://api.githubcopilot.com/mcp/', when: [] },
  { key: 'supabase', match: /supabase/i, title: 'Supabase', for: 'Tables, auth, storage and logs of your Supabase project.', roles: ['backend-developer', 'database-engineer'], words: ['postgres', 'database', 'auth'], add: 'claude mcp add --transport http supabase https://mcp.supabase.com/mcp', when: ['Supabase'] },
  { key: 'database', match: /postgres|neon|mysql|prisma|planetscale|mongo/i, title: 'Database', for: 'Look at schemas and data.', roles: ['database-engineer', 'backend-developer'], words: ['postgres', 'database', 'schema', 'sql'], when: [] },
  { key: 'sentry', match: /sentry/i, title: 'Sentry', for: 'Production errors, traces and releases.', roles: ['backend-developer', 'devops-engineer', 'qa-engineer'], words: ['errors', 'monitoring'], add: 'claude mcp add --transport http sentry https://mcp.sentry.dev/mcp', when: ['Sentry'] },
  { key: 'vercel', match: /vercel/i, title: 'Vercel', for: 'Deployments, build logs and project settings.', roles: ['devops-engineer'], words: ['deploy', 'hosting'], add: 'claude mcp add --transport http vercel https://mcp.vercel.com', when: ['Vercel'] },
  { key: 'stripe', match: /stripe/i, title: 'Stripe', for: 'Stripe docs and your test-mode data.', roles: ['backend-developer'], words: ['payments', 'checkout', 'billing'], add: 'claude mcp add --transport http stripe https://mcp.stripe.com', when: ['Stripe'] },
  { key: 'linear', match: /linear/i, title: 'Linear', for: 'Issues and projects your company tracks in Linear.', roles: ['tech-lead', 'product-manager'], words: [], add: 'claude mcp add --transport http linear https://mcp.linear.app/mcp', when: [] },
  { key: 'notion', match: /notion/i, title: 'Notion', for: 'Specs and notes kept in Notion.', roles: ['product-manager', 'tech-writer', 'tech-lead'], words: ['docs', 'spec'], add: 'claude mcp add --transport http notion https://mcp.notion.com/mcp', when: ['notion'] },
  { key: 'atlassian', match: /atlassian|jira|confluence/i, title: 'Jira / Confluence', for: 'Tickets and pages in Atlassian.', roles: ['tech-lead', 'product-manager'], words: [], when: [] },
  { key: 'slack', match: /slack/i, title: 'Slack', for: 'Read channels; sending messages goes to you.', roles: ['tech-lead'], words: [], when: [] },
  { key: 'cloud', match: /aws|azure|gcp|google[-_]?cloud|cloudflare/i, title: 'Cloud', for: 'Look at cloud resources and logs; changes go to you.', roles: ['devops-engineer'], words: ['cloud', 'infrastructure', 'azure', 'aws'], when: [] },
  { key: 'expo', match: /expo|eas/i, title: 'Expo', for: 'Expo docs, builds and updates.', roles: ['mobile-developer'], words: ['expo', 'react native', 'mobile'], when: [] },
];

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** What an MCP config entry points at, without secrets: a package name or a host. */
function describeServer(cfg = {}) {
  const type = cfg.type ?? (cfg.url ? 'http' : 'stdio');
  if (cfg.url) {
    try {
      const u = new URL(cfg.url);
      return { type, target: u.host };
    } catch {
      return { type, target: 'remote' };
    }
  }
  const cmd = path.basename(String(cfg.command ?? ''));
  const pkg = (cfg.args ?? []).map(String).find((a) => !a.startsWith('-') && /^(@[\w.-]+\/)?[\w.-]+(@[\w.^~-]+)?$/.test(a) && !/^(y|yes)$/.test(a));
  return { type, target: [cmd, ['npx', 'bunx', 'pnpx', 'uvx', 'pipx', 'docker'].includes(cmd) ? pkg : null].filter(Boolean).join(' ') || 'local command' };
}

export function knownFor(name) {
  return CATALOGUE.find((k) => k.match.test(name)) ?? null;
}

function skillsIn(dir, source) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const head = fs.readFileSync(file, 'utf8').slice(0, 2000);
    const desc = /^description:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? '';
    out.push({ name: /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? name, description: desc.slice(0, 200), source });
  }
  return out;
}

function agentsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const head = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 1500);
      return { name: /^name:\s*(.+)$/m.exec(head)?.[1]?.trim() ?? f.slice(0, -3), description: (/^description:\s*(.+)$/m.exec(head)?.[1] ?? '').trim().slice(0, 200) };
    });
}

/** installed_plugins.json has changed shape over versions; find a plugin's folder in any of them. */
function pluginPath(installed, id) {
  const e = installed?.plugins?.[id] ?? installed?.[id];
  const first = Array.isArray(e) ? e[0] : e;
  return first?.installPath ?? first?.path ?? null;
}

/**
 * Everything the project's Claude Code sessions (and so the agents) can use.
 * home is only overridden in tests.
 */
export function discoverTools(root, { home = os.homedir() } = {}) {
  const servers = [];
  const add = (name, cfg, scope, extra = {}) => {
    if (name === 'madcompany') return;
    const known = knownFor(name);
    servers.push({ name, scope, ...describeServer(cfg), prefix: `mcp__${name}__`, known: known ? { key: known.key, title: known.title, for: known.for } : null, ...extra });
  };

  // settings, merged the way Claude Code does: local > project > user
  const settings = [path.join(home, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json')].map(readJson).map((x) => x ?? {});
  const merged = Object.assign({}, ...settings);
  const approved = new Set(settings.flatMap((x) => x.enabledMcpjsonServers ?? []));
  const rejected = new Set(settings.flatMap((x) => x.disabledMcpjsonServers ?? []));
  const denied = settings.flatMap((x) => x.permissions?.deny ?? []).filter((r) => String(r).startsWith('mcp__'));

  // project servers (.mcp.json) need your OK the first time
  for (const [name, cfg] of Object.entries(readJson(path.join(root, '.mcp.json'))?.mcpServers ?? {})) {
    add(name, cfg, 'project', { approved: rejected.has(name) ? false : merged.enableAllProjectMcpServers || approved.has(name) ? true : null });
  }
  // yours (~/.claude.json): user scope, and local scope for this project
  const cj = readJson(path.join(home, '.claude.json')) ?? {};
  for (const [name, cfg] of Object.entries(cj.mcpServers ?? {})) add(name, cfg, 'user');
  for (const [name, cfg] of Object.entries(cj.projects?.[root]?.mcpServers ?? {})) add(name, cfg, 'local');

  // plugins
  const installed = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const enabled = {};
  settings.forEach((x, i) => {
    for (const [id, on] of Object.entries(x.enabledPlugins ?? {})) enabled[id] = { on: Boolean(on), scope: ['user', 'project', 'local'][i] };
  });
  const plugins = [];
  const skills = [...skillsIn(path.join(root, '.claude', 'skills'), 'project'), ...skillsIn(path.join(home, '.claude', 'skills'), 'yours')].filter((x) => !x.name.startsWith('mc-'));
  for (const [id, { on, scope }] of Object.entries(enabled)) {
    if (!on) continue;
    const [name, marketplace = ''] = id.split('@');
    const dir = pluginPath(installed, id);
    const found = Boolean(dir && fs.existsSync(dir));
    const manifest = found ? readJson(path.join(dir, '.claude-plugin', 'plugin.json')) ?? {} : {};
    const mcp = found ? { ...(readJson(path.join(dir, '.mcp.json'))?.mcpServers ?? {}), ...(typeof manifest.mcpServers === 'object' ? manifest.mcpServers : {}) } : {};
    const pSkills = found ? skillsIn(path.join(dir, 'skills'), `plugin ${name}`) : [];
    skills.push(...pSkills);
    for (const [sname, cfg] of Object.entries(mcp)) add(sname, cfg, 'plugin', { plugin: id, prefix: `mcp__plugin_${name}_${sname}__` });
    plugins.push({
      id,
      name,
      marketplace,
      scope,
      found,
      description: String(manifest.description ?? '').slice(0, 200),
      skills: pSkills.map((x) => x.name),
      agents: found ? agentsIn(path.join(dir, 'agents')) : [],
      servers: Object.keys(mcp),
      hooks: found && fs.existsSync(path.join(dir, 'hooks')),
    });
  }
  return { servers, plugins, skills, denied };
}

/** Which discovered servers a team member should use: by role, by domain words, or as you assigned in team.yaml. */
export function serversFor(member, servers, config = {}) {
  const assigned = new Set([...(config.tools?.assign?.[member.id] ?? []), ...(config.tools?.assign?.[member.type] ?? [])]);
  const text = [...(member.domain ?? []), ...(member.also ?? []), member.role ?? ''].join(' ').toLowerCase();
  return servers.filter((s) => {
    if (assigned.has(s.name)) return true;
    const k = knownFor(s.name);
    if (!k) return false;
    const word = (w) => new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`).test(text);
    return k.roles === '*' || k.roles.includes(member.type) || (member.lead && k.roles.includes('tech-lead')) || k.words.some(word);
  });
}

/** One line on what the safety policy does with a server's tools. */
export function policyLine(server, config = {}) {
  const tools = config.tools ?? {};
  if ((tools.allow ?? []).some((p) => p === server.prefix.slice(0, -2))) return 'All its tools are allowed (team.yaml).';
  if (LOCAL_SERVERS.test(server.prefix.slice(5, -2))) return tools.auto_allow === false ? 'Its tools follow your Claude Code permissions.' : 'All its tools are allowed.';
  const probe = classifyMcp(`${server.prefix}create_item`, { tools });
  return probe.decision === 'human'
    ? 'Reading is allowed; anything that writes (create, update, push, deploy…) goes to Human help.'
    : 'Reading is allowed; pushing, deploying, paying, deleting or sending goes to Human help; other tools follow your Claude Code permissions.';
}

/** Servers worth adding, from the stack, the mode and what's in the Library. */
export function suggestions({ servers, scan, mode, links = [] }) {
  const have = new Set(servers.map((s) => knownFor(s.name)?.key).filter(Boolean));
  const services = new Set(scan?.services ?? []);
  const frameworks = new Set(scan?.frameworks ?? []);
  const web = ['Next.js', 'React', 'Vue', 'Nuxt', 'SvelteKit', 'Angular', 'Svelte'].some((f) => frameworks.has(f)) || ['ui', 'ui-mvp'].includes(mode);
  const out = [];
  for (const k of CATALOGUE) {
    if (have.has(k.key) || !k.add) continue;
    const why =
      k.when.includes('always') ? 'Every agent writes better code with current library docs.'
      : k.when.includes('web') && web ? 'QA and the web developers can click through screens and take screenshots themselves.'
      : k.when.includes('figma') && links.some((l) => /figma\.com/.test(l.url ?? '')) ? 'Your Library has Figma links; designers and developers could read them directly.'
      : k.when.some((w) => services.has(w)) ? `The code uses ${k.when.find((w) => services.has(w))}.`
      : null;
    if (why) out.push({ key: k.key, title: k.title, for: k.for, why, add: k.add });
  }
  return out;
}

/** Recent MCP and skill calls from the hook's log, trimmed so it never grows without bound. */
export function toolUsage(paths, { limit = 40 } = {}) {
  const file = path.join(paths.run, 'tool-calls.jsonl');
  if (!fs.existsSync(file)) return { recent: [], byTool: {} };
  let lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  if (lines.length > 5000) {
    lines = lines.slice(-2000);
    fs.writeFileSync(file, lines.join('\n') + '\n');
  }
  const calls = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
  const byTool = {};
  for (const c of calls) {
    const t = (byTool[c.tool] ??= { calls: 0, blocked: 0, last: null, agents: [] });
    t.calls += 1;
    if (c.decision === 'human') t.blocked += 1;
    t.last = c.ts;
    const who = c.agent ? String(c.agent).replace(/^mc-/, '') : null;
    if (who && !t.agents.includes(who)) t.agents.push(who);
  }
  return { recent: calls.slice(-limit).reverse().map((c) => ({ ...c, agent: c.agent ? String(c.agent).replace(/^mc-/, '') : null })), byTool };
}

/** What the pre-tool hook reads (it runs without loading any dependencies). */
export function writePolicy(paths, config) {
  ensureDir(paths.run);
  let denied = [];
  try {
    denied = discoverTools(paths.root).denied;
  } catch {
    // unreadable settings: nothing extra to honour
  }
  fs.writeFileSync(
    paths.policy,
    JSON.stringify({
      allowPush: Boolean(config.allow_push),
      root: paths.root,
      tools: { auto_allow: config.tools?.auto_allow !== false, allow: config.tools?.allow ?? [], human: config.tools?.human ?? [] },
      denied,
    }),
  );
}
