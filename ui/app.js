/* madcompany HQ — a small no-build web app. State comes from /api/state and refreshes live over /api/stream. */
'use strict';

let S = null; // latest /api/state
let IDS = {}; // reference registry
const $main = document.getElementById('main');

// ---------- utilities ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const COLORS = ['#1f6feb', '#8250df', '#1a7f37', '#bf3989', '#9a6700', '#0a7ea4', '#cf222e', '#6e7781'];
const colorFor = (id) => COLORS[Math.abs([...String(id)].reduce((h, c) => (h * 33) ^ c.charCodeAt(0), 5381)) % COLORS.length];
const avatar = (id) => (id === 'you' ? '<span class="avatar you">Y</span>' : `<span class="avatar" style="background:${colorFor(id)}">${esc(String(id)[0]?.toUpperCase())}</span>`);
const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', in_review: 'In review', done: 'Done' };

function ago(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts).toLocaleDateString();
}
const clock = (ts) => (ts ? new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

// Same rules as src/refs/ids.js normalizeKey.
function normalizeKey(raw) {
  const t = String(raw).trim().replace(/\s+/g, ' ');
  let m;
  if ((m = /^Epic ?0*(\d+)$/i.exec(t))) return `epic-${m[1]}`;
  if ((m = /^Story ?0*(\d+)\.0*(\d+)$/i.exec(t))) return `story-${m[1]}-${m[2]}`;
  if ((m = /^([A-Za-z]{1,6})-?0*(\d+)$/.exec(t)) && /^(FR|NFR|UXR|AR|D)$/i.test(m[1])) return `${m[1].toLowerCase()}${m[2]}`;
  if ((m = /^([A-Za-z][A-Za-z0-9]{0,9})-0*(\d+)$/.exec(t))) return `${m[1].toLowerCase()}-${m[2]}`;
  if ((m = /^([A-Za-z]{1,6})0*(\d+)$/.exec(t))) return `${m[1].toLowerCase()}${m[2]}`;
  return t.toLowerCase();
}
const MENTION = /\b(?:Epic\s+\d+|Story\s+\d+\.\d+|[A-Z][A-Z0-9]{0,9}-\d+(?:\.\d+)?|[A-Z]{1,5}\d+)\b/g;

function hrefFor(entry) {
  return entry.hq ?? `#/file/${entry.file}?a=${encodeURIComponent(entry.anchor)}`;
}

/** Escape text, then turn links, known IDs, file paths and @mentions into links. */
function linkify(text) {
  const parts = [];
  const hold = (html) => `\u0000${parts.push(html) - 1}\u0000`;
  let s = esc(text);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g, (m, label, href) => {
    let url = href.replace(/&amp;/g, '&');
    if (/^https?:\/\//i.test(url)) return hold(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`);
    if (url.startsWith('#/')) return hold(`<a href="${esc(url)}">${label}</a>`);
    if (/^[a-z]+:/i.test(url)) return label;
    const [p, a] = url.split('#');
    return hold(`<a href="#/file/${esc(p.replace(/^\.?\//, ''))}${a ? `?a=${esc(a)}` : ''}">${label}</a>`);
  });
  s = s.replace(/`([^`]+)`/g, (m, code) => hold(`<code>${code}</code>`));
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '\u0001$1\u0002');
  s = s.replace(/https?:\/\/[^\s<]+/g, (u) => hold(`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`));
  s = s.replace(MENTION, (m) => {
    const e = IDS[normalizeKey(m)];
    return e ? hold(`<a href="${esc(hrefFor(e))}" title="${esc(e.title ?? '')}"${e.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${m}</a>`) : m;
  });
  s = s.replace(/(^|[\s(])((?:\.{0,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{1,8})(?::(\d+))?/gi, (m, pre, p, line) =>
    `${pre}${hold(`<a href="#/file/${esc(p.replace(/^\.\//, ''))}${line ? `?l=${line}` : ''}">${p}${line ? `:${line}` : ''}</a>`)}`,
  );
  s = s.replace(/@([a-z][a-z0-9-]*)/g, (m) => hold(`<span class="mention">${m}</span>`));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => parts[Number(i)]).replace(/\u0001/g, '<b>').replace(/\u0002/g, '</b>');
}

const idLink = (id) => (id ? `<a href="#/ticket/${esc(id)}">${esc(id)}</a>` : '');
const pill = (cls, label) => `<span class="pill ${esc(cls)}">${esc(label ?? cls)}</span>`;

async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? res.statusText);
  return out;
}

// ---------- data ----------
async function refresh() {
  [S, IDS] = await Promise.all([api('/api/state'), api('/api/ids')]);
  document.getElementById('project-name').textContent = S.config.project.name;
  const n = S.dashboard.needsYou.length;
  const badge = document.getElementById('inbox-badge');
  badge.hidden = n === 0;
  badge.textContent = n;
  document.title = `${n ? `(${n}) ` : ''}${S.config.project.name} · madcompany HQ`;
  render();
}

let pending = null;
function live() {
  const es = new EventSource('/api/stream');
  const dot = document.getElementById('live-dot');
  const txt = document.getElementById('live-text');
  es.addEventListener('change', () => {
    dot.className = 'dot live';
    txt.textContent = 'Live';
    clearTimeout(pending);
    pending = setTimeout(() => refresh().catch(console.error), 150);
  });
  es.onerror = () => {
    dot.className = 'dot';
    txt.textContent = 'Reconnecting…';
  };
}

// ---------- router ----------
function route() {
  const raw = location.hash.slice(1) || '/';
  const [p, q] = raw.split('?');
  const parts = p.split('/').filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] ?? 'dashboard', parts, query: new URLSearchParams(q ?? '') };
}

let lastView = '';
function render() {
  if (!S) return;
  const r = route();
  const viewName = r.name === 'questions' || r.name === 'facts' ? 'inbox' : r.name;
  const name = ['session', 'search', 'file'].includes(r.name) ? 'library' : viewName; // sidebar highlight
  document.querySelectorAll('.side a').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));
  const views = { dashboard, chat, board, ticket: ticketView, inbox, decisions, team, preview, file: fileView, library: libraryView, session: sessionView, search: searchView };
  const view = views[viewName] ?? dashboard;
  const key = location.hash;
  const keepScroll = key === lastView;
  const scroll = $main.scrollTop;
  const draft = document.querySelector('textarea[data-keep]')?.value;
  const html = view(r);
  if (html instanceof Promise) return;
  $main.innerHTML = html;
  if (draft) {
    const ta = document.querySelector('textarea[data-keep]');
    if (ta) ta.value = draft;
  }
  wire(r);
  if (keepScroll) $main.scrollTop = scroll;
  else {
    $main.scrollTop = 0;
    focusTarget(r);
  }
  lastView = key;
}

function focusTarget(r) {
  const id = r.parts[1];
  if (!id) return;
  const el = document.getElementById(`x-${id}`);
  if (el) {
    el.scrollIntoView({ block: 'center' });
    el.classList.add('hl');
  }
}

// ---------- views ----------
function dashboard() {
  const d = S.dashboard;
  const wd = d.workday.state;
  const epics = d.epics.length
    ? d.epics
        .map((e) => {
          const pct = e.total ? Math.round((100 * e.done) / e.total) : 0;
          return `<div class="stack"><div class="row"><b>${esc(e.title)}</b><span class="grow"></span><span class="sub">${e.done}/${e.total} tickets</span></div><div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div></div>`;
        })
        .join('')
    : '<p class="empty">No tickets yet. The lead creates them from your epics.</p>';
  const team = d.team
    .map(
      (m) => `<tr>
      <td><div class="who">${avatar(m.id)} <a href="#/team/${esc(m.id)}">${esc(m.id)}</a></div></td>
      <td class="sub">${esc(m.role)} · ${esc(m.lead ? 'your session' : m.model)}</td>
      <td><span class="row"><span class="dot ${m.status}"></span>${esc(m.status)}</span></td>
      <td>${m.ticket ? `${idLink(m.ticket)} <span class="sub">${esc(S.tickets[m.ticket]?.title ?? '')}</span>` : '<span class="sub">–</span>'}</td>
      <td class="time">${ago(m.lastActivity)}</td></tr>`,
    )
    .join('');
  const blocked = d.blocked.length
    ? d.blocked.map((b) => `<div>${idLink(b.id)} ← ${b.blockedBy.map((x) => (S.tickets[x] ? idLink(x) : `<a href="#/questions/${esc(x)}">${esc(x)}</a>`)).join(', ')} <span class="sub">${esc(b.assignee ?? '')}</span></div>`).join('')
    : '<p class="empty">Nothing blocked.</p>';
  const shots = d.shots.length
    ? `<div class="shots">${d.shots.map((s) => `<a href="#/ticket/${esc(s.ticket)}" title="${esc(s.ticket)} ${esc(s.caption)}"><img src="/shots/${esc(s.path.split('/').pop())}" alt="${esc(s.caption || s.ticket)}" loading="lazy"></a>`).join('')}</div>`
    : '<p class="empty">No screenshots yet.</p>';
  const decisions = d.decisions.length
    ? d.decisions.map((x) => `<div><a href="#/decisions/${esc(x.id)}">${esc(x.id)}</a> ${esc(x.title)} <span class="sub">· ${esc(x.by)}</span></div>`).join('')
    : '<p class="empty">No decisions logged yet.</p>';
  const feed = S.recent.length
    ? S.recent.map((e) => `<div class="item"><span class="time" style="width:110px;flex:none">${clock(e.ts)}</span>${avatar(e.by)}<span><b>${esc(e.by)}</b> ${linkify(e.text)}</span></div>`).join('')
    : '<p class="empty">Quiet so far.</p>';
  const t = d.today;
  const checks = t.lastChecks ? Object.entries(t.lastChecks.checks).map(([k, v]) => `${k} ${v === 'pass' ? '✓' : v}`).join(' · ') : 'no checks yet';
  const liveUrl = d.preview.url ?? `http://localhost:${S.integration.ports.web}`;
  return `
  <div class="top">
    <div class="grow"><h1>${esc(d.project.name)}</h1><div class="sub">Workday ${pill(wd, wd === 'on' ? 'ON' : wd.toUpperCase())} ${d.workday.since ? `since ${clock(d.workday.since)}` : ''}</div></div>
    ${wd === 'on' ? '<button data-act="end">End day</button>' : ''}
    ${wd === 'on' || wd === 'ending' ? '<button class="danger" data-act="stop">Stop now</button>' : ''}
    ${wd === 'off' || wd === 'stopped' ? '<span class="sub">Start the day with <code>/mc-start</code> in Claude Code.</span>' : ''}
  </div>
  <div class="grid g3">
    <a class="card ${d.needsYou.length ? 'needs' : ''}" href="#/inbox" style="color:inherit;text-decoration:none"><h3>Needs you</h3><div class="big">${d.needsYou.length}</div><div class="sub">${d.needsYou[0] ? esc(d.needsYou[0].question) : 'Nothing waiting on you.'}</div></a>
    <div class="card"><h3>Epics</h3>${epics}</div>
    <div class="card"><h3>Today</h3><div>${t.ticketsMoved} ticket moves · ${t.commits} commits · ${t.messages} messages</div><div class="sub">Last checks: ${esc(checks)}</div></div>
  </div>
  <div class="card" style="margin-top:14px"><h3>Team</h3><table class="team">${team}</table></div>
  <div class="grid g3" style="margin-top:14px">
    <div class="card"><h3>Blocked</h3>${blocked}</div>
    <div class="card"><h3>Latest previews</h3>${shots}<div style="margin-top:8px"><a href="${esc(liveUrl)}" target="_blank" rel="noopener">Open live app ↗</a></div></div>
    <div class="card"><h3>Recent decisions</h3>${decisions}</div>
  </div>
  <div class="card feed" style="margin-top:14px"><h3>Latest</h3>${feed}</div>`;
}

function channelsList() {
  const set = new Set(['general', 'contracts', ...Object.keys(S.epics).map((e) => `epic-${e.replace(/\D/g, '')}`), ...S.messages.map((m) => m.channel)]);
  const all = [...set];
  return {
    channels: all.filter((c) => !c.includes(':')).sort(),
    dms: all.filter((c) => c.startsWith('dm:')).sort(),
    tickets: all.filter((c) => c.startsWith('ticket:')).sort(),
  };
}
function channelLabel(c) {
  if (c.startsWith('dm:')) return c.slice(3).split('+').join(' ↔ ');
  if (c.startsWith('ticket:')) return c.slice(7);
  return `# ${c}`;
}
function messageHtml(m) {
  return `<div class="msg ${m.by === 'you' ? 'you' : ''}" id="x-${esc(m.id)}">${avatar(m.by)}<div class="body"><div><b>${esc(m.by)}</b> <span class="time">${clock(m.ts)}</span></div><div class="text">${linkify(m.text)}</div></div></div>`;
}
function chat(r) {
  const current = r.parts.slice(1).join('/') || 'general';
  const { channels, dms, tickets } = channelsList();
  const link = (c) => `<a href="#/chat/${encodeURIComponent(c)}" class="${c === current ? 'on' : ''}">${esc(channelLabel(c))}</a>`;
  const msgs = S.messages.filter((m) => m.channel === current);
  const newDm = S.dashboard.team.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join('');
  return `
  <div class="chat">
    <div class="card channels">
      <h3>Channels</h3>${channels.map(link).join('')}
      <h3>Direct messages</h3>${dms.map(link).join('') || '<div class="sub" style="padding:0 8px">None yet</div>'}
      <div class="row" style="padding:6px 8px"><select id="dm-to" aria-label="Message a team member">${newDm}</select><button data-act="dm">DM</button></div>
      <h3>Ticket threads</h3>${tickets.map(link).join('') || '<div class="sub" style="padding:0 8px">None yet</div>'}
    </div>
    <div class="card messages">
      <div class="row" style="margin-bottom:6px"><h2 style="margin:0">${esc(channelLabel(current))}</h2>${current.startsWith('ticket:') ? ` <a href="#/ticket/${esc(current.slice(7))}">open ticket</a>` : ''}</div>
      <div class="msgs" id="msgs">${msgs.map(messageHtml).join('') || '<p class="empty">No messages yet.</p>'}</div>
      <form class="composer" data-form="post" data-channel="${esc(current)}">
        <textarea name="text" data-keep rows="2" placeholder="Message ${esc(channelLabel(current))} — @mention someone, reference FR12, APP-4…" aria-label="Message"></textarea>
        <button class="primary" type="submit">Send</button>
      </form>
    </div>
  </div>`;
}

function board(r) {
  const agent = r.query.get('agent') ?? '';
  const epic = r.query.get('epic') ?? '';
  const all = Object.values(S.tickets).filter((t) => (!agent || t.assignee === agent) && (!epic || t.epic === epic));
  const cols = ['todo', 'in_progress', 'blocked', 'in_review', 'done']
    .map((st) => {
      const items = all.filter((t) => t.status === st).sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]));
      return `<div class="col"><h3>${STATUS_LABEL[st]} <span>${items.length}</span></h3>${items.map(cardHtml).join('')}</div>`;
    })
    .join('');
  const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label ?? v)}</option>`;
  const agents = S.dashboard.team.map((m) => opt(m.id, agent)).join('');
  const epics = Object.keys(S.epics).map((e) => opt(e, epic, `${e} ${S.epics[e].title ?? ''}`)).join('');
  return `
  <div class="top"><h1 class="grow">Board</h1>
    <select data-filter="agent" aria-label="Filter by agent"><option value="">Everyone</option>${agents}</select>
    <select data-filter="epic" aria-label="Filter by epic"><option value="">All epics</option>${epics}</select>
  </div>
  <div class="columns">${cols}</div>`;
}
function cardHtml(t) {
  const tags = [
    t.epic && `<span class="tag">${esc(t.epic)}</span>`,
    t.ui && '<span class="tag ui">UI</span>',
    t.kind !== 'task' && `<span class="tag warn">${esc(t.kind)}</span>`,
    t.blockedBy.length && `<span class="tag warn">⛔ ${esc(t.blockedBy.join(', '))}</span>`,
  ].filter(Boolean);
  return `<a class="tcard" href="#/ticket/${esc(t.id)}"><div class="row"><span class="id">${esc(t.id)}</span><span class="grow"></span>${t.assignee ? `${avatar(t.assignee)}` : ''}</div><div>${esc(t.title)}</div><div class="meta">${tags.join('')}</div></a>`;
}

function ticketView(r) {
  const t = S.tickets[(r.parts[1] ?? '').toUpperCase()];
  if (!t) return `<p class="empty">No ticket ${esc(r.parts[1])}.</p>`;
  const refLinks = t.refs.map((x) => linkify(x)).join(', ');
  const cp = t.checkpoint
    ? `<div class="callout"><b>Checkpoint</b> by ${esc(t.checkpoint.by)}, ${clock(t.checkpoint.ts)}<br><b>Done:</b> ${linkify(t.checkpoint.done)}<br><b>Next:</b> ${linkify(t.checkpoint.next)}${t.checkpoint.files?.length ? `<br><b>Files:</b> ${t.checkpoint.files.map(linkify).join(', ')}` : ''}${t.checkpoint.questions?.length ? `<br><b>Open questions:</b> ${t.checkpoint.questions.map(linkify).join('; ')}` : ''}</div>`
    : '';
  const shots = t.attachments.filter((a) => a.kind === 'screenshot');
  const thread = S.messages.filter((m) => m.channel === `ticket:${t.id}`);
  return `
  <div class="top"><div class="grow"><div class="sub"><a href="#/board">Board</a> / ${esc(t.id)}</div><h1>${esc(t.title)}</h1></div>${pill(t.status, STATUS_LABEL[t.status])}</div>
  <div class="grid g2">
    <div class="card stack">
      <dl class="kv">
        <dt>Assignee</dt><dd>${t.assignee ? `<a href="#/team/${esc(t.assignee)}">${esc(t.assignee)}</a>` : 'nobody'}</dd>
        <dt>Epic</dt><dd>${esc(t.epic ?? '–')}</dd>
        <dt>Kind</dt><dd>${esc(t.kind)}${t.ui ? ' · UI' : ''}${t.domain ? ` · ${esc(t.domain)}` : ''}</dd>
        <dt>Depends on</dt><dd>${t.deps.map(idLink).join(', ') || '–'}</dd>
        ${t.blockedBy.length ? `<dt>Blocked by</dt><dd>${t.blockedBy.map((x) => linkify(x)).join(', ')}</dd>` : ''}
        <dt>Refs</dt><dd>${refLinks || '–'}</dd>
        <dt>Attempts</dt><dd>${t.attempts}</dd>
      </dl>
      ${cp}
      ${t.body ? `<div class="prose">${linkify(t.body)}</div>` : ''}
    </div>
    <div class="stack">
      <div class="card"><h3>Screenshots</h3>${shots.length ? `<div class="shots">${shots.map((s) => `<a href="/shots/${esc(s.path.split('/').pop())}" target="_blank"><img src="/shots/${esc(s.path.split('/').pop())}" alt="${esc(s.caption)}"></a>`).join('')}</div>` : '<p class="empty">None yet.</p>'}</div>
      <div class="card"><h3>Reviews</h3>${t.reviews.map((v) => `<div>${pill(v.verdict)} ${esc(v.by)} <span class="time">${clock(v.ts)}</span> ${linkify(v.notes)}</div>`).join('') || '<p class="empty">None yet.</p>'}</div>
      <div class="card"><h3>Commits</h3>${t.commits.map((c) => `<div class="mono">${esc(c)}</div>`).join('') || '<p class="empty">None yet.</p>'}</div>
    </div>
  </div>
  <div class="card timeline" style="margin-top:14px"><h3>Activity</h3>${t.activity.map((a) => `<div class="item"><span class="time">${clock(a.ts)}</span><b>${esc(a.by)}</b><span>${linkify(a.text)}</span></div>`).join('')}</div>
  <div class="card" style="margin-top:14px"><h3>Thread</h3>${thread.map(messageHtml).join('') || '<p class="empty">No discussion yet.</p>'}
    <form class="composer" data-form="post" data-channel="ticket:${esc(t.id)}"><textarea name="text" data-keep rows="2" placeholder="Comment on ${esc(t.id)} — @mention the assignee" aria-label="Comment"></textarea><button class="primary" type="submit">Send</button></form>
  </div>`;
}

function inbox(r) {
  const qs = Object.values(S.questions);
  const open = qs.filter((q) => q.to === 'you' && q.status === 'open');
  const answered = qs.filter((q) => q.answeredBy === 'you').reverse();
  const others = qs.filter((q) => q.to !== 'you').reverse().slice(0, 30);
  const openHtml = open.length
    ? open
        .map(
          (q) => `<div class="card q stack" id="x-${esc(q.id)}">
        <div class="row"><b>${esc(q.id)}</b><span class="sub">from ${esc(q.from)} · ${clock(q.ts)}</span>${q.ticket ? ` · ${idLink(q.ticket)}` : ''}</div>
        <div style="font-size:15px">${linkify(q.question)}</div>
        ${q.links.length ? `<div class="sub">Sources: ${q.links.map(linkify).join(', ')}</div>` : ''}
        <div class="opts">${q.options.map((o) => `<button class="${o === q.recommended ? 'rec' : ''}" data-answer="${esc(q.id)}" data-value="${esc(o)}">${esc(o)}${o === q.recommended ? ' · Recommended' : ''}</button>`).join('')}</div>
        <form class="row" data-form="answer" data-q="${esc(q.id)}"><input name="answer" placeholder="Or type your own answer" style="flex:1" aria-label="Your answer"><button type="submit">Answer</button></form>
      </div>`,
        )
        .join('')
    : '<div class="card"><p class="empty">Nothing needs you right now.</p></div>';
  const qRow = (q) => `<div class="qitem" id="x-${esc(q.id)}"><b>${esc(q.id)}</b> <span class="sub">${esc(q.from)} → ${esc(q.to)}</span> ${linkify(q.question)} ${q.answer ? `<br><span class="sub">Answer (${esc(q.answeredBy)}):</span> ${linkify(q.answer)}` : pill('draft', 'open')}</div>`;
  return `
  <div class="top"><h1 class="grow">Inbox</h1></div>
  <div class="stack">${openHtml}</div>
  <div class="card" style="margin-top:14px"><h3>Request a change</h3>
    <form class="stack" data-form="change"><textarea name="text" data-keep rows="2" placeholder="Describe what should change. The lead will post an impact check." aria-label="Change request"></textarea><button class="primary" type="submit">Send to the lead</button></form>
  </div>
  <div class="grid g2" style="margin-top:14px">
    <div class="card feed"><h3>Facts (your answers)</h3>${S.facts.map((f) => `<div class="item" id="x-${esc(f.id)}"><b>${esc(f.id)}</b> ${linkify(f.text)}</div>`).join('') || '<p class="empty">None yet.</p>'}</div>
    <div class="card feed"><h3>Team questions</h3>${others.map(qRow).join('') || '<p class="empty">None yet.</p>'}${answered.length ? `<h3 style="margin-top:12px">You answered</h3>${answered.map(qRow).join('')}` : ''}</div>
  </div>`;
}

function decisions() {
  const list = [...S.decisions].reverse();
  return `<div class="top"><h1 class="grow">Decisions</h1><span class="sub">Made by the team without you. Also saved in <a href="#/file/.madcompany/log/decisions.md">.madcompany/log/decisions.md</a></span></div>
  <div class="stack">${
    list
      .map(
        (d) => `<div class="card" id="x-${esc(d.id)}"><div class="row"><b>${esc(d.id)}</b> ${esc(d.title)}<span class="grow"></span><span class="sub">${esc(d.by)} · ${clock(d.ts)}</span></div>
      <dl class="kv" style="margin-top:8px"><dt>Decision</dt><dd>${linkify(d.decision)}</dd><dt>Why</dt><dd>${linkify(d.why)}</dd>${d.alternatives ? `<dt>Alternatives</dt><dd>${linkify(d.alternatives)}</dd>` : ''}${d.ticket ? `<dt>Ticket</dt><dd>${idLink(d.ticket)}</dd>` : ''}${d.links?.length ? `<dt>Links</dt><dd>${d.links.map(linkify).join(', ')}</dd>` : ''}</dl></div>`,
      )
      .join('') || '<div class="card"><p class="empty">No decisions yet.</p></div>'
  }</div>`;
}

function modelPicker(m) {
  if (m.lead) return `<div class="sub">Model: your Claude Code session's (change it with <code>/model</code>)</div>`;
  const choices = S.config.models.includes(m.model) ? S.config.models : [...S.config.models, m.model];
  const label = { opus: 'Opus (strongest)', sonnet: 'Sonnet (balanced)', haiku: 'Haiku (fastest, cheapest)', fable: 'Fable', inherit: "Same as your session" };
  return `<label class="row sub">Model <select data-model="${esc(m.id)}" aria-label="Model for ${esc(m.id)}">${choices
    .map((c) => `<option value="${esc(c)}" ${c === m.model ? 'selected' : ''}>${esc(label[c] ?? c)}</option>`)
    .join('')}</select></label>`;
}

