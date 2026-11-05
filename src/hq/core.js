import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { McError, member } from '../config.js';
import { ensureDir, safeJoin, insideRoot, isHiddenPath } from '../paths.js';
import { modeInfo } from '../modes.js';
import { discoverTools, serversFor, policyLine } from '../tools.js';
import { createIndex } from './graph.js';

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
  const index = createIndex({ store, config, paths });

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
  // who may define requirements and map change requests to them
  const canPlan = (as) => as === lead || as === 'cli' || isHuman(as) || member(config, as)?.type === 'product-manager';

  // ---------- traceability: discussion and work map back to requirements ----------
  const strictness = () => config.traceability ?? 'warn';
  /**
   * Checks what a new ticket, decision, question or message traces to. Throws
   * in strict mode, returns the warning in warn mode, null when it's fine.
   */
  function traced(what, found, hint, { needRequirement = true } = {}) {
    if (strictness() === 'off') return null;
    const problems = [];
    if (found.unknown.length) problems.push(`${found.unknown.join(', ')} ${found.unknown.length > 1 ? "aren't" : "isn't"} defined anywhere (mc_lookup checks an ID).`);
    if (needRequirement && !found.requirements.length) {
      problems.push(
        found.anyRequirements
          ? `${what} isn't linked to a requirement. ${hint}`
          : `${what} can't be linked to a requirement because none are defined yet. Import the PRD (npx madcompany import) or define them with mc_requirement.`,
      );
    }
    if (!problems.length) return null;
    if (strictness() === 'strict') throw new McError(problems.join(' '));
    return problems.join(' ');
  }
  const withWarning = (res, warning) => (warning ? { ...res, warning } : res);
  const idsOf = (list) => [...new Set((list ?? []).map((x) => index.node(x)?.id ?? String(x).trim()).filter(Boolean))];
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
  // a change the team raised stops blocking once a person approves it (building it may be the parked work itself)
  const isSettled = (id) => {
    const c = s().tickets[String(id).toUpperCase()];
    return c?.kind === 'change' && c.approval && c.approval !== 'needed' ? true : isDone(id);
  };
  const blockersDone = (t) => t.blockedBy.every(isSettled);
  // a comment batched into a review waits for the plan the human approves for all of them
  const parked = (t) => Boolean(t.batch && s().reviews[t.batch] && !['applied', 'cancelled'].includes(s().reviews[t.batch].status));
  const isReady = (t) =>
    !parked(t) && ((t.status === 'todo' && depsDone(t)) || (t.status === 'blocked' && blockersDone(t) && depsDone(t)));

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
    const comment = ['feedback', 'change'].includes(t.kind) ? Object.fromEntries(Object.entries({ screen: t.screen, level: t.level, review: t.batch }).filter(([, v]) => v)) : {};
    return { id: t.id, title: t.title, status: t.status, assignee: t.assignee, epic: t.epic, release: t.release, domain: t.domain, deps: t.deps, blockedBy: t.blockedBy, ui: t.ui, kind: t.kind, ...comment };
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
      reviews: Object.values(s().reviews)
        .filter((r) => !['applied', 'cancelled'].includes(r.status))
        .map((r) => ({ id: r.id, status: r.status, comments: r.comments.length, next: REVIEW_NEXT[r.status] })),
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
      approve: tickets.filter((t) => t.kind === 'change' && t.approval === 'needed' && !t.withdrawn).map((t) => ({ id: t.id, title: t.title, by: t.raisedBy, amends: t.amends, extends: t.extends, body: t.body })),
      reviews: Object.values(s().reviews)
        .filter((r) => !['applied', 'cancelled'].includes(r.status))
        .map((r) => ({ id: r.id, title: r.title, status: r.status, by: r.by, comments: r.comments.filter((c) => !s().tickets[c]?.withdrawn).length, summary: r.plan?.summary ?? null })),
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
      trace: traceSummary(15),
    };
  }
  /** Traceability for the lead: how much maps to requirements, and what to fix. */
  function traceSummary(limit = 30) {
    const diags = index.diagnostics();
    return {
      mode: strictness(),
      coverage: index.coverage(),
      diagnostics: diags.slice(0, limit).map((d) => d.text),
      ...(diags.length > limit ? { more: `${diags.length - limit} more: mc_trace` } : {}),
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
    const kind = f.kind ?? 'task';
    if (!['task', 'chore', 'feedback', 'change'].includes(kind)) throw new McError('kind must be "task" or "chore" (a chore implements no requirement: tooling, checks, setup).');
    const release = f.release ? unit(f.release, 'release').id : !f.epic && byRelease() ? currentRelease()?.id ?? null : null;
    // a task implements requirements; a change request is mapped to them separately (mc_map_change)
    const warning =
      kind === 'task'
        ? traced('This ticket', index.check({ refs: f.refs, context: [f.epic] }), 'Pass refs: the requirement, story or epic IDs it implements, or the change request it is part of. Use kind "chore" for work that implements no requirement.')
        : null;
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
      kind,
      source: f.source ?? null,
      assignee: f.assignee ?? null,
      ...(kind === 'change' && (f.amends?.length || f.extends?.length) ? { amends: f.amends ?? [], extends: f.extends ?? [] } : {}),
      ...(kind === 'change' && f.approval === 'needed' ? { approval: 'needed', raisedBy: f.raisedBy ?? as } : {}),
      ...(['feedback', 'change'].includes(kind) ? Object.fromEntries(Object.entries({ screen: f.screen, where: f.where, level: f.level, batch: f.batch, from: f.from }).filter(([, v]) => v)) : {}),
    });
    return withWarning({ ticket: briefTicket(s().tickets[id]) }, warning);
  }

  function updateTicket(as, id, fields = {}) {
    leadOnly(as, 'edit tickets', { allowCli: true });
    const t = ticket(id);
    const clean = {};
    for (const k of ['title', 'body', 'domain', 'ui', 'epic', 'refs']) if (k in fields) clean[k] = fields[k];
    if ('release' in fields) clean.release = fields.release ? unit(fields.release, 'release').id : null;
    if ('deps' in fields) clean.deps = checkDeps(fields.deps, t.id);
    if ('kind' in fields && fields.kind !== t.kind) {
      if (!['task', 'chore'].includes(fields.kind) || !['task', 'chore'].includes(t.kind)) throw new McError('Only task and chore tickets switch kind (task ↔ chore). Change requests and feedback are mapped with mc_map_change.');
      clean.kind = fields.kind;
    }
    if (!Object.keys(clean).length) throw new McError('Nothing to update.');
    let warning = null;
    if (['refs', 'epic', 'kind'].some((k) => k in clean)) {
      const refs = clean.refs ?? t.refs;
      const found = index.check({ refs, context: [clean.epic ?? t.epic] });
      warning = traced(t.id, found, 'Pass refs: the requirement, story or epic IDs it implements, or make it a chore.', { needRequirement: (clean.kind ?? t.kind) === 'task' });
    }
    store.append('ticket.update', as, { id: t.id, fields: clean });
    return withWarning({ ticket: briefTicket(t) }, warning);
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
    if (parked(t)) {
      const r = s().reviews[t.batch];
      throw new McError(`${t.id} is a comment in review ${r.id} (${r.status}). It's planned with the others and starts once the human approves that plan.`);
    }
    if (t.attempts >= config.limits.attempts) {
      throw new McError(`${t.id} has hit its limit of ${config.limits.attempts} attempts. Don't retry: ask the lead with mc_ask.`);
    }
    // nobody builds a change before we know which requirements it changes
    let warning = null;
    if (strictness() !== 'off') {
      if (t.kind === 'change' && t.approval === 'needed') {
        warning = `${t.id} is a change the team raised; it waits for the human's OK in HQ → Inbox before anyone starts it.`;
      } else if (['change', 'feedback'].includes(t.kind) && !index.mapping(t).mapped) {
        warning =
          t.kind === 'change'
            ? `${t.id} is a change request that isn't mapped to the requirements it amends or extends yet. Ask the lead to map it (mc_map_change) first.`
            : `${t.id} is a comment nobody has classified (element, ux or story change) and mapped yet. Ask the lead to map it (mc_map_change) first.`;
      } else if (t.kind === 'task' && !index.trace(t.id).length) {
        warning = `${t.id} isn't linked to any requirement. Ask the lead to add refs (mc_update_ticket) or make it a chore.`;
      }
      if (warning && (strictness() === 'strict' || t.approval === 'needed')) throw new McError(warning);
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
    // the ticket's requirements as they stand now, and what's known about them
    const { context, requirements } = index.contextFor(t.id);
    // facts known to be about other requirements stay out; facts about none of them might matter anywhere
    const facts = s().facts.filter((f) => {
      const tr = index.trace(f.id);
      return !tr.length || tr.some((r) => requirements.includes(r));
    });
    return withWarning(
      {
        ticket: { ...briefTicket(t), body: t.body, refs: t.refs, attempts: t.attempts, ...(['change', 'feedback'].includes(t.kind) ? { amends: t.amends, extends: t.extends } : {}), ...(t.where ? { where: t.where } : {}) },
        ...(sketchesOf(t).length ? { sketches: { files: sketchesOf(t), note: 'Drawn by the human on the screen. Open each image (Read the file) before you start: it shows what they want.' } } : {}),
        resume_from: t.checkpoint,
        context,
        dependencies: depNotes,
        resolved_blockers: blockerNotes.map((b) =>
          b.question ? { id: b.id, question: b.question, answer: b.answer } : b.steps ? { id: b.id, title: b.title, status: b.status, note: b.note, env: b.env } : { id: b.id, title: b.title },
        ),
        git: gitPlan(t),
        env: env(as),
        facts: facts.map((f) => `${f.id}: ${f.text}`),
        ...(facts.length < s().facts.length ? { facts_elsewhere: `${s().facts.length - facts.length} more about other requirements: mc_facts` } : {}),
        designs: Object.values(s().designs).map((d) => ({ path: d.path, owner: d.owner, status: d.status })),
        unread: inboxFor(as).length,
      },
      warning,
    );
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
    // a change request split into tickets is done when they all are (its amendments then hold)
    for (const r of t.refs) {
      const c = s().tickets[String(r).toUpperCase()];
      if (!c || !['change', 'feedback'].includes(c.kind) || c.status !== 'todo') continue;
      const parts = partsOf(c.id);
      if (parts.every((x) => x.status === 'done')) store.append('ticket.status', 'cli', { id: c.id, status: 'done', reason: `all its tickets are done (${parts.map((x) => x.id).join(', ')})` });
    }
    return { ok: true, nowReady: Object.values(s().tickets).filter(isReady).map((x) => x.id) };
  }

  /** Tickets split from a change request: their refs name it. */
  const partsOf = (id) => Object.values(s().tickets).filter((x) => x.refs.some((r) => String(r).toUpperCase() === id));

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
  /** `system` posts are HQ's own (question DMs, contract notices); they carry their IDs already. */
  function post(as, f = {}, { system = false } = {}) {
    actor(as, { allowHuman: true });
    if (!f.text?.trim()) throw new McError('Empty message.');
    const channel = channelFor(as, f.channel);
    // agents talk about something: a ticket, story or requirement. The lead and people talk freely.
    const warning =
      !system && isMember(as) && as !== lead && !channel.startsWith('ticket:')
        ? traced('This message', index.check({ texts: [f.text], channel }), 'Mention the ticket or requirement it is about (e.g. APP-12 or FR3), or post in its thread (channel ticket:<ID>).')
        : null;
    const id = nextId('msg', 'M');
    store.append('msg.post', as, { id, channel, text: String(f.text), mentions: parseMentions(f.text) });
    return withWarning({ ok: true, id, channel }, warning);
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
    const tid = f.ticket ? ticket(f.ticket).id : null;
    const warning = traced('This question', index.check({ refs: f.refs, texts: [f.question, ...(f.links ?? [])], context: [tid] }), 'Pass the ticket it is about, or refs: the requirement IDs it concerns.');
    const id = nextId('q', 'Q');
    store.append('question.ask', as, { id, to, question: String(f.question), ticket: tid, options: f.options ?? [], links: f.links ?? [], refs: idsOf(f.refs) });
    post(as, { channel: `dm:${to}`, text: `${id} @${to}: ${f.question}` }, { system: true });
    // REL-3: a question bouncing between the same two agents goes to the lead.
    const pair = [as, to].sort().join('+');
    const bounces = Object.values(s().questions).filter(
      (q) => q.status === 'open' && [q.from, q.to].sort().join('+') === pair && (!f.ticket || q.ticket === s().questions[id].ticket),
    ).length;
    if (bounces >= 3 && to !== lead) {
      store.append('question.escalate', 'cli', { id, to: lead, reason: `ping-pong between ${as} and ${to}` });
    }
    return withWarning({ ok: true, id, note: 'Don\'t wait for the answer. If you can\'t continue, park the ticket with mc_block (blockedBy: ["' + id + '"]).' }, warning);
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
    post(as, { channel: `dm:${isHuman(q.from) ? lead : q.from}`, text: `${q.id} answered: ${text}` }, { system: true });
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
    const tid = f.ticket ? ticket(f.ticket).id : null;
    const warning = traced('This question', index.check({ refs: f.refs, texts: [f.question, ...(f.links ?? [])], context: [tid] }), 'Pass the ticket, or refs: the requirement IDs it is about, so the answer lands where it belongs.');
    const id = nextId('q', 'Q');
    store.append('question.ask', as, { id, to: HUMAN, question: String(f.question), options, recommended, links: f.links ?? [], ticket: tid, refs: idsOf(f.refs) });
    return withWarning({ ok: true, id }, warning);
  }

  function decide(as, f = {}) {
    actor(as);
    if (!f.title || !f.decision || !f.why) throw new McError('A decision needs a title, the decision and why.');
    const tid = f.ticket ? ticket(f.ticket).id : null;
    const supersedes = f.supersedes ? String(f.supersedes).toUpperCase() : null;
    if (supersedes && !s().decisions.some((d) => d.id === supersedes)) throw new McError(`No decision ${f.supersedes}.`);
    const warning = traced(
      'This decision',
      index.check({ refs: f.refs, texts: [f.title, f.decision, f.why, f.alternatives, ...(f.links ?? [])], context: [tid] }),
      'Pass the ticket it was made on, or refs: the requirement IDs it affects.',
    );
    const id = nextId('dec', 'DEC');
    store.append('decision.log', as, { id, title: f.title, decision: f.decision, why: f.why, alternatives: f.alternatives ?? '', links: f.links ?? [], ticket: tid, refs: idsOf(f.refs), supersedes });
    return withWarning({ ok: true, id }, warning);
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
      post(as, { channel: 'contracts', text: `${wasAgreed ? 'Changed' : 'Draft'}: ${rel} (v${s().designs[rel].version}). Please review and approve: ${consumers.map((c) => '@' + c).join(' ')}` }, { system: true });
    }
    // a design doc says which requirements it serves; never blocked (a codebase map serves none)
    const found = index.check({ texts: [f.content] });
    const warning = strictness() !== 'off' && found.anyRequirements && !found.requirements.length ? `${rel} doesn't link any requirement. Say which it serves, e.g. "Covers [FR12](…)", so it shows up under them.` : null;
    return withWarning({ ok: true, design: s().designs[rel] }, warning);
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
    // minutes are never refused (planning comes before requirements), but they should say what they're about
    const said = [f.summary, ...(f.keyPoints ?? []), ...(f.decisions ?? []), ...(f.openQuestions ?? []), ...(f.links ?? []), ...(f.actions ?? []).map((x) => (typeof x === 'string' ? x : x.what))];
    const found = index.check({ refs: f.refs, texts: said });
    const warning =
      strictness() !== 'off' && found.anyRequirements && (!found.requirements.length || found.unknown.length)
        ? `${id} is saved, but ${found.unknown.length ? `${found.unknown.join(', ')} isn't defined anywhere` : "it isn't linked to any requirement"}. Pass refs (the requirement, story or ticket IDs discussed) so the meeting shows up under them.`
        : null;
    ensureDir(path.join(paths.dir, 'meetings'));
    fs.writeFileSync(path.join(paths.root, rel), body.join('\n'));
    store.append('minutes.add', as, { id, title: String(f.title), kind, date, file: rel, attendees: f.attendees ?? [], summary: String(f.summary).slice(0, 300), refs: idsOf(f.refs) });
    return withWarning({ ok: true, id, file: rel }, warning);
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
    post(as, { channel: 'general', text: `${u.id} ${u.title} is ready for your review: open HQ → ${s().releases[u.id] ? 'Releases' : 'Epics'}, click through it in Preview (http://localhost:${env.ports.web}), then approve it or ask for changes.` }, { system: true });
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

  // ---------- screens: which stories and UX requirements each screen of the app implements ----------
  const SCREEN_MAKERS = new Set(['product-manager', 'ux-designer', 'ui-designer', 'web-developer', 'mobile-developer']);
  /** "/tasks/42?x" → ["tasks", "42"]. Hash routing ("/#/tasks") uses the hash; Expo groups like "(tabs)" aren't in URLs. */
  function routeParts(r) {
    let p = String(r ?? '').trim();
    if (/^https?:\/\//i.test(p)) {
      try {
        const u = new URL(p);
        p = u.pathname + u.hash;
      } catch {
        // keep it as written
      }
    }
    const hash = p.indexOf('#');
    if (hash >= 0) p = p.slice(hash + 1).startsWith('/') ? p.slice(hash + 1) : p.slice(0, hash);
    return p
      .replace(/\?.*$/, '')
      .split('/')
      .filter((x) => x && !/^\(.*\)$/.test(x))
      .map((x) => x.toLowerCase());
  }
  /** How well a screen's route ("/tasks/:id", "/tasks/[id]", "/docs/**") matches a URL path; -1 when it doesn't. */
  function routeScore(pattern, actual) {
    const pp = routeParts(pattern);
    const ap = routeParts(actual);
    let score = 0;
    for (let i = 0; i < pp.length; i++) {
      if (/^(\*\*|\[\.\.\..+\]|:.+\*)$/.test(pp[i])) return ap.length >= i ? score + 0.5 : -1;
      if (i >= ap.length) return -1;
      if (/^(:.+|\[.+\]|\*)$/.test(pp[i])) score += 1;
      else if (pp[i] === ap[i]) score += 2;
      else return -1;
    }
    return pp.length === ap.length ? score + 1 : -1;
  }
  /** A file in the project (a mockup, a sketch), as a clean relative path. */
  function projectFile(p, what) {
    const rel = path.posix.normalize(String(p ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/[?#].*$/, ''));
    const abs = rel && !rel.startsWith('..') ? safeJoin(paths.root, rel) : null;
    if (!abs || isHiddenPath(rel)) throw new McError(`${p} isn't a file in the project.`);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile() || !insideRoot(paths.root, abs)) throw new McError(`No ${what} at ${rel}.`);
    return rel;
  }
  function screenById(id) {
    const sc = s().screens[String(id ?? '').trim().toUpperCase()];
    if (!sc) throw new McError(`No screen ${id}. mc_screens lists them; mc_screen adds one.`);
    return sc;
  }
  /** The screen a comment is on: named, or the one showing this mockup, or the best route match. */
  function screenFor(f = {}) {
    if (f.screen) return screenById(f.screen);
    const all = Object.values(s().screens);
    if (f.mockup) {
      const hit = all.find((x) => x.mockups.includes(f.mockup));
      if (hit) return hit;
    }
    if (f.route) {
      let best = null;
      let top = -1;
      for (const x of all) {
        const sc = x.route ? routeScore(x.route, f.route) : -1;
        if (sc > top) [best, top] = [x, sc];
      }
      if (best && top >= 0) return best;
    }
    return null;
  }
  /** Record a screen of the app (or update one, with id): its route, what it implements and its mockups. */
  function defineScreen(as, f = {}) {
    actor(as, { allowHuman: true, allowCli: true });
    if (!canPlan(as) && !SCREEN_MAKERS.has(member(config, as)?.type)) throw new McError('The lead, the product manager, the designers and the front-end developers record screens.');
    const old = f.id ? screenById(f.id) : null;
    const title = String(f.title ?? old?.title ?? '').trim();
    if (!title) throw new McError('A screen needs a title, e.g. "Task list".');
    const route = f.route !== undefined ? String(f.route ?? '').trim() || null : old?.route ?? null;
    const impl = f.implements !== undefined ? idsOf(f.implements) : old?.implements ?? [];
    for (const x of impl) if (!index.isRequirement(x)) throw new McError(`${x} isn't a requirement, story or epic${index.node(x) ? ` (it's a ${index.node(x).kind})` : ' (nothing is registered under that ID)'}.`);
    const warning = traced('This screen', { unknown: [], requirements: impl, anyRequirements: index.check().anyRequirements }, 'Pass implements: the stories and UX requirements it shows, e.g. ["Story 2.1", "UXR3"].');
    const mockups = f.mockups !== undefined ? [...new Set((f.mockups ?? []).map((m) => projectFile(m, 'mockup')))] : old?.mockups ?? [];
    const key = route ? routeParts(route).join('/') : null;
    const dup = route && Object.values(s().screens).find((x) => x.id !== old?.id && x.route && routeParts(x.route).join('/') === key);
    if (dup) throw new McError(`${dup.id} (${dup.title}) already has the route ${dup.route}. Update it (id "${dup.id}") instead.`);
    const id = old?.id ?? nextId('screen', 'SCR');
    store.append('screen.upsert', as, { id, title, route, implements: impl, mockups, ...(f.notes !== undefined ? { notes: String(f.notes) } : {}) });
    return withWarning({ ok: true, screen: s().screens[id], note: `Link the tickets that build it with refs ["${id}"]; comments on ${route ?? 'its mockups'} land on it.` }, warning);
  }
  function screensView() {
    return Object.values(s().screens).map((sc) => {
      const card = index.card(sc.id, { limit: 30 });
      const comments = Object.values(s().tickets).filter((t) => t.screen === sc.id && !t.withdrawn);
      return {
        id: sc.id,
        title: sc.title,
        route: sc.route,
        implements: sc.implements,
        mockups: sc.mockups,
        built_by: (card.tickets ?? []).map((x) => `${x.id} (${x.status})`),
        open_comments: comments.filter((t) => t.status !== 'done').map((t) => `${t.id}${t.level ? ` [${t.level}]` : ''}${t.batch ? ` in ${t.batch}` : ''}`),
        ...(sc.notes ? { notes: sc.notes } : {}),
      };
    });
  }

  // ---------- sketches: what the human drew on a screen, for the agents to look at ----------
  const SKETCH = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;
  function saveSketch(as, t, dataUrl, caption) {
    const m = SKETCH.exec(String(dataUrl ?? ''));
    if (!m) throw new McError('A sketch is a PNG, JPEG or WebP image (a data: URL).');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 4 * 1024 * 1024) throw new McError('The sketch is over 4 MB.');
    // the bytes must be the image they claim to be
    const magic = { png: [0x89, 0x50, 0x4e, 0x47], jpeg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46] }[m[1]];
    if (!magic.every((b, i) => buf[i] === b)) throw new McError(`That sketch isn't a ${m[1].toUpperCase()} image.`);
    ensureDir(paths.shots);
    const n = t.attachments.length + 1;
    const name = `${t.id.toLowerCase()}-sketch-${n}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
    fs.writeFileSync(path.join(paths.shots, name), buf);
    store.append('ticket.attach', as, { id: t.id, kind: 'sketch', path: `.madcompany/shots/${name}`, caption: caption ?? 'Sketch' });
    return `.madcompany/shots/${name}`;
  }
  const sketchesOf = (t) => t.attachments.filter((a) => a.kind === 'sketch').map((a) => a.path);
  function addSketch(as, id, f = {}) {
    if (!isHuman(as) && !canPlan(as)) throw new McError('Sketches come from a person (HQ or the app\'s Comment button), or the lead relaying one.');
    const t = ticket(id);
    return { ok: true, path: saveSketch(as, t, f.sketch, f.caption) };
  }

  // ---------- comments: on a screen, a mockup or anything; sent now or batched into a review ----------
  const LEVELS = { element: 'element', look: 'element', ux: 'ux', flow: 'ux', story: 'story', feature: 'story' };
  function levelOf(raw, required = false) {
    if (raw == null || raw === '' || raw === 'unsure') {
      if (required) throw new McError('level is "element" (how it looks: spacing, colour, copy on one screen; keeps to what is agreed), "ux" (how it works: flow, navigation, interaction) or "story" (what it does).');
      return null;
    }
    const l = LEVELS[String(raw).toLowerCase()];
    if (!l) throw new McError(`level is element, ux or story, not "${raw}".`);
    return l;
  }
  const LEVEL_WORD = { element: 'an element change', ux: 'a UX change', story: 'a story change' };
  /**
   * A comment: from the app's Comment button, a mockup in HQ, a sketch, or
   * relayed by the lead from elsewhere (chat, a Claude artifact). It lands
   * on its screen. Sent now, the lead handles it at once; batched, it waits
   * in the person's open review until they submit the review for one plan.
   */
  function feedback(f = {}, by = HUMAN) {
    if (!f.text?.trim()) throw new McError('Empty comment.');
    const human = isHuman(by);
    if (!human && !canPlan(by)) throw new McError('Comments come from a person, or the lead relaying one (mc_comment).');
    const from = human ? by : String(f.from ?? HUMAN);
    const level = levelOf(f.level);
    const mockup = f.mockup ? projectFile(f.mockup, 'mockup') : null;
    const sc = screenFor({ screen: f.screen, route: mockup ? null : f.route, mockup });
    const pin = mockup && Number.isFinite(Number(f.x)) && Number.isFinite(Number(f.y)) ? { x: Math.max(0, Math.min(100, Number(f.x))), y: Math.max(0, Math.min(100, Number(f.y))) } : null;
    const where = Object.fromEntries(
      Object.entries({ route: f.route, url: f.url, selector: f.selector, snippet: f.snippet ? String(f.snippet).slice(0, 160) : null, viewport: f.viewport, mockup, ...(pin ?? {}), source: f.source }).filter(([, v]) => v != null && v !== ''),
    );
    const lines = [
      sc && `Screen: ${sc.id} ${sc.title}${sc.route ? ` (${sc.route})` : ''}`,
      f.route && !sc && `Screen: ${f.route}`,
      mockup && `Mockup: ${mockup}${pin ? ` at ${Math.round(pin.x)}% across, ${Math.round(pin.y)}% down` : ''}`,
      f.selector && `Element: \`${f.selector}\``,
      f.snippet && `Element text: "${String(f.snippet).slice(0, 120)}"`,
      f.viewport && `Screen size: ${f.viewport}`,
      f.url && `URL: ${f.url}`,
      f.source && `From: ${f.source}`,
      level && `Kind (as ${human ? 'they' : 'the human'} saw it): ${LEVEL_WORD[level]}`,
    ].filter(Boolean);
    const batch = f.batch ? reviewFor(from, f.review === true ? null : f.review).id : null;
    const res = createTicket(human ? by : lead, { title: `Feedback: ${f.text.slice(0, 70)}`, body: `${f.text}${lines.length ? `\n\n${lines.join('\n')}` : ''}`, kind: 'feedback', ui: true, screen: sc?.id, where, level, batch, from: human ? null : from });
    const t = s().tickets[res.ticket.id];
    const sketch = f.sketch ? saveSketch(by, t, f.sketch, `Sketch: ${f.text.slice(0, 60)}`) : null;
    if (!batch) {
      const on = sc ? ` on ${sc.id} ${sc.title}${sc.implements.length ? ` (implements ${sc.implements.join(', ')})` : ''}` : '';
      post(human ? by : lead, { channel: 'general', text: `New feedback ${res.ticket.id}${on} @${lead}: ${f.text}${sketch ? ` (sketch: ${sketch})` : ''}` }, { system: true });
    }
    return {
      ...res,
      ...(sc ? { screen: { id: sc.id, title: sc.title, implements: sc.implements } } : {}),
      ...(sketch ? { sketch } : {}),
      ...(batch ? { review: { id: batch, comments: s().reviews[batch].comments.length, note: `Saved in ${batch}. Submit the review in HQ when you're done commenting; the team plans all of it together.` } } : {}),
    };
  }
  /** The lead or PM files a comment the human made elsewhere: in chat, on a Claude artifact, in a call. */
  function relayComment(as, f = {}) {
    if (isHuman(as) || !canPlan(as)) throw new McError('The lead or the product manager relays the human\'s comments; people comment in HQ or with the app\'s Comment button.');
    if (!String(f.source ?? '').trim()) throw new McError('Say where the comment came from (source), e.g. "chat" or the artifact link.');
    return feedback(f, as);
  }
  /** A change request. Whoever raises it may say what it amends or extends; otherwise the lead maps it. */
  function change(f = {}, by = HUMAN) {
    if (!f.text?.trim()) throw new McError('Empty change request.');
    const u = f.unit ? unit(f.unit) : null;
    const amends = idsOf(f.amends);
    const ext = idsOf(f.extends);
    checkMapping(amends, ext, { allowEmpty: true });
    const batch = f.batch && isHuman(by) ? reviewFor(by, f.review === true ? null : f.review).id : null;
    // in epic mode a change ships with the epic it changes, not on a branch of its own
    const epic = !u && !byRelease() ? index.epicOf([...amends, ...ext]) : null;
    const res = createTicket(by, { title: `Change: ${f.text.slice(0, 70)}`, body: f.text, kind: 'change', amends, extends: ext, batch, ...(u ? (s().releases[u.id] ? { release: u.id } : { epic: u.id }) : epic ? { epic } : {}) });
    const impact = amends.length || ext.length ? index.impact(res.ticket.id).line : null;
    if (impact) post(by, { channel: `ticket:${res.ticket.id}`, text: impact }, { system: true });
    if (batch) return { ...res, review: { id: batch, comments: s().reviews[batch].comments.length } };
    post(by, { channel: 'general', text: `Change request ${res.ticket.id} @${lead}: ${f.text} — ${impact ?? 'please map it to the requirements it amends or extends (mc_map_change) and post an impact check.'}` }, { system: true });
    return impact ? { ...res, impact } : res;
  }

  // ---------- requirements and change requests ----------
  function checkMapping(amends, ext, { allowEmpty = false } = {}) {
    for (const x of [...amends, ...ext]) {
      if (!index.isRequirement(x)) throw new McError(`${x} isn't a requirement, story or epic${index.node(x) ? ` (it's a ${index.node(x).kind})` : ' (nothing is registered under that ID)'}.`);
    }
    if (!allowEmpty && !amends.length && !ext.length) {
      throw new McError('Say which requirements it amends (changes what they say) or extends (builds on); an epic counts. If the project has none yet, define the one it adds with mc_requirement (change: its ID).');
    }
  }
  /**
   * Map a change request or comment to what it changes. A comment says what
   * kind of change it is: an element change stays on its screen and amends
   * nothing; a UX or story change amends or extends requirements, and its
   * impact reaches every screen implementing them. Returns, and posts in its
   * thread, the impact.
   */
  function mapChange(as, id, f = {}) {
    if (!canPlan(as)) throw new McError('Only the lead, the product manager or a person maps a change request.');
    const t = ticket(id);
    if (!['change', 'feedback'].includes(t.kind)) throw new McError(`${t.id} is a ${t.kind} ticket. Map change requests and comments; give other tickets refs (mc_update_ticket).`);
    const amends = idsOf(f.amends);
    const ext = idsOf(f.extends);
    const level = f.level != null && f.level !== '' ? levelOf(f.level) : t.level;
    if (!level && t.kind === 'feedback') levelOf(null, true);
    const screen = f.screen !== undefined ? (f.screen ? screenById(f.screen).id : null) : t.screen;
    if (level === 'element') {
      if (amends.length) throw new McError(`An element change keeps to what's agreed, so it amends nothing. If it changes what ${amends.join(', ')} says, map it as "ux" or "story".`);
      checkMapping([], ext, { allowEmpty: true });
      const sc = screen ? s().screens[screen] : null;
      if (!ext.length && !sc) throw new McError(`Say which screen it's on (screen: "SCR-n"; mc_screens lists them, mc_screen adds one) or which story it belongs to (extends).`);
      if (!ext.length && !sc.implements.length) throw new McError(`${sc.id} doesn't say what it implements yet. Add that (mc_screen id "${sc.id}", implements [...]) or pass extends.`);
    } else checkMapping(amends, ext);
    if (screen !== t.screen) store.append('ticket.update', as, { id: t.id, fields: { screen } });
    store.append('ticket.map', as, { id: t.id, amends, extends: ext, ...(level ? { level } : {}) });
    // in epic mode a change ships with the epic it changes, not on a branch of its own
    const epic = !byRelease() && !t.epic && !t.release && t.status === 'todo' ? index.epicOf([...amends, ...ext, ...(screen ? s().screens[screen].implements : [])]) : null;
    if (epic) {
      if (!s().epics[epic]) store.append('epic.upsert', as, { id: epic, title: epic, phase: 'build' });
      store.append('ticket.update', as, { id: t.id, fields: { epic } });
    }
    const imp = index.impact(t.id);
    post(as === 'cli' ? lead : as, { channel: `ticket:${t.id}`, text: imp.line }, { system: true });
    const inReview = parked(t) ? s().reviews[t.batch] : null;
    const next = inReview
      ? `It's one of the comments in ${inReview.id}: put its wording, tickets and reopenings in that review's plan (mc_feedback_plan), not one by one.`
      : level === 'element'
        ? `Fix it on ${screen ?? 'its screen'}: assign ${t.id} to whoever built the screen${imp.affected.tickets.length ? ` (${imp.affected.tickets.map((x) => `${x.id}${x.by ? ` by ${x.by}` : ''}`).join(', ')})` : ''}. Nothing agreed changes, so no new wording.`
        : imp.affected.tickets.length
          ? `Post the impact in #general. For each affected ticket: reopen it (mc_reopen) or confirm it still holds (mc_decide with refs [ticket, "${t.id}"]). Record the new wording with mc_requirement (id, text, change: "${t.id}"). Changes to a release's or epic's scope wait for the human's OK.`
          : `Post the impact in #general, record any new wording with mc_requirement (change: "${t.id}"), then split it into tickets with refs ["${t.id}"].`;
    const unplaced = !inReview && !byRelease() && !s().tickets[t.id].epic && !t.release ? ` It isn't in an epic, so it would merge on its own branch: set one with mc_update_ticket (epic).` : '';
    return { ok: true, ...imp, ...(epic ? { epic } : {}), next: next + unplaced };
  }

  // ---------- reviews: the human's comments, gathered, planned as one, approved once ----------
  const REVIEW_NEXT = {
    open: 'The human is still commenting.',
    submitted: 'Plan it: /mc-review-feedback (mc_feedback_review, then mc_feedback_plan).',
    proposed: "The plan waits for the human's OK in HQ → Inbox.",
    approved: 'Being applied.',
  };
  function reviewOf(id) {
    const r = s().reviews[String(id ?? '').trim().toUpperCase()];
    if (!r) throw new McError(`No review ${id}.`);
    return r;
  }
  /** The person's open review (one at a time), opened on first use. */
  function reviewFor(person, id) {
    if (id) {
      const r = reviewOf(id);
      if (r.status !== 'open') throw new McError(`${r.id} is ${r.status}; comments go into an open review.`);
      return r;
    }
    return Object.values(s().reviews).find((r) => r.status === 'open' && r.by === person) ?? openReview(person).review;
  }
  function openReview(as, f = {}) {
    if (!isHuman(as)) throw new McError('A review gathers a person\'s comments; people start one in HQ or by batching a comment.');
    const open = Object.values(s().reviews).find((r) => r.status === 'open' && r.by === as);
    if (open) return { ok: true, review: open, existing: true };
    const id = nextId('review', 'REV');
    store.append('review.open', as, { id, title: String(f.title ?? '').trim() || `Review of ${new Date().toISOString().slice(0, 10)}` });
    return { ok: true, review: s().reviews[id] };
  }
  /** Move a comment into a review (planned with the others) or out of it (handled now). */
  function batchComment(as, id, target) {
    if (!isHuman(as) && !canPlan(as)) throw new McError('Only a person or the lead moves comments in or out of a review.');
    const t = ticket(id);
    if (!['feedback', 'change'].includes(t.kind)) throw new McError(`${t.id} isn't a comment or change request.`);
    if (t.withdrawn || t.status !== 'todo') throw new McError(`${t.id} is ${t.withdrawn ? 'withdrawn' : t.status}.`);
    const cur = t.batch ? s().reviews[t.batch] : null;
    if (cur && !['open', 'submitted'].includes(cur.status)) throw new McError(`${cur.id} is ${cur.status}: its plan covers ${t.id}. Send the plan back first.`);
    if (target) {
      const r = reviewFor(t.from ?? (isHuman(as) ? as : HUMAN), target === true ? null : target);
      if (t.batch !== r.id) store.append('ticket.batch', as, { id: t.id, review: r.id });
      return { ok: true, review: r.id };
    }
    if (!cur) return { ok: true, review: null };
    store.append('ticket.batch', as, { id: t.id, review: null });
    if (isHuman(as)) post(as, { channel: 'general', text: `${t.id} @${lead}: handle this one now, not with ${cur.id}: ${t.title}` }, { system: true });
    return { ok: true, review: null };
  }
  function submitReview(as, id) {
    if (!isHuman(as)) throw new McError('The person who gathered the comments submits the review.');
    const r = id ? reviewOf(id) : Object.values(s().reviews).find((x) => x.status === 'open' && x.by === as);
    if (!r) throw new McError('You have no open review.');
    if (r.status !== 'open') throw new McError(`${r.id} is already ${r.status}.`);
    const live = r.comments.filter((c) => !s().tickets[c]?.withdrawn);
    if (!live.length) throw new McError(`${r.id} has no comments yet.`);
    store.append('review.submit', as, { id: r.id });
    return { ok: true, review: r.id, comments: live };
  }
  /** Everything the lead needs to plan a review, and the human to approve it. */
  function reviewView(as, id) {
    actor(as, { allowHuman: true, allowCli: true });
    if (!id) {
      return {
        reviews: Object.values(s().reviews)
          .reverse()
          .map((r) => ({ id: r.id, title: r.title, by: r.by, status: r.status, comments: r.comments.length, ...(REVIEW_NEXT[r.status] ? { next: REVIEW_NEXT[r.status] } : {}) })),
      };
    }
    const r = reviewOf(id);
    const a = index.reviewAnalysis(r.id);
    for (const c of a.comments) {
      const sk = sketchesOf(s().tickets[c.id]);
      if (sk.length) c.sketches = sk;
    }
    const out = { ...a, review: { ...a.review, history: r.history } };
    if (r.plan) out.plan = r.plan;
    if (['submitted', 'proposed'].includes(r.status)) {
      const problems = r.plan ? validatePlan(r, r.plan, a) : null;
      if (problems) out.plan_check = problems.length ? { ok: false, problems } : { ok: true };
      out.next =
        r.status === 'submitted'
          ? `Map each comment (mc_map_change with level; sketches are images to open), then propose one plan with mc_feedback_plan: an item per comment, the new wording for everything amended, new tickets, reopenings, and an answer to every check.${a.comments.some((c) => c.sketches) ? ' Some comments have sketches: open them before you plan.' : ''}`
          : "Waiting for the human's OK.";
    }
    return out;
  }
  const ACTIONS = ['fix', 'split', 'merge', 'decline'];
  /**
   * The plan's problems against the review as it stands now (empty: it holds).
   * Every comment is classified and covered once; everything a UX or story
   * comment amends gets its new wording; every check is answered.
   */
  function validatePlan(r, plan, a = index.reviewAnalysis(r.id)) {
    const problems = [];
    const live = new Map(a.comments.filter((c) => !c.withdrawn).map((c) => [c.id, c]));
    for (const c of a.checks) if (c.blocking) problems.push(c.text);
    if (!String(plan.summary ?? '').trim()) problems.push('Give a summary: what changes, in a few lines the human reads first.');
    const items = new Map();
    for (const it of plan.items ?? []) {
      const cid = String(it.comment ?? '').toUpperCase();
      if (!live.has(cid)) problems.push(`items: ${it.comment} isn't a comment in ${r.id}.`);
      else if (items.has(cid)) problems.push(`items: ${cid} is listed twice.`);
      else if (!ACTIONS.includes(it.action)) problems.push(`items: ${cid} needs an action: fix (the comment is the work), split (into tickets), merge (into another comment) or decline.`);
      else {
        items.set(cid, it);
        if (it.action === 'decline' && !String(it.reason ?? '').trim()) problems.push(`items: say why ${cid} is declined (reason).`);
        if (it.action === 'merge') {
          const into = String(it.into ?? '').toUpperCase();
          if (!live.has(into) || into === cid) problems.push(`items: ${cid} merges into another comment in ${r.id} (into).`);
        }
        if (it.assignee && !isMember(it.assignee)) problems.push(`items: unknown assignee "${it.assignee}" for ${cid}.`);
      }
    }
    for (const cid of live.keys()) if (!items.has(cid)) problems.push(`items: ${cid} isn't in the plan. Every comment gets an item (fix, split, merge or decline).`);
    for (const [cid, it] of items) if (it.action === 'merge' && ['decline', 'merge'].includes(items.get(String(it.into).toUpperCase())?.action)) problems.push(`items: ${cid} merges into ${it.into}, which is itself ${items.get(String(it.into).toUpperCase()).action}d.`);
    const taken = (cid) => items.has(cid) && !['decline', 'merge'].includes(items.get(cid).action);
    // wording for everything amended
    const amended = new Map();
    for (const am of plan.amendments ?? []) {
      const n = index.node(am.id);
      if (!n || !['requirement', 'story'].includes(n.kind)) {
        problems.push(`amendments: ${am.id} isn't a requirement or story.`);
        continue;
      }
      if (amended.has(n.key)) problems.push(`amendments: ${n.id} is listed twice; give it one wording.`);
      const cs = (am.comments ?? []).map((x) => String(x).toUpperCase());
      if (!cs.length || cs.some((x) => !live.has(x))) problems.push(`amendments: ${n.id} needs comments: the comments in ${r.id} it comes from.`);
      else if (cs.every((x) => !taken(x))) problems.push(`amendments: ${n.id} comes only from comments the plan declines or merges.`);
      else if (cs.some((x) => live.get(x).level === 'element')) problems.push(`amendments: ${cs.filter((x) => live.get(x).level === 'element').join(', ')} ${cs.length > 1 ? 'are' : 'is'} element changes, which amend nothing. Map them as ux or story first.`);
      if (!String(am.text ?? '').trim()) problems.push(`amendments: ${n.id} needs its new text.`);
      amended.set(n.key, cs);
    }
    for (const [cid, c] of live) {
      if (!taken(cid)) continue;
      for (const x of c.amends) if (!amended.has(index.keyOf(x))) problems.push(`${cid} amends ${x}, but the plan gives ${x} no new wording. Add it to amendments, or map ${cid} as extending ${x} if it doesn't change what ${x} says.`);
    }
    for (const q of plan.requirements ?? []) {
      const cid = String(q.comment ?? '').toUpperCase();
      if (!taken(cid)) problems.push(`requirements: "${q.title ?? '?'}" needs the comment it comes from (comment), one the plan keeps.`);
      else if (live.get(cid).level === 'element') problems.push(`requirements: ${cid} is an element change; it adds no requirement.`);
      if (!['FR', 'NFR', 'UXR'].includes(String(q.kind ?? 'FR').toUpperCase())) problems.push(`requirements: kind is FR, NFR or UXR.`);
      if (!String(q.title ?? '').trim() || !String(q.text ?? '').trim()) problems.push('requirements: each needs a title and text.');
      for (const x of q.extends ?? []) if (!index.isRequirement(x)) problems.push(`requirements: ${x} isn't a requirement, story or epic.`);
    }
    for (const nt of plan.tickets ?? []) {
      const cid = String(nt.comment ?? '').toUpperCase();
      if (!taken(cid)) problems.push(`tickets: "${nt.title ?? '?'}" needs the comment it does (comment), one the plan keeps.`);
      if (!String(nt.title ?? '').trim()) problems.push('tickets: each needs a title.');
      const found = index.check({ refs: nt.refs ?? [] });
      if (found.unknown.length) problems.push(`tickets: "${nt.title}" refers to ${found.unknown.join(', ')}, which isn't defined anywhere.`);
      if (nt.assignee && !isMember(nt.assignee)) problems.push(`tickets: unknown assignee "${nt.assignee}".`);
      for (const d of nt.deps ?? []) if (!s().tickets[String(d).toUpperCase()]) problems.push(`tickets: dependency ${d} doesn't exist (new tickets can't depend on each other here; set deps after).`);
    }
    for (const [cid, it] of items) if (it.action === 'split' && !(plan.tickets ?? []).some((x) => String(x.comment ?? '').toUpperCase() === cid)) problems.push(`items: ${cid} is split, but no ticket in tickets does it.`);
    const reopen = new Set();
    for (const ro of plan.reopen ?? []) {
      const t = s().tickets[String(ro.ticket ?? '').toUpperCase()];
      if (!t) problems.push(`reopen: no ticket ${ro.ticket}.`);
      else if (t.status === 'todo') problems.push(`reopen: ${t.id} hasn't started; nothing to reopen.`);
      else if (live.has(t.id)) problems.push(`reopen: ${t.id} is a comment in this review.`);
      else {
        reopen.add(t.id);
        if (!String(ro.reason ?? '').trim()) problems.push(`reopen: say why ${t.id} is reopened (reason).`);
      }
    }
    const supersede = new Set();
    for (const d of plan.supersede ?? []) {
      const id2 = String(d).toUpperCase();
      if (!s().decisions.some((x) => x.id === id2)) problems.push(`supersede: no decision ${d}.`);
      else supersede.add(id2);
    }
    // every check answered, unless only declined or merged comments raised it
    const said = plan.resolutions ?? {};
    for (const c of a.checks) {
      if (c.blocking || (c.comments.length && c.comments.every((x) => !taken(x)))) continue;
      const id2 = c.ids[0];
      const handled =
        String(said[c.key] ?? '').trim() ||
        (c.kind === 'rework' && reopen.has(id2)) ||
        (c.kind === 'story' && amended.has(index.keyOf(id2))) ||
        (c.kind === 'decision' && supersede.has(id2)) ||
        (c.kind === 'overlap' && c.comments.every((x) => (amended.get(index.keyOf(id2)) ?? []).includes(x) || !taken(x))) ||
        (c.kind === 'same-element' && c.comments.filter(taken).length <= 1);
      if (!handled) problems.push(`${c.text} (answer it in resolutions["${c.key}"])`);
    }
    return problems;
  }
  /** The lead or PM proposes the plan for a submitted review. It must hold before the human sees it. */
  function planReview(as, id, plan = {}) {
    if (isHuman(as) || !canPlan(as)) throw new McError('The lead or the product manager plans a review; the human approves it.');
    const r = reviewOf(id);
    if (!['submitted', 'proposed'].includes(r.status)) throw new McError(`${r.id} is ${r.status}. ${r.status === 'open' ? 'The human is still commenting; it is planned once they submit it.' : ''}`);
    const a = index.reviewAnalysis(r.id);
    const problems = validatePlan(r, plan, a);
    if (problems.length) throw new McError(`The plan for ${r.id} doesn't hold yet:\n- ${problems.join('\n- ')}`);
    const clean = {
      summary: String(plan.summary).trim(),
      items: plan.items.map((it) => ({ comment: String(it.comment).toUpperCase(), action: it.action, ...(it.into ? { into: String(it.into).toUpperCase() } : {}), ...(it.reason ? { reason: String(it.reason) } : {}), ...(it.assignee ? { assignee: it.assignee } : {}) })),
      amendments: (plan.amendments ?? []).map((x) => ({ id: index.node(x.id).id, text: String(x.text).trim(), comments: x.comments.map((c) => String(c).toUpperCase()) })),
      requirements: (plan.requirements ?? []).map((x) => ({ kind: String(x.kind ?? 'FR').toUpperCase(), title: String(x.title).trim(), text: String(x.text).trim(), extends: idsOf(x.extends), comment: String(x.comment).toUpperCase() })),
      tickets: (plan.tickets ?? []).map((x) => ({ title: String(x.title).trim(), body: String(x.body ?? ''), comment: String(x.comment).toUpperCase(), refs: idsOf(x.refs), ...(x.assignee ? { assignee: x.assignee } : {}), ...(x.domain ? { domain: String(x.domain) } : {}), ...(x.ui !== undefined ? { ui: Boolean(x.ui) } : {}), deps: (x.deps ?? []).map((d) => String(d).toUpperCase()) })),
      reopen: (plan.reopen ?? []).map((x) => ({ ticket: String(x.ticket).toUpperCase(), reason: String(x.reason) })),
      supersede: (plan.supersede ?? []).map((d) => String(d).toUpperCase()),
      resolutions: Object.fromEntries(Object.entries(plan.resolutions ?? {}).filter(([, v]) => String(v ?? '').trim()).map(([k, v]) => [k, String(v).trim()])),
    };
    store.append('review.plan', as, { id: r.id, plan: clean, checks: a.checks.map(({ key, kind, text }) => ({ key, kind, text })) });
    return { ok: true, review: r.id, status: 'proposed', next: "It's in HQ → Inbox for the human to approve or send back. Wait for that; nothing in it starts before." };
  }
  /** The human approves the plan (HQ applies all of it) or sends it back with notes. */
  function decideReview(as, id, f = {}) {
    if (!isHuman(as)) throw new McError('Only a person approves or sends back a review\'s plan.');
    const r = reviewOf(id);
    if (r.status !== 'proposed') throw new McError(`${r.id} has no plan waiting (it is ${r.status}).`);
    if (!['approve', 'revise'].includes(f.verdict)) throw new McError('verdict is "approve" or "revise".');
    if (f.verdict === 'revise') {
      if (!String(f.notes ?? '').trim()) throw new McError('Say what should change in the plan.');
      store.append('review.decide', as, { id: r.id, verdict: 'revise', notes: String(f.notes).trim() });
      return { ok: true, status: 'submitted' };
    }
    // things may have moved since it was planned: a plan that no longer holds goes back
    const problems = validatePlan(r, r.plan);
    if (problems.length) {
      store.append('review.decide', 'cli', { id: r.id, verdict: 'revise', notes: `Out of date since it was planned: ${problems.join(' ')}` });
      return { ok: false, status: 'submitted', problems, note: 'Things changed since the plan was made, so it went back to the lead to update.' };
    }
    store.append('review.decide', as, { id: r.id, verdict: 'approve', notes: String(f.notes ?? '') });
    return { ok: true, status: 'applied', ...applyPlan(as, r) };
  }
  /** Carry out an approved plan: withdraw, merge, reword, add requirements and tickets, reopen, record the decision. */
  function applyPlan(approver, r) {
    const plan = r.plan;
    const by = plan.by;
    const done = { withdrawn: [], merged: [], amended: [], added: [], tickets: [], reopened: [], decisions: [] };
    for (const it of plan.items) {
      if (it.action === 'merge') {
        post(by, { channel: `ticket:${it.into}`, text: `Merged in from ${it.comment}: ${s().tickets[it.comment].body}` }, { system: true });
        withdrawChange(by, it.comment, `merged into ${it.into} (plan for ${r.id})`);
        done.merged.push(`${it.comment} → ${it.into}`);
      }
      if (it.action === 'decline') {
        withdrawChange(by, it.comment, `${it.reason} (plan for ${r.id})`);
        done.withdrawn.push(it.comment);
      }
    }
    for (const am of plan.amendments) {
      defineRequirement(by, { id: am.id, text: am.text, change: am.comments.find((c) => !s().tickets[c].withdrawn) });
      done.amended.push(am.id);
    }
    for (const q of plan.requirements) done.added.push(defineRequirement(by, { kind: q.kind, title: q.title, text: q.text, extends: q.extends, change: q.comment }).id);
    for (const nt of plan.tickets) {
      const c = s().tickets[nt.comment];
      const res = createTicket(lead, { title: nt.title, body: nt.body, refs: [nt.comment, ...nt.refs], ui: nt.ui ?? c.ui, domain: nt.domain, deps: nt.deps, assignee: nt.assignee, ...(c.release ? { release: c.release } : c.epic ? { epic: c.epic } : {}) });
      done.tickets.push(res.ticket.id);
    }
    for (const ro of plan.reopen) {
      reopen(lead, ro.ticket, `${ro.reason} (plan for ${r.id})`);
      done.reopened.push(ro.ticket);
    }
    for (const it of plan.items) if (it.action === 'fix' && it.assignee) assign(lead, it.comment, it.assignee);
    // the human's OK is a decision: it settles what the plan answered (rework kept, decisions and answers that still hold)
    const kept = plan.items.filter((it) => !['decline', 'merge'].includes(it.action)).map((it) => it.comment);
    const answered = (r.plan.checks ?? []).filter((c) => plan.resolutions[c.key]).map((c) => c.key.split(':').slice(1).join(':')).filter((x) => index.node(x) && !x.includes('+'));
    const refs = [...new Set([...kept, ...done.amended, ...answered])];
    const why = [`${nameOf(approver)} approved the plan for ${r.id} (${r.comments.length} comment${r.comments.length === 1 ? '' : 's'}).`, ...Object.entries(plan.resolutions).map(([k, v]) => `${k}: ${v}`)].join(' ');
    const did = nextId('dec', 'DEC');
    store.append('decision.log', approver, { id: did, title: `Plan for ${r.id} approved: ${r.title}`, decision: plan.summary, why, alternatives: '', links: [], ticket: null, refs, supersedes: plan.supersede[0] ?? null });
    done.decisions.push(did);
    for (const old of plan.supersede.slice(1)) {
      const x = nextId('dec', 'DEC');
      store.append('decision.log', approver, { id: x, title: `${old} no longer holds (plan for ${r.id})`, decision: `Superseded by ${did}.`, why: plan.summary, alternatives: '', links: [], ticket: null, refs: kept, supersedes: old });
      done.decisions.push(x);
    }
    // the plan answered every check against what's agreed, and a person approved it: that's a consistency review
    const checked = [...plan.items.filter((it) => ['fix', 'split'].includes(it.action) && s().tickets[it.comment]?.level !== 'element').map((it) => it.comment), ...done.amended, ...done.added];
    if (checked.length) store.append('consistency.check', by, { ids: checked, verdict: 'consistent', note: `Planned together in ${r.id}; ${nameOf(approver)} approved the plan (${did}).` });
    store.append('review.applied', by, { id: r.id, ...done });
    return done;
  }
  function nameOf(id) {
    return id === HUMAN ? config.owner ?? 'The owner' : config.people.find((p) => p.id === id)?.name ?? id;
  }
  /** Discard a review: its comments nobody has started are withdrawn. */
  function cancelReview(as, id, reason) {
    if (!isHuman(as) && as !== lead) throw new McError('A person (or the lead, when asked) discards a review.');
    const r = reviewOf(id);
    if (!['open', 'submitted', 'proposed'].includes(r.status)) throw new McError(`${r.id} is ${r.status}.`);
    const why = String(reason ?? '').trim() || 'review discarded';
    for (const c of r.comments) {
      const t = s().tickets[c];
      if (t && !t.withdrawn && t.status === 'todo') withdrawChange(as, c, `${r.id} discarded: ${why}`);
    }
    store.append('review.cancel', as, { id: r.id, reason: why });
    return { ok: true };
  }

  /**
   * Withdraw a change request nobody has started (you said no, or it's no
   * longer wanted). Its untouched tickets go with it, the wording it proposed
   * is dropped and requirements it added no longer apply.
   */
  function withdrawChange(as, id, reason) {
    if (!canPlan(as)) throw new McError('Only the lead, the product manager or a person withdraws a change request.');
    const t = ticket(id);
    if (!['change', 'feedback'].includes(t.kind)) throw new McError(`${t.id} is a ${t.kind} ticket; only change requests and feedback are withdrawn.`);
    if (t.withdrawn) throw new McError(`${t.id} is already withdrawn.`);
    if (t.status !== 'todo') throw new McError(`${t.id} is ${t.status}. Only a change nobody has started can be withdrawn; to undo built work, raise a change that reverses it.`);
    if (!String(reason ?? '').trim()) throw new McError('Say why it is withdrawn.');
    const parts = partsOf(t.id).filter((x) => !x.withdrawn);
    const started = parts.filter((x) => x.status !== 'todo');
    if (started.length) throw new McError(`${started.map((x) => `${x.id} (${x.status})`).join(', ')} already started on it. Stop that work first; anything merged needs a change that reverses it.`);
    for (const p of parts) store.append('ticket.withdraw', as, { id: p.id, reason: `part of ${t.id}: ${reason}` });
    store.append('ticket.withdraw', as, { id: t.id, reason: String(reason) });
    const dropped = s().amendments.filter((a) => a.change === t.id).map((a) => a.id);
    const removed = Object.values(s().requirements).filter((r) => r.change === t.id).map((r) => r.id);
    const line = `${t.id} withdrawn: ${reason}.${dropped.length ? ` The wording it proposed for ${dropped.join(', ')} is dropped.` : ''}${removed.length ? ` ${removed.join(', ')} no longer ${removed.length > 1 ? 'apply' : 'applies'}.` : ''}`;
    post(as === 'cli' ? lead : as, { channel: `ticket:${t.id}`, text: line }, { system: true });
    return { ok: true, withdrawn: [t.id, ...parts.map((p) => p.id)], line };
  }

  // ---------- contradictions: raised, routed, reviewed ----------
  /** Who settles a conflict: use-case ones the product manager, technical ones the architect; the lead otherwise. */
  function conflictOwner(kind, as) {
    const type = kind === 'use-case' ? 'product-manager' : 'architect';
    return config.team.find((m) => m.type === type && m.id !== as)?.id ?? lead;
  }
  /**
   * Raise a contradiction between a ticket, story, requirement, decision or
   * answer and something already agreed. It's a question to whoever settles
   * that kind of conflict, carrying both sides and a recommendation.
   */
  function conflict(as, f = {}) {
    actor(as);
    const about = (f.about ?? []).map(String).filter((x) => x.trim());
    if (!about.length) throw new McError('Name both sides: about, e.g. ["Story 3.2", "FR2"].');
    const found = index.check({ refs: about });
    if (found.unknown.length) throw new McError(`${found.unknown.join(', ')} ${found.unknown.length > 1 ? "aren't" : "isn't"} defined anywhere (mc_lookup checks an ID).`);
    const kind = f.kind === 'tech' ? 'tech' : f.kind === 'use-case' ? 'use-case' : null;
    if (!kind) throw new McError('kind is "use-case" (what the product should do) or "tech" (how it is built).');
    if (!String(f.conflict ?? '').trim()) throw new McError('Say what contradicts what.');
    if (!String(f.recommendation ?? '').trim()) throw new McError('Recommend a way out: which side should win, or what should change.');
    const to = conflictOwner(kind, as);
    if (to === as) throw new McError(`Conflicts like this come to you. Settle it with mc_decide, raise a change (mc_change) for the human's OK, or mc_escalate if it's the human's call.`);
    const tid = f.ticket ? ticket(f.ticket).id : null;
    const ids = idsOf(about);
    const id = nextId('q', 'Q');
    const question = `Conflict (${kind}): ${String(f.conflict).trim()} Recommendation: ${String(f.recommendation).trim()}`;
    store.append('question.ask', as, { id, to, question, ticket: tid, options: [], links: f.links ?? [], refs: ids, conflict: { kind, about: ids, recommendation: String(f.recommendation).trim() } });
    post(as, { channel: `dm:${to}`, text: `${id} @${to}: ${question}` }, { system: true });
    return { ok: true, id, to, note: `${id} went to ${to}${to === lead ? ' (the lead)' : ''}. Don't build either side meanwhile: park the ticket with mc_block (blockedBy: ["${id}"]) if it depends on the answer.` };
  }
  /** Record that stories, requirements or changes were checked against what's agreed. */
  function check(as, f = {}) {
    const m = member(config, as);
    if (!canPlan(as) && m?.type !== 'architect') throw new McError('The lead, the product manager or the architect checks for conflicts.');
    const ids = (f.ids ?? []).map(String).filter((x) => x.trim());
    if (!ids.length) throw new McError('Say what you checked: ids, e.g. ["Story 2.1", "APP-7"].');
    const found = index.check({ refs: ids });
    if (found.unknown.length) throw new McError(`${found.unknown.join(', ')} ${found.unknown.length > 1 ? "aren't" : "isn't"} defined anywhere.`);
    if (!['consistent', 'conflict'].includes(f.verdict)) throw new McError('verdict is "consistent" or "conflict".');
    const raised = (f.conflicts ?? []).map((q) => String(q).toUpperCase());
    if (f.verdict === 'conflict' && !raised.some((q) => s().questions[q]?.conflict)) throw new McError('Raise each conflict with mc_conflict first, then pass their question IDs as conflicts.');
    store.append('consistency.check', as, { ids: idsOf(ids), verdict: f.verdict, note: [f.note, raised.length ? `Conflicts: ${raised.join(', ')}` : ''].filter(Boolean).join(' ') });
    return { ok: true };
  }
  /**
   * The lead or PM raises a change request (typically to settle a conflict).
   * It must say what it amends or extends, and waits for a person's OK before
   * anyone starts it; the human raises theirs in HQ and needs no OK.
   */
  function raiseChange(as, f = {}) {
    if (isHuman(as) || !canPlan(as)) throw new McError('The lead or the product manager raises a change; people do it in HQ → Inbox.');
    if (!String(f.text ?? '').trim()) throw new McError('Describe the change.');
    const amends = idsOf(f.amends);
    const ext = idsOf(f.extends);
    checkMapping(amends, ext);
    const from = f.from ? String(f.from).toUpperCase() : null;
    if (from && !s().questions[from]) throw new McError(`No question ${f.from}.`);
    const epic = !byRelease() ? index.epicOf([...amends, ...ext]) : null;
    const body = `${String(f.text).trim()}${f.why ? `\n\nWhy: ${f.why}` : ''}${from ? `\n\nFrom ${from}.` : ''}`;
    const res = createTicket(lead, { title: `Change: ${String(f.text).trim().slice(0, 70)}`, body, kind: 'change', amends, extends: ext, approval: 'needed', raisedBy: as, ...(epic ? { epic } : {}) });
    const imp = index.impact(res.ticket.id);
    post(as, { channel: `ticket:${res.ticket.id}`, text: `${imp.line} Raised by ${as}; waits for the human's OK.` }, { system: true });
    // work parked on the conflict this settles now waits for the human's OK on the change, not just an answer
    const touched = new Set([...amends, ...ext].map((x) => index.keyOf(x)));
    const settles = new Set(
      Object.values(s().questions)
        .filter((q) => q.conflict && (q.id === from || (q.status === 'open' && q.conflict.about.some((x) => touched.has(index.keyOf(x))))))
        .map((q) => q.id),
    );
    const parked = Object.values(s().tickets).filter((t) => t.status === 'blocked' && t.blockedBy.some((b) => settles.has(b)));
    for (const t of parked) store.append('ticket.status', as, { id: t.id, status: 'blocked', blockedBy: [...new Set([...t.blockedBy, res.ticket.id])] });
    return { ok: true, id: res.ticket.id, ...imp, ...(parked.length ? { parked: parked.map((t) => t.id) } : {}), next: `It shows in HQ → Inbox for the human to approve or withdraw.${parked.length ? ` ${parked.map((t) => t.id).join(', ')} now wait${parked.length > 1 ? '' : 's'} for that OK.` : ''} Record the wording it proposes now with mc_requirement (id, text, change: "${res.ticket.id}").` };
  }
  /** A person approves a change the team raised; until then nobody starts it. */
  function approveChange(as, id) {
    if (!isHuman(as)) throw new McError('Only a person approves a change.');
    const t = ticket(id);
    if (t.kind !== 'change' || t.approval !== 'needed') throw new McError(`${t.id} isn't waiting for approval.`);
    if (t.withdrawn) throw new McError(`${t.id} was withdrawn.`);
    store.append('ticket.approve', as, { id: t.id });
    return { ok: true };
  }

  /**
   * Add a requirement (from the brief, MVP scope or a change request), or
   * amend an existing one, PRD or not, with the change request behind it.
   * Written to .madcompany/log/requirements.md; the PRD itself is never edited.
   */
  function defineRequirement(as, f = {}) {
    if (!canPlan(as)) throw new McError('Only the lead, the product manager or a person defines requirements.');
    const text = String(f.text ?? '').trim();
    if (!text) throw new McError('A requirement needs its text: what the product must do.');
    const chg = f.change ? ticket(f.change) : null;
    if (chg && !['change', 'feedback'].includes(chg.kind)) throw new McError(`${chg.id} isn't a change request.`);
    if (f.id) {
      const n = index.node(f.id);
      if (!n || !['requirement', 'story'].includes(n.kind)) throw new McError(`${f.id} isn't a requirement or story. Leave out id to add a new requirement.`);
      if (!chg && strictness() === 'strict') throw new McError(`Amending ${n.id} needs the change request behind it (change: "<ID>"). Raise one first (the human's, or mc_escalate).`);
      store.append('requirement.amend', as, { id: n.id, text, change: chg?.id ?? null });
      if (chg && !chg.amends.some((x) => index.keyOf(x) === n.key)) store.append('ticket.map', as, { id: chg.id, amends: [...chg.amends, n.id], extends: chg.extends });
      const holds = !chg || chg.status === 'done';
      return {
        ok: true,
        id: n.id,
        amended: true,
        state: holds ? 'in effect' : 'proposed',
        ...(holds ? {} : { note: `Proposed: agents see it next to the current wording, and it becomes ${n.id} when ${chg.id} is done.` }),
        ...(chg ? { impact: index.impact(chg.id).line } : {}),
      };
    }
    const kind = String(f.kind ?? 'FR').toUpperCase();
    if (!['FR', 'NFR', 'UXR'].includes(kind)) throw new McError('kind must be FR, NFR or UXR.');
    if (!String(f.title ?? '').trim()) throw new McError('A new requirement needs a short title.');
    const ext = idsOf(f.extends);
    checkMapping([], ext, { allowEmpty: true });
    if (chg && !ext.length && !chg.amends.length && !chg.extends.length && index.check().anyRequirements && strictness() === 'strict') {
      throw new McError(`A requirement added by ${chg.id} builds on what exists: pass extends (the requirements or epic it extends).`);
    }
    const id = index.nextRequirementId(kind);
    store.append('requirement.add', as, { id, kind, title: String(f.title).trim(), text, extends: ext, change: chg?.id ?? null, source: f.source ? String(f.source) : null });
    if (chg && ext.some((x) => !chg.extends.includes(x))) store.append('ticket.map', as, { id: chg.id, amends: chg.amends, extends: [...new Set([...chg.extends, ...ext])] });
    return { ok: true, id, link: `[${id}](.madcompany/log/requirements.md#${id.toLowerCase()})` };
  }

  // ---------- notes: what a member knows about a story or requirement ----------
  function note(as, f = {}) {
    actor(as, { allowHuman: true });
    const about = (f.about ?? []).map(String).filter((x) => x.trim());
    if (!about.length) throw new McError('A note is about something: pass about, e.g. ["Story 2.3"] or ["APP-31", "FR12"].');
    if (!String(f.text ?? '').trim()) throw new McError('Empty note.');
    const found = index.check({ refs: about, texts: [f.text] });
    if (found.unknown.length) throw new McError(`${found.unknown.join(', ')} ${found.unknown.length > 1 ? "aren't" : "isn't"} defined anywhere (mc_lookup checks an ID).`);
    const warning = traced('This note', found, 'Make it about a ticket, story or requirement.');
    const id = nextId('note', 'N');
    store.append('note.add', as, { id, about: idsOf(about), text: String(f.text).trim(), scope: f.scope === 'project' ? 'project' : 'story' });
    return withWarning({ ok: true, id }, warning);
  }

  // ---------- the project index: look up instead of reading files ----------
  function ref(as, id, opts = {}) {
    actor(as, { allowHuman: true, allowCli: true });
    return index.card(id, { only: opts.only ?? null });
  }
  function section(as, id) {
    actor(as, { allowHuman: true, allowCli: true });
    return index.section(id);
  }
  function traceView() {
    return { ...traceSummary(500), requirements: index.requirements() };
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
    relayComment,
    change,
    mapChange,
    defineScreen,
    screensView,
    screenFor,
    addSketch,
    openReview,
    batchComment,
    submitReview,
    reviewView,
    planReview,
    decideReview,
    cancelReview,
    withdrawChange,
    conflict,
    check,
    raiseChange,
    approveChange,
    defineRequirement,
    note,
    ref,
    section,
    traceView,
    traceSummary,
    index,
    minutes,
    addLink,
    STATUSES,
  };
}
