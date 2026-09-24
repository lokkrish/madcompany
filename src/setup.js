import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { ensureDir } from './paths.js';

const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const T = (name) => fs.readFileSync(path.join(PKG, 'templates', name), 'utf8');

export const HOOK_COMMAND = 'node "$(git rev-parse --path-format=absolute --git-common-dir)/../.storyfront/bin/hook.mjs"';

function writeIfMissing(file, content, log) {
  if (fs.existsSync(file)) return false;
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, content);
  log(`  created ${path.relative(process.cwd(), file) || file}`);
  return true;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Set up Storyfront in an app project. Never overwrites your files; merges
 * into .mcp.json, .claude/settings.json and .gitignore.
 */
export function init(paths, { skills = true, port = 4317, log = console.log } = {}) {
  const { root } = paths;
  log(`Setting up Storyfront in ${root}`);
  ensureDir(paths.dir);
  writeIfMissing(paths.team, T('team.yaml'), log);
  writeIfMissing(paths.facts, '# Facts\n\nAnswers you have given. Agents check this before asking you anything.\n', log);
  writeIfMissing(path.join(paths.dir, 'credentials-needed.md'), T('credentials-needed.md'), log);
  writeIfMissing(path.join(root, 'docker-compose.storyfront.yml'), T('docker-compose.storyfront.yml'), log);
  ensureDir(paths.log);
  ensureDir(paths.agents);

  // the hook runs on every tool call, so it is copied in and has no dependencies
  ensureDir(paths.bin);
  fs.copyFileSync(path.join(PKG, 'src', 'hook.js'), path.join(paths.bin, 'hook.mjs'));
  log('  updated .storyfront/bin/hook.mjs');

  // MCP server entry (HTTP, local only). A long timeout lets the lead wait for events.
  const mcpFile = path.join(root, '.mcp.json');
  const mcp = readJson(mcpFile) ?? {};
  mcp.mcpServers ??= {};
  mcp.mcpServers.storyfront = { type: 'http', url: `http://127.0.0.1:${port}/mcp`, timeout: 900000 };
  fs.writeFileSync(mcpFile, JSON.stringify(mcp, null, 2) + '\n');
  log('  updated .mcp.json (storyfront server)');

  // Claude Code settings: hook + permissions for unattended agents (SEC-6)
  const settingsFile = path.join(root, '.claude', 'settings.json');
  ensureDir(path.dirname(settingsFile));
  const st = readJson(settingsFile) ?? {};
  st.hooks ??= {};
  st.hooks.PreToolUse ??= [];
  const has = st.hooks.PreToolUse.some((h) => (h.hooks ?? []).some((x) => String(x.command).includes('.storyfront/bin/hook.mjs')));
  if (!has) st.hooks.PreToolUse.push({ matcher: '*', hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 10 }] });
  st.permissions ??= {};
  st.permissions.allow = [...new Set([...(st.permissions.allow ?? []), ...DEFAULT_ALLOW])];
  st.enabledMcpjsonServers = [...new Set([...(st.enabledMcpjsonServers ?? []), 'storyfront'])];
  fs.writeFileSync(settingsFile, JSON.stringify(st, null, 2) + '\n');
  log('  updated .claude/settings.json (safety hook, permissions)');

  // keep runtime files out of git
  const gi = path.join(root, '.gitignore');
  const current = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const want = ['.storyfront/run/', '.storyfront/worktrees/', '.claude/worktrees/', '.env', '.env.local'];
  const missing = want.filter((w) => !current.split('\n').includes(w));
  if (missing.length) {
    fs.writeFileSync(gi, `${current}${current && !current.endsWith('\n') ? '\n' : ''}# Storyfront\n${missing.join('\n')}\n`);
    log('  updated .gitignore');
  }

  if (skills) {
    const src = path.join(PKG, 'skills');
    for (const name of fs.readdirSync(src)) {
      const dest = path.join(root, '.claude', 'skills', name);
      fs.cpSync(path.join(src, name), dest, { recursive: true });
    }
    log('  installed skills into .claude/skills/ (/sf-start, /sf-staff, /sf-plan-epic, /sf-ui-sprint, …)');
  }
}