function team(r) {
  const focus = r.parts[1];
  const cards = S.dashboard.team
    .map((m) => {
      const envInfo = S.envs[m.id];
      const h = m.handoff;
      return `<div class="card stack" id="x-${esc(m.id)}">
      <div class="row">${avatar(m.id)}<b>${esc(m.id)}</b>${m.lead ? pill('in_review', 'lead') : ''}<span class="grow"></span><span class="row"><span class="dot ${m.status}"></span>${esc(m.status)}</span></div>
      <div>${esc(m.role)}</div>
      <div class="sub">${[m.domain.length && `Domain: ${esc(m.domain.join(', '))}`, m.also.length && `also ${esc(m.also.join(', '))}`].filter(Boolean).join(' · ')}</div>
      ${modelPicker(m)}
      <div>${m.ticket ? `${m.status === 'blocked' ? 'Parked' : 'Working on'} ${idLink(m.ticket)}` : '<span class="sub">No current ticket</span>'} · <a href="#/board?agent=${esc(m.id)}">their tickets</a></div>
      ${envInfo ? `<div class="sub mono">ports web ${envInfo.ports.web}, api ${envInfo.ports.api}, expo ${envInfo.ports.expo} · db ${esc(envInfo.db)}</div>` : ''}
      ${h ? `<div class="callout"><b>Last handoff</b> ${clock(h.ts)}<br>Done: ${linkify(h.done)}<br>Next: ${linkify(h.next)}${h.waitingOn ? `<br>Waiting on: ${linkify(h.waitingOn)}` : ''}</div>` : ''}
      <div class="row"><a href="#/chat/${encodeURIComponent(`dm:${[m.id, 'you'].sort().join('+')}`)}">Message</a> · <button data-memory="${esc(m.id)}">Memory</button></div>
      <div class="memory" id="mem-${esc(m.id)}"></div>
    </div>`;
    })
    .join('');
  setTimeout(() => focus && document.querySelector(`[data-memory="${CSS.escape(focus)}"]`)?.click(), 0);
  return `<div class="top"><h1 class="grow">Team</h1><span class="sub">Up to ${S.config.max_parallel} agents work at once.</span></div><div class="grid g3">${cards}</div>`;
}

