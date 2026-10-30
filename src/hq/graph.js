import fs from 'node:fs';
import path from 'node:path';
import { McError } from '../config.js';
import { normalizeKey, MENTION, listMarkdown, DEFAULT_DIRS, cleanTitle } from '../refs/ids.js';

/**
 * The project index: every ID in the project (requirements, stories, epics,
 * releases, tickets, change requests, decisions, questions, facts, notes,
 * design docs, meetings, chat) and the typed links between them. It is built
 * from HQ's event log and the anchored planning docs, so "what touches FR12?"
 * is a lookup, not a model reading every file: what a language server does
 * for code, for the requirements and management side.
 */

// requirement-like IDs: what everything else should trace back to
const REQ_KEY = /^(fr|nfr|uxr|ar)\d+$/;
const REQ_KINDS = new Set(['requirement', 'story', 'epic']);
// links followed upwards when asking "which requirements is this about?"
const UP = new Set(['implements', 'refs', 'about', 'discussed_in', 'amends', 'extends', 'answers', 'help_for', 'defines', 'part_of']);
const OUT_LABEL = {
  implements: 'implements',
  part_of: 'part of',
  depends_on: 'depends on',
  blocked_by: 'blocked by',
  refs: 'refers to',
  about: 'about',
  discussed_in: 'discussed in',
  amends: 'amends',
  extends: 'extends',
  defines: 'defines',
  answers: 'answers',
  help_for: 'for',
  supersedes: 'supersedes',
};
// incoming links grouped by what they come from
const FROM_KIND = { decision: 'decisions', question: 'questions', fact: 'facts', message: 'discussion', note: 'notes', minutes: 'meetings', help: 'human help', design: 'designs' };
const IN_LABEL = { amends: 'amended by', extends: 'extended by', defines: 'defined by', depends_on: 'needed by', blocked_by: 'blocking', part_of: 'contains', supersedes: 'superseded by' };
const VIA_TICKETS = new Set(['decision', 'question', 'note', 'message', 'help']);

