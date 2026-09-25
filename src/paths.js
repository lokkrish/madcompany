import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The project root is the main git worktree, so agents working in linked
 * worktrees still find the one shared .madcompany folder.
 */
export function findRoot(start = process.cwd()) {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: start,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (common) return path.dirname(common);
  } catch {
    // not a git repo; fall through
  }
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.madcompany'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

export function mcPaths(root) {
  const dir = path.join(root, '.madcompany');
  const log = path.join(dir, 'log');
  const run = path.join(dir, 'run');
  return {
    root,
    dir,
    log,
    events: path.join(log, 'events.jsonl'),
    chat: path.join(log, 'chat'),
    run,
    stop: path.join(run, 'STOP'),
    lock: path.join(run, 'hq.json'),
    cursors: path.join(run, 'cursors.json'),
    policy: path.join(run, 'policy.json'),
    agents: path.join(dir, 'agents'),
    team: path.join(dir, 'team.yaml'),
    facts: path.join(dir, 'facts.md'),
    ids: path.join(dir, 'ids.json'),
    shots: path.join(dir, 'shots'),
    worktrees: path.join(dir, 'worktrees'),
    bin: path.join(dir, 'bin'),
    design: path.join(root, 'docs', 'design'),
  };
}

/** Resolve a user-supplied relative path, refusing anything outside the root. */
export function safeJoin(root, rel) {
  const target = path.resolve(root, rel);
  const relToRoot = path.relative(root, target);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) return null;
  return target;
}

/** Files HQ never shows or serves: secrets and git internals. */
export function isHiddenPath(rel) {
  const parts = rel.split(/[\\/]/);
  if (parts.includes('.git') || parts.includes('node_modules')) return true;
  const base = parts[parts.length - 1];
  return /^\.env(\..+)?$/.test(base) && !/\.(example|sample|template)$/.test(base);
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}
