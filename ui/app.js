/* madcompany HQ — a small no-build web app. State comes from /api/state and refreshes live over /api/stream. */
'use strict';

let S = null; // latest /api/state
let IDS = {}; // reference registry
const $main = document.getElementById('main');

// ---------- utilities ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const COLORS = ['#1f6feb', '#8250df', '#1a7f37', '#bf3989', '#9a6700', '#0a7ea4', '#cf222e', '#6e7781'];
const colorFor = (id) => COLORS[Math.abs([...String(id)].reduce((h, c) => (h * 33) ^ c.charCodeAt(0), 5381)) % COLORS.length];
let ME = { id: 'you', name: 'You', role: 'owner' };
const LEVEL = { viewer: 1, member: 2, owner: 3 };
const can = (need) => (LEVEL[ME.role] ?? 0) >= LEVEL[need];
const personOf = (id) => (S?.people ?? []).find((p) => p.id === id);
const isHumanId = (id) => id === 'you' || Boolean(personOf(id));
const nameOf = (id) => (id === ME.id ? 'You' : id === 'you' ? S?.config.owner ?? 'Owner' : personOf(id)?.name ?? id);
const avatar = (id) =>
  isHumanId(id)
    ? `<span class="avatar you" title="${esc(nameOf(id))}">${esc((nameOf(id) === 'You' ? ME.name : nameOf(id))[0]?.toUpperCase() ?? 'Y')}</span>`
    : `<span class="avatar" style="background:${colorFor(id)}">${esc(String(id)[0]?.toUpperCase())}</span>`;
