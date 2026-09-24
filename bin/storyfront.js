#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findRoot, sfPaths } from '../src/paths.js';
import { loadConfig, SfError } from '../src/config.js';

const HELP = `Storyfront: a UI-first AI dev team that runs inside your Claude Code session.

Usage: npx storyfront <command> [options]

Set up
  init [--no-skills]      Set up Storyfront in this project (.storyfront/, .mcp.json, hook, skills)
  staff                   Create the agents in .storyfront/team.yaml (.claude/agents/sf-*.md)
  import [--epics F]      Anchor BMad planning docs and turn stories into tickets
  demo [dir]              Create a demo project with a day of simulated team activity

Run
  hq [--port 4317]        Start HQ (dashboard, chat, board…) at http://127.0.0.1:4317
  status                  One-screen summary of the team and tickets
  start-day | end-day | stop    Workday controls (also buttons in HQ)

Work
  merge <TICKET>          Merge an approved ticket into its epic branch, run checks, mark done
  snapshot                Commit HQ logs, facts and design docs (only those paths)
  env <agent|integration> Print the ports and database for an agent
  anchor <files…>         Add stable anchors to requirement/epic/story IDs
  refs check|fix [files…] Find (or fix) bare references like FR12 that should be links
  ids                     Rebuild .storyfront/ids.json

Docs: https://github.com/lokkrish/BMAD-company/blob/main/docs/USAGE.md`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === '--version' || cmd === '-v') return console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

  const root = findRoot();
  const paths = sfPaths(root);
  const { values: opts, positionals: args } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: { port: { type: 'string' }, epics: { type: 'string' }, prd: { type: 'string' }, 'no-skills': { type: 'boolean' }, json: { type: 'boolean' } },
  });

  switch (cmd) {
    case 'init': {
      const { init } = await import('../src/setup.js');
      if (!fs.existsSync(path.join(root, '.git'))) console.warn('Note: this folder is not a git repository. Storyfront needs git for branches and worktrees (git init).');
      init(paths, { skills: !opts['no-skills'], port: Number(opts.port ?? 4317) });
      console.log(`\nNext:\n  1. Edit .storyfront/team.yaml (or run /sf-staff in Claude Code)\n  2. npx storyfront staff\n  3. npx storyfront hq   (keep it running; open http://127.0.0.1:${opts.port ?? 4317})\n  4. In Claude Code: /sf-plan-epic, then /sf-start`);
      return;
    }
    case 'staff': {
      const { staff } = await import('../src/setup.js');
      const cfg = staff(paths);
      console.log(`Team of ${cfg.team.length}: ${cfg.team.map((m) => m.id).join(', ')}. The lead is your main Claude Code session (/sf-start).`);
      return;
    }
    case 'hq': {
      const { createHq } = await import('../src/hq/server.js');
      const { readLock } = await import('../src/client.js');
      const lock = readLock(paths);
      if (lock) {
        try {
          const res = await fetch(`http://127.0.0.1:${lock.port}/api/health`, { signal: AbortSignal.timeout(1000) });
          if (res.ok) return console.log(`HQ is already running: http://127.0.0.1:${lock.port}`);
        } catch {
          // stale lock
        }
      }
      const hq = createHq({ paths, port: Number(opts.port ?? process.env.STORYFRONT_PORT ?? 4317) });
      const port = await hq.listen();
      console.log(`Storyfront HQ: http://127.0.0.1:${port}  (project: ${root})\nPress Ctrl+C to stop.`);
      const bye = async () => {
        await hq.close();
        process.exit(0);
      };
      process.on('SIGINT', bye);
      process.on('SIGTERM', bye);
      return;
    }
    case 'demo': {
      const { createDemo } = await import('../src/demo.js');
      await createDemo(args[0] ?? 'storyfront-demo');
      return;
    }
    case 'import': {
      const { connect } = await import('../src/client.js');
      const { importBmad } = await import('../src/bmad/run.js');
      const c = await connect(paths);
      await importBmad(paths, c, { epics: opts.epics, prd: opts.prd });
      await c.close();
      return;
    }
    case 'status': {
      const { connect } = await import('../src/client.js');
      const c = await connect(paths);
      const s = await c.call('status', 'cli');
      await c.close();
      if (opts.json) return console.log(JSON.stringify(s, null, 2));
      console.log(`${s.project.name} · workday ${s.workday.state} · ${s.done_count} done, ${s.in_progress.length} in progress, ${s.in_review.length} in review, ${s.blocked.length} blocked, ${s.ready.length} ready`);
      for (const m of s.team) console.log(`  ${m.status.padEnd(8)} ${m.id.padEnd(12)} ${m.ticket ?? ''}`);
      if (s.open_questions.length) console.log(`Open questions: ${s.open_questions.map((q) => `${q.id} (${q.from}→${q.to})`).join(', ')}`);
      return;
    }
    case 'start-day':
    case 'end-day':
    case 'stop': {
      const { connect } = await import('../src/client.js');
      const c = await connect(paths);
      const op = { 'start-day': 'startDay', 'end-day': 'requestEndDay', stop: 'stopNow' }[cmd];
      const out = await c.call(op, 'cli');
      await c.close();
      console.log(`Workday: ${out.workday.state}`);
      return;
    }
    case 'merge': {
      if (!args[0]) throw new SfError('Usage: storyfront merge <TICKET>');
      const { connect } = await import('../src/client.js');
      const { mergeTicket } = await import('../src/git.js');
      const c = await connect(paths);
      const res = await mergeTicket(paths, c, loadConfig(paths), args[0]);
      await c.close();
      if (!res.ok) process.exitCode = 1;
      return;
    }
    case 'snapshot': {
      const { snapshot } = await import('../src/git.js');
      snapshot(paths);
      return;
    }
    case 'env': {
      const { connect } = await import('../src/client.js');
      const c = await connect(paths);
      const who = args[0] ?? 'integration';
      const e = who === 'integration' ? await c.call('integrationEnv') : await c.call('env', who);
      await c.close();
      console.log(`PORT=${e.ports.web}\nAPI_PORT=${e.ports.api}\nEXPO_PORT=${e.ports.expo}\nDATABASE_NAME=${e.db}${e.databaseUrl ? `\nDATABASE_URL=${e.databaseUrl}` : ''}`);
      return;
    }
    case 'anchor': {
      const { anchorMarkdown } = await import('../src/refs/anchor.js');
      if (!args.length) throw new SfError('Usage: storyfront anchor <file.md…>');
      for (const f of args) {
        const { text, added } = anchorMarkdown(fs.readFileSync(f, 'utf8'));
        if (added.length) fs.writeFileSync(f, text);
        console.log(`${f}: ${added.length ? `anchored ${added.join(', ')}` : 'nothing new'}`);
      }
      return;
    }
    case 'refs': {
      const { buildRegistry, listMarkdown, DEFAULT_DIRS } = await import('../src/refs/ids.js');
      const { findBareRefs, fixBareRefs } = await import('../src/refs/check.js');
      const [mode = 'check', ...files] = args;
      const reg = buildRegistry(root);
      const targets = files.length ? files.map((f) => path.relative(root, path.resolve(f)).split(path.sep).join('/')) : listMarkdown(root, DEFAULT_DIRS).filter((f) => !f.startsWith('.storyfront/log/'));
      let total = 0;
      for (const rel of targets) {
        const abs = path.join(root, rel);
        const md = fs.readFileSync(abs, 'utf8');
        if (mode === 'fix') {
          const { text, count } = fixBareRefs(md, reg, rel);
          if (count) fs.writeFileSync(abs, text);
          total += count;
          if (count) console.log(`${rel}: linked ${count}`);
        } else {
          for (const b of findBareRefs(md, reg)) {
            total += 1;
            console.log(`${rel}:${b.line}:${b.col}  ${b.id} is not a link`);
          }
        }
      }
      if (mode !== 'fix' && total) {
        console.log(`\n${total} bare reference(s). Run "npx storyfront refs fix" to link them.`);
        process.exitCode = 1;
      } else if (mode === 'fix') console.log(`Linked ${total} reference(s).`);
      else console.log('All references are links.');
      return;
    }
    case 'ids': {
      const { buildRegistry, writeRegistry } = await import('../src/refs/ids.js');
      const reg = buildRegistry(root);
      writeRegistry(paths.ids, reg);
      console.log(`${Object.keys(reg).length} IDs → ${path.relative(root, paths.ids)}`);
      return;
    }
    default:
      throw new SfError(`Unknown command "${cmd}". Run "npx storyfront help".`);
  }
}

main().catch((err) => {
  console.error(err instanceof SfError ? err.message : err.stack ?? err.message);
  process.exit(1);
});
