import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isHiddenPath } from '../paths.js';
import { ARTIFACT_URL } from '../hook.js';

/**
 * HQ's Library: one place for everything about the project. Planning files,
 * design packs, UI mockups, minutes of meetings, links (Claude artifacts,
 * Figma…) and your Claude Code conversations with the planning agents.
 * Everything here is discovered from disk or HQ's log; nothing to maintain.
 */

const SKIP = new Set(['node_modules', '.git', 'worktrees', 'run', 'shots', 'dist', 'build', '.next', '.expo', 'images']);
const SHOWN = /\.(md|markdown|txt|html?|ya?ml|csv|pdf|png|jpe?g|webp|gif|svg)$/i;
const TEXT = /\.(md|markdown|txt|html?|ya?ml|csv)$/i;

// BMad v6 file names → what they are
const LABELS = [
  [/brainstorm/i, 'Brainstorming'],
  [/(product[-_]?brief|brief)/i, 'Product brief'],
  [/research/i, 'Research'],
  [/(^|[-_/])prd/i, 'PRD'],
  [/ux[-_]?(design|spec)|ux-color|ux-design/i, 'UX design'],
  [/architecture/i, 'Architecture'],
  [/epic/i, 'Epics & stories'],
  [/sprint[-_]status/i, 'Sprint status'],
  [/tech[-_]?spec/i, 'Tech spec'],
  [/project[-_]context/i, 'Project context'],
  [/(^|\/)\d+[-.]\d+[-.][^/]*\.md$/i, 'Story'],
  [/readiness|validation|checklist/i, 'Checks'],
];

export function labelFor(rel) {
  if (/\.html?$/i.test(rel)) return 'Mockup';
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(rel)) return 'Image';
  for (const [re, label] of LABELS) if (re.test(rel)) return label;
  return null;
}

function walk(root, dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) walk(root, rel, out);
    } else if (SHOWN.test(e.name) && !isHiddenPath(rel)) {
      out.push(rel);
    }
  }
}

function titleOf(root, rel) {
  if (!TEXT.test(rel)) return path.basename(rel);
  try {
    const head = fs.readFileSync(path.join(root, rel), 'utf8').slice(0, 4000);
    const m = /^#\s+(.+)$/m.exec(head) ?? /<title>([^<]+)<\/title>/i.exec(head) ?? /^title:\s*["']?(.+?)["']?\s*$/m.exec(head);
    if (m) return m[1].replace(/<a id="[^"]*"><\/a>/g, '').replace(/[*_`]/g, '').trim().slice(0, 120);
  } catch {
    // unreadable: fall back to the name
  }
  return path.basename(rel);
}

function fileEntry(root, rel) {
  const st = fs.statSync(path.join(root, rel));
  return { path: rel, title: titleOf(root, rel), label: labelFor(rel), updated: st.mtime.toISOString(), size: st.size };
}

const newestFirst = (a, b) => ((a.updated ?? '') < (b.updated ?? '') ? 1 : -1);

export const LINK_GROUPS = { 'Claude artifact': 'Claude artifacts', Figma: 'Figma', GitHub: 'GitHub', Google: 'Google Docs & Drive', Notion: 'Notion', Miro: 'Miro', Video: 'Videos', Web: 'Other links' };

export const MEETING_KINDS = { planning: 'Planning', 'ui-sprint': 'UI sprints', demo: 'Epic demos', standup: 'Daily wrap-ups', review: 'Reviews', other: 'Other' };

function cat(id, title, description, groups) {
  const kept = groups.filter(([, items]) => items.length).map(([label, items]) => ({ label, items }));
  return { id, title, description, groups: kept, count: kept.reduce((n, g) => n + g.items.length, 0) };
}