// What background agents may do without asking (they can't answer prompts).
// The hook still blocks the deny list (push, deploy, secrets…) on top of this.
export const DEFAULT_ALLOW = [
  'mcp__storyfront',
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Bash(git status*)',
  'Bash(git diff*)',
  'Bash(git log*)',
  'Bash(git show*)',
  'Bash(git add*)',
  'Bash(git commit*)',
  'Bash(git switch*)',
  'Bash(git checkout*)',
  'Bash(git branch*)',
  'Bash(git stash*)',
  'Bash(git merge*)',
  'Bash(git rev-parse*)',
  'Bash(git rm *)',
  'Bash(git mv *)',
  'Bash(git worktree list*)',
  'Bash(test *)',
  'Bash(npm *)',
  'Bash(npx *)',
  'Bash(pnpm *)',
  'Bash(yarn *)',
  'Bash(node *)',
  'Bash(ls*)',
  'Bash(cat *)',
  'Bash(mkdir *)',
  'Bash(psql *)',
  'Bash(createdb *)',
  'Bash(curl -s http://localhost*)',
  'Bash(curl -s http://127.0.0.1*)',
  'Bash(docker compose *)',
];

const PROFILE_FIELDS = {
  developer: '',
  lead: '',
  reviewer: 'disallowedTools: Edit, Write, NotebookEdit\n',
};

/** Generate one Claude Code subagent + identity + memory files per team member. */
export function staff(paths, { log = console.log } = {}) {
  const cfg = loadConfig(paths);
  const protocol = T('agent-protocol.md');
  const agentsDir = path.join(paths.root, '.claude', 'agents');
  ensureDir(agentsDir);
  const wanted = new Set();
  for (const m of cfg.team) {
    const dir = ensureDir(path.join(paths.agents, m.id));
    const identity = [
      `# ${m.id}`,
      '',
      `- **Role:** ${m.role}`,
      m.domain.length ? `- **Main domain:** ${m.domain.join(', ')}` : null,
      m.also.length ? `- **Also knows:** ${m.also.join(', ')}` : null,
      `- **Model:** ${m.model}`,
      '',
      m.lead
        ? 'You lead the team: you split epics into tickets, keep agents busy, run reviews and merges, and are the only one who asks the human.'
        : 'You take tickets in your domain from the lead and collaborate with teammates through Storyfront HQ.',
      '',
    ]
      .filter((l) => l !== null)
      .join('\n');
    fs.writeFileSync(path.join(dir, 'identity.md'), identity);
    writeIfMissing(path.join(dir, 'work.md'), `# ${m.id}: work memory\n\nWhat I've built, what I know about this codebase, areas I own.\n`, log);
    writeIfMissing(path.join(dir, 'comms.md'), `# ${m.id}: comms memory\n\nOpen threads, promises I made, questions waiting on others.\n`, log);
    if (m.lead) continue; // the lead is your main Claude Code session (/sf-start), not a subagent
    const name = `sf-${m.id}`;
    wanted.add(`${name}.md`);
    const checks = cfg.checks.length ? ` (${cfg.checks.map((c) => `\`${c}\``).join(', ')})` : '';
    const body = protocol.replaceAll('{{id}}', m.id).replaceAll('{{domain}}', [...m.domain, ...m.also].join(', ') || 'your role').replaceAll('{{checks}}', checks);
    const front = [
      '---',
      `name: ${name}`,
      `description: Storyfront team member "${m.id}", ${m.role}${m.domain.length ? ` (${m.domain.join(', ')})` : ''}. Started by the Storyfront lead with a ticket ID; not for general use.`,
      m.model && m.model !== 'inherit' ? `model: ${m.model}` : null,
      'isolation: worktree',
      PROFILE_FIELDS[m.profile]?.trim() || null,
      '---',
    ]
      .filter(Boolean)
      .join('\n');
    const content = `${front}\n\nYou are **${m.id}**, the ${m.role} on this project's Storyfront team.${m.domain.length ? ` Your main domain: ${m.domain.join(', ')}.` : ''}${m.also.length ? ` You also know ${m.also.join(', ')}.` : ''}\n\nAt the start of every run, call \`sf_memory\` (as: "${m.id}") to load your identity and memories.\n\n${body}`;
    fs.writeFileSync(path.join(agentsDir, `${name}.md`), content);
    log(`  wrote .claude/agents/${name}.md`);
  }
  // remove agents that left the team
  for (const f of fs.readdirSync(agentsDir)) {
    if (f.startsWith('sf-') && f.endsWith('.md') && !wanted.has(f)) {
      fs.rmSync(path.join(agentsDir, f));
      log(`  removed .claude/agents/${f} (no longer in team.yaml)`);
    }
  }
  return cfg;
}
