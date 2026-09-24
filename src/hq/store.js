import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

/**
 * HQ's state is an append-only event log (.storyfront/log/events.jsonl).
 * Everything else — board, chat, decisions, dashboard — is derived from it,
 * which also gives every ticket a full activity history for free.
 */
export function emptyState() {
  return {
    seq: 0,
    counters: { ticket: 0, dec: 0, q: 0, fact: 0, msg: 0 },
    workday: { state: 'off', since: null },
    epics: {},
    tickets: {},
    messages: [],
    decisions: [],
    questions: {},
    facts: [],
    designs: {},
    envs: {},
    handoffs: {},
    lastActivity: {},
    memoryUpdated: {},
  };
}

const num = (id) => Number(String(id).split('-').pop()) || 0;

export function applyEvent(s, ev) {
  s.seq = ev.seq;
  const d = ev.data ?? {};
  if (ev.by && ev.by !== 'cli') s.lastActivity[ev.by] = ev.ts;
  let t = d.id && s.tickets[d.id];

  switch (ev.type) {
    case 'workday.start':
      s.workday = { state: 'on', since: ev.ts };
      break;
    case 'workday.ending':
      s.workday = { ...s.workday, state: 'ending' };
      break;
    case 'workday.stop':
      s.workday = { state: 'stopped', since: ev.ts };
      break;
    case 'workday.end':
      s.workday = { state: 'off', since: ev.ts };
      break;

    case 'epic.upsert':
      s.epics[d.id] = { ...(s.epics[d.id] ?? { id: d.id }), ...d };
      break;

    case 'ticket.create':
      s.counters.ticket = Math.max(s.counters.ticket, num(d.id));
      t = s.tickets[d.id] = {
        id: d.id,
        title: d.title,
        epic: d.epic ?? null,
        body: d.body ?? '',
        domain: d.domain ?? null,
        deps: d.deps ?? [],
        ui: Boolean(d.ui),
        refs: d.refs ?? [],
        kind: d.kind ?? 'task',
        source: d.source ?? null,
        assignee: d.assignee ?? null,
        status: 'todo',
        blockedBy: [],
        attempts: 0,
        created: ev.ts,
        updated: ev.ts,
        checkpoint: null,
        worklog: [],
        reviews: [],
        attachments: [],
        commits: [],
        activity: [],
      };
      break;
    case 'ticket.update':
      if (t) for (const k of ['title', 'body', 'deps', 'domain', 'ui', 'epic', 'refs']) if (k in d.fields) t[k] = d.fields[k];
      break;
    case 'ticket.assign':
      if (t) t.assignee = d.agent;
      break;
    case 'ticket.claim':
      if (t) {
        t.status = 'in_progress';
        t.assignee = ev.by;
        t.attempts += 1;
        t.blockedBy = [];
      }
      break;
    case 'ticket.status':
      if (t) {
        t.status = d.status;
        t.blockedBy = d.status === 'blocked' ? d.blockedBy ?? [] : [];
      }
      break;
    case 'ticket.checkpoint':
      if (t) t.checkpoint = { done: d.done, next: d.next, files: d.files ?? [], questions: d.questions ?? [], by: ev.by, ts: ev.ts };
      break;
    case 'ticket.worklog':
      if (t) t.worklog.push({ by: ev.by, ts: ev.ts, text: d.text, checks: d.checks ?? null });
      break;
    case 'ticket.review':
      if (t) t.reviews.push({ by: ev.by, ts: ev.ts, verdict: d.verdict, notes: d.notes ?? '' });
      break;
    case 'ticket.attach':
      if (t) t.attachments.push({ by: ev.by, ts: ev.ts, kind: d.kind, path: d.path, caption: d.caption ?? '' });
      break;
    case 'ticket.commit':
      if (t) t.commits.push(...(d.commits ?? []));
      break;

    case 'msg.post':
      s.counters.msg = Math.max(s.counters.msg, num(d.id));
      s.messages.push({ id: d.id, channel: d.channel, by: ev.by, text: d.text, mentions: d.mentions ?? [], ts: ev.ts, seq: ev.seq });
      break;

    case 'decision.log':
      s.counters.dec = Math.max(s.counters.dec, num(d.id));
      s.decisions.push({ ...d, by: ev.by, ts: ev.ts });
      break;

    case 'question.ask':
      s.counters.q = Math.max(s.counters.q, num(d.id));
      s.questions[d.id] = {
        id: d.id,
        from: ev.by,
        to: d.to,
        question: d.question,
        options: d.options ?? [],
        recommended: d.recommended ?? null,
        links: d.links ?? [],
        ticket: d.ticket ?? null,
        status: 'open',
        ts: ev.ts,
        trail: [ev.by, d.to],
      };
      break;
    case 'question.escalate': {
      const q = s.questions[d.id];
      if (q) {
        q.to = d.to;
        q.trail.push(d.to);
        if (d.options) q.options = d.options;
        if (d.recommended !== undefined) q.recommended = d.recommended;
        if (d.links) q.links = d.links;
        if (d.question) q.question = d.question;
      }
      break;
    }
    case 'question.answer': {
      const q = s.questions[d.id];
      if (q) Object.assign(q, { status: 'answered', answer: d.answer, answeredBy: ev.by, answeredAt: ev.ts });
      break;
    }

    case 'fact.add':
      s.counters.fact = Math.max(s.counters.fact, num(d.id));
      s.facts.push({ id: d.id, text: d.text, source: d.source ?? null, by: ev.by, ts: ev.ts });
      break;

    case 'design.write': {
      const old = s.designs[d.path];
      s.designs[d.path] = {
        path: d.path,
        owner: old?.owner ?? ev.by,
        status: 'draft',
        consumers: d.consumers ?? old?.consumers ?? [],
        approvals: [],
        version: (old?.version ?? 0) + 1,
        updated: ev.ts,
      };
      settleDesign(s.designs[d.path]);
      break;
    }
    case 'design.approve': {
      const doc = s.designs[d.path];
      if (doc && !doc.approvals.includes(ev.by)) doc.approvals.push(ev.by);
      if (doc) settleDesign(doc);
      break;
    }
    case 'design.status':
      if (s.designs[d.path]) s.designs[d.path].status = d.status;
      break;

    case 'env.allocate':
      s.envs[d.agent] = { ports: d.ports, db: d.db };
      break;
    case 'handoff':
      s.handoffs[ev.by] = { ...d, ts: ev.ts };
      break;
    case 'memory.write':
      s.memoryUpdated[ev.by] = ev.ts;
      break;
    default:
      break;
  }

  if (ev.type.startsWith('ticket.') && t) {
    t.updated = ev.ts;
    t.activity.push({ seq: ev.seq, ts: ev.ts, by: ev.by, type: ev.type, text: summarize(ev) });
  }
}

