import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { McError, member } from '../config.js';
import { ensureDir, safeJoin } from '../paths.js';
import { modeInfo } from '../modes.js';
import { discoverTools, serversFor, policyLine } from '../tools.js';

const STATUSES = ['todo', 'in_progress', 'blocked', 'in_review', 'done'];
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const HUMAN = 'you';
// what only a person can do; each Human help item has one of these kinds
export const HELP_KINDS = {
  account: 'Accounts & sign-ups',
  secret: 'Keys & secrets',
  setup: 'Service setup',
  money: 'Payments & purchases',
  ship: 'Push, deploy & publish',
  access: 'Access, data & legal',
  other: 'Other',
};

/**
 * All state changes go through here, whether they come from an agent (MCP),
 * from you (HQ web app) or from the CLI. The rules in the spec that can be
 * enforced in code are enforced here, not left to prompts.
 */
export function createCore({ store, config, paths }) {
  const s = () => store.state;
  const lead = config.leadId;

  // ---------- helpers ----------
  const isMember = (id) => Boolean(member(config, id));
  // you, plus anyone invited to HQ (config.people)
  const isHuman = (id) => id === HUMAN || config.people.some((p) => p.id === id);
  function actor(as, { allowHuman = false, allowCli = false } = {}) {
    if (allowHuman && isHuman(as)) return as;
    if (allowCli && as === 'cli') return 'cli';
    if (!isMember(as)) throw new McError(`Unknown team member "${as}". Pass your own id as "as" (one of: ${config.team.map((m) => m.id).join(', ')}).`);
    return as;
  }
  function leadOnly(as, what, { allowHuman = false, allowCli = false } = {}) {
    if (as === lead || (allowHuman && isHuman(as)) || (allowCli && as === 'cli')) return as;
    throw new McError(`Only the lead can ${what}.`);
  }
  function ticket(id) {
    const t = s().tickets[String(id ?? '').toUpperCase()];
    if (!t) throw new McError(`No ticket ${id}.`);
    return t;
  }
  const isDone = (id) => {
    const up = String(id).toUpperCase();
    if (s().tickets[up]) return s().tickets[up].status === 'done';
    if (s().questions[up]) return s().questions[up].status === 'answered';
    if (s().help[up]) return s().help[up].status !== 'open';
    return false;
  };
  const mode = () => modeInfo(config.mode);
  const byRelease = () => mode().unit === 'release';
  const depsDone = (t) => t.deps.every(isDone);
  const blockersDone = (t) => t.blockedBy.every(isDone);
  const isReady = (t) =>
    (t.status === 'todo' && depsDone(t)) || (t.status === 'blocked' && blockersDone(t) && depsDone(t));

  function unitBranch(id) {
    if (/^R\d+$/i.test(id)) return `release/${id.toLowerCase()}`;
    return `epic/${String(id).replace(/^E(pic)?[-\s]*/i, '').toLowerCase()}`;
  }
  function epicBranch(t) {
    // tickets merge into their release or epic branch, never straight into main
    if (t.release) return unitBranch(t.release);
    if (t.epic) return unitBranch(t.epic);
    return byRelease() ? 'release/next' : 'epic/misc';
  }

  function workdayControl(as) {
    const st = s().workday.state;
    if (as === lead || isHuman(as) || as === 'cli') return null;
    if (st === 'stopped') return 'STOP: stop now. End your turn immediately without further tool calls.';
    if (st === 'ending') return 'END_DAY: finish your current step, then call mc_block (with a checkpoint) or mc_submit, then mc_handoff, then end your turn.';
    if (st === 'off') return 'WORKDAY_OFF: the workday is off. Call mc_handoff and end your turn.';
    return null;
  }

  function agentStatus(id) {
    const st = s().workday.state;
    if (st === 'off' || st === 'stopped') return 'off';
    const mine = Object.values(s().tickets).filter((t) => t.assignee === id);
    if (mine.some((t) => t.status === 'in_progress')) return 'working';
    if (mine.some((t) => t.status === 'blocked')) return 'blocked';
    return 'idle';
  }

  function currentTicket(id) {
    const mine = Object.values(s().tickets).filter((t) => t.assignee === id);
    return (mine.find((t) => t.status === 'in_progress') ?? mine.find((t) => t.status === 'blocked'))?.id ?? null;
  }

  function nextId(counter, prefix) {
    return `${prefix}-${s().counters[counter] + 1}`;
  }

  function parseMentions(text) {
    const out = new Set();
    for (const m of String(text).matchAll(/@([a-z][a-z0-9-]*)/g)) {
      if (isMember(m[1]) || isHuman(m[1])) out.add(m[1]);
    }
    return [...out];
  }

  function channelFor(as, channel) {
    const c = String(channel ?? 'general').trim().replace(/^#/, '');
    if (c.startsWith('dm:')) {
      const other = c.slice(3).split('+').find((x) => x !== as) ?? c.slice(3);
      if (!isMember(other) && !isHuman(other)) throw new McError(`Unknown DM recipient "${other}".`);
      return `dm:${[as, other].sort().join('+')}`;
    }
    if (c.startsWith('ticket:')) return `ticket:${ticket(c.slice(7)).id}`;
    if (/^(general|contracts|epic-\d+)$/.test(c)) return c;
    throw new McError(`Unknown channel "${channel}". Use general, contracts, epic-N, dm:<id> or ticket:<ID>.`);
  }

  // ---------- cursors (unread tracking; runtime only) ----------
  function readCursors() {
    try {
      return JSON.parse(fs.readFileSync(paths.cursors, 'utf8'));
    } catch {
      return {};
    }
  }
  function writeCursor(id, seq) {
    const c = readCursors();
    c[id] = seq;
    ensureDir(paths.run);
    fs.writeFileSync(paths.cursors, JSON.stringify(c));
  }
  function inboxFor(id) {
    const since = readCursors()[id] ?? 0;
    return s().messages.filter(
      (m) =>
        m.seq > since &&
        m.by !== id &&
        (m.mentions.includes(id) ||
          (m.channel.startsWith('dm:') && m.channel.slice(3).split('+').includes(id)) ||
          (id === lead && isHuman(m.by))),
    );
  }

  // ---------- read models ----------
  function teamView() {
    return config.team.map((m) => ({
      id: m.id,
      role: m.role,
      type: m.type,
      dept: m.dept,
      domain: m.domain,
      also: m.also,
      model: m.model,
      lead: m.lead,
      status: agentStatus(m.id),
      ticket: currentTicket(m.id),
      lastActivity: s().lastActivity[m.id] ?? null,
      handoff: s().handoffs[m.id] ?? null,
    }));
  }

  function briefTicket(t) {
    return { id: t.id, title: t.title, status: t.status, assignee: t.assignee, epic: t.epic, release: t.release, domain: t.domain, deps: t.deps, blockedBy: t.blockedBy, ui: t.ui, kind: t.kind };
  }

  function status(as) {
    actor(as, { allowHuman: true, allowCli: true });
    const tickets = Object.values(s().tickets);
    const by = (st) => tickets.filter((t) => t.status === st).map(briefTicket);
    return {
      project: config.project,
      workday: s().workday,
      max_parallel: config.max_parallel,
      team: teamView(),
      ready: tickets.filter(isReady).map(briefTicket),
      in_progress: by('in_progress'),
      in_review: by('in_review'),
      blocked: by('blocked'),
      todo_count: tickets.filter((t) => t.status === 'todo').length,
      done_count: tickets.filter((t) => t.status === 'done').length,
      open_questions: Object.values(s().questions).filter((q) => q.status === 'open').map((q) => ({ id: q.id, from: q.from, to: q.to, question: q.question })),
      mode: { name: mode().name, title: mode().title, unit: mode().unit, guidance: mode().guidance },
      current_release: byRelease() ? currentRelease() : null,
      human_help_open: Object.values(s().help).filter((h) => h.status === 'open').map((h) => ({ id: h.id, title: h.title, kind: h.kind, tickets: h.tickets })),
      unread: isHuman(as) || as === 'cli' ? 0 : inboxFor(as).length,
      control: workdayControl(as),
    };
  }

  function dashboard() {
    const tickets = Object.values(s().tickets);
    const epics = {};
    for (const t of tickets) {
      const key = t.epic ?? 'No epic';
      epics[key] ??= { id: key, title: s().epics[key]?.title ?? key, total: 0, done: 0, phase: s().epics[key]?.phase ?? null };
      epics[key].total += 1;
      if (t.status === 'done') epics[key].done += 1;
    }
    const help = Object.values(s().help).filter((h) => h.status === 'open');
    const today = new Date().toISOString().slice(0, 10);
    const todays = store.events.filter((e) => e.ts.startsWith(today));
    const shots = tickets
      .flatMap((t) => t.attachments.filter((a) => a.kind === 'screenshot').map((a) => ({ ...a, ticket: t.id })))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .slice(0, 6);
    const lastChecks = tickets
      .flatMap((t) => t.worklog.filter((w) => w.checks).map((w) => ({ ...w, ticket: t.id })))
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))[0];
    return {
      project: config.project,
      owner: config.owner,
      workday: s().workday,
      team: teamView(),
      epics: Object.values(epics),
      mode: { name: mode().name, title: mode().title, unit: mode().unit },
      units: units(),
      inReview: units().filter((u) => u.status === 'review').map((u) => ({ id: u.id, title: u.title })),
      help: { open: help.length, blocking: help.filter((h) => waitingOn(h.id).length).length, top: help.slice(0, 3).map((h) => ({ id: h.id, title: h.title })) },
      needsYou: Object.values(s().questions).filter((q) => q.to === HUMAN && q.status === 'open').map((q) => ({ id: q.id, question: q.question })),
      blocked: tickets.filter((t) => t.status === 'blocked').map((t) => ({ id: t.id, title: t.title, blockedBy: t.blockedBy, assignee: t.assignee })),
      shots,
      decisions: s().decisions.slice(-5).reverse(),
      preview: config.preview,
      today: {
        ticketsMoved: todays.filter((e) => e.type === 'ticket.status' || e.type === 'ticket.claim').length,
        commits: todays.filter((e) => e.type === 'ticket.commit').reduce((n, e) => n + (e.data.commits?.length ?? 0), 0),
        messages: todays.filter((e) => e.type === 'msg.post').length,
        lastChecks: lastChecks ? { ticket: lastChecks.ticket, checks: lastChecks.checks, ts: lastChecks.ts } : null,
      },
    };
  }

  // ---------- workday ----------
  function startDay(as) {
    leadOnly(as, 'start the day', { allowHuman: true, allowCli: true });
    fs.rmSync(paths.stop, { force: true });
    if (s().workday.state !== 'on') store.append('workday.start', as);
    return briefing();
  }
  function briefing() {
    const st = status('cli');
    return {
      ...st,
      handoffs: s().handoffs,
      // the humans in HQ besides "you"; agents can @mention them
      people: config.people,
      mode_guidance: mode().guidance,
      tools: toolsSummary(),
      human_messages: s().messages.filter((m) => isHuman(m.by)).slice(-5),
      answered_for_you: Object.values(s().questions).filter((q) => q.status === 'answered' && isHuman(q.answeredBy)).slice(-5),
    };
  }
  function requestEndDay(as) {
    leadOnly(as, 'end the day', { allowHuman: true, allowCli: true });
    if (s().workday.state === 'on') store.append('workday.ending', as);
    return { workday: s().workday };
  }
  function stopNow(as) {
    leadOnly(as, 'stop the team', { allowHuman: true, allowCli: true });
    ensureDir(paths.run);
    fs.writeFileSync(paths.stop, new Date().toISOString());
    store.append('workday.stop', as);
    return { workday: s().workday };
  }
  function endDay(as) {
    leadOnly(as, 'close the day', { allowHuman: true, allowCli: true });
    const working = teamView().filter((m) => m.status === 'working' && m.id !== lead);
    if (working.length && s().workday.state !== 'stopped') {
      throw new McError(`Still working: ${working.map((m) => `${m.id} (${m.ticket})`).join(', ')}. Wait for their handoffs, or use Stop now.`);
    }
    store.append('workday.end', as);
    return { workday: s().workday };
  }

  // ---------- tickets ----------
  function checkDeps(deps, selfId) {
    const out = [];
    for (const d of deps ?? []) {
      const id = String(d).toUpperCase();
      if (id === selfId) throw new McError(`${selfId} can't depend on itself.`);
      if (!s().tickets[id]) throw new McError(`Dependency ${id} doesn't exist.`);
      out.push(id);
    }
    if (selfId) {
      // reject cycles
      const seen = new Set();
      const walk = (id) => {
        if (id === selfId) throw new McError(`That dependency would create a cycle through ${selfId}.`);
        if (seen.has(id)) return;
        seen.add(id);
        for (const n of s().tickets[id]?.deps ?? []) walk(n);
      };
      out.forEach(walk);
    }
    return out;
  }

  function createTicket(as, f) {
    leadOnly(as, 'create tickets', { allowHuman: true, allowCli: true });
    if (!f?.title) throw new McError('A ticket needs a title.');
    if (f.source) {
      const existing = Object.values(s().tickets).find((t) => t.source === f.source);
      if (existing) return { ticket: briefTicket(existing), existing: true };
    }
    if (f.assignee && !isMember(f.assignee)) throw new McError(`Unknown assignee "${f.assignee}".`);
    const release = f.release ? unit(f.release, 'release').id : !f.epic && byRelease() ? currentRelease()?.id ?? null : null;
    const id = nextId('ticket', config.project.key);
    const deps = checkDeps(f.deps);
    if (f.epic && !s().epics[f.epic]) store.append('epic.upsert', as, { id: f.epic, title: f.epicTitle ?? f.epic, phase: 'build' });
    store.append('ticket.create', as, {
      id,
      title: String(f.title),
      epic: f.epic ?? null,
      release,
      body: f.body ?? '',
      domain: f.domain ?? null,
      deps,
      ui: Boolean(f.ui),
      refs: f.refs ?? [],
      kind: f.kind ?? 'task',
      source: f.source ?? null,
      assignee: f.assignee ?? null,
    });
    return { ticket: briefTicket(s().tickets[id]) };
  }

  function updateTicket(as, id, fields = {}) {
    leadOnly(as, 'edit tickets', { allowCli: true });
    const t = ticket(id);
    const clean = {};
    for (const k of ['title', 'body', 'domain', 'ui', 'epic', 'refs']) if (k in fields) clean[k] = fields[k];
    if ('release' in fields) clean.release = fields.release ? unit(fields.release, 'release').id : null;
    if ('deps' in fields) clean.deps = checkDeps(fields.deps, t.id);
    if (!Object.keys(clean).length) throw new McError('Nothing to update.');
    store.append('ticket.update', as, { id: t.id, fields: clean });
    return { ticket: briefTicket(t) };
  }

  function assign(as, id, agent) {
    leadOnly(as, 'assign tickets', { allowCli: true });
    const t = ticket(id);
    if (!isMember(agent)) throw new McError(`Unknown agent "${agent}".`);
    store.append('ticket.assign', as, { id: t.id, agent });
    return { ticket: briefTicket(t) };
  }

  function next(as) {
    const m = member(config, actor(as));
    const ready = Object.values(s().tickets).filter(isReady);
    const mine = ready.filter((t) => t.assignee === as);
    const words = [...m.domain, ...m.also].map((w) => w.toLowerCase());
    const matches = ready
      .filter((t) => !t.assignee)
      .map((t) => ({ t, score: words.filter((w) => `${t.domain ?? ''} ${t.title}`.toLowerCase().includes(w)).length }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.t);
    return { yours: mine.map(briefTicket), suggestions: matches.slice(0, 3).map(briefTicket), control: workdayControl(as) };
  }

  function claim(as, id) {
    actor(as);
    const ctl = workdayControl(as);
    if (ctl) throw new McError(ctl);
    const t = ticket(id);
    if (t.assignee && t.assignee !== as) throw new McError(`${t.id} is assigned to ${t.assignee}.`);
    if (t.status === 'done' || t.status === 'in_review') throw new McError(`${t.id} is ${t.status}.`);
    if (t.status === 'in_progress' && t.assignee !== as) throw new McError(`${t.id} is being worked on by ${t.assignee}.`);
    if (!depsDone(t)) throw new McError(`${t.id} depends on ${t.deps.filter((d) => !isDone(d)).join(', ')}, which aren't done yet.`);
    if (t.status === 'blocked' && !blockersDone(t)) throw new McError(`${t.id} is still blocked by ${t.blockedBy.filter((d) => !isDone(d)).join(', ')}.`);
    if (t.attempts >= config.limits.attempts) {
      throw new McError(`${t.id} has hit its limit of ${config.limits.attempts} attempts. Don't retry: ask the lead with mc_ask.`);
    }
    // read the blockers before claiming: a claim clears them
    const blockers = [...t.blockedBy];
    store.append('ticket.claim', as, { id: t.id });
    if (t.release && s().releases[t.release]?.status === 'planned') store.append('unit.status', as, { id: t.release, status: 'building' });
    const depNotes = t.deps.map((d) => {
      const dt = s().tickets[d];
      return { id: d, title: dt.title, lastWorklog: dt.worklog.at(-1)?.text ?? null };
    });
    const blockerNotes = blockers.map((b) => s().questions[b] ?? s().tickets[b] ?? s().help[b]).filter(Boolean);
    return {
      ticket: { ...briefTicket(t), body: t.body, refs: t.refs, attempts: t.attempts },
      resume_from: t.checkpoint,
      dependencies: depNotes,
      resolved_blockers: blockerNotes.map((b) =>
        b.question ? { id: b.id, question: b.question, answer: b.answer } : b.steps ? { id: b.id, title: b.title, status: b.status, note: b.note, env: b.env } : { id: b.id, title: b.title },
      ),
      git: gitPlan(t),
      env: env(as),
      facts: s().facts.map((f) => `${f.id}: ${f.text}`),
      designs: Object.values(s().designs).map((d) => ({ path: d.path, owner: d.owner, status: d.status })),
      unread: inboxFor(as).length,
    };
  }

  /** Everything about one ticket, including its git branch, so a reviewer can check it out. */
  function ticketInfo(as, id) {
    actor(as, { allowHuman: true, allowCli: true });
    const t = ticket(id);
    const branch = `mc/${t.id.toLowerCase()}`;
    return {
      ...t,
      activity: t.activity.slice(-15),
      git: { branch, base: epicBranch(t), review: `git switch --detach ${branch} && git diff ${epicBranch(t)}...${branch}`, note: 'Run in your own worktree. Never check out the branch itself.' },
      thread: s().messages.filter((m) => m.channel === `ticket:${t.id}`).slice(-10).map((m) => ({ by: m.by, text: m.text })),
    };
  }

  function isGitRepo() {
    return fs.existsSync(path.join(paths.root, '.git'));
  }
  function branchExists(branch) {
    return spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: paths.root }).status === 0;
  }
  function baseRef(t) {
    const base = epicBranch(t);
    if (branchExists(base)) return base;
    const head = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: paths.root, encoding: 'utf8' }).stdout.trim();
    return head && head !== 'HEAD' ? head : 'HEAD';
  }
  function newCommits(t) {
    const r = spawnSync('git', ['rev-list', '--count', `${baseRef(t)}..mc/${t.id.toLowerCase()}`], { cwd: paths.root, encoding: 'utf8' });
    return r.status === 0 ? Number(r.stdout.trim()) : 0;
  }

  /**
   * Ticket branches are never checked out (git refuses one branch in two
   * worktrees, and a resumed agent gets a fresh worktree). Agents start
   * detached from the ticket branch or its base, and save by moving the
   * ticket branch to their HEAD.
   */
  function gitPlan(t) {
    const branch = `mc/${t.id.toLowerCase()}`;
    const base = epicBranch(t);
    return {
      branch,
      base,
      start: `git switch --detach ${branch} 2>/dev/null || git switch --detach ${base} 2>/dev/null || git switch --detach`,
      save: `git add -A && git commit -qm "${t.id}: <what changed>"; git branch -f ${branch} HEAD`,
      note: `Run git in your current directory (your own worktree); never cd elsewhere and never check out ${branch}. Run "save" after every meaningful step and before mc_block or mc_submit.`,
    };
  }

  function mustOwn(as, t, st) {
    if (t.assignee !== as) throw new McError(`${t.id} isn't yours (assignee: ${t.assignee ?? 'nobody'}).`);
    if (st && t.status !== st) throw new McError(`${t.id} is ${t.status}, expected ${st}.`);
  }

  function log(as, id, text) {
    actor(as);
    const t = ticket(id);
    if (!text) throw new McError('Empty log entry.');
    store.append('ticket.worklog', as, { id: t.id, text: String(text) });
    return { ok: true, control: workdayControl(as) };
  }

  function block(as, id, f = {}) {
    actor(as);
    const t = ticket(id);
    mustOwn(as, t, 'in_progress');
    const blockedBy = (f.blockedBy ?? []).map((b) => String(b).toUpperCase());
    if (!blockedBy.length) throw new McError('Say what blocks it: blockedBy is a list of ticket, question or HELP IDs.');
    for (const b of blockedBy) if (!s().tickets[b] && !s().questions[b] && !s().help[b]) throw new McError(`${b} isn't a ticket, question or HELP ID.`);
    if (!f.done || !f.next) throw new McError('A checkpoint needs "done" (what is finished) and "next" (the exact next step).');
    store.append('ticket.checkpoint', as, { id: t.id, done: f.done, next: f.next, files: f.files ?? [], questions: f.questions ?? [] });
    store.append('ticket.status', as, { id: t.id, status: 'blocked', blockedBy });
    return { ok: true, message: `${t.id} parked. Commit your work in progress, then call mc_next or end your turn.`, control: workdayControl(as) };
  }

  function checkpoint(as, id, f = {}) {
    actor(as);
    const t = ticket(id);
    mustOwn(as, t);
    if (!f.done || !f.next) throw new McError('A checkpoint needs "done" and "next".');
    store.append('ticket.checkpoint', as, { id: t.id, done: f.done, next: f.next, files: f.files ?? [], questions: f.questions ?? [] });
    return { ok: true, control: workdayControl(as) };
  }

  function submit(as, id, f = {}) {
    actor(as);
    const t = ticket(id);
    mustOwn(as, t, 'in_progress');
    if (!f.summary) throw new McError('A work-log summary is required before review.');
    const checks = f.checks ?? {};
    if (!Object.keys(checks).length) throw new McError('Report your checks, e.g. {"typecheck":"pass","lint":"pass","test":"pass"}. Use "n/a" where a check does not exist yet.');
    const failing = Object.entries(checks).filter(([, v]) => v !== 'pass' && v !== 'n/a');
    if (failing.length) throw new McError(`Fix failing checks first: ${failing.map(([k, v]) => `${k}=${v}`).join(', ')}.`);
    if (isGitRepo()) {
      const { branch, save } = gitPlan(t);
      if (!branchExists(branch)) throw new McError(`Branch ${branch} doesn't exist yet. Commit your work and run: ${save}`);
      if (newCommits(t) === 0) throw new McError(`${branch} has no commits beyond ${baseRef(t)}. Your work is probably on another branch: commit it and run \`git branch -f ${branch} HEAD\`, then submit again.`);
    }
    if (t.ui && !t.attachments.some((a) => a.kind === 'screenshot')) {
      throw new McError(`${t.id} is a UI ticket: attach at least one screenshot with mc_attach before review.`);
    }
    store.append('ticket.worklog', as, { id: t.id, text: String(f.summary), checks });
    if (f.commits?.length) store.append('ticket.commit', as, { id: t.id, commits: f.commits.map(String) });
    store.append('ticket.status', as, { id: t.id, status: 'in_review' });
    return { ok: true, message: `${t.id} is in review. Call mc_handoff if you're done for now, then end with a short report.` };
  }

  function review(as, id, f = {}) {
    actor(as);
    const t = ticket(id);
    if (t.status !== 'in_review') throw new McError(`${t.id} isn't in review.`);
    if (t.assignee === as) throw new McError(`You can't review your own ticket (${t.id}).`);
    if (!['approve', 'changes'].includes(f.verdict)) throw new McError('verdict must be "approve" or "changes".');
    store.append('ticket.review', as, { id: t.id, verdict: f.verdict, notes: f.notes ?? '' });
    if (f.verdict === 'changes') store.append('ticket.status', as, { id: t.id, status: 'in_progress', reason: 'changes requested' });
    return { ok: true };
  }

  function canMerge(t) {
    if (t.status !== 'in_review') return `${t.id} is ${t.status}, not in review.`;
    const last = t.reviews.at(-1);
    if (!last || last.verdict !== 'approve' || last.by === t.assignee) return `${t.id} needs an approving review from someone other than ${t.assignee}.`;
    if (!t.worklog.some((w) => w.checks)) return `${t.id} has no work-log entry with checks.`;
    return null;
  }

  function markMerged(as, id, f = {}) {
    leadOnly(as, 'merge tickets', { allowCli: true });
    const t = ticket(id);
    const why = canMerge(t);
    if (why) throw new McError(why);
    if (f.commits?.length) store.append('ticket.commit', as, { id: t.id, commits: f.commits });
    store.append('ticket.status', as, { id: t.id, status: 'done', reason: f.sha ? `merged ${f.sha}` : 'merged' });
    return { ok: true, nowReady: Object.values(s().tickets).filter(isReady).map((x) => x.id) };
  }

  function reopen(as, id, reason) {
    leadOnly(as, 'reopen tickets', { allowCli: true });
    const t = ticket(id);
    store.append('ticket.worklog', as, { id: t.id, text: `Reopened: ${reason ?? 'no reason given'}` });
    store.append('ticket.status', as, { id: t.id, status: 'todo', reason: 'reopened' });
    return { ok: true };
  }

  function attach(as, id, f = {}) {
    actor(as);
    const t = ticket(id);
    const src = path.resolve(paths.root, String(f.path ?? ''));
    if (!IMAGE.test(src)) throw new McError('Only png, jpg, webp or gif screenshots can be attached.');
    if (!fs.existsSync(src)) throw new McError(`File not found: ${src}`);
    if (fs.statSync(src).size > 8 * 1024 * 1024) throw new McError('Screenshot is over 8 MB.');
    ensureDir(paths.shots);
    const n = t.attachments.length + 1;
    const name = `${t.id.toLowerCase()}-${n}${path.extname(src).toLowerCase()}`;
    fs.copyFileSync(src, path.join(paths.shots, name));
    store.append('ticket.attach', as, { id: t.id, kind: 'screenshot', path: `.madcompany/shots/${name}`, caption: f.caption ?? '' });
    return { ok: true, path: `.madcompany/shots/${name}` };
  }

  function handoff(as, f = {}) {
    actor(as);
    store.append('handoff', as, { done: f.done ?? '', inProgress: f.inProgress ?? '', next: f.next ?? '', waitingOn: f.waitingOn ?? '' });
    return { ok: true };
  }

  // ---------- chat & questions ----------
  function post(as, f = {}) {
    actor(as, { allowHuman: true });
    if (!f.text?.trim()) throw new McError('Empty message.');
    const channel = channelFor(as, f.channel);
    const id = nextId('msg', 'M');
    store.append('msg.post', as, { id, channel, text: String(f.text), mentions: parseMentions(f.text) });
    return { ok: true, id, channel };
  }

  function read(as) {
    actor(as);
    const msgs = inboxFor(as);
    if (msgs.length) writeCursor(as, msgs.at(-1).seq);
    return { messages: msgs.map((m) => ({ id: m.id, channel: m.channel, by: m.by, text: m.text, ts: m.ts })), control: workdayControl(as) };
  }

  function ask(as, f = {}) {
    actor(as);
    const to = f.to === 'lead' ? lead : f.to;
    if (!isMember(to)) throw new McError(`Unknown recipient "${f.to}". Ask a team member or "lead"; only the lead escalates to the human.`);
    if (to === as) throw new McError("You can't ask yourself.");
    if (!f.question) throw new McError('Empty question.');
    const id = nextId('q', 'Q');
    store.append('question.ask', as, { id, to, question: String(f.question), ticket: f.ticket ? ticket(f.ticket).id : null, options: f.options ?? [], links: f.links ?? [] });
    post(as, { channel: `dm:${to}`, text: `${id} @${to}: ${f.question}` });
    // REL-3: a question bouncing between the same two agents goes to the lead.
    const pair = [as, to].sort().join('+');
    const bounces = Object.values(s().questions).filter(
      (q) => q.status === 'open' && [q.from, q.to].sort().join('+') === pair && (!f.ticket || q.ticket === s().questions[id].ticket),
    ).length;
    if (bounces >= 3 && to !== lead) {
      store.append('question.escalate', 'cli', { id, to: lead, reason: `ping-pong between ${as} and ${to}` });
    }
    return { ok: true, id, note: 'Don\'t wait for the answer. If you can\'t continue, park the ticket with mc_block (blockedBy: ["' + id + '"]).' };
  }

  function answer(as, qid, text) {
    actor(as, { allowHuman: true });
    const q = s().questions[String(qid).toUpperCase()];
    if (!q) throw new McError(`No question ${qid}.`);
    if (q.status !== 'open') throw new McError(`${q.id} is already answered.`);
    if (as !== q.to && as !== lead && !isHuman(as)) throw new McError(`${q.id} is for ${q.to}.`);
    if (!text) throw new McError('Empty answer.');
    store.append('question.answer', as, { id: q.id, answer: String(text) });
    if (isHuman(as)) {
      const fid = nextId('fact', 'F');
      store.append('fact.add', as, { id: fid, text: `${q.question} → ${text}`, source: q.id });
      writeFacts();
    }
    post(as, { channel: `dm:${isHuman(q.from) ? lead : q.from}`, text: `${q.id} answered: ${text}` });
    return { ok: true };
  }

  function escalate(as, f = {}) {
    leadOnly(as, 'escalate to the human');
    const options = (f.options ?? []).map(String);
    if (options.length < 2) throw new McError('Escalations to the human are multiple-choice: give at least 2 options.');
    const recommended = f.recommended ?? options[0];
    if (!options.includes(recommended)) throw new McError('"recommended" must be one of the options.');
    if (f.q) {
      const q = s().questions[String(f.q).toUpperCase()];
      if (!q) throw new McError(`No question ${f.q}.`);
      store.append('question.escalate', as, { id: q.id, to: HUMAN, options, recommended, links: f.links ?? q.links, question: f.question ?? q.question });
      return { ok: true, id: q.id };
    }
    if (!f.question) throw new McError('Empty question.');
    const id = nextId('q', 'Q');
    store.append('question.ask', as, { id, to: HUMAN, question: String(f.question), options, recommended, links: f.links ?? [], ticket: f.ticket ? ticket(f.ticket).id : null });
    return { ok: true, id };
  }

  function decide(as, f = {}) {
    actor(as);
    if (!f.title || !f.decision || !f.why) throw new McError('A decision needs a title, the decision and why.');
    const id = nextId('dec', 'DEC');
    store.append('decision.log', as, { id, title: f.title, decision: f.decision, why: f.why, alternatives: f.alternatives ?? '', links: f.links ?? [], ticket: f.ticket ?? null });
    return { ok: true, id };
  }

  function facts() {
    return { facts: s().facts.map((f) => ({ id: f.id, text: f.text, source: f.source })) };
  }

  function writeFacts() {
    const lines = ['# Facts', '', 'Answers you have given. Agents check this before asking you anything.', ''];
    for (const f of s().facts) lines.push(`- <a id="${f.id.toLowerCase()}"></a>**${f.id}** ${f.text}${f.source ? ` ([${f.source}](log/questions.md#${f.source.toLowerCase()}))` : ''}`);
    fs.writeFileSync(paths.facts, lines.join('\n') + '\n');
  }

  // ---------- design packs ----------
  function designPath(p) {
    const rel = path.posix.normalize(String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, ''));
    if (!rel.startsWith('docs/design/') || rel.includes('..')) throw new McError('Design docs live under docs/design/<area>/.');
    return rel;
  }
  function designWrite(as, f = {}) {
    actor(as);
    const rel = designPath(f.path);
    const doc = s().designs[rel];
    if (doc && doc.owner !== as && as !== lead) throw new McError(`${rel} is owned by ${doc.owner}. Ask them (mc_ask) instead of editing it.`);
    if (doc?.status === 'frozen' && as !== lead) throw new McError(`${rel} is frozen. Ask the lead to unfreeze it.`);
    const consumers = (f.consumers ?? doc?.consumers ?? []).filter((c) => c !== as);
    for (const c of consumers) if (!isMember(c)) throw new McError(`Unknown consumer "${c}".`);
    const full = path.join(paths.root, rel);
    ensureDir(path.dirname(full));
    fs.writeFileSync(full, String(f.content ?? ''));
    const wasAgreed = doc && doc.status !== 'draft';
    store.append('design.write', as, { path: rel, consumers });
    if (consumers.length) {
      post(as, { channel: 'contracts', text: `${wasAgreed ? 'Changed' : 'Draft'}: ${rel} (v${s().designs[rel].version}). Please review and approve: ${consumers.map((c) => '@' + c).join(' ')}` });
    }
    return { ok: true, design: s().designs[rel] };
  }
  function designApprove(as, p) {
    actor(as);
    const rel = designPath(p);
    const doc = s().designs[rel];
    if (!doc) throw new McError(`No design doc ${rel}.`);
    if (!doc.consumers.includes(as)) throw new McError(`You're not listed as a consumer of ${rel}.`);
    store.append('design.approve', as, { path: rel });
    return { ok: true, design: s().designs[rel] };
  }
  function designFreeze(as, p, frozen = true) {
    leadOnly(as, 'freeze design docs');
    const rel = designPath(p);
    if (!s().designs[rel]) throw new McError(`No design doc ${rel}.`);
    store.append('design.status', as, { path: rel, status: frozen ? 'frozen' : 'draft' });
    return { ok: true };
  }

  // ---------- memory ----------
  function memoryFile(as, which) {
    return path.join(paths.agents, as, `${which}.md`);
  }
  function memoryRead(as) {
    actor(as);
    const r = (w) => (fs.existsSync(memoryFile(as, w)) ? fs.readFileSync(memoryFile(as, w), 'utf8') : '');
    return { identity: r('identity'), work: r('work'), comms: r('comms'), limit: config.limits.memory_chars };
  }
  function memoryWrite(as, which, content) {
    actor(as);
    if (!['work', 'comms'].includes(which)) throw new McError('which must be "work" or "comms".');
    const text = String(content ?? '');
    if (text.length > config.limits.memory_chars) {
      throw new McError(`That's ${text.length} characters; the limit is ${config.limits.memory_chars}. Summarise older detail, move it to mc_memory_archive, then write again.`);
    }
    ensureDir(path.join(paths.agents, as));
    fs.writeFileSync(memoryFile(as, which), text);
    store.append('memory.write', as, { which, chars: text.length });
    return { ok: true };
  }
  function memoryArchive(as, text) {
    actor(as);
    ensureDir(path.join(paths.agents, as));
    fs.appendFileSync(memoryFile(as, 'archive'), `\n## ${new Date().toISOString().slice(0, 10)}\n\n${text}\n`);
    return { ok: true };
  }

  // ---------- environments ----------
  function env(as) {
    const m = member(config, actor(as));
    if (!s().envs[as]) {
      const used = new Set(Object.values(s().envs).map((e) => e.ports.web));
      let slot = m.index + 1;
      while (used.has(config.ports.base + slot * 10)) slot += 1;
      const base = config.ports.base + slot * 10;
      store.append('env.allocate', 'cli', { agent: as, ports: { web: base, api: base + 1, expo: base + 2 }, db: `mc_${as.replace(/-/g, '_')}` });
    }
    const e = s().envs[as];
    return { ...e, databaseUrl: dbUrl(e.db) };
  }
  function integrationEnv() {
    const base = config.ports.base;
    return { ports: { web: base, api: base + 1, expo: base + 2 }, db: 'mc_integration', databaseUrl: dbUrl('mc_integration') };
  }
  function dbUrl(db) {
    return String(config.database_url ?? 'postgres://madcompany:madcompany@localhost:5433/{db}').replace('{db}', db);
  }

  // ---------- minutes of meetings & links ----------
  const KINDS = ['planning', 'ui-sprint', 'demo', 'standup', 'review', 'other'];
  function minutes(as, f = {}) {
    actor(as, { allowHuman: true, allowCli: true });
    if (!f.title || !f.summary) throw new McError('Minutes need a title and a summary.');
    const kind = KINDS.includes(f.kind) ? f.kind : 'other';
    const id = nextId('mom', 'MOM');
    const date = new Date().toISOString().slice(0, 10);
    const slug = String(f.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'meeting';
    const rel = `.madcompany/meetings/${date}-${id.toLowerCase()}-${slug}.md`;
    // links are written from the project root; the minutes file lives two folders down
    const fromRoot = (t) => String(t).replace(/\]\((?!https?:|#|\/|\.\.\/)([^)\s]+)\)/g, '](../../$1)');
    const list = (title, items) => (items?.length ? [`## ${title}`, '', ...items.map((x) => `- ${fromRoot(typeof x === 'string' ? x : `${x.what}${x.who ? ` (${x.who})` : ''}`)}`), ''] : []);
    const body = [
      `# <a id="${id.toLowerCase()}"></a>${id}: ${f.title}`,
      '',
      `- **Date:** ${date} · **Kind:** ${kind}`,
      `- **Attendees:** ${(f.attendees ?? []).join(', ') || 'you, lead'}`,
      f.source ? `- **Source:** ${f.source}` : null,
      '',
      '## Summary',
      '',
      String(f.summary),
      '',
      ...list('Key points', f.keyPoints),
      ...list('Decisions', f.decisions),
      ...list('Action items', f.actions),
      ...list('Open questions', f.openQuestions),
      ...list('Links', f.links),
    ].filter((l) => l !== null);
    ensureDir(path.join(paths.dir, 'meetings'));
    fs.writeFileSync(path.join(paths.root, rel), body.join('\n'));
    store.append('minutes.add', as, { id, title: String(f.title), kind, date, file: rel, attendees: f.attendees ?? [], summary: String(f.summary).slice(0, 300) });
    return { ok: true, id, file: rel };
  }
  function addLink(as, f = {}) {
    actor(as, { allowHuman: true, allowCli: true });
    const url = String(f.url ?? '').trim();
    if (!/^https?:\/\/\S+$/.test(url)) throw new McError('A link needs an http(s) URL.');
    if (s().links.some((l) => l.url === url)) return { ok: true, existing: true };
    const id = nextId('link', 'L');
    store.append('link.add', as, { id, title: String(f.title || url).slice(0, 140), url, kind: f.kind || kindOfUrl(url), note: f.note ?? '' });
    return { ok: true, id };
  }
  function kindOfUrl(u) {
    if (/claude\.ai\/(code\/)?(artifact|public\/artifacts)|claude\.site\/artifacts/i.test(u)) return 'Claude artifact';
    if (/figma\.com/i.test(u)) return 'Figma';
    if (/github\.com/i.test(u)) return 'GitHub';
    if (/docs\.google\.com|drive\.google\.com/i.test(u)) return 'Google';
    if (/notion\.(so|site)/i.test(u)) return 'Notion';
    if (/miro\.com/i.test(u)) return 'Miro';
    if (/loom\.com|youtube\.com|youtu\.be/i.test(u)) return 'Video';
    return 'Web';
  }

  // ---------- releases and epics: what gets delivered, reviewed by you, then shipped ----------
  const UNIT_STATUSES = ['planned', 'building', 'review', 'approved', 'shipped'];
  function unit(id, want) {
    const key = String(id ?? '').trim().toUpperCase();
    const u = s().releases[key] ?? s().epics[key] ?? s().epics[String(id)];
    if (!u || (want === 'release' && !s().releases[key])) throw new McError(`No ${want ?? 'release or epic'} ${id}.${want === 'release' ? ' Plan it first with mc_release.' : ''}`);
    return u;
  }
  function unitTickets(u) {
    return Object.values(s().tickets).filter((t) => (s().releases[u.id] ? t.release === u.id : t.epic === u.id));
  }
  /** Where new tickets go: the first release still being planned or built, else the one in review. */
  function currentRelease() {
    const byId = (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1));
    const all = Object.values(s().releases).sort(byId);
    return all.find((r) => ['planned', 'building'].includes(r.status)) ?? all.find((r) => r.status === 'review') ?? null;
  }
  function units() {
    // spec mode delivers epics, but a release planned there still shows up
    const list = byRelease() ? Object.values(s().releases) : [...Object.values(s().epics), ...Object.values(s().releases)];
    return list
      .map((u) => {
        const ts = unitTickets(u);
        return { id: u.id, title: u.title, goal: u.goal ?? '', status: u.status ?? 'building', version: u.version ?? null, total: ts.length, done: ts.filter((t) => t.status === 'done').length, reviews: u.reviews ?? [], branch: unitBranch(u.id), notes: u.notes ?? null };
      })
      .sort((a, b) => a.id[0].localeCompare(b.id[0]) || Number(a.id.replace(/\D/g, '')) - Number(b.id.replace(/\D/g, '')));
  }
  function planRelease(as, f = {}) {
    leadOnly(as, 'plan releases', { allowHuman: true, allowCli: true });
    if (f.id && s().releases[String(f.id).toUpperCase()]) {
      const r = unit(f.id, 'release');
      const fields = Object.fromEntries(['title', 'goal', 'version'].filter((k) => f[k] != null).map((k) => [k, String(f[k])]));
      store.append('release.upsert', as, { id: r.id, ...fields });
      return { release: s().releases[r.id] };
    }
    if (!f.title || !f.goal) throw new McError('A release needs a title and a goal: what the human will be able to see or do at the end of it.');
    const id = `R${(s().counters.release ?? 0) + 1}`;
    store.append('release.upsert', as, { id, title: String(f.title), goal: String(f.goal), version: f.version ? String(f.version) : null });
    return { release: s().releases[id], branch: unitBranch(id), note: `New tickets go into ${id} automatically while it is the current release.` };
  }
  function readyForReview(as, id) {
    leadOnly(as, 'send a release or epic for review', { allowCli: true });
    const u = unit(id);
    if (u.status === 'approved' || u.status === 'shipped') throw new McError(`${u.id} is already ${u.status}.`);
    const ts = unitTickets(u);
    if (!ts.length) throw new McError(`${u.id} has no tickets.`);
    const open = ts.filter((t) => t.status !== 'done');
    if (open.length) throw new McError(`${u.id} still has open tickets: ${open.map((t) => `${t.id} (${t.status})`).join(', ')}.`);
    store.append('unit.status', as, { id: u.id, status: 'review' });
    const env = integrationEnv();
    post(as, { channel: 'general', text: `${u.id} ${u.title} is ready for your review: open HQ → ${s().releases[u.id] ? 'Releases' : 'Epics'}, click through it in Preview (http://localhost:${env.ports.web}), then approve it or ask for changes.` });
    return { ok: true, status: 'review' };
  }
  function reviewUnit(as, id, f = {}) {
    if (!isHuman(as)) throw new McError('Only a person reviews a release or epic.');
    const u = unit(id);
    if (u.status !== 'review') throw new McError(`${u.id} isn't waiting for review (it is ${u.status ?? 'building'}).`);
    if (!['approve', 'changes'].includes(f.verdict)) throw new McError('verdict must be "approve" or "changes".');
    if (f.verdict === 'changes' && !String(f.notes ?? '').trim()) throw new McError('Say what should change.');
    store.append('unit.review', as, { id: u.id, verdict: f.verdict, notes: f.notes ?? '' });
    if (f.verdict === 'changes') {
      const res = change({ text: String(f.notes), unit: u.id }, as);
      return { ok: true, status: 'building', ticket: res.ticket.id };
    }
    writeReleaseNotes(u.id);
    return { ok: true, status: 'approved', notes: s().releases[u.id]?.notes ?? s().epics[u.id]?.notes };
  }
  /** Called by `npx madcompany ship` once the branch is merged into main. */
  function shipped(as, id, f = {}) {
    leadOnly(as, 'mark a release shipped', { allowCli: true });
    const u = unit(id);
    if (u.status !== 'approved') throw new McError(`${u.id} is ${u.status ?? 'building'}; it ships after you approve it.`);
    store.append('unit.status', as, { id: u.id, status: 'shipped', notes: writeReleaseNotes(u.id, f) });
    const push = `git push origin ${config.main_branch}${f.tag ? ` && git push origin ${f.tag}` : ''}`;
    const help = requestHelp(as === 'cli' ? lead : as, {
      title: `Push and deploy ${u.id}: ${u.title}`,
      kind: 'ship',
      why: `${u.id} is approved and merged into ${config.main_branch}${f.sha ? ` (${f.sha})` : ''}. Agents never push or deploy.`,
      steps: [`Read the release notes: ${s().releases[u.id]?.notes ?? s().epics[u.id]?.notes}`, `Push: \`${push}\``, ...(config.deploy?.length ? config.deploy.map(String) : ['Deploy it the way this project deploys (e.g. Vercel, your cloud). Ask the lead to write the steps into docs/deploy.md.']), 'Mark this done and tell the team in #general.'],
    });
    return { ok: true, status: 'shipped', help: help.id };
  }
  function writeReleaseNotes(id, f = {}) {
    const u = unit(id);
    const ts = unitTickets(u);
    const ids = new Set(ts.map((t) => t.id));
    const decs = s().decisions.filter((d) => d.ticket && ids.has(String(d.ticket).toUpperCase()));
    const help = Object.values(s().help).filter((h) => h.tickets.some((x) => ids.has(x)));
    const date = new Date().toISOString().slice(0, 10);
    const rel = `.madcompany/releases/${u.id.toLowerCase()}.md`;
    const lines = [
      `# <a id="${u.id.toLowerCase()}"></a>${u.id}: ${u.title}`,
      '',
      `- **Status:** ${f.sha ? 'shipped' : 'approved'} · **Date:** ${date}${u.version ? ` · **Version:** ${u.version}` : ''}${f.tag ? ` · **Tag:** ${f.tag}` : ''}${f.sha ? ` · **Merged:** ${f.sha}` : ''}`,
      u.goal ? `- **Goal:** ${u.goal}` : null,
      `- **Branch:** ${unitBranch(u.id)} → ${config.main_branch}`,
      '',
      '## What changed',
      '',
      ...ts.map((t) => `- [${t.id}](../log/board.md#${t.id.toLowerCase()}) ${t.title}${t.kind !== 'task' ? ` (${t.kind})` : ''}`),
      ...(decs.length ? ['', '## Decisions', '', ...decs.map((d) => `- [${d.id}](../log/decisions.md#${d.id.toLowerCase()}) ${d.title}`)] : []),
      ...((u.reviews ?? []).length ? ['', '## Your reviews', '', ...u.reviews.map((r) => `- ${r.ts.slice(0, 10)} ${r.by}: ${r.verdict === 'approve' ? 'approved' : `changes — ${r.notes}`}`)] : []),
      ...(help.length ? ['', '## Human help', '', ...help.map((h) => `- [${h.id}](../human-help.md#${h.id.toLowerCase()}) ${h.title} (${h.status})`)] : []),
    ].filter((l) => l !== null);
    ensureDir(path.join(paths.dir, 'releases'));
    fs.writeFileSync(path.join(paths.root, rel), lines.join('\n') + '\n');
    if (!f.sha) store.append('unit.status', 'cli', { id: u.id, status: 'approved', notes: rel });
    return rel;
  }

  // ---------- Human help: what only a person can do ----------
  const ENV_KEY = /^[A-Z][A-Z0-9_]{1,63}$/;
  function requestHelp(as, f = {}) {
    actor(as, { allowHuman: true, allowCli: true });
    if (!f.title?.trim()) throw new McError('Human help needs a title, e.g. "Create a Stripe account and test API keys".');
    const kind = HELP_KINDS[f.kind] ? f.kind : 'other';
    const env = (f.env ?? []).map((k) => String(k).trim().toUpperCase());
    for (const k of env) if (!ENV_KEY.test(k)) throw new McError(`"${k}" isn't an environment variable name (like STRIPE_SECRET_KEY).`);
    const tickets = (f.tickets ?? []).map((x) => ticket(x).id);
    const same = Object.values(s().help).find(
      (h) => h.status === 'open' && (h.title.toLowerCase() === f.title.trim().toLowerCase() || (f.service && h.service && h.service.toLowerCase() === String(f.service).toLowerCase() && h.kind === kind)),
    );
    if (same) {
      if (tickets.some((x) => !same.tickets.includes(x))) store.append('help.link', as, { id: same.id, tickets });
      return { ok: true, id: same.id, existing: true, note: `Already asked as ${same.id}. Park your ticket on it with mc_block (blockedBy: ["${same.id}"]) if you can't continue.` };
    }
    const id = nextId('help', 'HELP');
    store.append('help.request', as, {
      id,
      title: f.title.trim(),
      kind,
      service: f.service ? String(f.service) : null,
      why: String(f.why ?? ''),
      steps: (f.steps ?? []).map(String),
      env,
      tickets,
      links: (f.links ?? []).map(String),
      neededBy: f.neededBy ? String(f.neededBy) : null,
    });
    return { ok: true, id, note: `Filed ${id} in HQ → Human help. Keep going on mocks if you can; otherwise park your ticket with mc_block (blockedBy: ["${id}"]). It resumes when the human marks ${id} done.` };
  }
  /** Which of these keys have a value in the project's env files. Never returns the values. */
  function envStatus(keys) {
    const found = new Set();
    for (const f of config.env_files) {
      const abs = safeJoin(paths.root, f);
      if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (m && m[2].trim().replace(/^(['"])(.*)\1$/, '$2').trim()) found.add(m[1]);
      }
    }
    return Object.fromEntries(keys.map((k) => [k, found.has(k)]));
  }
  function waitingOn(id) {
    return Object.values(s().tickets).filter((t) => t.status === 'blocked' && t.blockedBy.includes(id)).map((t) => t.id);
  }
  function helpView() {
    return Object.values(s().help)
      .map((h) => ({ ...h, envSet: envStatus(h.env), waiting: waitingOn(h.id), kindLabel: HELP_KINDS[h.kind] }))
      .sort((a, b) => (a.status === b.status ? Number(b.id.split('-')[1]) - Number(a.id.split('-')[1]) : a.status === 'open' ? -1 : 1));
  }
  function helpDone(as, id, f = {}) {
    if (!isHuman(as)) throw new McError('Only a person can mark Human help done.');
    const h = s().help[String(id).toUpperCase()];
    if (!h) throw new McError(`No ${id}.`);
    if (h.status !== 'open') throw new McError(`${h.id} is already ${h.status}.`);
    const missing = Object.entries(envStatus(h.env)).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length && !f.force) throw new McError(`Not found in ${config.env_files.join(' or ')}: ${missing.join(', ')}. Add them there, or mark it done anyway.`);
    store.append('help.done', as, { id: h.id, note: f.note ?? '' });
    return { ok: true, canResume: Object.values(s().tickets).filter((t) => t.blockedBy.includes(h.id) && isReady(t)).map((t) => t.id) };
  }
  function helpCancel(as, id, reason) {
    if (!isHuman(as) && as !== lead && as !== 'cli') throw new McError('Only the lead or a person can cancel Human help.');
    const h = s().help[String(id).toUpperCase()];
    if (!h) throw new McError(`No ${id}.`);
    if (h.status !== 'open') throw new McError(`${h.id} is already ${h.status}.`);
    store.append('help.cancel', as, { id: h.id, reason: reason ?? '' });
    return { ok: true };
  }

  // ---------- MCP servers, plugins and skills ----------
  function found() {
    try {
      return discoverTools(paths.root);
    } catch {
      return { servers: [], plugins: [], skills: [] };
    }
  }
  /** For the lead's briefing: who uses which server, and what plugins bring. */
  function toolsSummary() {
    const f = found();
    return {
      servers: f.servers.filter((x) => ['project', 'plugin', 'local'].includes(x.scope) || x.known).map((x) => ({ name: x.name, for: x.known?.for ?? null, users: config.team.filter((m) => serversFor(m, [x], config).length).map((m) => m.id) })),
      plugin_skills: f.skills.filter((x) => x.source.startsWith('plugin')).map((x) => `${x.name}: ${x.description}`).slice(0, 20),
      plugin_agents: f.plugins.flatMap((p) => p.agents.map((a) => `${a.name} (${p.name}): ${a.description}`)).slice(0, 10),
      note: 'Read-only MCP tools need no permission. Tools that push, deploy, pay, delete or send are blocked; agents file them as Human help.',
    };
  }
  /** mc_tools: everything available, and which of it is yours. */
  function toolsFor(as) {
    const m = member(config, actor(as, { allowCli: true })) ?? null;
    const f = found();
    const mine = m ? serversFor(m, f.servers, config) : [];
    const view = (x) => ({ name: x.name, prefix: x.prefix, what: x.known?.for ?? null, policy: policyLine(x, config) });
    return {
      yours: mine.map(view),
      others: f.servers.filter((x) => !mine.includes(x)).map(view),
      plugins: f.plugins.map((p) => ({ id: p.id, skills: p.skills, agents: p.agents.map((a) => a.name), servers: p.servers })),
      skills: f.skills.map((x) => ({ name: x.name, what: x.description, from: x.source })),
      rules: 'Use your servers freely for reading. Anything that pushes, deploys, pays, deletes or sends is the human\'s: if the hook blocks a tool, file mc_human_help with what to run and why, and keep going on a mock.',
    };
  }

  // ---------- feedback & change requests ----------
  function feedback(f = {}, by = HUMAN) {
    if (!f.text?.trim()) throw new McError('Empty comment.');
    const where = [f.route && `Screen: ${f.route}`, f.selector && `Element: \`${f.selector}\``, f.snippet && `Element text: "${String(f.snippet).slice(0, 120)}"`, f.viewport && `Screen size: ${f.viewport}`, f.url && `URL: ${f.url}`]
      .filter(Boolean)
      .join('\n');
    const res = createTicket(by, { title: `Feedback: ${f.text.slice(0, 70)}`, body: `${f.text}\n\n${where}`, kind: 'feedback', ui: true });
    post(by, { channel: 'general', text: `New feedback ${res.ticket.id} @${lead}: ${f.text}` });
    return res;
  }
  function change(f = {}, by = HUMAN) {
    if (!f.text?.trim()) throw new McError('Empty change request.');
    const u = f.unit ? unit(f.unit) : null;
    const res = createTicket(by, { title: `Change: ${f.text.slice(0, 70)}`, body: f.text, kind: 'change', ...(u ? (s().releases[u.id] ? { release: u.id } : { epic: u.id }) : {}) });
    post(by, { channel: 'general', text: `Change request ${res.ticket.id} @${lead}: ${f.text} — please post an impact check.` });
    return res;
  }

  return {
    config,
    store,
    paths,
    isHuman,
    status,
    dashboard,
    briefing,
    teamView,
    agentStatus,
    isReady,
    workdayControl,
    startDay,
    requestEndDay,
    stopNow,
    endDay,
    createTicket,
    updateTicket,
    assign,
    next,
    claim,
    log,
    block,
    checkpoint,
    submit,
    review,
    canMerge: (id) => ({ reason: canMerge(ticket(id)) }),
    ticketInfo,
    markMerged,
    reopen,
    attach,
    handoff,
    post,
    read,
    ask,
    answer,
    escalate,
    decide,
    facts,
    writeFacts,
    designWrite,
    designApprove,
    designFreeze,
    memoryRead,
    memoryWrite,
    memoryArchive,
    env,
    integrationEnv,
    epicBranch: (id) => epicBranch(ticket(id)),
    unitBranch,
    unit: (id) => ({ ...unit(id), branch: unitBranch(unit(id).id), tickets: unitTickets(unit(id)).map(briefTicket) }),
    units,
    currentRelease,
    planRelease,
    readyForReview,
    reviewUnit,
    shipped,
    requestHelp,
    helpView,
    helpDone,
    helpCancel,
    envStatus,
    mode,
    toolsFor,
    toolsSummary,
    ticket,
    feedback,
    change,
    minutes,
    addLink,
    STATUSES,
  };
}
