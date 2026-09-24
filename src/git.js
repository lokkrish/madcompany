import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureDir } from './paths.js';

export function git(cwd, args, { allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed:\n${(r.stderr || r.stdout).trim()}`);
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

const branchExists = (root, b) => git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], { allowFail: true }).ok;

/** Make sure an epic branch exists and has its own worktree for merging and previews. */
export function ensureEpicWorktree(paths, branch) {
  const { root } = paths;
  if (!branchExists(root, branch)) {
    const base = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).out;
    git(root, ['branch', branch, base === 'HEAD' ? 'HEAD' : base]);
  }
  const wt = path.join(paths.worktrees, branch.replace(/\//g, '-'));
  if (!fs.existsSync(wt)) {
    ensureDir(paths.worktrees);
    git(root, ['worktree', 'add', wt, branch]);
  }
  return wt;
}

function runChecks(checks, cwd, env) {
  for (const cmd of checks) {
    const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20 * 60 * 1000 });
    if (r.status !== 0) {
      const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n');
      return { ok: false, cmd, tail };
    }
  }
  return { ok: true };
}

/**
 * The merge queue step (MRG-1/2): merge one approved ticket branch into its
 * epic branch, run the checks there, and either mark it done or revert and
 * reopen it. One merge at a time.
 */
export async function mergeTicket(paths, client, config, id, { log = console.log } = {}) {
  const lockFile = path.join(paths.run, 'merge.lock');
  ensureDir(paths.run);
  try {
    fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx' });
  } catch {
    throw new Error(`Another merge is running (${lockFile}). Merges go one at a time.`);
  }
  try {
    const t = await client.call('ticket', id);
    const { reason: why } = await client.call('canMerge', t.id);
    if (why) throw new Error(why);
    const branch = `sf/${t.id.toLowerCase()}`;
    if (!branchExists(paths.root, branch)) throw new Error(`Branch ${branch} doesn't exist. The agent must commit on it before review.`);
    const base = await client.call('epicBranch', t.id);
    const wt = ensureEpicWorktree(paths, base);
    const before = git(wt, ['rev-parse', 'HEAD']).out;
    const merged = git(wt, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${t.id}: ${t.title}`, branch], { allowFail: true });
    if (!merged.ok) {
      const conflicts = git(wt, ['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).out.split('\n').filter(Boolean);
      git(wt, ['merge', '--abort'], { allowFail: true });
      const reason = `Merge conflict with ${base}${conflicts.length ? ` in ${conflicts.join(', ')}` : ''}. Merge ${base} into ${branch}, resolve, re-run checks and submit again.`;
      await client.call('reopen', 'cli', t.id, reason);
      await client.call('post', 'lead', { channel: `ticket:${t.id}`, text: `@${t.assignee} ${reason}` });
      log(`✗ ${t.id}: ${reason}`);
      return { ok: false, reason };
    }
    const env = await client.call('integrationEnv');
    const checks = runChecks(config.checks, wt, { PORT: String(env.ports.web), API_PORT: String(env.ports.api), DATABASE_URL: env.databaseUrl });
    if (!checks.ok) {
      git(wt, ['revert', '-m', '1', '--no-edit', 'HEAD']);
      const reason = `Checks failed on ${base} after merging (\`${checks.cmd}\`). The merge was reverted.\n\n${checks.tail}`;
      await client.call('reopen', 'cli', t.id, reason);
      await client.call('post', 'lead', { channel: `ticket:${t.id}`, text: `@${t.assignee} ${reason}` });
      log(`✗ ${t.id}: checks failed after merge; reverted and reopened.`);
      return { ok: false, reason };
    }
    const sha = git(wt, ['rev-parse', '--short', 'HEAD']).out;
    const commits = git(wt, ['log', '--no-merges', '--format=%h %s', `${before}..HEAD`]).out.split('\n').filter(Boolean);
    const res = await client.call('markMerged', 'cli', t.id, { sha, commits });
    log(`✓ ${t.id} merged into ${base} (${sha}). ${res.nowReady.length ? `Now ready: ${res.nowReady.join(', ')}` : ''}`);
    return { ok: true, sha, nowReady: res.nowReady };
  } finally {
    fs.rmSync(lockFile, { force: true });
  }
}

/** Commit HQ's logs, facts and design docs on the main checkout (HQ-8). Touches nothing else. */
export function snapshot(paths, { log = console.log } = {}) {
  const { root } = paths;
  const targets = ['.storyfront', 'docs/design'].filter((p) => fs.existsSync(path.join(root, p)));
  if (!targets.length) return log('Nothing to snapshot.');
  git(root, ['add', '--', ...targets]);
  const dirty = !git(root, ['diff', '--cached', '--quiet', '--', ...targets], { allowFail: true }).ok;
  if (!dirty) return log('Nothing new to snapshot.');
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  git(root, ['commit', '-m', `storyfront: snapshot ${stamp}`, '--', ...targets]);
  log(`Committed Storyfront logs and design docs (${git(root, ['rev-parse', '--short', 'HEAD']).out}).`);
}