const dmWith = (id) => `dm:${[id, ME.id].sort().join('+')}`;
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
const byRelease = () => S.config.mode.unit === 'release';
const blockerLink = (x) => (S.tickets[x] ? idLink(x) : /^HELP-/.test(x) ? `<a href="#/help/${esc(x)}">${esc(x)}</a>` : `<a href="#/questions/${esc(x)}">${esc(x)}</a>`);
const unitWord = (plural) => (byRelease() ? (plural ? 'Releases' : 'release') : plural ? 'Epics' : 'epic');
const UNIT_LABEL = { planned: 'Planned', building: 'Building', review: 'Waiting for your review', approved: 'Approved', shipped: 'Shipped' };
const unitPill = (st) => pill({ planned: 'todo', building: 'in_progress', review: 'in_review', approved: 'done', shipped: 'done' }[st] ?? 'todo', UNIT_LABEL[st] ?? st);
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
  const setBadge = (id, count) => {
    const b = document.getElementById(id);
    b.hidden = count === 0;
    b.textContent = count;
  };
  setBadge('inbox-badge', n);
  setBadge('help-badge', S.dashboard.help.open);
  setBadge('review-badge', S.dashboard.inReview.length);
  document.getElementById('units-label').textContent = unitWord(true);
  const all = n + S.dashboard.help.open + S.dashboard.inReview.length;
  document.title = `${all ? `(${all}) ` : ''}${S.config.project.name} · madcompany HQ`;
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
  const viewName = r.name === 'questions' || r.name === 'facts' ? 'inbox' : r.name === 'epics' ? 'releases' : r.name;
  const name = ['session', 'search', 'file'].includes(r.name) ? 'library' : viewName; // sidebar highlight
  document.querySelectorAll('.side a').forEach((a) => a.classList.toggle('on', a.dataset.nav === name));
  const views = { dashboard, chat, board, ticket: ticketView, inbox, decisions, team, preview, file: fileView, library: libraryView, session: sessionView, search: searchView, help: helpPage, releases: releasesPage, tools: toolsPage };
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
  const bar = (done, total) => {
    const pct = total ? Math.round((100 * done) / total) : 0;
    return `<div class="bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><span style="width:${pct}%"></span></div>`;
  };
  const list = d.units.length ? d.units : d.epics.map((e) => ({ ...e, status: null }));
  const epics = list.length
    ? list
        .map((e) => `<a class="stack" href="#/releases/${esc(e.id)}" style="color:inherit;text-decoration:none"><div class="row"><b>${esc(e.id === e.title ? e.title : `${e.id} ${e.title}`)}</b>${e.status ? unitPill(e.status) : ''}<span class="grow"></span><span class="sub">${e.done}/${e.total}</span></div>${bar(e.done, e.total)}</a>`)
        .join('')
    : `<p class="empty">No ${unitWord(true).toLowerCase()} yet. In Claude Code: <code>${byRelease() ? '/mc-plan-release' : '/mc-plan-epic'}</code></p>`;
  const waiting = d.needsYou.length + d.help.open + d.inReview.length;
  const needsLines = [
    d.inReview.length && `<a href="#/releases/${esc(d.inReview[0].id)}">${d.inReview.map((u) => esc(u.id)).join(', ')} ready for your review</a>`,
    d.needsYou.length && `<a href="#/inbox">${d.needsYou.length} question${d.needsYou.length > 1 ? 's' : ''}</a>: ${esc(d.needsYou[0].question)}`,
    d.help.open && `<a href="#/help">${d.help.open} in Human help</a>${d.help.blocking ? `, ${d.help.blocking} blocking work` : ''}`,
  ].filter(Boolean);
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
    ? d.blocked.map((b) => `<div>${idLink(b.id)} ← ${b.blockedBy.map(blockerLink).join(', ')} <span class="sub">${esc(b.assignee ?? '')}</span></div>`).join('')
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
    ${wd === 'on' && can('owner') ? '<button data-act="end">End day</button>' : ''}
    ${(wd === 'on' || wd === 'ending') && can('owner') ? '<button class="danger" data-act="stop">Stop now</button>' : ''}
    ${wd === 'off' || wd === 'stopped' ? '<span class="sub">Start the day with <code>/mc-start</code> in Claude Code.</span>' : ''}
  </div>
  <div class="grid g3">
    <div class="card ${waiting ? 'needs' : ''}"><h3>Needs you</h3><div class="big">${waiting}</div><div class="sub stack">${needsLines.map((l) => `<div>${l}</div>`).join('') || 'Nothing waiting on you.'}</div></div>
    <div class="card stack"><h3>${unitWord(true)} <span class="sub" style="text-transform:none;font-weight:400">· ${esc(d.mode.title)}</span></h3>${epics}</div>
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
  if (c.startsWith('dm:')) return c.slice(3).split('+').map(nameOf).join(' ↔ ');
  if (c.startsWith('ticket:')) return c.slice(7);
  return `# ${c}`;
}
function messageHtml(m) {
  return `<div class="msg ${m.by === ME.id ? 'you' : ''}" id="x-${esc(m.id)}">${avatar(m.by)}<div class="body"><div><b>${esc(nameOf(m.by))}</b> <span class="time">${clock(m.ts)}</span></div><div class="text">${linkify(m.text)}</div></div></div>`;
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
      ${can('member') ? '' : '<p class="sub">You have read-only access.</p>'}
      <form class="composer" data-form="post" data-channel="${esc(current)}" ${can('member') ? '' : 'hidden'}>
        <textarea name="text" data-keep rows="2" placeholder="Message ${esc(channelLabel(current))} — @mention someone, reference FR12, APP-4…" aria-label="Message"></textarea>
        <button class="primary" type="submit">Send</button>
      </form>
    </div>
  </div>`;
}

function board(r) {
  const agent = r.query.get('agent') ?? '';
  const epic = r.query.get('epic') ?? '';
  const rel = r.query.get('release') ?? '';
  const all = Object.values(S.tickets).filter((t) => (!agent || t.assignee === agent) && (!epic || t.epic === epic) && (!rel || t.release === rel));
  const cols = ['todo', 'in_progress', 'blocked', 'in_review', 'done']
    .map((st) => {
      const items = all.filter((t) => t.status === st).sort((a, b) => Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]));
      return `<div class="col"><h3>${STATUS_LABEL[st]} <span>${items.length}</span></h3>${items.map(cardHtml).join('')}</div>`;
    })
    .join('');
  const opt = (v, cur, label) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label ?? v)}</option>`;
  const agents = S.dashboard.team.map((m) => opt(m.id, agent)).join('');
  const epics = Object.keys(S.epics).map((e) => opt(e, epic, `${e} ${S.epics[e].title ?? ''}`)).join('');
  const rels = S.units.filter((u) => /^R\d+$/.test(u.id)).map((u) => opt(u.id, rel, `${u.id} ${u.title}`)).join('');
  return `
  <div class="top"><h1 class="grow">Board</h1>
    <select data-filter="agent" aria-label="Filter by agent"><option value="">Everyone</option>${agents}</select>
    ${rels ? `<select data-filter="release" aria-label="Filter by release"><option value="">All releases</option>${rels}</select>` : ''}
    ${epics ? `<select data-filter="epic" aria-label="Filter by epic"><option value="">All epics</option>${epics}</select>` : ''}
  </div>
  <div class="columns">${cols}</div>`;
}
function cardHtml(t) {
  const tags = [
    t.release && `<span class="tag">${esc(t.release)}</span>`,
    !t.release && t.epic && `<span class="tag">${esc(t.epic)}</span>`,
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
        ${t.release ? `<dt>Release</dt><dd><a href="#/releases/${esc(t.release)}">${esc(t.release)}</a> ${esc(S.units.find((u) => u.id === t.release)?.title ?? '')}</dd>` : ''}
        ${t.epic || !t.release ? `<dt>Epic</dt><dd>${esc(t.epic ?? '–')}</dd>` : ''}
        <dt>Kind</dt><dd>${esc(t.kind)}${t.ui ? ' · UI' : ''}${t.domain ? ` · ${esc(t.domain)}` : ''}</dd>
        <dt>Depends on</dt><dd>${t.deps.map(idLink).join(', ') || '–'}</dd>
        ${t.blockedBy.length ? `<dt>Blocked by</dt><dd>${t.blockedBy.map((x) => linkify(x)).join(', ')}</dd>` : ''}
        ${S.help.some((h) => h.tickets.includes(t.id)) ? `<dt>Human help</dt><dd>${S.help.filter((h) => h.tickets.includes(t.id)).map((h) => `<a href="#/help/${esc(h.id)}">${esc(h.id)}</a> ${pill(h.status === 'open' ? 'blocked' : 'done', h.status)}`).join(' ')}</dd>` : ''}
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
    <form class="composer" data-form="post" data-channel="ticket:${esc(t.id)}" ${can('member') ? '' : 'hidden'}><textarea name="text" data-keep rows="2" placeholder="Comment on ${esc(t.id)} — @mention the assignee" aria-label="Comment"></textarea><button class="primary" type="submit">Send</button></form>
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
        <div class="opts" ${can('member') ? '' : 'hidden'}>${q.options.map((o) => `<button class="${o === q.recommended ? 'rec' : ''}" data-answer="${esc(q.id)}" data-value="${esc(o)}">${esc(o)}${o === q.recommended ? ' · Recommended' : ''}</button>`).join('')}</div>
        <form class="row" data-form="answer" data-q="${esc(q.id)}" ${can('member') ? '' : 'hidden'}><input name="answer" placeholder="Or type your own answer" style="flex:1" aria-label="Your answer"><button type="submit">Answer</button></form>
      </div>`,
        )
        .join('')
    : '<div class="card"><p class="empty">Nothing needs you right now.</p></div>';
  const qRow = (q) => `<div class="qitem" id="x-${esc(q.id)}"><b>${esc(q.id)}</b> <span class="sub">${esc(q.from)} → ${esc(q.to)}</span> ${linkify(q.question)} ${q.answer ? `<br><span class="sub">Answer (${esc(q.answeredBy)}):</span> ${linkify(q.answer)}` : pill('draft', 'open')}</div>`;
  return `
  <div class="top"><h1 class="grow">Inbox</h1></div>
  <div class="stack">${openHtml}</div>
  <div class="card" style="margin-top:14px"><h3>Request a change</h3>
    <form class="stack" data-form="change" ${can('member') ? '' : 'hidden'}><textarea name="text" data-keep rows="2" placeholder="Describe what should change. The lead will post an impact check." aria-label="Change request"></textarea><button class="primary" type="submit">Send to the lead</button></form>
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
  if (!can('owner')) return `<div class="sub">Model: ${esc(m.model)}</div>`;
  const choices = S.config.models.includes(m.model) ? S.config.models : [...S.config.models, m.model];
  const label = { opus: 'Opus (strongest)', sonnet: 'Sonnet (balanced)', haiku: 'Haiku (fastest, cheapest)', fable: 'Fable', inherit: "Same as your session" };
  return `<label class="row sub">Model <select data-model="${esc(m.id)}" aria-label="Model for ${esc(m.id)}">${choices
    .map((c) => `<option value="${esc(c)}" ${c === m.model ? 'selected' : ''}>${esc(label[c] ?? c)}</option>`)
    .join('')}</select></label>`;
}

let ROLES = null;
function team(r) {
  const focus = r.parts[1];
  const card = (m) => {
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
      <div class="row"><a href="#/chat/${encodeURIComponent(dmWith(m.id))}">Message</a> · <button data-memory="${esc(m.id)}">Memory</button>${can('owner') && !m.lead ? `<span class="grow"></span><button class="danger" data-remove="${esc(m.id)}">Remove</button>` : ''}</div>
      <div class="memory" id="mem-${esc(m.id)}"></div>
    </div>`;
  };
  const order = ['Leadership', 'Product', 'Design', 'Engineering', 'Quality', 'Operations', 'Docs', 'Other'];
  const byDept = {};
  for (const m of S.dashboard.team) (byDept[m.dept ?? 'Other'] ??= []).push(m);
  const depts = order
    .filter((d) => byDept[d])
    // small departments sit side by side; big ones take a full row
    .map((d) => {
      const n = Math.min(byDept[d].length, 3);
      return `<div class="dept" style="--n:${n}"><h3>${esc(d)} <span class="count">${byDept[d].length}</span></h3><div class="grid">${byDept[d].map(card).join('')}</div></div>`;
    })
    .join('');
  const hire = can('owner')
    ? `<form class="card row" data-form="hire" style="flex-wrap:wrap"><b>Hire</b><select name="type" aria-label="Role">${ROLES ? Object.entries(ROLES.roles).filter(([k]) => k !== 'tech-lead').map(([k, v]) => `<option value="${esc(k)}">${esc(v.title)} · ${esc(v.dept)}</option>`).join('') : '<option>Loading…</option>'}</select><input name="id" placeholder="id (optional, e.g. backend-4)" aria-label="Team id"><select name="model" aria-label="Model"><option value="">Role's default model</option>${S.config.models.map((x) => `<option>${esc(x)}</option>`).join('')}</select><button class="primary" type="submit">Hire</button><span class="sub">Restart Claude Code after hiring so the new agent loads.</span></form>`
    : '';
  const people = S.people ?? [];
  const peopleHtml = `<div class="card stack"><h3>People <span class="count">${people.length}</span></h3>
    ${people.map((p) => `<div class="row">${avatar(p.id)}<b>${esc(p.id === ME.id ? `${p.name} (you)` : p.name)}</b>${pill(p.role === 'owner' ? 'in_review' : p.role === 'member' ? 'in_progress' : 'todo', p.role)}<span class="grow"></span>${can('owner') && S.config.share ? `<button data-link="${esc(p.id)}">New sign-in link</button>` : ''}${can('owner') && p.id !== 'you' ? `<button class="danger" data-unperson="${esc(p.id)}">Remove</button>` : ''}</div>`).join('')}
    ${can('owner') ? `<form class="row" data-form="invite" style="flex-wrap:wrap"><input name="id" placeholder="id, e.g. priya" aria-label="Person id"><input name="name" placeholder="Name" aria-label="Name"><select name="role" aria-label="Access"><option value="member">Member: chat, answer, request changes</option><option value="viewer">Viewer: read only</option><option value="owner">Owner: everything</option></select><button type="submit">Invite</button></form>
    <p class="sub">${S.config.share ? 'People sign in with their link. Send it privately.' : 'Teammates can reach HQ once you run <code>npx madcompany hq --share</code>.'}</p>
    <div id="invite-link"></div>` : ''}</div>`;
  setTimeout(() => focus && document.querySelector(`[data-memory="${CSS.escape(focus)}"]`)?.click(), 0);
  if (!ROLES) api('/api/roles').then((x) => { ROLES = x; if (route().name === 'team') render(); });
  return `<div class="top"><h1 class="grow">Team</h1><span class="sub">${S.dashboard.team.length} agents · up to ${S.config.max_parallel} work at once</span></div>${hire}<div class="depts">${depts}</div><div style="margin-top:14px">${peopleHtml}</div>`;
}

// ---------- Human help: what only a person can do ----------
const POLICY = [
  'Create accounts and sign up for services',
  'Get API keys and put secrets in .env (agents can never read or write it)',
  'Pay for anything: plans, domains, app store fees',
  'Push to GitHub (unless you set allow_push: true)',
  'Deploy, change cloud resources, publish packages or apps',
  'Install things globally, or delete anything outside the project',
];
function helpPage(r) {
  const kind = r.query.get('kind') ?? '';
  const items = S.help;
  const open = items.filter((h) => h.status === 'open');
  const counts = {};
  for (const h of open) counts[h.kind] = (counts[h.kind] ?? 0) + 1;
  const chips = [`<a href="#/help" class="${kind ? '' : 'on'}">All open <b>${open.length}</b></a>`, ...Object.entries(S.helpKinds).filter(([k]) => counts[k]).map(([k, label]) => `<a href="#/help?kind=${k}" class="${kind === k ? 'on' : ''}">${esc(label)} <b>${counts[k]}</b></a>`)].join('');
  // what blocks work first, then what the nearest release needs, then oldest first
  const need = (h) => Number(String(h.neededBy ?? '').replace(/\D/g, '')) || 1e6;
  const shown = open
    .filter((h) => !kind || h.kind === kind)
    .sort((a, b) => b.waiting.length - a.waiting.length || need(a) - need(b) || Number(a.id.split('-')[1]) - Number(b.id.split('-')[1]));
  const keys = (h) =>
    h.env.length
      ? `<div class="stack"><div class="sub">Add to <code>${esc(S.config.env_files[0])}</code>${S.config.env_files.length > 1 ? ` (or ${S.config.env_files.slice(1).map((f) => `<code>${esc(f)}</code>`).join(', ')})` : ''}:</div><div class="keys">${h.env.map((k) => `<span class="key ${h.envSet[k] ? 'set' : 'missing'}" title="${h.envSet[k] ? 'Found' : 'Not added yet'}">${h.envSet[k] ? '✓' : '○'} ${esc(k)}</span>`).join('')}</div></div>`
      : '';
  const card = (h) => `<div class="card stack help-card ${h.waiting.length ? 'blocking' : ''}" id="x-${esc(h.id)}">
      <div class="row" style="flex-wrap:wrap"><b>${esc(h.id)}</b><b>${esc(h.title)}</b>${pill(h.waiting.length ? 'blocked' : 'draft', h.kindLabel)}${h.service ? `<span class="tag">${esc(h.service)}</span>` : ''}<span class="grow"></span>${h.neededBy ? `<span class="sub">needed by <a href="#/releases/${esc(h.neededBy)}">${esc(h.neededBy)}</a></span>` : ''}</div>
      <div class="sub">${avatar(h.by)} asked by ${esc(nameOf(h.by))} · ${clock(h.ts)}${h.why ? ` · ${linkify(h.why)}` : ''}</div>
      ${h.waiting.length ? `<div class="callout">⛔ Work is waiting on this: ${h.waiting.map(idLink).join(', ')}. It resumes when you mark it done.</div>` : h.tickets.length ? `<div class="sub">For ${h.tickets.map(idLink).join(', ')}</div>` : ''}
      ${h.steps.length ? `<ol>${h.steps.map((x) => `<li>${linkify(x)}</li>`).join('')}</ol>` : ''}
      ${keys(h)}
      ${h.links.length ? `<div class="sub">Links: ${h.links.map(linkify).join(' · ')}</div>` : ''}
      <form class="row" data-form="help-done" data-id="${esc(h.id)}" ${can('member') ? '' : 'hidden'} style="flex-wrap:wrap"><input name="note" placeholder="Note for the team (optional), e.g. test keys added" aria-label="Note" style="flex:1;min-width:220px"><button class="primary" type="submit">Mark done</button>${can('owner') ? `<button type="button" data-help-cancel="${esc(h.id)}">Not needed</button>` : ''}</form>
    </div>`;
  const done = items.filter((h) => h.status !== 'open');
  const kinds = Object.entries(S.helpKinds).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  return `<div class="top"><div class="grow"><h1>Human help</h1><div class="sub">Things only a person can do. Agents file them and keep working on mocks; anything parked on one resumes the moment you mark it done.</div></div></div>
  <div class="help-kinds">${chips}</div>
  <div class="stack">${shown.map(card).join('') || `<div class="card"><p class="empty">${open.length ? 'Nothing of this kind.' : 'Nothing needs you here right now.'}</p></div>`}</div>
  <div class="grid g2" style="margin-top:14px">
    <div class="card"><h3>Always yours</h3><p class="sub">Agents are blocked from these by the safety hook, so they come here instead.</p><ul class="policy">${POLICY.map((p) => `<li>${esc(p)}</li>`).join('')}</ul><p class="sub">Also in <a href="#/file/.madcompany/human-help.md">.madcompany/human-help.md</a>. HQ checks that keys exist in ${S.config.env_files.map((f) => `<code>${esc(f)}</code>`).join(', ')}, never what they are.</p></div>
    <div class="card stack"><h3>Add something only you can do</h3>
      <form class="stack" data-form="help-add" ${can('member') ? '' : 'hidden'}>
        <input name="title" placeholder="e.g. Renew the domain" aria-label="What needs doing">
        <div class="row"><select name="kind" aria-label="Kind">${kinds}</select><input name="env" placeholder="Keys, e.g. SENDGRID_API_KEY" aria-label="Environment variable names" style="flex:1"></div>
        <textarea name="steps" rows="3" placeholder="Steps, one per line (optional)" aria-label="Steps"></textarea>
        <button class="primary" type="submit">Add</button>
      </form>
    </div>
  </div>
  ${done.length ? `<details class="card" style="margin-top:14px"><summary><b>Done</b> <span class="count">${done.length}</span></summary><div class="feed" style="margin-top:8px">${done.map((h) => `<div class="item" id="x-${esc(h.id)}"><b>${esc(h.id)}</b> ${esc(h.title)} ${pill(h.status === 'done' ? 'done' : 'todo', h.status)} <span class="sub">${esc(nameOf(h.doneBy ?? ''))} · ${clock(h.doneAt)}${h.note ? ` · ${linkify(h.note)}` : ''}</span></div>`).join('')}</div></details>` : ''}`;
}

// ---------- Releases (or epics in spec mode): delivered, reviewed by you, shipped ----------
function releasesPage(r) {
  const m = S.config.mode;
  const units = S.units;
  const isRel = (u) => /^R\d+$/.test(u.id);
  const tickets = (u) => Object.values(S.tickets).filter((t) => (isRel(u) ? t.release === u.id : t.epic === u.id));
  const card = (u) => {
    const ts = tickets(u);
    const pct = u.total ? Math.round((100 * u.done) / u.total) : 0;
    const last = u.reviews.at(-1);
    const review =
      u.status === 'review'
        ? `<div class="callout review-box stack"><b>Your review.</b> Click through it in <a href="#/preview">Preview</a>, then approve it or say what should change.
            <div class="row" style="flex-wrap:wrap">${can('owner') ? `<button class="primary" data-approve="${esc(u.id)}">Approve ${esc(u.id)}</button>` : ''}</div>
            <form class="stack" data-form="changes" data-id="${esc(u.id)}" ${can('member') ? '' : 'hidden'}><textarea name="notes" data-keep rows="2" placeholder="What should change? It goes back to the team as a ticket in ${esc(u.id)}." aria-label="Changes"></textarea><button type="submit">Request changes</button></form></div>`
        : u.status === 'approved'
          ? `<div class="callout">Approved${last ? ` by ${esc(nameOf(last.by))}` : ''}. The lead ships it with <code>npx madcompany ship ${esc(u.id)}</code>: merge into <code>${esc(S.config.main_branch)}</code> and tag${u.version ? ` <code>${esc(u.version)}</code>` : ''}. Pushing and deploying come to you in <a href="#/help">Human help</a>.</div>`
          : u.status === 'shipped'
            ? `<div class="callout">Shipped to <code>${esc(S.config.main_branch)}</code>${u.version ? ` as <code>${esc(u.version)}</code>` : ''}.</div>`
            : '';
    return `<div class="card stack unit ${esc(u.status)}" id="x-${esc(u.id)}">
      <div class="row" style="flex-wrap:wrap"><h2 style="margin:0">${esc(u.id)} · ${esc(u.title)}</h2>${unitPill(u.status)}${u.version ? `<span class="tag">${esc(u.version)}</span>` : ''}<span class="grow"></span><span class="sub">${u.done}/${u.total} tickets</span></div>
      ${u.goal ? `<div><b>Goal:</b> ${linkify(u.goal)}</div>` : ''}
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="meta" style="display:flex;flex-wrap:wrap;gap:6px">${ts.map((t) => `<a class="tag" href="#/ticket/${esc(t.id)}" title="${esc(t.title)}">${esc(t.id)} · ${esc(STATUS_LABEL[t.status])}</a>`).join('') || '<span class="sub">No tickets yet.</span>'}</div>
      <div class="sub mono">branch ${esc(u.branch)}${u.notes ? ` · <a href="#/file/${esc(u.notes)}">release notes</a>` : ''} · <a href="#/board?${isRel(u) ? 'release' : 'epic'}=${esc(u.id)}">board</a></div>
      ${review}
      ${u.reviews.length ? `<div class="sub">${u.reviews.map((v) => `${clock(v.ts)} ${esc(nameOf(v.by))}: ${v.verdict === 'approve' ? 'approved' : `asked for changes — ${linkify(v.notes)}`}`).join('<br>')}</div>` : ''}
    </div>`;
  };
  const ladder = m.unit === 'release' ? `<div class="ladder">${S.config.modes[m.name].ladder.map(([t, what], i, all) => `<div><b>R${i + 1}${i === all.length - 1 ? '+' : ''} · ${esc(t)}</b><div class="sub">${esc(what)}</div></div>`).join('')}</div>` : '';
  return `<div class="top"><div class="grow"><h1>${unitWord(true)}</h1><div class="sub">${esc(m.title)}: ${esc(S.config.modes[m.name].for)}</div></div></div>
  <div class="card"><h3>How ${unitWord(true).toLowerCase()} work here</h3><div class="sub">${esc(m.guidance)}</div>${ladder}<div class="sub" style="margin-top:8px">Switch with <code>npx madcompany mode &lt;${Object.keys(S.config.modes).join('|')}&gt;</code>.</div></div>
  <div class="stack" style="margin-top:14px">${[...units].reverse().map(card).join('') || `<div class="card"><p class="empty">No ${unitWord(true).toLowerCase()} yet. In Claude Code, run <code>${byRelease() ? '/mc-plan-release' : '/mc-plan-epic'}</code>.</p></div>`}</div>`;
}

// ---------- Tools: MCP servers, plugins and skills ----------
const SCOPE = { project: 'Project (.mcp.json)', user: 'Yours (all projects)', local: 'Yours (this project)', plugin: 'From a plugin' };
function toolsPage() {
  api('/api/tools')
    .then((t) => {
      const serverRow = (s) => `<div class="card stack" id="x-${esc(s.name)}">
          <div class="row" style="flex-wrap:wrap"><b>${esc(s.name)}</b>${s.known ? `<span class="tag">${esc(s.known.title)}</span>` : ''}<span class="sub">${esc(SCOPE[s.scope] ?? s.scope)}${s.plugin ? ` · ${esc(s.plugin)}` : ''} · ${esc(s.type)} · <span class="mono">${esc(s.target)}</span></span><span class="grow"></span>${s.approved === null ? pill('draft', 'waiting for your OK in Claude Code') : s.approved === false ? pill('stopped', 'turned off') : ''}</div>
          ${s.known ? `<div>${esc(s.known.for)}</div>` : ''}
          <div class="sub">${esc(s.policy)}</div>
          <div class="sub">Used by: ${s.users.length ? s.users.map((u) => `<a href="#/team/${esc(u)}">${esc(u)}</a>`).join(', ') : 'nobody yet (assign it under tools.assign in team.yaml)'}${s.calls ? ` · ${s.calls} call${s.calls > 1 ? 's' : ''}` : ''}${s.blocked ? ` · <a href="#/help">${s.blocked} blocked</a>` : ''}</div>
          ${s.type !== 'stdio' ? '<div class="sub">If it needs a login, run <code>/mcp</code> in Claude Code once; agents can’t log in for you.</div>' : ''}
        </div>`;
      const plugin = (p) => `<div class="card stack"><div class="row"><b>${esc(p.name)}</b><span class="sub">${esc(p.marketplace)} · enabled for ${esc(p.scope === 'user' ? 'you' : p.scope)}</span></div>
          ${p.description ? `<div class="sub">${esc(p.description)}</div>` : ''}
          ${p.found ? `<div class="sub">${[p.skills.length && `Skills: ${p.skills.map((x) => `<code>/${esc(x)}</code>`).join(' ')}`, p.agents.length && `Agents: ${p.agents.map((a) => esc(a.name)).join(', ')}`, p.servers.length && `MCP servers: ${p.servers.map(esc).join(', ')}`, p.hooks && 'Hooks'].filter(Boolean).join(' · ') || 'Nothing the team uses directly.'}</div>` : '<div class="sub">Installed files not found; Claude Code still loads it.</div>'}</div>`;
      const sugg = (x) => `<div class="card stack"><div class="row"><b>${esc(x.title)}</b><span class="grow"></span>${can('member') ? `<button data-suggest="${esc(x.key)}">Add to Human help</button>` : ''}</div><div>${esc(x.for)}</div><div class="sub">${esc(x.why)}</div><div class="mono sub">${esc(x.add)}</div></div>`;
      const recent = t.usage.recent.length
        ? t.usage.recent.map((c) => `<div class="item"><span class="time" style="width:110px;flex:none">${clock(c.ts)}</span><span>${c.agent ? `<b>${esc(c.agent)}</b> ` : ''}<span class="mono">${esc(c.tool)}</span> ${c.decision === 'human' ? pill('stopped', 'blocked → Human help') : c.decision === 'allow' ? pill('agreed', 'allowed') : ''}</span></div>`).join('')
        : '<p class="empty">No MCP or skill calls yet.</p>';
      const pol = t.policy;
      $main.innerHTML = `<div class="top"><div class="grow"><h1>Tools</h1><div class="sub">MCP servers, plugins and skills your Claude Code sessions have, so the whole team has them too. Found from <code>.mcp.json</code>, your Claude Code settings and enabled plugins.</div></div>${can('owner') ? '<button data-act="restaff" title="Rewrite each agent’s Your tools section">Update agents</button>' : ''}</div>
        <div class="card"><h3>What agents may do</h3><ul class="policy">
          <li>${pol.auto_allow ? 'Read-only tools, and every tool of servers that only work on this machine (Playwright, Chrome DevTools, Context7), run without a permission prompt.' : 'Every MCP tool follows your Claude Code permissions (tools.auto_allow is off).'}</li>
          <li>Tools that push, merge, deploy, publish, pay, refund, delete or send, and anything that writes to GitHub, Linear, Notion, Slack, Stripe, Supabase, Vercel or a cloud, are blocked. The agent files it in <a href="#/help">Human help</a>.</li>
          <li>Change it in <code>.madcompany/team.yaml</code>: <code>tools.allow</code> ${pol.allow.length ? `(now: ${pol.allow.map((x) => `<code>${esc(x)}</code>`).join(', ')})` : ''}, <code>tools.human</code> ${pol.human.length ? `(now: ${pol.human.map((x) => `<code>${esc(x)}</code>`).join(', ')})` : ''}, and who gets which server with <code>tools.assign</code>.</li>
        </ul></div>
        <h2 style="margin-top:18px">MCP servers <span class="count">${t.servers.length}</span></h2>
        <div class="stack">${t.servers.map(serverRow).join('') || '<div class="card"><p class="empty">No MCP servers yet. Suggestions below.</p></div>'}</div>
        ${t.suggestions.length ? `<h2 style="margin-top:18px">Worth adding <span class="count">${t.suggestions.length}</span></h2><p class="sub">Adding a server is yours to do: it runs someone else's code with your accounts. Each one becomes a Human help item with the command.</p><div class="grid g2">${t.suggestions.map(sugg).join('')}</div>` : ''}
        <h2 style="margin-top:18px">Plugins <span class="count">${t.plugins.length}</span></h2>
        <div class="grid g2">${t.plugins.map(plugin).join('') || '<div class="card"><p class="empty">No plugins enabled. Add them with <code>/plugin</code> in Claude Code; the team gets their skills, agents and MCP servers.</p></div>'}</div>
        <div class="grid g2" style="margin-top:14px">
          <div class="card feed"><h3>Skills <span class="count">${t.skills.length}</span></h3>${t.skills.map((x) => `<div class="item"><code>/${esc(x.name)}</code><span class="sub">${esc(x.description)} · ${esc(x.source)}</span></div>`).join('') || '<p class="empty">Only madcompany’s own.</p>'}</div>
          <div class="card feed"><h3>Recent calls</h3>${recent}</div>
        </div>`;
      $main.querySelector('[data-act="restaff"]')?.addEventListener('click', () => act(() => api('/api/tools/restaff', {})).then(() => alert('Agents updated. Restart Claude Code so they reload.')));
      $main.querySelectorAll('[data-suggest]').forEach((b) =>
        b.addEventListener('click', async () => {
          const x = t.suggestions.find((y) => y.key === b.dataset.suggest);
          try {
            const out = await api('/api/help', { title: `Connect the ${x.title} MCP server`, kind: 'setup', service: x.title, why: `${x.why} ${x.for}`, steps: [`In the project folder, run: ${x.add}`, 'Restart Claude Code and run /mcp to check it shows as connected. Log in there if it asks.', 'In HQ → Tools, press Update agents so the right people know about it.'] });
            location.hash = `#/help/${out.id}`;
          } catch (err) {
            alert(err.message);
          }
        }),
      );
    })
    .catch((e) => ($main.innerHTML = `<p class="empty">${esc(e.message)}</p>`));
  return new Promise(() => {});
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
        const addLink = cat.id === 'links' && can('member')
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
    location.hash = `#/chat/${encodeURIComponent(dmWith(to))}`;
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
  $main.querySelector('form[data-form="hire"]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    act(() => api('/api/team/hire', { type: f.type.value, id: f.id.value.trim() || undefined, model: f.model.value || undefined }));
  });
  $main.querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', () => confirm(`Remove ${b.dataset.remove} from the team? Their memory files are kept.`) && act(() => api('/api/team/remove', { id: b.dataset.remove }))),
  );
  const showLink = (link) => {
    const box = document.getElementById('invite-link');
    if (box) box.innerHTML = `<div class="callout">Send this link privately. It signs them in:<br><code>${esc(location.origin + link)}</code></div>`;
  };
  $main.querySelector('form[data-form="invite"]')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const out = await api('/api/people', { id: f.id.value.trim(), name: f.name.value.trim(), role: f.role.value });
      await refresh();
      showLink(out.link);
    } catch (err) {
      alert(err.message);
    }
  });
  $main.querySelectorAll('[data-link]').forEach((b) =>
    b.addEventListener('click', async () => {
      if (!confirm('Make a new sign-in link? The old one stops working.')) return;
      const out = await api('/api/people/link', { id: b.dataset.link });
      showLink(out.link);
    }),
  );
  $main.querySelectorAll('[data-unperson]').forEach((b) =>
    b.addEventListener('click', () => confirm(`Remove ${b.dataset.unperson}? Their link stops working.`) && act(() => api('/api/people/remove', { id: b.dataset.unperson }))),
  );
  $main.querySelectorAll('select[data-model]').forEach((sel) =>
    sel.addEventListener('change', () => act(() => api('/api/team/model', { id: sel.dataset.model, model: sel.value }))),
  );
  $main.querySelectorAll('form[data-form="help-done"]').forEach((f) =>
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = { id: f.dataset.id, note: f.note.value.trim() };
      try {
        await api('/api/help/done', body);
      } catch (err) {
        if (!/^Not found in/.test(err.message)) return alert(err.message);
        if (!confirm(`${err.message}\n\nMark it done anyway?`)) return;
        await api('/api/help/done', { ...body, force: true }).catch((e2) => alert(e2.message));
      }
      await refresh();
    }),
  );
  $main.querySelectorAll('[data-help-cancel]').forEach((b) =>
    b.addEventListener('click', () => {
      const reason = prompt(`Why isn't ${b.dataset.helpCancel} needed? (the team sees this)`);
      if (reason !== null) act(() => api('/api/help/cancel', { id: b.dataset.helpCancel, reason }));
    }),
  );
  $main.querySelector('form[data-form="help-add"]')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const env = f.env.value.split(/[\s,]+/).filter(Boolean);
    const steps = f.steps.value.split('\n').map((x) => x.trim()).filter(Boolean);
    act(() => api('/api/help', { title: f.title.value.trim(), kind: f.kind.value, env, steps, why: 'Added in HQ' }));
  });
  $main.querySelectorAll('[data-approve]').forEach((b) =>
    b.addEventListener('click', () => confirm(`Approve ${b.dataset.approve}? The lead then ships it into ${S.config.main_branch}.`) && act(() => api('/api/review', { id: b.dataset.approve, verdict: 'approve' }))),
  );
  $main.querySelectorAll('form[data-form="changes"]').forEach((f) =>
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const notes = f.notes.value.trim();
      if (notes) act(() => api('/api/review', { id: f.dataset.id, verdict: 'changes', notes }));
    }),
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
// a sign-in link opened in a tab that already shows HQ only changes the hash
window.addEventListener('hashchange', () => (/^#\/login\//.test(location.hash) ? location.reload() : render()));

async function signIn() {
  const m = /^#\/login\/([A-Za-z0-9_-]+)$/.exec(location.hash);
  if (m) {
    try {
      await api('/api/login', { token: m[1] });
    } catch (e) {
      return showSignIn(e.message);
    }
    history.replaceState(null, '', '/#/');
  }
  const res = await fetch('/api/me');
  if (res.status === 401) return showSignIn();
  ME = await res.json();
  const foot = document.querySelector('.side-foot');
  if (ME.share) foot.insertAdjacentHTML('beforebegin', `<div class="me sub">Signed in as <b>${esc(ME.name)}</b> · ${esc(ME.role)} · <a href="#" id="sign-out">Sign out</a></div>`);
  document.getElementById('sign-out')?.addEventListener('click', async (e) => {
    e.preventDefault();
    await api('/api/logout', {});
    location.reload();
  });
  await refresh();
  live();
}

function showSignIn(msg) {
  document.querySelector('.side').hidden = true;
  document.querySelector('.shell').classList.add('solo');
  $main.innerHTML = `<div class="card signin"><h1>madcompany HQ</h1><p>${esc(msg ?? 'Sign in with the link the HQ owner sent you.')}</p><p class="sub">Ask the owner for a new link if yours stopped working.</p></div>`;
}

signIn().catch((e) => {
  $main.innerHTML = `<p class="empty">Could not reach HQ: ${esc(e.message)}</p>`;
});