function preview() {
  const url = S.config.preview.url ?? `http://localhost:${S.integration.ports.web}`;
  const shots = Object.values(S.tickets).flatMap((t) => t.attachments.filter((a) => a.kind === 'screenshot').map((a) => ({ ...a, ticket: t.id }))).reverse();
  const fb = Object.values(S.tickets).filter((t) => t.kind === 'feedback').reverse();
  return `
  <div class="top"><h1 class="grow">Preview</h1>
    <div class="devices" role="group" aria-label="Screen size"><button data-size="390">Phone</button><button data-size="820">Tablet</button><button data-size="100%">Desktop</button></div>
    <a href="${esc(url)}" target="_blank" rel="noopener">Open in a tab ↗</a>
  </div>
  <div class="card"><iframe class="frame" id="frame" src="${esc(url)}" title="Running app"></iframe>
    <p class="sub">To comment on any element, the app loads <code>&lt;script src="${esc(location.origin)}/widget.js" defer&gt;&lt;/script&gt;</code> in development, then use its <b>Comment</b> button. Each comment becomes a ticket.</p>
  </div>
  <div class="grid g2" style="margin-top:14px">
    <div class="card"><h3>Screenshots</h3>${shots.length ? `<div class="shots">${shots.map((s) => `<a href="#/ticket/${esc(s.ticket)}" title="${esc(s.ticket)} ${esc(s.caption)}"><img src="/shots/${esc(s.path.split('/').pop())}" alt="${esc(s.caption || s.ticket)}" loading="lazy"></a>`).join('')}</div>` : '<p class="empty">None yet.</p>'}</div>
    <div class="card feed"><h3>Your feedback</h3>${fb.map((t) => `<div class="item">${idLink(t.id)} ${esc(t.title.replace(/^Feedback: /, ''))} ${pill(t.status, STATUS_LABEL[t.status])}</div>`).join('') || '<p class="empty">No comments yet.</p>'}</div>
  </div>`;
}

