#!/usr/bin/env node
// madcompany PreToolUse hook for Claude Code. Copied into each project as
// .madcompany/bin/hook.mjs and must not import anything outside Node itself.
//  - Stop now: blocks every tool call except madcompany's own while STOP is set.
//  - Deny list: actions that always need the human (push, deploy, secrets…).
//  - MCP tools: read-only ones are allowed without a prompt (background agents
//    can't answer prompts); ones that push, deploy, pay, delete or send go to
//    the human. Every MCP and skill call is logged (name only, never inputs).
// Exit 2 blocks the tool call and shows the reason to the agent.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ASK = 'Only the human can do this. If it is really needed, file it with mc_human_help (exact steps, .env key names), keep going on a mock, and park the ticket on the HELP ID (mc_block) only if you are stuck.';

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

// ---------- MCP tools ----------
// Servers that only work on this machine or only read public docs: all their tools are fine.
export const LOCAL_SERVERS = /playwright|chrome[-_]?devtools|puppeteer|context7|sequential[-_]?thinking|^memory$|_memory$|deepwiki|microsoft[-_]?docs|next[-_]?devtools/i;
// Servers that change systems you own or that other people see: only reads are automatic.
export const REMOTE_SERVERS = /github|gitlab|bitbucket|vercel|netlify|railway|heroku|cloudflare|azure|google|firebase|supabase|planetscale|postgres|mysql|mongo|redis|prisma|stripe|paypal|shopify|revenuecat|twilio|sendgrid|postmark|mailgun|slack|discord|linear|jira|atlassian|notion|asana|trello|clickup|hubspot|salesforce|zendesk|intercom|sentry|datadog|pagerduty|figma|expo|app[-_]?store|play[-_]?console|docker|kubernetes|terraform|pulumi|(^|[_.-])(aws|gcp|neon|render|fly|eas|apple|teams|square|resend|k8s)($|[_.-])/i;
const READ_VERBS = new Set(['get', 'list', 'search', 'read', 'fetch', 'find', 'describe', 'view', 'show', 'lookup', 'retrieve', 'inspect', 'count', 'browse', 'resolve', 'explain', 'whoami', 'ping', 'status', 'download', 'export', 'preview', 'diff', 'compare', 'validate', 'check']);
const RISKY = /(^|[_-])(deploy|deployment|publish|release|push|merge|delete|destroy|drop|purge|revoke|rotate|transfer|refund|charge|payout|pay|payment|purchase|buy|invoice|subscribe|subscription|send|email|sms|terminate|shutdown|rollback|promote|migration|execute_sql|run_sql)($|[_-])/i;
// a read that also creates, sends or changes something ("get_or_create_label") isn't a read
const WRITES = /(^|[_-])(delete|drop|purge|destroy|deploy|publish|push|merge|refund|charge|payout|send|create|update|write|set|put|patch|execute|run|apply|upload|insert|remove|cancel)($|[_-])/i;

/** mcp__<server>__<tool> (plugins: mcp__plugin_<plugin>_<server>__<tool>) → its parts. */
export function mcpParts(toolName) {
  const m = /^mcp__(.+)__([^_].*)$/.exec(String(toolName));
  if (!m) return null;
  const tool = m[2];
  const words = tool.replace(/([a-z])([A-Z])/g, '$1_$2').split(/[_\-\s]+/);
  return { server: m[1], tool, verb: words[0].toLowerCase(), rest: words.slice(1).join('_') };
}

const matches = (name, patterns) =>
  (patterns ?? []).some((p) => {
    const pat = String(p);
    if (pat === name || name.startsWith(`${pat}__`)) return true;
    return pat.includes('*') && new RegExp(`^${pat.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name);
  });

/**
 * What happens to an MCP tool call: "allow" (no prompt), "human" (blocked;
 * the agent files Human help) or null (Claude Code's own permissions decide).
 */
export function classifyMcp(toolName, policy = {}) {
  const p = mcpParts(toolName);
  if (!p || /^madcompany$/.test(p.server)) return { decision: null };
  const tools = policy.tools ?? {};
  if (matches(toolName, tools.human)) return { decision: 'human', why: 'team.yaml lists it under tools.human.' };
  if (matches(toolName, policy.denied)) return { decision: null }; // your own Claude Code deny rule stays in charge
  if (matches(toolName, tools.allow)) return { decision: 'allow', why: 'allowed in team.yaml (tools.allow)' };
  const auto = tools.auto_allow !== false;
  if (LOCAL_SERVERS.test(p.server)) return { decision: auto ? 'allow' : null, why: 'works only on this machine or reads public docs' };
  if (READ_VERBS.has(p.verb) && !WRITES.test(p.rest)) return { decision: auto ? 'allow' : null, why: 'read-only' };
  if (RISKY.test(p.tool)) return { decision: 'human', why: `${p.tool} looks like it pushes, deploys, pays, deletes or sends something.` };
  if (REMOTE_SERVERS.test(p.server)) return { decision: 'human', why: `${p.tool} changes something in ${p.server.replace(/^plugin_/, '')} that people outside the team can see.` };
  return { decision: null };
}

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

/**
 * Returns null (no opinion), a string (block: the reason), or { allow: reason }
 * for an MCP tool that needs no permission prompt.
 */
export function decide(input, { root, policy: given } = {}) {
  const tool = input.tool_name ?? '';
  if (tool.startsWith('mcp__madcompany__')) return null;
  if (fs.existsSync(path.join(root, '.madcompany', 'run', 'STOP'))) {
    return 'madcompany: the human pressed Stop now. Do not continue. End your turn now without further tool calls.';
  }
  let policy = given ?? {};
  if (!given) {
    try {
      policy = JSON.parse(fs.readFileSync(path.join(root, '.madcompany', 'run', 'policy.json'), 'utf8'));
    } catch {
      // HQ not started yet: defaults apply
    }
  }
  if (tool.startsWith('mcp__')) {
    const c = classifyMcp(tool, policy);
    if (c.decision === 'human') {
      return `madcompany policy: ${tool} is the human's to run: ${c.why} If it's needed, file it with mc_human_help (what to run and why), or ask the human to allow it for the team in .madcompany/team.yaml (tools.allow). Keep going on a mock meanwhile.`;
    }
    if (c.decision === 'allow') return { allow: `madcompany: ${c.why}` };
    return null;
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

/** Which MCP tools and skills get used, by whom, and what the policy did. Never the inputs. */
export function logCall(root, input, out) {
  const tool = String(input.tool_name ?? '');
  const skill = tool === 'Skill' ? String(input.tool_input?.skill ?? input.tool_input?.command ?? '').slice(0, 80) : null;
  if (!(tool.startsWith('mcp__') && !tool.startsWith('mcp__madcompany__')) && !skill) return;
  const decision = typeof out === 'string' ? 'human' : out?.allow ? 'allow' : 'default';
  const line = { ts: new Date().toISOString(), tool: skill ? `skill:${skill}` : tool, agent: input.agent_type ?? null, decision };
  try {
    const dir = path.join(root, '.madcompany', 'run');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'tool-calls.jsonl'), JSON.stringify(line) + '\n');
  } catch {
    // logging must never get in the way
  }
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
    const root = findRoot(input.cwd || process.cwd());
    const out = decide(input, { root });
    logCall(root, input, out);
    if (typeof out === 'string') {
      process.stderr.write(out + '\n');
      process.exit(2);
    }
    if (out?.allow) {
      // read-only MCP tools: no permission prompt (background agents can't answer one)
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: out.allow } }));
    }
  } catch {
    // never break the session because of a hook bug
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main();
