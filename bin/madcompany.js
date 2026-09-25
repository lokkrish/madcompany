#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { findRoot, mcPaths } from '../src/paths.js';
import { loadConfig, McError } from '../src/config.js';

const HELP = `madcompany: a UI-first AI dev team that runs inside your Claude Code session.

Usage: npx madcompany <command> [options]

Set up
  init [--mode M]         Set up madcompany in this project (.madcompany/, .mcp.json, hook, skills)
                          M: ui | mvp | ui-mvp | brownfield | spec (default ui-mvp)
  mode [M]                Show how this project is built and its steps, or switch to M
  scan [--json]           Brownfield: look at an existing codebase (stack, commands, services)
  staff [--template T]    Create the agents in .madcompany/team.yaml (.claude/agents/mc-*.md);
                          --template small|medium|large starts from a 5, 10 or 20-person team
  people add|list|link|remove   Who else can use HQ (owner, member or viewer) and their sign-in links
  import [--epics F]      Anchor BMad planning docs and turn stories into tickets
  demo [dir]              Create a demo project with a day of simulated team activity

Run
  hq [--port 4317]        Start HQ (dashboard, chat, board…) at http://127.0.0.1:4317
     [--share]            Let teammates in: everyone signs in with a link (see "people")
  status                  One-screen summary of the team and tickets
  start-day | end-day | stop    Workday controls (also buttons in HQ)

Work
  merge <TICKET>          Merge an approved ticket into its release or epic branch, run checks, mark done
  ship <R1|E1>            Merge an approved release or epic into main and tag it (push/deploy stay yours)
  snapshot                Commit HQ logs, facts and design docs (only those paths)
  env <agent|integration> Print the ports and database for an agent
  anchor <files…>         Add stable anchors to requirement/epic/story IDs
  refs check|fix [files…] Find (or fix) bare references like FR12 that should be links
  ids                     Rebuild .madcompany/ids.json

Docs: https://github.com/lokkrish/madcompany/blob/main/docs/USAGE.md`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === '--version' || cmd === '-v') return console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

  const root = findRoot();
  const paths = mcPaths(root);
  const { values: opts, positionals: args } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: { mode: { type: 'string' }, port: { type: 'string' }, epics: { type: 'string' }, prd: { type: 'string' }, 'no-skills': { type: 'boolean' }, json: { type: 'boolean' }, template: { type: 'string' }, force: { type: 'boolean' }, share: { type: 'boolean' }, bind: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, host: { type: 'string' } },
  });

  switch (cmd) {
    case 'init': {
      const { init } = await import('../src/setup.js');
      if (!fs.existsSync(path.join(root, '.git'))) console.warn('Note: this folder is not a git repository. madcompany needs git for branches and worktrees (git init).');
      init(paths, { skills: !opts['no-skills'], port: Number(opts.port ?? 4317), mode: opts.mode ?? null });
      const { modeInfo } = await import('../src/modes.js');
      const m = modeInfo(loadConfig(paths).mode);
      console.log(`\nNext (${m.title}):\n  • npx madcompany hq   (keep it running; open http://127.0.0.1:${opts.port ?? 4317})`);
      for (const [where, command, what] of m.flow.slice(1)) console.log(`  • ${where === 'Claude Code' ? 'In Claude Code: ' : where === 'HQ' ? 'In HQ: ' : ''}${command}  — ${what}`);
      return;
    }
    case 'mode': {
      const { MODES, modeInfo } = await import('../src/modes.js');
      if (args[0]) {
        const { setMode } = await import('../src/setup.js');
        setMode(paths, args[0]);
        console.log(`Mode set to ${args[0]} (${MODES[args[0]].title}). Agents were regenerated; restart Claude Code so they reload.`);
      }
      const m = modeInfo(loadConfig(paths).mode);
      console.log(`\n${m.title} (${m.name}): works in ${m.unit}s.\n${m.for}\nPlan: ${m.plan}\n`);
      m.ladder.forEach(([title, what], i) => console.log(`  ${m.unit === 'release' ? `R${i + 1}${i === m.ladder.length - 1 ? '+' : ''}` : '  '} ${title}: ${what}`));
      console.log('\nSteps:');
      m.flow.forEach(([where, command, what], i) => console.log(`  ${String(i + 1).padStart(2)}. [${where}] ${command}  — ${what}`));
      if (!args[0]) console.log(`\nOther modes: ${Object.keys(MODES).filter((k) => k !== m.name).join(', ')}. Switch with: npx madcompany mode <name>`);
      return;
    }
    case 'scan': {
      const { scanProject, formatScan } = await import('../src/scan.js');
      const r = scanProject(root);
      console.log(opts.json ? JSON.stringify(r, null, 2) : formatScan(r));
      return;
    }
    case 'ship': {
      if (!args[0]) throw new McError('Usage: madcompany ship <R1|E1>');
      const { connect } = await import('../src/client.js');
      const { shipUnit } = await import('../src/git.js');
      const c = await connect(paths);
      try {
        await shipUnit(paths, c, loadConfig(paths), args[0]);
      } finally {
        await c.close();
      }
      return;
    }
    case 'staff': {
      const { staff, applyTemplate } = await import('../src/setup.js');
      if (opts.template) {
        const { connect } = await import('../src/client.js');
        const c = await connect(paths);
        const st = await c.call('status', 'cli');
        await c.close();
        const busy = [...st.in_progress, ...st.blocked, ...st.in_review].map((t) => t.assignee).filter(Boolean);
        applyTemplate(paths, opts.template, { force: opts.force, busy });
        console.log(`Applied the ${opts.template} team template to .madcompany/team.yaml.`);
      }
      const cfg = staff(paths);
      console.log(`Team of ${cfg.team.length}: ${cfg.team.map((m) => m.id).join(', ')}. The lead is your main Claude Code session (/mc-start).`);
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
      const hq = createHq({ paths, port: Number(opts.port ?? process.env.MADCOMPANY_PORT ?? 4317), share: Boolean(opts.share), bind: opts.bind ?? null });
      const port = await hq.listen();
      if (opts.share) {
        const { createAccess } = await import('../src/auth.js');
        const os = await import('node:os');
        const ips = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
        const host = opts.host ?? ips[0] ?? '127.0.0.1';
        // so "madcompany people" can print links with the real address
        fs.writeFileSync(paths.lock, JSON.stringify({ ...readLock(paths), host }));
        console.log(`madcompany HQ (shared): http://${host}:${port}  (project: ${root})`);
        console.log(`Your sign-in link (keep it private): http://${host}:${port}/#/login/${createAccess(paths).issue('you')}`);
        console.log('Invite people with: npx madcompany people add <id> --name "Name" --role member|viewer');
        console.log('Use a private network (e.g. Tailscale) or an HTTPS tunnel for people outside your network.');
      } else {
        console.log(`madcompany HQ: http://127.0.0.1:${port}  (project: ${root})`);
      }
      console.log('Press Ctrl+C to stop.');
      const bye = async () => {
        await hq.close();
        process.exit(0);
      };
      process.on('SIGINT', bye);
      process.on('SIGTERM', bye);
      return;
    }
    case 'people': {
      const { addPerson, removePerson } = await import('../src/setup.js');
      const { createAccess } = await import('../src/auth.js');
      const { readLock } = await import('../src/client.js');
      const access = createAccess(paths);
      const lock = readLock(paths);
      const base = `http://${opts.host ?? lock?.host ?? '<your-address>'}:${lock?.port ?? 4317}`;
      const [sub, id] = args;
      if (sub === 'add') {
        if (!id) throw new McError('Usage: madcompany people add <id> --name "Name" --role member|viewer|owner');
        const p = addPerson(paths, { id, name: opts.name, role: opts.role ?? 'member' });
        console.log(`Added ${p.name} (${p.role}). Their sign-in link (send it privately):\n  ${base}/#/login/${access.issue(p.id)}`);
        if (!lock?.share) console.log('HQ must run with --share for them to reach it.');
      } else if (sub === 'link') {
        if (!id) throw new McError('Usage: madcompany people link <id>   (use "you" for your own)');
        if (id !== 'you' && !loadConfig(paths).people.some((x) => x.id === id)) throw new McError(`No person "${id}".`);
        console.log(`New sign-in link for ${id} (the old one stops working):\n  ${base}/#/login/${access.issue(id)}`);
      } else if (sub === 'remove') {
        if (!id) throw new McError('Usage: madcompany people remove <id>');
        removePerson(paths, id);
        access.revoke(id);
        console.log(`Removed ${id}; their link no longer works.`);
      } else {
        const cfg = loadConfig(paths);
        console.log(`you (owner)${access.hasLink('you') ? '' : ' · no link yet'}`);
        for (const x of cfg.people) console.log(`${x.id} · ${x.name} (${x.role})${access.hasLink(x.id) ? '' : ' · no link yet'}`);
      }
      return;
    }
    case 'demo': {
      const { createDemo } = await import('../src/demo.js');
      await createDemo(args[0] ?? 'madcompany-demo');
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
      console.log(`${s.project.name} · ${s.mode.title}${s.current_release ? ` · ${s.current_release.id} ${s.current_release.title} (${s.current_release.status})` : ''} · workday ${s.workday.state} · ${s.done_count} done, ${s.in_progress.length} in progress, ${s.in_review.length} in review, ${s.blocked.length} blocked, ${s.ready.length} ready`);
      for (const m of s.team) console.log(`  ${m.status.padEnd(8)} ${m.id.padEnd(12)} ${m.ticket ?? ''}`);
      if (s.open_questions.length) console.log(`Open questions: ${s.open_questions.map((q) => `${q.id} (${q.from}→${q.to})`).join(', ')}`);
      if (s.human_help_open.length) console.log(`Human help (only you can do these): ${s.human_help_open.map((h) => `${h.id} ${h.title}`).join('; ')}`);
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
      if (!args[0]) throw new McError('Usage: madcompany merge <TICKET>');
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
      if (!args.length) throw new McError('Usage: madcompany anchor <file.md…>');
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
      const targets = files.length ? files.map((f) => path.relative(root, path.resolve(f)).split(path.sep).join('/')) : listMarkdown(root, DEFAULT_DIRS).filter((f) => !f.startsWith('.madcompany/log/'));
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
        console.log(`\n${total} bare reference(s). Run "npx madcompany refs fix" to link them.`);
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
      throw new McError(`Unknown command "${cmd}". Run "npx madcompany help".`);
  }
}

main().catch((err) => {
  console.error(err instanceof McError ? err.message : err.stack ?? err.message);
  process.exit(1);
});