function fileView(r) {
  const rel = r.parts.slice(1).join('/');
  api(`/api/file?path=${encodeURIComponent(rel)}`)
    .then((f) => {
      const body =
        f.kind === 'markdown' ? `<div class="card doc">${f.html}</div>`
        : f.kind === 'text' ? `<div class="code">${f.html}</div>`
        : f.kind === 'image' ? `<img src="${esc(f.src)}" alt="${esc(rel)}" style="max-width:100%">`
        : f.kind === 'html' ? `<p class="sub">Mockup, shown sandboxed. <a href="${esc(f.src)}" target="_blank" rel="noopener">Open in a new tab ↗</a></p><iframe class="frame" sandbox="allow-scripts allow-forms" src="${esc(f.src)}" title="${esc(rel)}"></iframe>`
        : f.kind === 'pdf' ? `<iframe class="frame" src="${esc(f.src)}" title="${esc(rel)}"></iframe>`
        : '<p class="empty">This file is too big to show.</p>';
      $main.innerHTML = `<div class="crumbs">${esc(rel)}</div>${body}`;
      renderMermaid();
      const a = r.query.get('a');
      const l = r.query.get('l');
      const target = a ? document.getElementById(a) : l ? document.getElementById(`L${l}`) : null;
      if (target) {
        const block = target.closest('li, tr, p, h1, h2, h3, h4, h5, h6, .ln') ?? target;
        block.classList.add('target');
        block.scrollIntoView({ block: 'center' });
      }
    })
    .catch((e) => {
      $main.innerHTML = `<div class="crumbs">${esc(rel)}</div><p class="empty">${esc(e.message)}</p>`;
    });
  return new Promise(() => {});
}