function settleDesign(doc) {
  if (doc.status === 'frozen') return;
  const all = doc.consumers.length > 0 && doc.consumers.every((c) => doc.approvals.includes(c));
  doc.status = all ? 'agreed' : 'draft';
}

export function summarize(ev) {
  const d = ev.data ?? {};
  switch (ev.type) {
    case 'ticket.create': return `created (${d.kind ?? 'task'})`;
    case 'ticket.update': return `updated ${Object.keys(d.fields ?? {}).join(', ')}`;
    case 'ticket.assign': return `assigned to ${d.agent}`;
    case 'ticket.claim': return 'started work';
    case 'ticket.status':
      return d.status === 'blocked'
        ? `blocked by ${(d.blockedBy ?? []).join(', ')}`
        : `status → ${d.status}${d.reason ? ` (${d.reason})` : ''}`;
    case 'ticket.checkpoint': return `checkpoint — next: ${d.next}`;
    case 'ticket.worklog': return d.text;
    case 'ticket.review': return `review: ${d.verdict}${d.notes ? ` — ${d.notes}` : ''}`;
    case 'ticket.attach': return `attached ${d.kind}: ${d.caption || d.path}`;
    case 'ticket.commit': return `${(d.commits ?? []).length} commit(s) merged`;
    default: return ev.type;
  }
}

/** One line per event for the dashboard's "Latest" feed; null for noise. */
export function describeEvent(ev) {
  const d = ev.data ?? {};
  const clip = (t, n = 140) => (String(t).length > n ? `${String(t).slice(0, n)}…` : String(t));
  if (ev.type.startsWith('ticket.')) return ev.type === 'ticket.update' ? null : `${d.id}: ${clip(summarize(ev))}`;
  switch (ev.type) {
    case 'msg.post': return `in #${d.channel}: ${clip(d.text)}`;
    case 'decision.log': return `decided ${d.id}: ${d.title}`;
    case 'question.ask': return `asked ${d.to} ${d.id}: ${clip(d.question)}`;
    case 'question.answer': return `answered ${d.id}: ${clip(d.answer)}`;
    case 'question.escalate': return `passed ${d.id} to ${d.to}`;
    case 'design.write': return `wrote ${d.path}`;
    case 'design.approve': return `approved ${d.path}`;
    case 'handoff': return `handed off. Next: ${clip(d.next || 'n/a')}`;
    case 'workday.start': return 'started the workday';
    case 'workday.ending': return 'asked to end the day';
    case 'workday.stop': return 'pressed Stop now';
    case 'workday.end': return 'closed the workday';
    case 'fact.add': return `recorded ${d.id}: ${clip(d.text)}`;
    default: return null;
  }
}

export class Store extends EventEmitter {
  constructor(file, { now = () => new Date() } = {}) {
    super();
    this.file = file;
    this.now = now;
    this.state = emptyState();
    this.events = [];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          applyEvent(this.state, ev);
          this.events.push(ev);
        } catch {
          // a torn last line after a crash; skip it
        }
      }
    }
  }

  append(type, by, data = {}) {
    const ev = { seq: this.state.seq + 1, ts: this.now().toISOString(), type, by, data };
    fs.appendFileSync(this.file, JSON.stringify(ev) + '\n');
    applyEvent(this.state, ev);
    this.events.push(ev);
    this.emit('event', ev);
    return ev;
  }
}