function groupBy(items, keyOf, order = []) {
  const map = new Map(order.map((k) => [k, []]));
  for (const it of items) {
    const k = keyOf(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return [...map.entries()];
}

export function createLibrary({ paths, config, store }) {
  const root = paths.root;
  const extra = (config.library?.dirs ?? []).map(String);

  function files() {
    const planning = [];
    for (const d of ['_bmad-output', 'docs', ...extra]) walk(root, d, planning);
    const design = [];
    walk(root, 'docs/design', design);
    const designSet = new Set(design);
    const plan = planning.filter((p) => !designSet.has(p) && !p.startsWith('docs/design/'));
    const top = ['README.md', 'CLAUDE.md', 'AGENTS.md'].filter((f) => fs.existsSync(path.join(root, f)));
    const team = [];
    walk(root, '.madcompany', team);
    return { plan: [...new Set([...plan, ...top])], design, team: team.filter((p) => !p.startsWith('.madcompany/meetings/') && !p.startsWith('.madcompany/agents/')) };
  }

  /**
   * Everything, sorted into categories that follow how a project is planned
   * and built. Each category holds labelled groups of items.
   */
  function overview() {
    const s = store.state;
    const f = files();
    const planning = f.plan.map((p) => fileEntry(root, p));
    const design = f.design.map((p) => ({ ...fileEntry(root, p), label: designLabel(p), status: s.designs[p]?.status ?? null, owner: s.designs[p]?.owner ?? null }));
    const records = f.team.map((p) => ({ ...fileEntry(root, p), label: recordLabel(p) }));
    const shots = Object.values(s.tickets)
      .flatMap((t) => t.attachments.filter((a) => a.kind === 'screenshot').map((a) => ({ path: a.path, title: a.caption || t.title, ticket: t.id, updated: a.ts, label: 'Screenshot' })))
      .sort(newestFirst);
    const byLabel = (items, labels) => items.filter((x) => labels.includes(x.label));
    const used = new Set();
    const take = (items) => (items.forEach((x) => used.add(x.path)), items);


    const found = foundLinks(f.plan.concat(f.design));
    const saved = [...s.links].reverse();
    const allLinks = [...saved.map((l) => ({ ...l, saved: true })), ...found];
    const claudeArtifacts = allLinks.filter((l) => l.kind === 'Claude artifact');

    const categories = [
      cat('discovery', 'Discovery', 'Brainstorming, research and the product brief.', [
        ['Product brief', take(byLabel(planning, ['Product brief']))],
        ['Research', take(byLabel(planning, ['Research']))],
        ['Brainstorming', take(byLabel(planning, ['Brainstorming']))],
      ]),
      cat('requirements', 'Requirements', 'What the product must do. Every FR/NFR is anchored and clickable.', [['PRD', take(byLabel(planning, ['PRD']))]]),
      cat('ux', 'UX & UI', 'The UX spec, mockups, screenshots from the team and the running app.', [
        ['UX design', take(byLabel(planning, ['UX design']))],
        ['Claude artifacts', claudeArtifacts],
        ['Mockups', take(byLabel(planning, ['Mockup']))],
        ['Images', take(byLabel(planning, ['Image']))],
        ['Screenshots', shots],
      ]),
      cat('architecture', 'Architecture & design', 'Architecture, tech specs and the design packs developers publish before coding.', [
        ['Architecture', take(byLabel(planning, ['Architecture', 'Tech spec', 'Project context']))],
        ['Codebase map', byLabel(design, ['Codebase map'])],
        ['API contracts', byLabel(design, ['API contract'])],
        ['Data models', byLabel(design, ['Data model'])],
        ['Module sketches & flows', byLabel(design, ['Design pack'])],
      ]),
      cat('delivery', 'Releases & epics', 'Release notes, epics, stories, sprint status and the board.', [
        ['Release notes', byLabel(records, ['Release notes'])],
        ['Epics & stories', take(byLabel(planning, ['Epics & stories']))],
        ['Stories', take(byLabel(planning, ['Story']))],
        ['Sprint & checks', take(byLabel(planning, ['Sprint status', 'Checks']))],
        ['Board', byLabel(records, ['Board'])],
      ]),
      cat('meetings', 'Meetings', 'Minutes of every session with you: planning, UI sprints, demos and daily wrap-ups.', groupBy([...s.minutes].reverse(), (m) => MEETING_KINDS[m.kind] ?? 'Other', Object.values(MEETING_KINDS))),
      cat('conversations', 'Conversations', 'Your Claude Code sessions in this project, including the planning agents.', config.library?.sessions === false ? [] : [['Claude Code sessions', sessions()]]),
      cat('links', 'Links', 'Claude artifacts, Figma, docs and other links, saved or found in docs and chat.', groupBy(allLinks, (l) => LINK_GROUPS[l.kind] ?? 'Other links', Object.values(LINK_GROUPS))),
      cat('records', 'Records', 'Decisions, questions, your answers, Human help, the team and chat logs.', [
        ['Decisions & answers', byLabel(records, ['Decisions', 'Questions', 'Facts'])],
        ['Human help', byLabel(records, ['Human help', 'Credentials'])],
        ['Team', byLabel(records, ['Team'])],
        ['Chat logs', byLabel(records, ['Chat log'])],
      ]),
      cat('other', 'Other documents', 'Everything else in your planning folders.', [['Documents', planning.filter((x) => !used.has(x.path))]]),
    ];
    return { categories, counts: Object.fromEntries(categories.map((c) => [c.id, c.count])) };
  }

  function designLabel(rel) {
    const base = rel.toLowerCase();
    if (base.startsWith('docs/design/codebase/')) return 'Codebase map';
    const text = TEXT.test(rel) ? readText(rel).slice(0, 20000) : '';
    if (/api|openapi|contract|endpoint|swagger/.test(base) || /^openapi:|\|\s*method\s*\|\s*path|\b(GET|POST|PUT|PATCH|DELETE)\s+\/\w/im.test(text)) return 'API contract';
    if (/schema|erd|data[-_]?model|database|\bdb\b|entities/.test(base) || /erDiagram|CREATE TABLE|^model \w+ \{/im.test(text)) return 'Data model';
    return 'Design pack';
  }
  function recordLabel(rel) {
    if (rel.endsWith('log/board.md')) return 'Board';
    if (rel.endsWith('log/decisions.md')) return 'Decisions';
    if (rel.endsWith('log/questions.md')) return 'Questions';
    if (rel.endsWith('facts.md')) return 'Facts';
    if (rel.endsWith('credentials-needed.md')) return 'Credentials';
    if (rel.endsWith('.madcompany/human-help.md')) return 'Human help';
    if (rel.startsWith('.madcompany/releases/')) return 'Release notes';
    if (rel.includes('/log/chat/')) return 'Chat log';
    if (rel.endsWith('team.yaml')) return 'Team';
    return 'Record';
  }

  // ---------- links found in docs and chat ----------
  function kindOfUrl(u) {
    if (/claude\.ai\/(code\/)?(artifact|public\/artifacts)|claude\.site\/artifacts/i.test(u)) return 'Claude artifact';
    if (/figma\.com/i.test(u)) return 'Figma';
    if (/github\.com/i.test(u)) return 'GitHub';
    if (/docs\.google\.com|drive\.google\.com/i.test(u)) return 'Google';
    if (/notion\.(so|site)/i.test(u)) return 'Notion';
    if (/loom\.com|youtube\.com|youtu\.be/i.test(u)) return 'Video';
    if (/miro\.com/i.test(u)) return 'Miro';
    return 'Web';
  }
  function foundLinks(rels) {
    const seen = new Map();
    const add = (url, source, href, verb) => {
      const clean = url.replace(/[).,;:!?\]>'"*_]+$/, '');
      if (/127\.0\.0\.1|localhost/.test(clean)) return;
      if (!seen.has(clean)) seen.set(clean, { url: clean, kind: kindOfUrl(clean), title: linkTitle(clean), sources: [] });
      const e = seen.get(clean);
      if (e.sources.length < 3 && !e.sources.some((x) => x.label === source)) e.sources.push({ label: source, href, ...(verb ? { verb } : {}) });
    };
    for (const rel of rels) {
      if (!TEXT.test(rel)) continue;
      const text = readText(rel);
      for (const m of text.matchAll(/https?:\/\/[^\s)<>"'`]+/g)) add(m[0], rel, `#/file/${rel}`);
    }
    for (const m of store.state.messages) for (const u of m.text.matchAll(/https?:\/\/[^\s)<>"'`]+/g)) add(u[0], `#${m.channel}`, `#/chat/${encodeURIComponent(m.channel)}`);
    for (const d of store.state.decisions) for (const u of `${d.decision} ${d.why} ${(d.links ?? []).join(' ')}`.matchAll(/https?:\/\/[^\s)<>"'`]+/g)) add(u[0], d.id, `#/decisions/${d.id}`);
    if (config.library?.sessions !== false) {
      for (const meta of sessions()) {
        for (const a of meta.artifacts ?? []) {
          add(a.url, `conversation “${meta.title.slice(0, 50)}”`, `#/session/${meta.id}`, 'Published in');
          const e = seen.get(a.url);
          if (e && (!e.title || e.title.startsWith('Claude artifact'))) e.title = a.title;
          if (e && !e.ts) e.ts = a.ts;
        }
      }
    }
    const saved = new Set(store.state.links.map((l) => l.url));
    return [...seen.values()].filter((l) => !saved.has(l.url)).sort((a, b) => (a.kind === 'Claude artifact' ? -1 : 0) - (b.kind === 'Claude artifact' ? -1 : 0));
  }

  function linkTitle(u) {
    try {
      const x = new URL(u);
      if (kindOfUrl(u) === 'Claude artifact') return `Claude artifact ${x.pathname.split('/').filter(Boolean).pop()?.slice(0, 8) ?? ''}`.trim();
      const bits = x.pathname.split('/').filter(Boolean).slice(0, 2).join('/');
      return `${x.host.replace(/^www\./, '')}${bits ? `/${bits}` : ''}`;
    } catch {
      return u;
    }
  }

  // ---------- text cache (for search and link scanning) ----------
  const cache = new Map();
  function readText(rel) {
    const abs = path.join(root, rel);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return '';
    }
    const hit = cache.get(rel);
    if (hit && hit.mtime === st.mtimeMs) return hit.text;
    let text = st.size > 2 * 1024 * 1024 ? '' : fs.readFileSync(abs, 'utf8');
    if (/\.html?$/i.test(rel)) text = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    cache.set(rel, { mtime: st.mtimeMs, text });
    return text;
  }

  // ---------- Claude Code conversations (planning sessions) ----------
  function sessionsDir() {
    const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    return path.join(base, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'));
  }
  const sessionCache = new Map();
  function parseSession(file) {
    const st = fs.statSync(file);
    const hit = sessionCache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.value;
    const messages = [];
    const artifacts = [];
    const toolInputs = new Map();
    const raw = st.size > 50 * 1024 * 1024 ? '' : fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if ((ev.type !== 'user' && ev.type !== 'assistant') || ev.isSidechain) continue;
      // artifacts this session published: the link is in the Artifact tool's result
      for (const b of Array.isArray(ev.message?.content) ? ev.message.content : []) {
        if (b?.type === 'tool_use' && /artifact/i.test(b.name ?? '') && !/comment|data/i.test(b.name ?? '')) toolInputs.set(b.id, b.input ?? {});
        if (b?.type === 'tool_result' && toolInputs.has(b.tool_use_id)) {
          const args = toolInputs.get(b.tool_use_id);
          if (args.action && args.action !== 'publish') continue;
          for (const url of new Set(JSON.stringify(b.content ?? '').match(ARTIFACT_URL) ?? [])) {
            if (artifacts.some((a) => a.url === url)) continue;
            const file = args.file_path ? path.basename(String(args.file_path)).replace(/\.[a-z]+$/i, '').replace(/[-_]+/g, ' ') : '';
            const a = { url, title: String(args.title || args.description || file || 'Claude artifact').slice(0, 140), ts: ev.timestamp ?? null };
            artifacts.push(a);
            messages.push({ role: 'artifact', text: a.title, url, ts: a.ts });
          }
        }
      }
      if (ev.isMeta) continue;
      const text = messageText(ev);
      if (text) messages.push({ role: ev.type === 'user' ? 'you' : 'claude', text, ts: ev.timestamp ?? null });
    }
    const yours = messages.filter((m) => m.role === 'you');
    const firstCmd = yours.find((m) => m.text.startsWith('/'));
    const firstWords = yours.find((m) => !m.text.startsWith('/'));
    const title = [firstCmd?.text.split(/\s/)[0], firstWords?.text.split('\n')[0]].filter(Boolean).join(' · ').slice(0, 120) || '(no messages)';
    const value = {
      id: path.basename(file, '.jsonl'),
      title,
      started: messages[0]?.ts ?? st.birthtime.toISOString(),
      updated: st.mtime.toISOString(),
      yourMessages: messages.filter((m) => m.role === 'you').length,
      commands: [...new Set(messages.filter((m) => m.role === 'you' && m.text.startsWith('/')).map((m) => m.text.split(/\s/)[0]))].slice(0, 8),
      artifacts,
      messages,
    };
    sessionCache.set(file, { mtime: st.mtimeMs, value });
    return value;
  }
  function sessions() {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const { messages, ...meta } = parseSession(path.join(dir, f));
        return meta;
      })
      .filter((x) => x.yourMessages > 0)
      .sort(newestFirst);
  }
  function session(id) {
    if (!/^[0-9a-zA-Z-]{8,64}$/.test(String(id))) return null;
    const file = path.join(sessionsDir(), `${id}.jsonl`);
    return fs.existsSync(file) ? parseSession(file) : null;
  }

  // ---------- search across everything ----------
  function search(q) {
    const needle = String(q ?? '').trim().toLowerCase();
    if (needle.length < 2) return [];
    const results = [];
    const plain = (t) => String(t).replace(/<[^>]+>/g, ' ').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^#+\s*|[*_`>|]+/gm, '').replace(/\s+/g, ' ');
    const snip = (raw) => {
      const text = plain(raw);
      const i = text.toLowerCase().indexOf(needle);
      if (i < 0) return null;
      const a = Math.max(0, i - 70);
      return `${a > 0 ? '…' : ''}${text.slice(a, i + needle.length + 90).replace(/\s+/g, ' ').trim()}…`;
    };
    const push = (type, title, href, text, extra = {}) => {
      const s = snip(`${title}\n${text}`);
      if (s) results.push({ type, title, href, snippet: s, ...extra });
    };
    const f = files();
    for (const rel of [...f.plan, ...f.design, ...f.team]) {
      if (!TEXT.test(rel)) continue;
      push(rel.startsWith('docs/design/') ? 'Design' : rel.startsWith('.madcompany/') ? 'Team log' : 'Planning', titleOf(root, rel), `#/file/${rel}`, readText(rel), { path: rel });
    }
    const s = store.state;
    for (const m of s.minutes) push('Meeting', `${m.id} ${m.title}`, `#/file/${m.file}?a=${m.id.toLowerCase()}`, readText(m.file));
    for (const t of Object.values(s.tickets)) push('Ticket', `${t.id} ${t.title}`, `#/ticket/${t.id}`, [t.body, ...t.worklog.map((w) => w.text), t.checkpoint?.next ?? ''].join('\n'));
    for (const d of s.decisions) push('Decision', `${d.id} ${d.title}`, `#/decisions/${d.id}`, `${d.decision}\n${d.why}\n${d.alternatives ?? ''}`);
    for (const q2 of Object.values(s.questions)) push('Question', `${q2.id} ${q2.question}`, `#/questions/${q2.id}`, q2.answer ?? '');
    for (const x of s.facts) push('Fact', x.id, `#/facts/${x.id}`, x.text);
    for (const l of s.links) push('Link', l.title, l.url, `${l.url}\n${l.note ?? ''}`, { external: true });
    for (const m of s.messages) push('Chat', `#${m.channel} · ${m.by}`, `#/chat/${encodeURIComponent(m.channel)}`, m.text);
    if (config.library?.sessions !== false) {
      for (const meta of sessions()) {
        const sess = session(meta.id);
        const hit = sess.messages.find((m) => m.text.toLowerCase().includes(needle));
        if (hit) results.push({ type: 'Conversation', title: meta.title, href: `#/session/${meta.id}`, snippet: snip(hit.text), when: hit.ts });
      }
    }
    return results.slice(0, 80);
  }

  return { overview, session, search, readText };
}

/** The readable part of a transcript line: your words, Claude's words, slash commands. */
function messageText(ev) {
  const c = ev.message?.content;
  let text = '';
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) text = c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  text = text.trim();
  if (!text) return '';
  const cmd = /<command-name>([^<]+)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return `${cmd[1].trim()}${args ? ` ${args}` : ''}`;
  }
  if (/^(<system-reminder>|<local-command|Base directory for this skill|Caveat:|\[Request interrupted)/.test(text)) return '';
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
}