// ---------- Library: everything about the project, by category ----------
const CAT_ICONS = { discovery: '💡', requirements: '📋', ux: '🎨', architecture: '🏗️', delivery: '🚚', meetings: '🗒️', conversations: '💬', links: '🔗', records: '📁', other: '📄' };

function libItem(it, catId) {
  if (catId === 'meetings') {
    return `<a class="lib-item" href="#/file/${esc(it.file)}?a=${esc(it.id.toLowerCase())}"><div class="row"><b>${esc(it.id)}</b> ${esc(it.title)}<span class="grow"></span><span class="time">${esc(it.date)}</span></div><div class="sub">${esc(it.summary)}</div><div class="sub">${esc((it.attendees ?? []).join(', '))}</div></a>`;
  }
  if (catId === 'conversations') {
    return `<a class="lib-item" href="#/session/${esc(it.id)}"><div class="row"><b>${esc(it.title)}</b><span class="grow"></span><span class="time">${clock(it.started)}</span></div><div class="sub">${it.yourMessages} messages from you${it.commands.length ? ` · ${it.commands.map((c) => `<code>${esc(c)}</code>`).join(' ')}` : ''}</div></a>`;
  }
  if (catId === 'links' || it.url) {
    const host = (() => { try { return new URL(it.url).host; } catch { return it.url; } })();
    const src = it.sources?.length ? `<div class="sub">${esc(it.sources[0].verb ?? 'Found in')} ${it.sources.map((x) => `<a href="${esc(x.href)}">${esc(x.label)}</a>`).join(', ')}</div>` : it.note ? `<div class="sub">${linkify(it.note)}</div>` : '';
    return `<div class="lib-item"><div class="row"><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer"><b>${esc(it.title ?? host)}</b></a>${it.saved ? pill('agreed', 'saved') : ''}<span class="grow"></span><span class="sub">${esc(host)}</span></div>${src}</div>`;
  }
  if (it.label === 'Screenshot') {
    return `<a class="lib-shot" href="#/ticket/${esc(it.ticket)}" title="${esc(it.ticket)} ${esc(it.title)}"><img src="/shots/${esc(it.path.split('/').pop())}" alt="${esc(it.title)}" loading="lazy"><span>${esc(it.ticket)}</span></a>`;
  }
  return `<a class="lib-item" href="#/file/${esc(it.path)}"><div class="row"><b>${esc(it.title)}</b>${it.status ? pill(it.status) : ''}<span class="grow"></span><span class="time">${ago(it.updated)}</span></div><div class="sub mono">${esc(it.path)}${it.owner ? ` · owner ${esc(it.owner)}` : ''}</div></a>`;
}

