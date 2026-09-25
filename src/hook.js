#!/usr/bin/env node
// madcompany PreToolUse hook for Claude Code. Copied into each project as
// .madcompany/bin/hook.mjs and must not import anything outside Node itself.
//  - Stop now: blocks every tool call except madcompany's own while STOP is set.
//  - Deny list: actions that always need the human (push, deploy, secrets…).
// Exit 2 blocks the tool call and shows the reason to the agent.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ASK = 'This needs the human. Park the ticket (mc_block) and ask the lead with mc_ask.';

const RULES = [
  [/\bgit\s+push\b[^\n;&|]*(\s(-f|--force|--force-with-lease|--mirror|--delete)\b|\s\+\S)/, 'Force-pushing or deleting remote branches rewrites shared history.'],
  [/\bgit\s+push\b/, 'Pushing to a remote is done by the human.', (p) => !p.allowPush],
  [/\bgit\s+(filter-branch|filter-repo)\b/, 'Rewriting git history.'],
  [/\bgit\s+rebase\b[^\n;&|]*\b(main|master|epic\/\S+)\b/, 'Rebasing a shared branch rewrites history.'],
  [/\bgit\s+branch\s+-D\s+(main|master|epic\/)/, 'Deleting the main branch or an epic branch.'],
  [/\bgit\s+reset\s+--hard\s+(origin\/)?(main|master|epic\/)/, 'Resetting a shared branch.'],
  [/\bvercel\b(?!\s+(dev|build|env\s+pull|link|whoami|login|ls|inspect|--version|-v|help)\b)/, 'Deploying (vercel).'],
  [/\b(netlify\s+deploy|fly(ctl)?\s+deploy|railway\s+up|eas\s+(submit|update)|serverless\s+deploy|sls\s+deploy|cdk\s+deploy|firebase\s+deploy|terraform\s+(apply|destroy)|pulumi\s+(up|destroy)|kubectl\s+(apply|delete|create|replace)|helm\s+(install|upgrade|uninstall))\b/, 'Deploying or changing infrastructure.'],
  [/\baz\s+[^\n;&|]*\b(create|delete|deploy|up|update|set|purge|restart)\b/, 'Changing Azure resources.'],
  [/\baws\s+\S+\s+(create|delete|deploy|put|update|run-instances|terminate|remove)/, 'Changing AWS resources.'],
  [/\bgcloud\b[^\n;&|]*\b(deploy|create|delete|update)\b/, 'Changing Google Cloud resources.'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bdocker\s+push\b/, 'Publishing a package or image.'],
  [/\b(npm|pnpm)\s+(i|install|add)\b[^\n;&|]*\s(-g|--global)\b|\byarn\s+global\s+add\b|\bbrew\s+install\b|\bsudo\b|\bapt(-get)?\s+install\b|\bpipx?\s+install\b[^\n;&|]*--user\b/, 'Installing software outside the project.'],
  [/\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|node|python3?)\b/, 'Running a script straight from the internet.'],
  [/(^|[\s;&|(])(cat|less|more|head|tail|bat|source|\.|grep|sed|awk|cp|mv)\s[^\n;&|]*?(?<=[\s/])\.env(\.local|\.production|\.prod|\.[\w-]+\.local)?(?=$|[\s;&|)])/, 'Reading or copying secrets from .env files.'],
  [/\b(gh\s+secret|vercel\s+env\s+(add|rm)|az\s+keyvault\s+secret|aws\s+secretsmanager|aws\s+ssm\s+put-parameter)\b/, 'Changing secrets.'],
  [/\b(stripe|twilio|sendgrid)\b[^\n;&|]*\b(live|--live)\b/, 'Using live payment or messaging credentials.'],
];

export function isSecretFile(p) {
  return /(^|[\\/])\.env(\.local|\.production|\.prod|\.[\w-]+\.local)?$/.test(String(p));
}