const ANCHOR = /<a id="([a-z0-9-]+)"><\/a>/g;
const HEADING = /^(#{1,6})\s/;
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+\.)\s/;
const ROW = /^\s*\|/;
const DEPENDS = /^\s*[-*]?\s*\**(?:Depends on|Dependencies|Blocked by)\**\s*:/i;
const PATH = /(?:^|[\s(\[`'"])((?:\.{1,2}\/)*(?:[\w@.-]+\/)+[\w@.-]+\.[a-z0-9]{1,8})/gi;
const LINK_ANCHOR = /\]\([^)\s]*#([a-z0-9-]+)\)/g;
const MAX_SECTION = 8000;
// words that say nothing about what a requirement is about. Quantities (one, only, all, each…) stay:
// "exactly one" against "several" is where contradictions live
const STOP = new Set(
  'the and for with that this from into than then when which who what will must should may can are was were has have had per via its their there these those our your users user able also such use used using shall being been does done make made get set way want'.split(' '),
);
/** Lower-case word stems, for "possibly related" (shared vocabulary, not shared IDs). */
export function terms(text) {
  const out = [];
  for (let w of String(text ?? '').toLowerCase().replace(/<[^>]+>|\]\([^)]*\)/g, ' ').split(/[^a-z]+/)) {
    if (w.length < 3 || STOP.has(w)) continue;
    // a light stemmer: assignees, assignee, assigned, assigning → assign(e) alike
    if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    if (w.length > 5) w = w.replace(/(ing|ed)$/, '');
    if (w.length > 6 && w.endsWith('ee')) w = w.slice(0, -2); // assignee → assign
    else if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

// a line of markdown as plain text, whole (cleanTitle shortens it)
const plain = (t) =>
  String(t ?? '')
    .replace(ANCHOR, '')
    .replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const clip = (t, n = 120) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** FR12, Story 1.2, Epic 1, APP-12, DEC-3, R1 from a registry key. */
export function displayId(key) {
  let m;
  if ((m = /^story-(\d+)-(\d+)$/.exec(key))) return `Story ${m[1]}.${m[2]}`;
  if ((m = /^epic-(\d+)$/.exec(key))) return `Epic ${m[1]}`;
  if ((m = /^([a-z][a-z0-9]*)-(\d+)$/.exec(key))) return `${m[1].toUpperCase()}-${m[2]}`;
  if ((m = /^([a-z]+)(\d+)$/.exec(key))) return `${m[1].toUpperCase()}${m[2]}`;
  return key;
}

function normPath(p) {
  return path.posix.normalize(String(p).replace(/\\/g, '/').replace(/[#?].*$/, '').replace(/:\d+$/, '')).replace(/^(\.\.?\/)+/, '');
}

/** The index key for an ID or path as a person or agent would write it. */
export function keyOf(raw) {
  let t = String(raw ?? '').trim();
  const link = /^\[([^\]]+)\]\([^)]*\)$/.exec(t);
  if (link) t = link[1];
  if (!t) return null;
  if (t.includes('/')) return normPath(t);
  const k = normalizeKey(t.replace(/^#/, ''));
  const e = /^e(\d+)$/.exec(k);
  return e ? `epic-${e[1]}` : k;
}

/** Candidate keys mentioned in prose: IDs, anchors in links, file paths. */
export function mentionKeys(text, baseDir = null) {
  const out = new Set();
  const s = String(text ?? '').replace(ANCHOR, '');
  for (const m of s.matchAll(MENTION)) out.add(keyOf(m[0]));
  for (const m of s.matchAll(LINK_ANCHOR)) out.add(m[1]);
  for (const m of s.matchAll(PATH)) {
    if (/^https?:/i.test(m[1])) continue;
    out.add(normPath(m[1]));
    if (baseDir && !m[1].startsWith('/')) {
      const rel = path.posix.normalize(path.posix.join(baseDir, m[1].replace(/[#?].*$/, '')));
      if (!rel.startsWith('..')) out.add(rel);
    }
  }
  out.delete(null);
  return [...out];
}

/** Anchored items in one markdown file: where each is defined, what it contains and mentions. */
export function scanDoc(rel, text) {
  const lines = text.split('\n');
  const items = [];
  const fileMentions = [];
  const stack = []; // open headings that define an ID
  let block = null; // an open list item, table row or paragraph that defines an ID
  let fence = false;
  const lastText = (i) => {
    while (i > 0 && !lines[i].trim()) i -= 1;
    return i;
  };
  const indent = (l) => /^\s*/.exec(l)[0].length;
  const baseDir = path.posix.dirname(rel);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const h = HEADING.exec(line);
    if (block) {
      const ends = block.form === 'row' || h || (block.form === 'item' && line.trim() && indent(line) <= block.indent) || (block.form === 'para' && !line.trim());
      if (ends) {
        block.item.end = block.form === 'row' ? block.item.start : lastText(i - 1);
        block = null;
      }
    }
    if (h) {
      while (stack.length && stack.at(-1).item.level >= h[1].length) stack.pop().item.end = lastText(i - 1);
    }
    const anchor = /<a id="([a-z0-9-]+)"><\/a>/.exec(line);
    if (anchor) {
      const form = h ? 'heading' : ROW.test(line) ? 'row' : LIST_ITEM.test(line) ? 'item' : 'para';
      const item = { key: anchor[1], start: i, end: i, line: i + 1, title: cleanTitle(line), level: h ? h[1].length : 0, form, parent: stack.at(-1)?.item.key ?? null, mentions: [] };
      items.push(item);
      if (h) stack.push({ item });
      else block = { item, form, indent: indent(line) };
    }
    const owner = block?.item ?? stack.at(-1)?.item ?? null;
    const depends = DEPENDS.test(line);
    for (const key of mentionKeys(line, baseDir)) {
      if (owner && key === owner.key) continue;
      (owner ? owner.mentions : fileMentions).push({ key, depends });
    }
  }
  if (block) block.item.end = block.form === 'row' ? block.item.start : lastText(lines.length - 1);
  for (const { item } of stack) item.end = lastText(lines.length - 1);
  const title = lines.find((l) => /^#\s/.test(l));
  return { items, fileMentions, title: title ? cleanTitle(title) : null };
}

/** "FR2: Users can sign up" → "Users can sign up" (the ID is shown separately). */
function stripId(title, key) {
  const m = /^\s*([A-Za-z]+[\s-]?\d+(?:\.\d+)?)\s*(?:[:.\-–—)]\s*|\s+)/.exec(title);
  return m && keyOf(m[1]) === key ? title.slice(m[0].length) : title;
}

export function createIndex({ store, config, paths }) {
  const docCache = new Map(); // rel → { mtimeMs, size, text, scan }
  let cached = null;

  function readCached(rel, scan) {
    const abs = path.join(paths.root, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      docCache.delete(rel);
      return null;
    }
    if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
    let entry = docCache.get(rel);
    if (!entry || entry.mtimeMs !== st.mtimeMs || entry.size !== st.size) {
      entry = { mtimeMs: st.mtimeMs, size: st.size, text: fs.readFileSync(abs, 'utf8'), scan: null, mentions: null };
      docCache.set(rel, entry);
    }
    if (scan && !entry.scan) entry.scan = scanDoc(rel, entry.text);
    if (!scan && !entry.mentions) entry.mentions = mentionKeys(entry.text, path.posix.dirname(rel));
    return entry;
  }

  // one look at the docs per synchronous turn: a snapshot asks the index hundreds of questions
  let docsMemo = null;
  function docs() {
    if (docsMemo) return docsMemo;
    const files = listMarkdown(paths.root, DEFAULT_DIRS).filter((f) => !f.startsWith('.madcompany/'));
    const out = [];
    for (const rel of files) {
      const e = readCached(rel, true);
      if (e) out.push({ rel, ...e });
    }
    docsMemo = out;
    queueMicrotask(() => {
      docsMemo = null;
    });
    return out;
  }

  // ---------- build ----------
  function build() {
    const s = store.state;
    const docList = docs();
    const sig = `${s.seq}|${docList.map((d) => `${d.rel}:${d.mtimeMs}:${d.size}`).join(',')}|${Object.values(s.designs).map((d) => `${d.path}:${d.version}`).join(',')}`;
    if (cached?.sig === sig) return cached;

    const nodes = new Map();
    const edges = [];
    const unknown = [];
    const add = (key, node) => {
      if (!key || nodes.has(key)) return nodes.get(key);
      const n = { key, id: displayId(key), ...node };
      nodes.set(key, n);
      return n;
    };
    const kindOfKey = (k) => (REQ_KEY.test(k) ? 'requirement' : /^story-\d+-\d+$/.test(k) ? 'story' : /^epic-\d+$/.test(k) ? 'epic' : 'doc');

    // 1. nodes: planning docs first (PRD wins, as in the reference registry)
    const pending = []; // edges from docs, resolved once every node exists
    for (const d of docList) {
      const isDesign = d.rel.startsWith('docs/design/');
      add(d.rel, { id: d.rel, kind: isDesign ? 'design' : 'file', title: d.scan.title ?? path.posix.basename(d.rel), file: d.rel });
      for (const m of d.scan.fileMentions) pending.push([d.rel, m.key, m.depends ? 'depends_on' : 'refs']);
      for (const it of d.scan.items) {
        if (nodes.has(it.key)) {
          // listed again elsewhere (e.g. a requirements inventory): a mention, not a definition
          pending.push([it.parent ?? d.rel, it.key, 'refs']);
          for (const m of it.mentions) pending.push([it.parent ?? d.rel, m.key, m.depends ? 'depends_on' : 'refs']);
          continue;
        }
        add(it.key, { kind: kindOfKey(it.key), title: stripId(it.title, it.key), file: d.rel, line: it.line, start: it.start, end: it.end, form: it.form });
        if (it.parent) pending.push([it.key, it.parent, 'part_of']);
        for (const m of it.mentions) pending.push([it.key, m.key, m.depends ? 'depends_on' : 'refs']);
      }
    }
    // requirements defined in HQ (from the brief, MVP scope or a change request)
    for (const r of Object.values(s.requirements ?? {})) {
      // one a change request adds is proposed until that change is done, and gone if it is withdrawn
      const c = r.change ? s.tickets[r.change] : null;
      const status = c?.withdrawn ? 'withdrawn' : c && c.status !== 'done' ? 'proposed' : undefined;
      add(keyOf(r.id), { id: r.id, kind: 'requirement', title: r.title, text: r.text, file: '.madcompany/log/requirements.md', ledger: true, by: r.by, ts: r.ts, ...(status ? { status } : {}) });
    }
    // an epic only named on a ticket is a bucket of work, not a requirement; one in the epics doc is both
    for (const e of Object.values(s.epics)) Object.assign(add(keyOf(e.id), { id: e.id, kind: 'epic', title: e.title ?? e.id, hqOnly: true }), { status: e.status });
    for (const r of Object.values(s.releases)) add(keyOf(r.id), { id: r.id, kind: 'release', title: r.title, status: r.status, file: r.notes ?? null });
    for (const t of Object.values(s.tickets)) {
      add(keyOf(t.id), { id: t.id, kind: 'ticket', sub: t.kind, title: t.title, status: t.withdrawn ? 'withdrawn' : t.status, by: t.assignee, ts: t.created, file: '.madcompany/log/board.md' });
    }
    for (const d of s.decisions) add(keyOf(d.id), { id: d.id, kind: 'decision', title: d.title, by: d.by, ts: d.ts, seq: d.seq ?? 0, file: '.madcompany/log/decisions.md' });
    for (const q of Object.values(s.questions)) add(keyOf(q.id), { id: q.id, kind: 'question', title: q.question, status: q.status, by: q.from, ts: q.ts, seq: q.seq ?? 0, file: '.madcompany/log/questions.md' });
    for (const f of s.facts) add(keyOf(f.id), { id: f.id, kind: 'fact', title: f.text, by: f.by, ts: f.ts, seq: f.seq ?? 0, file: '.madcompany/facts.md' });
    for (const h of Object.values(s.help ?? {})) add(keyOf(h.id), { id: h.id, kind: 'help', title: h.title, status: h.status, by: h.by, ts: h.ts, file: '.madcompany/human-help.md' });
    for (const m of s.minutes ?? []) add(keyOf(m.id), { id: m.id, kind: 'minutes', title: m.title, by: m.by, ts: m.ts, file: m.file });
    for (const n of s.notes ?? []) add(keyOf(n.id), { id: n.id, kind: 'note', title: clip(n.text, 100), by: n.by, ts: n.ts, seq: n.seq ?? 0, scope: n.scope, file: '.madcompany/log/notes.md' });
    for (const m of s.messages) add(keyOf(m.id), { id: m.id, kind: 'message', title: clip(m.text, 140), by: m.by, ts: m.ts, channel: m.channel });
    for (const d of Object.values(s.designs)) {
      const n = add(d.path, { id: d.path, kind: 'design', title: path.posix.basename(d.path), file: d.path });
      Object.assign(n, { kind: 'design', status: d.status, by: d.owner, version: d.version, consumers: d.consumers });
    }

    // 2. links
    const resolve = (raw) => {
      const k = keyOf(raw);
      return k && nodes.has(k) ? k : null;
    };
    const link = (from, to, type) => {
      if (from && to && from !== to && nodes.has(from) && nodes.has(to)) edges.push({ from, to, type });
    };
    // explicit references (refs, about, amends…) must exist; prose mentions only count when they do
    const explicit = (from, list, type) => {
      for (const raw of list ?? []) {
        const k = resolve(raw);
        if (k) link(from, k, type);
        else if (String(raw ?? '').trim()) unknown.push({ from: nodes.get(from)?.id ?? from, raw: String(raw) });
      }
    };
    // IDs mentioned in text; on a "Depends on:" line they are dependencies, not references
    const prose = (from, texts) => {
      for (const t of texts) {
        for (const line of String(t ?? '').split('\n')) {
          const type = DEPENDS.test(line) ? 'depends_on' : 'refs';
          for (const k of mentionKeys(line)) if (nodes.has(k)) link(from, k, type);
        }
      }
    };
    for (const [from, to, type] of pending) if (nodes.has(to)) link(from, to, type);
    for (const r of Object.values(s.requirements ?? {})) {
      const k = keyOf(r.id);
      explicit(k, r.extends, 'extends');
      if (r.change) link(keyOf(r.change), k, 'defines');
      prose(k, [r.text]);
    }
    for (const a of s.amendments ?? []) if (a.change) link(keyOf(a.change), keyOf(a.id), 'amends');
    for (const t of Object.values(s.tickets)) {
      const k = keyOf(t.id);
      explicit(k, t.refs, 'implements');
      explicit(k, t.amends, 'amends');
      explicit(k, t.extends, 'extends');
      if (t.epic) link(k, resolve(t.epic), 'part_of');
      if (t.release) link(k, resolve(t.release), 'part_of');
      for (const d of t.deps) link(k, keyOf(d), 'depends_on');
      for (const b of t.blockedBy) link(k, keyOf(b), 'blocked_by');
      prose(k, [t.body]);
    }
    for (const d of s.decisions) {
      const k = keyOf(d.id);
      if (d.ticket) link(k, resolve(d.ticket), 'about');
      explicit(k, d.refs, 'refs');
      if (d.supersedes) explicit(k, [d.supersedes], 'supersedes');
      prose(k, [d.title, d.decision, d.why, d.alternatives, ...(d.links ?? [])]);
    }
    for (const q of Object.values(s.questions)) {
      const k = keyOf(q.id);
      if (q.ticket) link(k, resolve(q.ticket), 'about');
      explicit(k, q.refs, 'refs');
      prose(k, [q.question, q.answer, ...(q.links ?? [])]);
    }
    for (const f of s.facts) {
      if (f.source) link(keyOf(f.id), resolve(f.source), 'answers');
      prose(keyOf(f.id), [f.text]);
    }
    for (const h of Object.values(s.help ?? {})) {
      for (const t of h.tickets) link(keyOf(h.id), resolve(t), 'help_for');
      prose(keyOf(h.id), [h.title, h.why]);
    }
    for (const m of s.minutes ?? []) {
      const k = keyOf(m.id);
      explicit(k, m.refs, 'refs');
      const e = m.file ? readCached(m.file, false) : null;
      for (const x of e?.mentions ?? []) if (nodes.has(x)) link(k, x, 'refs');
    }
    for (const n of s.notes ?? []) {
      const k = keyOf(n.id);
      explicit(k, n.about, 'about');
      prose(k, [n.text]);
    }
    for (const m of s.messages) {
      const k = keyOf(m.id);
      if (m.channel.startsWith('ticket:')) link(k, resolve(m.channel.slice(7)), 'discussed_in');
      else if (/^epic-\d+$/.test(m.channel)) link(k, m.channel, 'discussed_in');
      prose(k, [m.text]);
    }
    for (const d of Object.values(s.designs)) {
      if (docCache.has(d.path) && docCache.get(d.path).scan) continue; // markdown designs were scanned with the docs
      const e = readCached(d.path, false);
      for (const x of e?.mentions ?? []) if (nodes.has(x)) link(d.path, x, 'refs');
    }

    // de-duplicate, then index both ways
    const seen = new Set();
    const out = new Map();
    const inc = new Map();
    for (const e of edges) {
      const id = `${e.from}>${e.to}>${e.type}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (!out.has(e.from)) out.set(e.from, []);
      if (!inc.has(e.to)) inc.set(e.to, []);
      out.get(e.from).push(e);
      inc.get(e.to).push(e);
    }
    cached = { sig, nodes, out, inc, unknown, traces: new Map() };
    return cached;
  }

  // ---------- queries ----------
  const outOf = (g, k) => g.out.get(k) ?? [];
  const inOf = (g, k) => g.inc.get(k) ?? [];
  const isReq = (n) => Boolean(n && REQ_KINDS.has(n.kind) && !n.hqOnly && n.status !== 'withdrawn');

  /** The requirements (FR, NFR, story, epic…) a node traces back to. */
  function traceKeys(g, start) {
    if (g.traces.has(start)) return g.traces.get(start);
    const found = new Set();
    const seen = new Set([start]);
    let frontier = [start];
    for (let depth = 0; depth < 6 && frontier.length; depth++) {
      const nextLevel = [];
      for (const k of frontier) {
        const n = g.nodes.get(k);
        if (isReq(n)) {
          found.add(k);
          continue;
        }
        // a whole planning file mentions everything; linking to it says nothing about which requirement
        if (n.kind === 'file' && k !== start) continue;
        for (const e of outOf(g, k)) {
          if (!UP.has(e.type) || seen.has(e.to)) continue;
          seen.add(e.to);
          nextLevel.push(e.to);
        }
      }
      frontier = nextLevel;
    }
    const list = [...found];
    g.traces.set(start, list);
    return list;
  }
  /** Requirements plus the ones a traced story or epic covers. */
  function deepTrace(g, start) {
    const base = traceKeys(g, start);
    const all = new Set(base);
    for (const k of base) for (const e of outOf(g, k)) if (['refs', 'part_of'].includes(e.type) && g.nodes.get(e.to)?.kind === 'requirement') all.add(e.to);
    return [...all];
  }
  /** What a new item (not stored yet) would trace to: its explicit refs plus IDs it mentions. */
  function check({ refs = [], texts = [], context = [], channel = null } = {}) {
    const g = build();
    const known = [];
    const unknownRefs = [];
    for (const raw of refs ?? []) {
      const k = keyOf(raw);
      if (k && g.nodes.has(k)) known.push(k);
      else if (String(raw ?? '').trim()) unknownRefs.push(String(raw));
    }
    // context (the ticket it's on, the epic it's in) counts when it exists, and is never "unknown"
    for (const raw of context) {
      const k = raw ? keyOf(raw) : null;
      if (k && g.nodes.has(k)) known.push(k);
    }
    if (channel?.startsWith('ticket:') && g.nodes.has(keyOf(channel.slice(7)))) known.push(keyOf(channel.slice(7)));
    if (channel && /^epic-\d+$/.test(channel) && g.nodes.has(channel)) known.push(channel);
    for (const t of texts) for (const k of mentionKeys(t)) if (g.nodes.has(k)) known.push(k);
    const reqs = new Set();
    for (const k of known) for (const r of traceKeys(g, k)) reqs.add(r);
    return { known: [...new Set(known)].map((k) => g.nodes.get(k).id), unknown: unknownRefs, requirements: [...reqs].map((k) => g.nodes.get(k).id), anyRequirements: [...g.nodes.values()].some(isReq) };
  }

  function nodeFor(raw) {
    const g = build();
    const k = keyOf(raw);
    const n = k && g.nodes.get(k);
    if (!n) throw new McError(`Nothing is registered as ${raw}. IDs come from anchored planning docs (npx madcompany import), HQ (tickets, decisions, questions…) and mc_requirement; design docs by their path.`);
    return { g, n };
  }

  function linkOf(n) {
    if (!n.file) return null;
    if (['design', 'file'].includes(n.kind)) return `[${n.id}](${n.file})`;
    if (n.kind === 'message') return null;
    return `[${n.id}](${n.file}#${n.key})`;
  }
  const brief = (g, k, extra = {}) => {
    const n = g.nodes.get(k);
    const o = { id: n.id };
    if (n.kind === 'message') Object.assign(o, { by: n.by, in: n.channel, text: n.title });
    else {
      o.title = clip(n.title, 100);
      if (n.status) o.status = n.status;
      if (n.kind === 'ticket' && n.sub !== 'task') o.kind = n.sub;
      if (['note', 'decision', 'ticket'].includes(n.kind) && n.by) o.by = n.by;
    }
    return { ...o, ...extra };
  };

  /**
   * An amendment is proposed until its change request is done (merged, or all
   * its tickets merged), and dropped if the change is withdrawn. One recorded
   * without a change holds at once.
   */
  function amendmentState(a) {
    const c = a.change ? store.state.tickets[a.change] : null;
    if (!c) return 'in effect';
    if (c.withdrawn) return 'withdrawn';
    return c.status === 'done' ? 'in effect' : 'proposed';
  }
  /** Change requests (mapped, not withdrawn) that amend this requirement. */
  const amendingChanges = (k) => Object.values(store.state.tickets).filter((c) => c.kind === 'change' && !c.withdrawn && c.mappedSeq && (c.amends ?? []).some((x) => keyOf(x) === k));
  const supersededBy = (g, key) => inOf(g, key).find((e) => e.type === 'supersedes')?.from ?? null;
  /** A decision after the change that refs both settles whether an item still holds. */
  const confirmedBy = (g, itemKey, changeKey, after) => store.state.decisions.some((d) => (d.seq ?? 0) > after && [itemKey, changeKey].every((x) => outOf(g, keyOf(d.id)).some((e) => e.to === x)));
  /** The change that amended one of these requirements after this decision, fact or note was made (and nobody confirmed it since). */
  function predates(g, key, reqKeys) {
    const n = g.nodes.get(key);
    if (!n?.seq) return null;
    for (const r of reqKeys) for (const c of amendingChanges(r)) if (n.seq < c.mappedSeq && !confirmedBy(g, key, keyOf(c.id), c.mappedSeq)) return c.id;
    return null;
  }
  /** Marks for a decision, fact or note: replaced by a later decision, or older than a change to what it's about. */
  function freshness(g, key, reqKeys) {
    const out = {};
    const by = g.nodes.get(key).kind === 'decision' ? supersededBy(g, key) : null;
    if (by) out.superseded_by = g.nodes.get(by).id;
    const before = predates(g, key, reqKeys);
    if (before) out.before_change = before;
    return out;
  }
  /** A requirement plus what it covers (a story's requirements), or what an item traces to. */
  const reqScope = (g, k) => (isReq(g.nodes.get(k)) ? [k, ...outOf(g, k).filter((e) => e.type === 'refs' && g.nodes.get(e.to).kind === 'requirement').map((e) => e.to)] : deepTrace(g, k));

  /** What a requirement says now, and any wording proposed by a change still being built. Text is left out when it's just the title. */
  function currentText(g, n) {
    const t = wording(g, n);
    if (t.text === n.title && !t.amended_by) delete t.text;
    return t;
  }
  function wording(g, n) {
    const mine = (store.state.amendments ?? []).filter((a) => keyOf(a.id) === n.key);
    const now = mine.filter((a) => amendmentState(a) === 'in effect').at(-1);
    const next = mine.filter((a) => amendmentState(a) === 'proposed').at(-1);
    const out = now ? { text: now.text, amended_by: now.change } : original(n);
    if (next) out.proposed = { text: next.text, change: next.change, change_status: store.state.tickets[next.change]?.status };
    return out;
  }
  function original(n) {
    if (n.ledger) return { text: n.text ?? n.title };
    if (n.file && n.start != null && n.form !== 'heading') {
      const lines = sectionLines(n);
      if (n.form === 'row') {
        // "| NFR1 | Loads in under 1 second |" → the cells other than the ID
        const cells = lines.at(-1).split('|').map(plain).filter((c) => c && keyOf(c) !== n.key);
        return { text: cells.join(' — ') };
      }
      return { text: stripId(plain(lines.join(' ')), n.key) };
    }
    return { text: n.title };
  }

  function sectionLines(n) {
    const e = readCached(n.file, true);
    if (!e) return [];
    const lines = e.text.split('\n');
    if (n.form === 'row') {
      // a table row means little without the table's header
      let top = n.start;
      while (top > 0 && ROW.test(lines[top - 1])) top -= 1;
      return top < n.start - 1 ? [lines[top], lines[top + 1], lines[n.start]] : [lines[n.start]];
    }
    return lines.slice(n.start, n.end + 1);
  }

  /**
   * Everything linked to one ID, grouped: what it is part of, what implements
   * it, changes, decisions, questions, discussion, designs and notes. For a
   * requirement it also pulls in what was decided or discussed on its tickets.
   */
  function card(raw, { only = null, limit = 8 } = {}) {
    const { g, n } = nodeFor(raw);
    const k = n.key;
    const groups = {};
    const put = (name, key, extra) => {
      if (!g.nodes.has(key) || key === k) return;
      const list = (groups[name] ??= new Map());
      if (!list.has(key)) list.set(key, extra);
    };
    for (const e of outOf(g, k)) {
      const to = g.nodes.get(e.to);
      if (n.kind === 'message' || n.kind === 'note' || n.kind === 'decision' || n.kind === 'question') put(OUT_LABEL[e.type], e.to);
      else if (e.type === 'refs' && FROM_KIND[to.kind]) put(FROM_KIND[to.kind], e.to);
      else put(OUT_LABEL[e.type], e.to);
    }
    const inGroup = (e, src) => {
      if (FROM_KIND[src.kind] && !['part_of', 'depends_on'].includes(e.type)) return FROM_KIND[src.kind];
      if (src.kind === 'ticket' && e.type === 'implements') return 'tickets';
      return IN_LABEL[e.type] ?? 'referenced by';
    };
    for (const e of inOf(g, k)) put(inGroup(e, g.nodes.get(e.from)), e.from);
    if (isReq(n)) {
      // one hop: what was decided, asked and said on the tickets and changes behind it
      const behind = [...(groups.tickets?.keys() ?? []), ...(groups['amended by']?.keys() ?? []), ...(groups['extended by']?.keys() ?? [])];
      for (const t of behind) {
        for (const e of inOf(g, t)) {
          const src = g.nodes.get(e.from);
          if (VIA_TICKETS.has(src.kind)) put(FROM_KIND[src.kind], e.from, { via: g.nodes.get(t).id });
        }
      }
      for (const q of [...(groups.questions?.keys() ?? [])]) for (const e of inOf(g, q)) if (g.nodes.get(e.from).kind === 'fact') put('facts', e.from, { via: g.nodes.get(q).id });
    }
    for (const weak of ['referenced by', 'refers to']) {
      if (!groups[weak]) continue;
      for (const key of [...groups[weak].keys()]) if (Object.entries(groups).some(([name, m]) => name !== weak && m.has(key))) groups[weak].delete(key);
      if (!groups[weak].size) delete groups[weak];
    }
    const card = { id: n.id, kind: n.kind === 'ticket' ? `ticket (${n.sub})` : n.kind, title: n.title };
    const check = checkOf(n.key);
    if (check) card.checked = check;
    if (n.status) card.status = n.status;
    if (n.by && n.kind !== 'requirement') card.by = n.by;
    const l = linkOf(n);
    if (l) card.link = l;
    if (n.file && n.line) card.defined = `${n.file}:${n.line}`;
    if (n.kind === 'message') card.channel = n.channel;
    if (isReq(n)) Object.assign(card, currentText(g, n));
    if (!isReq(n)) {
      const tr = traceKeys(g, k);
      card.traces_to = tr.map((x) => brief(g, x));
    }
    const order = ['part of', 'contains', 'implements', 'tickets', 'amends', 'amended by', 'extends', 'extended by', 'defines', 'defined by', 'depends on', 'needed by', 'blocked by', 'blocking', 'about', 'answers', 'decisions', 'questions', 'facts', 'notes', 'designs', 'meetings', 'human help', 'refers to', 'referenced by', 'discussed in', 'superseded by', 'supersedes', 'for', 'discussion'];
    const recent = (a, b) => String(g.nodes.get(b[0]).ts ?? '').localeCompare(String(g.nodes.get(a[0]).ts ?? ''));
    const scope = reqScope(g, k);
    const names = Object.keys(groups).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const more = {};
    for (const name of names) {
      if (only && name !== only) continue;
      let entries = [...groups[name].entries()];
      if (['decisions', 'questions', 'facts', 'notes', 'discussion', 'meetings'].includes(name)) entries.sort(recent);
      if (name === 'questions') entries.sort((a, b) => (g.nodes.get(a[0]).status === 'open' ? 0 : 1) - (g.nodes.get(b[0]).status === 'open' ? 0 : 1));
      if (name === 'discussion' && !only) {
        const channels = {};
        for (const [m] of entries) {
          const c = g.nodes.get(m).channel;
          channels[c] = (channels[c] ?? 0) + 1;
        }
        card.discussion = { messages: entries.length, channels, latest: entries.slice(0, 3).map(([m, x]) => brief(g, m, x ?? {})) };
        continue;
      }
      const cap = only ? 50 : limit;
      const marks = (m) => (['decision', 'fact', 'note'].includes(g.nodes.get(m).kind) ? freshness(g, m, scope) : {});
      card[name] = entries.slice(0, cap).map(([m, x]) => brief(g, m, { ...(x ?? {}), ...marks(m) }));
      if (entries.length > cap) more[name] = entries.length - cap;
    }
    if ((isReq(n) || n.kind === 'ticket') && (!only || only === 'possibly related')) {
      const rel = relatedTo(g, textOf(g, n), linkedSet(g, k), only ? 15 : 5);
      if (rel.length) card['possibly related'] = rel;
    }
    if (Object.keys(more).length) card.more = Object.fromEntries(Object.entries(more).map(([name, c]) => [name, `${c} more: mc_ref with only: "${name}"`]));
    const diags = diagnostics().filter((d) => d.ids.includes(n.id));
    if (diags.length) card.diagnostics = diags.map((d) => d.text);
    return card;
  }

  /** The text of one item: a requirement's section of its doc, a ticket's body, a decision… */
  function section(raw) {
    const { g, n } = nodeFor(raw);
    const s = store.state;
    const cap = (t) => (t.length > MAX_SECTION ? `${t.slice(0, MAX_SECTION)}\n…(truncated; open ${n.file})` : t);
    const out = { id: n.id, kind: n.kind, title: n.title };
    if (n.file && n.start != null) {
      const lines = sectionLines(n);
      out.defined = `${n.file}:${n.line}${n.end > n.start ? `-${n.end + 1}` : ''}`;
      out.text = cap(lines.join('\n').replace(ANCHOR, ''));
    } else if (['design', 'file'].includes(n.kind) || n.kind === 'minutes') {
      out.text = cap(readCached(n.file, false)?.text ?? '');
    } else if (n.kind === 'ticket') {
      const t = s.tickets[n.id];
      out.text = [t.body, t.refs.length ? `Refs: ${t.refs.join(', ')}` : '', t.amends?.length ? `Amends: ${t.amends.join(', ')}` : '', t.extends?.length ? `Extends: ${t.extends.join(', ')}` : '', t.checkpoint ? `Checkpoint: done ${t.checkpoint.done}; next ${t.checkpoint.next}` : ''].filter(Boolean).join('\n');
    } else if (n.kind === 'decision') {
      const d = s.decisions.find((x) => x.id === n.id);
      out.text = [`Decision: ${d.decision}`, `Why: ${d.why}`, d.alternatives ? `Alternatives: ${d.alternatives}` : '', d.ticket ? `Ticket: ${d.ticket}` : ''].filter(Boolean).join('\n');
    } else if (n.kind === 'question') {
      const q = s.questions[n.id];
      out.text = [`Question: ${q.question}`, q.options.length ? `Options: ${q.options.join(' / ')}` : '', q.answer ? `Answer (${q.answeredBy}): ${q.answer}` : 'Not answered yet.'].filter(Boolean).join('\n');
    } else if (n.kind === 'help') {
      const h = s.help[n.id];
      out.text = [h.why, ...h.steps.map((x, i) => `${i + 1}. ${x}`)].filter(Boolean).join('\n');
    } else if (n.kind === 'note') {
      out.text = s.notes.find((x) => x.id === n.id).text;
    } else if (n.kind === 'message') {
      out.text = s.messages.find((x) => x.id === n.id).text;
    } else {
      out.text = n.text ?? n.title;
    }
    if (isReq(n)) {
      const am = (s.amendments ?? []).filter((a) => keyOf(a.id) === n.key);
      if (am.length) out.amendments = am.map((a) => ({ change: a.change, state: amendmentState(a), by: a.by, date: a.ts.slice(0, 10), text: a.text }));
    }
    return out;
  }

  /** What a change request touches: tickets, designs, stories and open questions on what it amends. */
  function impact(changeId) {
    const g = build();
    const t = store.state.tickets[String(changeId).toUpperCase()];
    if (!t) throw new McError(`No ticket ${changeId}.`);
    const ck = keyOf(t.id);
    const amended = (t.amends ?? []).map(keyOf).filter((k) => g.nodes.has(k));
    const extended = (t.extends ?? []).map(keyOf).filter((k) => g.nodes.has(k));
    const own = new Set(inOf(g, ck).filter((e) => e.type === 'implements').map((e) => e.from));
    const touching = (reqs) => {
      const res = { tickets: new Set(), designs: new Set(), stories: new Set(), questions: new Set() };
      const set = new Set(reqs);
      // a story or epic that covers an amended requirement is affected too
      for (const r of reqs) for (const e of inOf(g, r)) if (isReq(g.nodes.get(e.from)) && ['refs', 'part_of'].includes(e.type)) set.add(e.from);
      for (const r of set) {
        for (const e of inOf(g, r)) {
          const src = g.nodes.get(e.from);
          if (src.kind === 'ticket' && e.type === 'implements' && e.from !== ck && !own.has(e.from)) res.tickets.add(e.from);
          if (src.kind === 'design') res.designs.add(e.from);
          if (src.kind === 'story' && !reqs.includes(e.from)) res.stories.add(e.from);
          if (src.kind === 'question' && src.status === 'open') res.questions.add(e.from);
        }
        if (g.nodes.get(r).kind === 'story' && !reqs.includes(r)) res.stories.add(r);
      }
      return Object.fromEntries(Object.entries(res).map(([name, v]) => [name, [...v].map((k) => brief(g, k))]));
    };
    const a = touching(amended);
    const ids = (list) => list.map((x) => `${x.id}${x.status ? ` (${x.status})` : ''}`).join(', ');
    const parts = [
      amended.length ? `amends ${amended.map((k) => g.nodes.get(k).id).join(', ')}` : null,
      extended.length ? `extends ${extended.map((k) => g.nodes.get(k).id).join(', ')}` : null,
      a.tickets.length ? `tickets ${ids(a.tickets)}` : null,
      a.designs.length ? `designs ${a.designs.map((x) => x.id).join(', ')}` : null,
      a.stories.length ? `stories ${a.stories.map((x) => x.id).join(', ')}` : null,
      a.questions.length ? `open questions ${a.questions.map((x) => x.id).join(', ')}` : null,
    ].filter(Boolean);
    const exclude = linkedSet(g, ck);
    for (const r of [...amended, ...extended]) exclude.add(r);
    const near = relatedTo(g, `${t.title} ${t.body}`, exclude, 5);
    return { change: t.id, amends: amended.map((k) => g.nodes.get(k).id), extends: extended.map((k) => g.nodes.get(k).id), affected: a, ...(near.length ? { possibly_related: near } : {}), line: `Impact of ${t.id}: ${parts.join('; ') || 'nothing built on it yet'}.` };
  }

  /** The latest consistency check that covered this item, if any. */
  function checkOf(k) {
    const c = (store.state.checks ?? []).filter((x) => x.ids.some((id) => keyOf(id) === k)).at(-1);
    return c ? { verdict: c.verdict, by: c.by, ts: c.ts, ...(c.note ? { note: c.note } : {}) } : null;
  }

  /** Is this change request (or feedback) tied to the requirements it changes? */
  function mapping(t, g = build()) {
    const k = keyOf(t.id);
    const defines = outOf(g, k).filter((e) => e.type === 'defines').map((e) => g.nodes.get(e.to).id);
    const amends = (t.amends ?? []).filter((x) => g.nodes.has(keyOf(x)));
    const ext = (t.extends ?? []).filter((x) => g.nodes.has(keyOf(x)));
    const reqs = [...g.nodes.values()].filter(isReq);
    // a change in a project with no requirements yet can only define the first ones
    const onlyOwn = reqs.every((r) => defines.includes(r.id));
    const mapped = t.kind === 'change' ? amends.length + ext.length > 0 || (defines.length > 0 && onlyOwn) : traceKeys(g, k).length > 0;
    return { mapped, amends, extends: ext, defines };
  }

  // ---------- diagnostics ----------
  let diagCache = null;
  /**
   * Problems the index can see without a model: change requests nobody has
   * mapped, work done before a change amended its requirement, references to
   * IDs that don't exist, reopened dependencies, untraced work.
   */
  function diagnostics() {
    const g = build();
    if (diagCache?.sig === g.sig) return diagCache.list;
    const s = store.state;
    const list = [];
    const seen = new Set();
    const add = (code, text, ids) => {
      if (seen.has(text)) return;
      seen.add(text);
      list.push({ code, text, ids });
    };
    const tickets = Object.values(s.tickets);
    // event order, not clock time: two events can share a millisecond
    const lastSeq = (t, type) => t.activity.filter((a) => a.type === type).at(-1)?.seq ?? 0;
    const confirmed = (item, ck, after) => confirmedBy(g, item, ck, after);

    for (const t of tickets) {
      if ((t.kind === 'change' || t.kind === 'feedback') && t.status !== 'done' && !mapping(t, g).mapped) {
        add('unmapped-change', `${t.id} (${t.kind}) isn't mapped to the requirements it amends or extends. The lead maps it with mc_map_change before anyone starts it.`, [t.id]);
      }
    }
    const changes = tickets.filter((x) => x.kind === 'change' && x.mappedSeq && x.amends?.length && !x.withdrawn);
    for (const c of changes) {
      const ck = keyOf(c.id);
      const own = new Set(inOf(g, ck).filter((e) => e.type === 'implements').map((e) => e.from));
      const amended = new Set(c.amends.map(keyOf));
      for (const t of tickets) {
        const tk = keyOf(t.id);
        if (t.id === c.id || own.has(tk)) continue;
        const hit = deepTrace(g, tk).find((r) => amended.has(r));
        if (!hit) continue;
        const rid = g.nodes.get(hit).id;
        if (t.status === 'done' && lastSeq(t, 'ticket.status') < c.mappedSeq && !confirmed(tk, ck, c.mappedSeq)) {
          add('done-before-change', `${t.id} was done before ${c.id} amended ${rid}. Reopen it (mc_reopen) or confirm it still holds (mc_decide with refs ["${t.id}", "${c.id}"]).`, [t.id, c.id, rid]);
        } else if (['in_progress', 'in_review', 'blocked'].includes(t.status) && lastSeq(t, 'ticket.claim') < c.mappedSeq && !confirmed(tk, ck, c.mappedSeq)) {
          add('changed-under-work', `${t.id} (${t.status}${t.assignee ? `, ${t.assignee}` : ''}) implements ${rid}, which ${c.id} amended after work started. Tell its owner in ticket:${t.id}, or confirm with mc_decide (refs ["${t.id}", "${c.id}"]).`, [t.id, c.id, rid]);
        }
      }
    }
    // what was written, decided or answered about a requirement before a change amended it
    for (const c of changes) {
      const ck = keyOf(c.id);
      const amended = c.amends.map(keyOf).filter((k) => g.nodes.has(k));
      for (const r of amended) {
        const rid = g.nodes.get(r).id;
        const stories = inOf(g, r).filter((e) => e.type === 'refs' && g.nodes.get(e.from).kind === 'story' && !amended.includes(e.from)).map((e) => e.from);
        for (const st of stories) {
          const reworded = (s.amendments ?? []).some((a) => keyOf(a.id) === st && a.change === c.id);
          const sid = g.nodes.get(st).id;
          if (!reworded && !confirmed(st, ck, c.mappedSeq)) {
            add('stale-story', `${sid} covers ${rid}, which ${c.id} amends, and still says what it said before. Reword it (mc_requirement id "${sid}", change "${c.id}") or confirm it holds (mc_decide refs ["${sid}", "${c.id}"]).`, [sid, c.id, rid]);
          }
        }
        for (const target of [r, ...stories]) {
          for (const e of inOf(g, target)) {
            const d = g.nodes.get(e.from);
            if (d.kind !== 'decision' || !(d.seq < c.mappedSeq) || supersededBy(g, e.from) || confirmed(e.from, ck, c.mappedSeq)) continue;
            add('stale-decision', `${d.id} was decided on ${g.nodes.get(target).id} before ${c.id} amended ${rid}. Supersede it (mc_decide supersedes "${d.id}") or confirm it holds (mc_decide refs ["${d.id}", "${c.id}"]).`, [d.id, c.id, rid]);
          }
        }
        for (const f of s.facts) {
          const fk = keyOf(f.id);
          if ((f.seq ?? 0) < c.mappedSeq && deepTrace(g, fk).includes(r) && !confirmed(fk, ck, c.mappedSeq)) {
            add('stale-fact', `${f.id} (an answer from ${f.by === 'you' ? 'the human' : f.by}) was given before ${c.id} amended ${rid}: "${clip(f.text, 90)}". Check it still holds and confirm (mc_decide refs ["${f.id}", "${c.id}"]), or ask the human again.`, [f.id, c.id, rid]);
          }
        }
      }
    }
    for (const q of Object.values(s.questions)) {
      if (q.conflict && q.status === 'open') add('open-conflict', `${q.id} (${q.conflict.kind} conflict on ${q.conflict.about.join(', ')}) is open with ${q.to}: ${clip(q.question, 120)}`, [q.id, ...q.conflict.about]);
    }
    for (const t of tickets) {
      if (t.kind === 'change' && t.approval === 'needed' && !t.withdrawn) add('awaiting-approval', `${t.id} (a change the team raised) waits for the human's OK in HQ → Inbox before anyone starts it.`, [t.id]);
    }
    // new stories, added requirements and changes are checked against what's already agreed
    const unchecked = [...g.nodes.values()]
      .filter((n) => (n.kind === 'story' || (n.ledger && isReq(n)) || (n.kind === 'ticket' && n.sub === 'change' && n.status !== 'withdrawn' && n.status !== 'done' && s.tickets[n.id]?.mappedSeq)) && !checkOf(n.key))
      .map((n) => n.id);
    if (unchecked.length) {
      add('unchecked', `${unchecked.length} not checked for conflicts with what's already agreed: ${unchecked.slice(0, 8).join(', ')}${unchecked.length > 8 ? '…' : ''}. Run /mc-check (mc_check records the result).`, unchecked);
    }
    for (const u of g.unknown) add('unknown-ref', `${u.from} refers to ${u.raw}, which isn't defined anywhere.`, [u.from]);
    for (const t of tickets) {
      if (!['in_review', 'done'].includes(t.status)) continue;
      for (const d of t.deps) if (s.tickets[d] && s.tickets[d].status !== 'done') add('dependency-reopened', `${t.id} is ${t.status} but depends on ${d}, which is ${s.tickets[d].status} again.`, [t.id, d]);
      for (const q of Object.values(s.questions)) if (q.ticket === t.id && q.status === 'open') add('open-question', `${t.id} is ${t.status} with ${q.id} still unanswered.`, [t.id, q.id]);
    }
    for (const t of tickets) {
      if (['change', 'feedback', 'chore'].includes(t.kind) || t.status === 'done') continue;
      if (!traceKeys(g, keyOf(t.id)).length) add('untraced', `${t.id} isn't linked to any requirement. Add refs (mc_update_ticket) or make it a chore.`, [t.id]);
    }
    for (const d of s.decisions) if (!traceKeys(g, keyOf(d.id)).length) add('untraced', `${d.id} (decision) isn't linked to any requirement or ticket.`, [d.id]);
    for (const q of Object.values(s.questions)) if (q.status === 'open' && !traceKeys(g, keyOf(q.id)).length) add('untraced', `${q.id} (open question) isn't linked to any requirement or ticket.`, [q.id]);
    diagCache = { sig: g.sig, list };
    return list;
  }

  /** How much of the project traces back to a requirement. */
  function coverage() {
    const g = build();
    const s = store.state;
    const share = (items) => {
      const traced = items.filter((k) => traceKeys(g, k).length).length;
      return { traced, total: items.length };
    };
    const reqs = [...g.nodes.values()].filter((n) => n.kind === 'requirement' || n.kind === 'story');
    let withTickets = 0;
    let done = 0;
    for (const r of reqs) {
      const ts = inOf(g, r.key).filter((e) => e.type === 'implements').map((e) => s.tickets[g.nodes.get(e.from).id]);
      if (ts.length) withTickets += 1;
      if (ts.length && ts.every((t) => t.status === 'done')) done += 1;
    }
    const work = Object.values(s.tickets).filter((t) => t.kind !== 'chore');
    return {
      requirements: { total: reqs.length, with_tickets: withTickets, done },
      tickets: share(work.map((t) => keyOf(t.id))),
      chores: Object.values(s.tickets).length - work.length,
      decisions: share(s.decisions.map((d) => keyOf(d.id))),
      questions: share(Object.values(s.questions).map((q) => keyOf(q.id))),
      discussion: share(s.messages.map((m) => keyOf(m.id))),
    };
  }

  /** Every requirement, story and epic with what implements and changes it (HQ → Trace). */
  function requirements() {
    const g = build();
    const s = store.state;
    return [...g.nodes.values()]
      .filter(isReq)
      .map((n) => {
        const inc = inOf(g, n.key);
        // an epic is built by its own tickets and by its stories' tickets
        const parts = n.kind === 'epic' ? inc.filter((e) => e.type === 'part_of').map((e) => e.from) : [];
        const builders = [...inc, ...parts.flatMap((p) => inOf(g, p))].filter((e) => e.type === 'implements' || (n.kind === 'epic' && e.type === 'part_of'));
        const tickets = [...new Set(builders.map((e) => s.tickets[g.nodes.get(e.from).id]).filter(Boolean))];
        const changes = inc.filter((e) => ['amends', 'extends', 'defines'].includes(e.type)).map((e) => ({ id: g.nodes.get(e.from).id, how: { amends: 'amended', extends: 'extended', defines: 'defined' }[e.type], status: g.nodes.get(e.from).status }));
        const count = (kind) => inc.filter((e) => g.nodes.get(e.from).kind === kind).length;
        const state = !tickets.length ? 'none' : tickets.every((t) => t.status === 'done') ? 'done' : tickets.some((t) => t.status !== 'todo') ? 'building' : 'planned';
        const parent = outOf(g, n.key).find((e) => e.type === 'part_of');
        return {
          id: n.id,
          kind: n.kind,
          title: clip(n.title, 160),
          ...currentText(g, n),
          link: linkOf(n),
          parent: parent ? g.nodes.get(parent.to).id : null,
          ledger: Boolean(n.ledger),
          ...(n.status ? { status: n.status } : {}),
          state,
          tickets: tickets.map((t) => ({ id: t.id, status: t.status })),
          changes,
          decisions: count('decision'),
          questions: count('question'),
          discussion: count('message'),
          notes: count('note'),
        };
      });
  }

  // ---------- possibly related: what shares vocabulary without sharing an ID ----------
  const KNOWLEDGE = new Set(['requirement', 'story', 'decision', 'fact']);
  function textOf(g, n) {
    const s = store.state;
    if (n.kind === 'decision') {
      const d = s.decisions.find((x) => x.id === n.id);
      return `${d.title} ${d.decision} ${d.why}`;
    }
    if (n.kind === 'story' && n.file) return `${n.title} ${sectionLines(n).join(' ').slice(0, 1200)}`;
    if (isReq(n)) {
      const w = wording(g, n);
      return `${n.title} ${w.text ?? ''} ${w.proposed?.text ?? ''}`;
    }
    if (n.kind === 'ticket') {
      const t = s.tickets[n.id];
      return `${t.title} ${t.body}`;
    }
    return n.title ?? '';
  }
  /** Term weights for every requirement, story, decision and answer (built once per index). */
  function termIndex(g) {
    if (g.terms) return g.terms;
    const docs = new Map();
    const df = new Map();
    for (const n of g.nodes.values()) {
      if (!KNOWLEDGE.has(n.kind) || (REQ_KINDS.has(n.kind) && !isReq(n))) continue;
      if (n.kind === 'decision' && supersededBy(g, n.key)) continue;
      const tf = new Map();
      for (const w of terms(textOf(g, n))) tf.set(w, (tf.get(w) ?? 0) + 1);
      if (!tf.size) continue;
      docs.set(n.key, tf);
      for (const w of tf.keys()) df.set(w, (df.get(w) ?? 0) + 1);
    }
    const idf = new Map([...df].map(([w, c]) => [w, Math.log(1 + docs.size / c)]));
    const weigh = (tf) => {
      const v = new Map();
      let norm = 0;
      for (const [w, c] of tf) {
        const x = c * (idf.get(w) ?? Math.log(1 + docs.size));
        v.set(w, x);
        norm += x * x;
      }
      return { v, norm: Math.sqrt(norm) };
    };
    g.terms = { docs: new Map([...docs].map(([k, tf]) => [k, weigh(tf)])), weigh };
    return g.terms;
  }
  /**
   * Requirements, stories, decisions and answers that share vocabulary with
   * this text but aren't linked to it: where an unnoticed contradiction would
   * hide. Deterministic word overlap; a model decides whether they conflict.
   */
  function relatedTo(g, text, exclude, limit = 5) {
    const ix = termIndex(g);
    const tf = new Map();
    for (const w of terms(text)) tf.set(w, (tf.get(w) ?? 0) + 1);
    const q = ix.weigh(tf);
    if (!q.norm) return [];
    const scored = [];
    for (const [k, d] of ix.docs) {
      if (exclude.has(k)) continue;
      let dot = 0;
      let covered = 0;
      let shared = 0;
      for (const [w, x] of q.v) {
        if (!d.v.has(w)) continue;
        dot += x * d.v.get(w);
        covered += d.v.get(w) ** 2;
        shared += 1;
      }
      // similar overall, or covering much of a short requirement; one shared word is never enough
      const score = Math.max(dot / (q.norm * d.norm), covered / d.norm ** 2);
      if (shared >= 2 && score >= 0.2) scored.push([k, score]);
    }
    return scored.sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k, score]) => brief(g, k, { similarity: Math.round(score * 100) / 100 }));
  }
  /** What's already linked to an item (so "related" only shows what isn't). */
  function linkedSet(g, k) {
    const out = new Set([k]);
    for (const e of [...outOf(g, k), ...inOf(g, k)]) out.add(e.to === k ? e.from : e.to);
    for (const r of deepTrace(g, k)) {
      out.add(r);
      for (const e of [...outOf(g, r), ...inOf(g, r)]) out.add(e.to === r ? e.from : e.to);
    }
    return out;
  }
  function related(raw, limit = 5) {
    const { g, n } = nodeFor(raw);
    return relatedTo(g, textOf(g, n), linkedSet(g, n.key), limit);
  }

  /** What an agent needs when it starts a ticket: its requirements as they stand now, and what is known about them. */
  function contextFor(ticketId) {
    const g = build();
    const t = store.state.tickets[String(ticketId).toUpperCase()];
    const tk = keyOf(t.id);
    const reqs = deepTrace(g, tk);
    const linked = (k, kinds) => inOf(g, k).map((e) => e.from).filter((x) => kinds.includes(g.nodes.get(x).kind));
    // the change this ticket builds (itself, or the change it is part of)
    const building = new Set([t.id, ...t.refs.map((r) => String(r).toUpperCase()).filter((r) => store.state.tickets[r]?.kind === 'change')]);
    const requirementsOut = reqs.map((k) => {
      const n = g.nodes.get(k);
      const o = { id: n.id, title: clip(n.title, 140), ...currentText(g, n) };
      if (o.proposed) {
        o.proposed.note = building.has(o.proposed.change)
          ? 'Your ticket builds this wording: it becomes the requirement when it is merged.'
          : `Not in effect until ${o.proposed.change} is done: build to the current text unless your ticket says otherwise.`;
      }
      const l = linkOf(n);
      if (l) o.link = l;
      const fresh = (x) => freshness(g, x, [k]);
      const decisions = linked(k, ['decision']).filter((x) => !supersededBy(g, x));
      const questions = linked(k, ['question']).filter((q) => g.nodes.get(q).status === 'open');
      const notes = linked(k, ['note']);
      // the human's answers: given on it directly, or to a question about it
      const answered = linked(k, ['question']).flatMap((q) => inOf(g, q).filter((e) => e.type === 'answers').map((e) => e.from));
      const facts = [...new Set([...linked(k, ['fact']), ...answered])];
      const others = inOf(g, k).filter((e) => e.type === 'implements' && e.from !== tk).map((e) => e.from);
      if (decisions.length) o.decisions = decisions.slice(-5).map((x) => brief(g, x, fresh(x)));
      if (questions.length) o.open_questions = questions.map((x) => brief(g, x));
      if (notes.length) o.notes = notes.slice(-5).map((x) => ({ ...brief(g, x, fresh(x)), text: clip(store.state.notes.find((m) => m.id === g.nodes.get(x).id)?.text, 400) }));
      if (facts.length) o.facts = facts.map((x) => (fresh(x).before_change ? `${g.nodes.get(x).title} (given before ${fresh(x).before_change} changed this: check it)` : g.nodes.get(x).title));
      if (others.length) o.other_tickets = others.slice(0, 8).map((x) => brief(g, x));
      const changes = inOf(g, k).filter((e) => ['amends', 'extends'].includes(e.type)).map((e) => `${IN_LABEL[e.type]} ${g.nodes.get(e.from).id}`);
      if (changes.length) o.changes = changes;
      return o;
    });
    const own = (kinds) => inOf(g, tk).map((e) => e.from).filter((x) => kinds.includes(g.nodes.get(x).kind));
    const out = { requirements: requirementsOut };
    const decisions = own(['decision']).filter((x) => !supersededBy(g, x));
    const notes = own(['note']);
    if (decisions.length) out.decisions = decisions.map((x) => brief(g, x, freshness(g, x, reqs)));
    if (notes.length) out.notes = notes.map((x) => ({ ...brief(g, x, freshness(g, x, reqs)), text: clip(store.state.notes.find((m) => m.id === g.nodes.get(x).id)?.text, 400) }));
    // close in wording but not linked: the place a contradiction would go unnoticed
    const exclude = linkedSet(g, tk);
    for (const r of reqs) for (const e of inOf(g, r)) exclude.add(e.from);
    const near = relatedTo(g, [textOf(g, g.nodes.get(tk)), ...reqs.map((r) => textOf(g, g.nodes.get(r)))].join(' '), exclude, 4);
    if (near.length) out.possibly_related = { note: 'Not linked to this ticket, but close in wording. Check none contradicts what you build; if one does, mc_conflict.', items: near };
    const thread = own(['message']).length;
    if (thread) out.discussion = `${thread} message(s) about ${t.id}: mc_ref "${t.id}" with only: "discussion"`;
    if (t.kind === 'change' && (t.amends?.length || t.extends?.length)) out.impact = impact(t.id).line;
    const diags = diagnostics().filter((d) => d.ids.includes(t.id) || d.ids.some((x) => reqs.includes(keyOf(x))));
    if (diags.length) out.diagnostics = diags.map((d) => d.text);
    out.how = 'mc_ref <ID> shows everything linked to an ID; mc_section <ID> reads just its definition. Read those instead of whole files.';
    return { context: out, requirements: reqs.map((k) => g.nodes.get(k).id) };
  }

  /**
   * The one epic these requirements belong to (HQ's id, e.g. "E1"), or null
   * when they span several or none: an epic itself, a story's epic, the epics
   * of the stories that cover a requirement and of the tickets implementing it.
   */
  function epicOf(ids) {
    const g = build();
    const found = new Set();
    const asEpic = (k) => {
      const m = /^epic-(\d+)$/.exec(k);
      if (m) found.add(`E${m[1]}`);
    };
    for (const raw of ids) {
      const k = keyOf(raw);
      const n = g.nodes.get(k);
      if (!n) continue;
      if (n.kind === 'epic') asEpic(k);
      const stories = n.kind === 'story' ? [k] : inOf(g, k).filter((e) => e.type === 'refs' && g.nodes.get(e.from).kind === 'story').map((e) => e.from);
      for (const st of stories) for (const e of outOf(g, st)) if (e.type === 'part_of') asEpic(e.to);
      for (const e of inOf(g, k)) if (e.type === 'implements' && g.nodes.get(e.from).kind === 'ticket') asEpic(keyOf(store.state.tickets[g.nodes.get(e.from).id]?.epic ?? ''));
    }
    return found.size === 1 ? [...found][0] : null;
  }

  /** The next free ID for a new requirement of this kind (FR, NFR, UXR). */
  function nextRequirementId(prefix = 'FR') {
    const g = build();
    const re = new RegExp(`^${prefix.toLowerCase()}(\\d+)$`);
    let max = 0;
    for (const k of g.nodes.keys()) {
      const m = re.exec(k);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${prefix.toUpperCase()}${max + 1}`;
  }

  return {
    build,
    keyOf,
    node: (raw) => {
      const k = keyOf(raw);
      return k ? build().nodes.get(k) ?? null : null;
    },
    isRequirement: (raw) => isReq(build().nodes.get(keyOf(raw))),
    check,
    trace: (raw) => {
      const g = build();
      return traceKeys(g, keyOf(raw)).map((k) => g.nodes.get(k).id);
    },
    card,
    section,
    impact,
    mapping,
    diagnostics,
    coverage,
    requirements,
    contextFor,
    related,
    checkOf: (raw) => checkOf(keyOf(raw)),
    epicOf,
    nextRequirementId,
  };
}