function libGroups(c) {
  if (!c.groups.length) return '<p class="empty">Nothing here yet.</p>';
  return c.groups
    .map((g) => {
      const shots = g.items[0]?.label === 'Screenshot';
      return `<div class="lib-group"><h3>${esc(g.label)} <span class="count">${g.items.length}</span></h3><div class="${shots ? 'lib-shots' : 'lib-list'}">${g.items.map((it) => libItem(it, c.id)).join('')}</div></div>`;
    })
    .join('');
}

function libraryView(r) {
  const current = r.parts[1] ?? '';
  api('/api/library')
    .then((lib) => {
      const rail = lib.categories
        .map((c) => `<a href="#/library/${c.id}" class="${c.id === current ? 'on' : ''} ${c.count ? '' : 'dim'}"><span>${CAT_ICONS[c.id] ?? '•'} ${esc(c.title)}</span><span class="count">${c.count}</span></a>`)
        .join('');
      const cat = lib.categories.find((c) => c.id === current);
      let body;
      if (cat) {
        const addLink = cat.id === 'links'
          ? `<form class="row lib-add" data-form="link"><input name="title" placeholder="Title (e.g. Checkout flow artifact)" aria-label="Link title"><input name="url" placeholder="https://claude.ai/…" aria-label="URL" style="flex:2"><button class="primary" type="submit">Save link</button></form>`
          : '';
        const minutesHint = cat.id === 'meetings' ? '<p class="sub">After any planning conversation in Claude Code, run <code>/mc-minutes</code> to add its minutes here.</p>' : '';
        body = `<div class="card"><h2>${CAT_ICONS[cat.id] ?? ''} ${esc(cat.title)}</h2><p class="sub">${esc(cat.description)}</p>${minutesHint}${addLink}${libGroups(cat)}</div>`;
      } else {
        body = `<div class="lib-tiles">${lib.categories
          .filter((c) => c.count || ['requirements', 'ux', 'meetings', 'links'].includes(c.id))
          .map((c) => {
            const top = c.groups.flatMap((g) => g.items).slice(0, 3);
            const names = top.map((it) => `<li>${esc(it.title ?? it.id ?? it.url ?? '')}</li>`).join('');
            return `<a class="card lib-tile" href="#/library/${c.id}"><div class="row"><span class="lib-icon">${CAT_ICONS[c.id] ?? ''}</span><h2 style="margin:0">${esc(c.title)}</h2><span class="grow"></span><span class="big" style="font-size:20px">${c.count}</span></div><p class="sub">${esc(c.description)}</p>${names ? `<ul>${names}</ul>` : '<p class="empty">Nothing yet.</p>'}</a>`;
          })
          .join('')}</div>`;
      }
      $main.innerHTML = `<div class="top"><h1 class="grow">Library</h1><form data-form="search" class="row"><input name="q" placeholder="Search everything…" aria-label="Search everything" style="width:280px"></form></div><div class="lib"><nav class="card lib-rail" aria-label="Library categories"><a href="#/library" class="${current ? '' : 'on'}"><span>🗂️ All</span></a>${rail}</nav><div>${body}</div></div>`;
      wireLibrary();
    })
    .catch((e) => ($main.innerHTML = `<p class="empty">${esc(e.message)}</p>`));
  return new Promise(() => {});
}

