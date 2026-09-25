import fs from 'node:fs';
import path from 'node:path';

/**
 * Stable IDs → where they are defined. "FR-012", "FR12" and "fr12" are the
 * same requirement, so everything goes through normalizeKey first.
 */
export function normalizeKey(raw) {
  const t = String(raw).trim().replace(/\s+/g, ' ');
  let m;
  if ((m = /^Epic ?0*(\d+)$/i.exec(t))) return `epic-${m[1]}`;
  if ((m = /^Story ?0*(\d+)\.0*(\d+)$/i.exec(t))) return `story-${m[1]}-${m[2]}`;
  if ((m = /^([A-Za-z]{1,6})-?0*(\d+)$/.exec(t)) && /^(FR|NFR|UXR|AR|D)$/i.test(m[1])) return `${m[1].toLowerCase()}${m[2]}`;
  if ((m = /^([A-Za-z][A-Za-z0-9]{0,9})-0*(\d+)$/.exec(t))) return `${m[1].toLowerCase()}-${m[2]}`;
  if ((m = /^([A-Za-z]{1,6})0*(\d+)$/.exec(t))) return `${m[1].toLowerCase()}${m[2]}`;
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Candidate ID mentions in prose. Only ones found in the registry become links. */
export const MENTION = /\b(?:Epic\s+\d+|Story\s+\d+\.\d+|[A-Z][A-Z0-9]{0,9}-\d+(?:\.\d+)?|[A-Z]{1,5}\d+)\b/g;

const ANCHOR = /<a id="([a-z0-9-]+)"><\/a>/g;
const SKIP_DIRS = new Set(['node_modules', '.git', 'worktrees', 'run', 'dist', 'build', '.next', '.expo']);

export function listMarkdown(root, dirs) {
  const out = [];
  const walk = (abs) => {
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(abs, e.name));
      } else if (e.name.endsWith('.md')) {
        out.push(path.relative(root, path.join(abs, e.name)).split(path.sep).join('/'));
      }
    }
  };
  for (const d of dirs) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isFile()) out.push(d);
    else walk(abs);
  }
  // Definitions win in this order: PRD, then epics, then everything else.
  const rank = (f) => (/prd/i.test(f) ? 0 : /epic/i.test(f) ? 1 : /log\//.test(f) ? 3 : 2);
  return [...new Set(out)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export const DEFAULT_DIRS = ['docs', '_bmad-output', '.madcompany/log', '.madcompany/facts.md', 'README.md'];

export function cleanTitle(line) {
  return line
    .replace(ANCHOR, '')
    .replace(/^\s*(#{1,6}|[-*+]|\d+\.)\s+/, '')
    .replace(/\|/g, ' ')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

export function scanFile(root, rel) {
  const entries = [];
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(ANCHOR)) {
      entries.push({ key: m[1], file: rel, anchor: m[1], line: i + 1, title: cleanTitle(line) });
    }
  });
  return entries;
}

export function buildRegistry(root, dirs = DEFAULT_DIRS) {
  const reg = {};
  for (const rel of listMarkdown(root, dirs)) {
    for (const e of scanFile(root, rel)) {
      if (!reg[e.key]) reg[e.key] = { file: e.file, anchor: e.anchor, line: e.line, title: e.title };
    }
  }
  return reg;
}

/** HQ's own objects (tickets, decisions, questions, facts) link into the HQ app. */
export function hqEntries(state) {
  const reg = {};
  for (const t of Object.values(state.tickets)) reg[normalizeKey(t.id)] = { hq: `#/ticket/${t.id}`, title: `${t.id} ${t.title} (${t.status})` };
  for (const d of state.decisions) reg[normalizeKey(d.id)] = { hq: `#/decisions/${d.id}`, title: `${d.id} ${d.title}` };
  for (const q of Object.values(state.questions)) reg[normalizeKey(q.id)] = { hq: `#/questions/${q.id}`, title: `${q.id} ${q.question}` };
  for (const f of state.facts) reg[normalizeKey(f.id)] = { hq: `#/facts/${f.id}`, title: `${f.id} ${f.text}` };
  for (const m of state.minutes ?? []) reg[normalizeKey(m.id)] = { hq: `#/file/${m.file}?a=${m.id.toLowerCase()}`, title: `${m.id} ${m.title} (${m.date})` };
  for (const l of state.links ?? []) reg[normalizeKey(l.id)] = { hq: l.url, title: `${l.id} ${l.title}`, external: true };
  return reg;
}

export function writeRegistry(file, reg) {
  const sorted = Object.fromEntries(Object.entries(reg).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
  fs.writeFileSync(file, JSON.stringify(sorted, null, 1) + '\n');
}

export function readRegistry(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