function rmOutsideRoot(cmd, root) {
  for (const m of cmd.matchAll(/\brm\s+((?:-[a-zA-Z]+\s+|--[a-z-]+\s+)+)([^\n;&|]+)/g)) {
    if (!/r/i.test(m[1]) && !/--recursive/.test(m[1])) continue;
    for (const raw of m[2].trim().split(/\s+/)) {
      const t = raw.replace(/^["']|["']$/g, '');
      if (!t) continue;
      if (t === '/' || t === '~' || t.startsWith('~/') || t.startsWith('$HOME') || t === '*' || t === '/*') return true;
      if (path.isAbsolute(t)) {
        const rel = path.relative(root, t);
        if ((rel.startsWith('..') || path.isAbsolute(rel)) && !t.startsWith('/tmp/')) return true;
      }
    }
  }
  return false;
}

/** Returns a reason string if the shell command must go to the human. */
export function checkCommand(cmd, { root = process.cwd(), allowPush = false } = {}) {
  const c = String(cmd);
  for (const [re, why, when] of RULES) {
    if (re.test(c) && (!when || when({ allowPush }))) return why;
  }
  if (rmOutsideRoot(c, root)) return 'Deleting files outside the project.';
  return null;
}

export function findRoot(cwd) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.dirname(common);
  } catch {
    return process.env.CLAUDE_PROJECT_DIR || cwd;
  }
}

export function decide(input, { root }) {
  const tool = input.tool_name ?? '';
  if (tool.startsWith('mcp__madcompany__')) return null;
  if (fs.existsSync(path.join(root, '.madcompany', 'run', 'STOP'))) {
    return 'madcompany: the human pressed Stop now. Do not continue. End your turn now without further tool calls.';
  }
  let policy = {};
  try {
    policy = JSON.parse(fs.readFileSync(path.join(root, '.madcompany', 'run', 'policy.json'), 'utf8'));
  } catch {
    // HQ not started yet: defaults apply
  }
  if (tool === 'Bash') {
    const why = checkCommand(input.tool_input?.command ?? '', { root, allowPush: policy.allowPush });
    if (why) return `madcompany policy: ${why} ${ASK}`;
  }
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) && isSecretFile(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '')) {
    return `madcompany policy: secrets in .env files are never read or written by agents. Use .env.example and mock adapters. ${ASK}`;
  }
  return null;
}

export const ARTIFACT_URL = /https:\/\/(?:claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+|claude\.site\/artifacts\/[A-Za-z0-9-]+)/g;

/**
 * PostToolUse: when a session publishes a Claude artifact, the link is in the
 * tool's result. Returns the links to save (title from what was published).
 */
export function artifactLinks(input) {
  const tool = String(input.tool_name ?? '');
  if (!/artifact/i.test(tool) || /comment|data/i.test(tool)) return [];
  const args = input.tool_input ?? {};
  if (args.action && args.action !== 'publish') return [];
  const urls = new Set(JSON.stringify(input.tool_response ?? '').match(ARTIFACT_URL) ?? []);
  if (typeof args.url === 'string') for (const u of args.url.match(ARTIFACT_URL) ?? []) urls.add(u);
  const file = args.file_path ? path.basename(String(args.file_path)).replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ') : '';
  const title = String(args.title || args.description || file || 'Claude artifact').slice(0, 140);
  const note = `Published from Claude Code${input.session_id ? ` (session ${String(input.session_id).slice(0, 8)})` : ''}`;
  return [...urls].map((url) => ({ url, title, note, kind: 'Claude artifact' }));
}

/** Save links to HQ if it's running, else queue them for HQ's next start. */
async function saveLinks(root, links) {
  if (!links.length) return;
  let port = null;
  try {
    port = JSON.parse(fs.readFileSync(path.join(root, '.madcompany', 'run', 'hq.json'), 'utf8')).port;
  } catch {
    // HQ not running
  }
  if (port) {
    try {
      for (const l of links) {
        const res = await fetch(`http://127.0.0.1:${port}/api/cli`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-madcompany-cli': '1' },
          body: JSON.stringify({ op: 'addLink', args: ['cli', l] }),
          signal: AbortSignal.timeout(1500),
        });
        if (!res.ok) throw new Error(String(res.status));
      }
      return;
    } catch {
      // fall through to the queue
    }
  }
  const dir = path.join(root, '.madcompany', 'run');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'pending-links.jsonl'), links.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

async function main() {
  let input = {};
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    process.exit(0);
  }
  if (process.argv[2] === 'post-tool') {
    try {
      await saveLinks(findRoot(input.cwd || process.cwd()), artifactLinks(input));
    } catch {
      // never break the session because of a hook bug
    }
    process.exit(0);
  }
  try {
    const why = decide(input, { root: findRoot(input.cwd || process.cwd()) });
    if (why) {
      process.stderr.write(why + '\n');
      process.exit(2);
    }
  } catch {
    // never break the session because of a hook bug
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