function wireLibrary() {
  $main.querySelector('form[data-form="search"]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const q = e.target.q.value.trim();
    if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
  });
  $main.querySelector('form[data-form="link"]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('/api/links', { title: f.title.value.trim(), url: f.url.value.trim() });
      render();
    } catch (err) {
      alert(err.message);
    }
  });
}

function sessionView(r) {
  const id = r.parts[1];
  api(`/api/session/${encodeURIComponent(id)}`)
    .then((sess) => {
      const msgs = sess.messages.slice(-1500);
      $main.innerHTML = `<div class="top"><div class="grow"><div class="sub"><a href="#/library/conversations">Conversations</a></div><h1>${esc(sess.title)}</h1><div class="sub">Started ${clock(sess.started)} · ${sess.yourMessages} messages from you · Claude Code session <code>${esc(sess.id.slice(0, 8))}</code></div></div></div>
      <div class="card">${sess.messages.length > msgs.length ? `<p class="sub">Showing the last ${msgs.length} messages.</p>` : ''}${msgs
        .map((m) => m.role === 'artifact'
          ? `<div class="msg"><span class="avatar" style="background:#1f6feb">A</span><div class="body"><div><b>Published a Claude artifact</b> <span class="time">${clock(m.ts)}</span></div><div class="text"><a href="${esc(m.url)}" target="_blank" rel="noopener noreferrer">${esc(m.text)} ↗</a></div></div></div>`
          : `<div class="msg ${m.role === 'you' ? 'you' : ''}">${m.role === 'you' ? avatar('you') : '<span class="avatar" style="background:#d97757">C</span>'}<div class="body"><div><b>${m.role === 'you' ? 'You' : 'Claude'}</b> <span class="time">${clock(m.ts)}</span></div><div class="text">${linkify(m.text.length > 4000 ? `${m.text.slice(0, 4000)}…` : m.text)}</div></div></div>`)
        .join('')}</div>`;
    })
    .catch((e) => ($main.innerHTML = `<p class="empty">${esc(e.message)}</p>`));
  return new Promise(() => {});
}

function searchView(r) {
  const q = r.query.get('q') ?? '';
  api(`/api/search?q=${encodeURIComponent(q)}`)
    .then(({ results }) => {
      const mark = (t) => esc(t).replace(new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[&<>"']/g, (c) => esc(c)), 'gi'), (m) => `<mark>${m}</mark>`);
      const groups = {};
      for (const x of results) (groups[x.type] ??= []).push(x);
      const order = ['Planning', 'Design', 'Meeting', 'Conversation', 'Decision', 'Question', 'Fact', 'Ticket', 'Link', 'Chat', 'Team log'];
      const html = Object.keys(groups)
        .sort((a, b) => order.indexOf(a) - order.indexOf(b))
        .map((t) => `<div class="lib-group"><h3>${esc(t)} <span class="count">${groups[t].length}</span></h3><div class="lib-list">${groups[t]
          .map((x) => `<a class="lib-item" href="${esc(x.href)}"${x.external ? ' target="_blank" rel="noopener noreferrer"' : ''}><b>${esc(x.title)}</b>${x.path ? ` <span class="sub mono">${esc(x.path)}</span>` : ''}<div class="sub">${mark(x.snippet)}</div></a>`)
          .join('')}</div></div>`)
        .join('');
      $main.innerHTML = `<div class="top"><h1 class="grow">Search</h1><form data-form="search" class="row"><input name="q" value="${esc(q)}" aria-label="Search everything" style="width:280px"></form></div><div class="card"><p class="sub">${results.length} result${results.length === 1 ? '' : 's'} for “${esc(q)}” across planning files, design docs, meetings, conversations, decisions, tickets, links and chat.</p>${html || '<p class="empty">Nothing found.</p>'}</div>`;
      wireLibrary();
    })
    .catch((e) => ($main.innerHTML = `<p class="empty">${esc(e.message)}</p>`));
  return new Promise(() => {});
}

// Mermaid diagrams (module sketches, flows) render when a doc has them. Pinned + integrity-checked.
let mermaidLoading = null;
function renderMermaid() {
  const blocks = [...document.querySelectorAll('.doc pre code.language-mermaid')];
  if (!blocks.length) return;
  mermaidLoading ??= new Promise((resolve, reject) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js';
    sc.integrity = 'sha384-rbtjAdnIQE/aQJGEgXrVUlMibdfTSa4PQju4HDhN3sR2PmaKFzhEafuePsl9H/9I';
    sc.crossOrigin = 'anonymous';
    sc.onload = () => {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default' });
      resolve(window.mermaid);
    };
    sc.onerror = reject;
    document.head.appendChild(sc);
  });
  mermaidLoading
    .then((m) => {
      const nodes = blocks.map((code) => {
        const div = document.createElement('div');
        div.className = 'mermaid';
        div.textContent = code.textContent;
        code.parentElement.replaceWith(div);
        return div;
      });
      return m.run({ nodes });
    })
    .catch(() => {}); // offline: the diagram source stays visible as code
}

// ---------- interactions ----------
function wire(r) {
  const msgs = document.getElementById('msgs');
  if (msgs) msgs.scrollTop = msgs.scrollHeight;

  $main.querySelectorAll('[data-act="end"]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (confirm('End the day? Agents finish their current step, hand off and stop.')) await act(() => api('/api/workday', { action: 'end' }));
    }),
  );
  $main.querySelectorAll('[data-act="stop"]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (confirm('Stop now? Every agent is blocked at its next action. Resume tomorrow with /mc-start.')) await act(() => api('/api/workday', { action: 'stop' }));
    }),
  );
  $main.querySelector('[data-act="dm"]')?.addEventListener('click', () => {
    const to = document.getElementById('dm-to').value;
    location.hash = `#/chat/${encodeURIComponent(`dm:${[to, 'you'].sort().join('+')}`)}`;
  });
  $main.querySelectorAll('form[data-form="post"]').forEach((f) => {
    const ta = f.querySelector('textarea');
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        f.requestSubmit();
      }
    });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      await act(() => api('/api/messages', { channel: f.dataset.channel, text }));
    });
  });
  $main.querySelectorAll('[data-answer]').forEach((b) => b.addEventListener('click', () => act(() => api('/api/answer', { q: b.dataset.answer, answer: b.dataset.value }))));
  $main.querySelectorAll('form[data-form="answer"]').forEach((f) =>
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const answer = f.answer.value.trim();
      if (answer) act(() => api('/api/answer', { q: f.dataset.q, answer }));
    }),
  );
  $main.querySelector('form[data-form="change"]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const ta = e.target.querySelector('textarea');
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    act(() => api('/api/change', { text }));
  });
  $main.querySelectorAll('[data-filter]').forEach((sel) =>
    sel.addEventListener('change', () => {
      const q = new URLSearchParams(route().query);
      if (sel.value) q.set(sel.dataset.filter, sel.value);
      else q.delete(sel.dataset.filter);
      location.hash = `#/board${q.toString() ? `?${q}` : ''}`;
    }),
  );
  $main.querySelectorAll('[data-memory]').forEach((b) =>
    b.addEventListener('click', async () => {
      const box = document.getElementById(`mem-${b.dataset.memory}`);
      if (box.innerHTML) return (box.innerHTML = '');
      const m = await api(`/api/memory/${encodeURIComponent(b.dataset.memory)}`);
      box.innerHTML = ['identity', 'work', 'comms'].map((k) => `<h3>${k}</h3><pre>${esc(m[k] || '(empty)')}</pre>`).join('');
    }),
  );
  $main.querySelectorAll('select[data-model]').forEach((sel) =>
    sel.addEventListener('change', () => act(() => api('/api/team/model', { id: sel.dataset.model, model: sel.value }))),
  );
  $main.querySelectorAll('[data-size]').forEach((b) =>
    b.addEventListener('click', () => {
      const f = document.getElementById('frame');
      f.style.width = b.dataset.size === '100%' ? '100%' : `${b.dataset.size}px`;
    }),
  );
}

async function act(fn) {
  try {
    await fn();
    await refresh();
  } catch (e) {
    alert(e.message);
  }
}

document.getElementById('side-search')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (q) location.hash = `#/search?q=${encodeURIComponent(q)}`;
});
window.addEventListener('hashchange', render);
refresh()
  .then(live)
  .catch((e) => {
    $main.innerHTML = `<p class="empty">Could not reach HQ: ${esc(e.message)}</p>`;
  });
