import fs from 'node:fs';
import path from 'node:path';
import { normalizeKey } from '../refs/ids.js';

const ANCHOR = String.raw`(?:<a id="[^"]*"><\/a>\s*)?`;
const EPIC = new RegExp(String.raw`^(#{1,4})\s+${ANCHOR}\**Epic\s+(\d+)\**\s*[:.\-–—]\s*(.+?)\s*$`, 'i');
const STORY = new RegExp(String.raw`^(#{1,5})\s+${ANCHOR}\**Story\s+(\d+)\.(\d+)\**\s*[:.\-–—]\s*(.+?)\s*$`, 'i');
const DEPENDS = /^\s*[-*]?\s*\**(?:Depends on|Dependencies|Blocked by)\**\s*:\**\s*(.+)$/i;
const FR = /\b(?:FR|NFR|UXR|AR)-?\d+\b/g;

/** Candidate BMad planning files, newest v6 locations first. */
export function findBmadDocs(root) {
  const pick = (cands) => cands.find((c) => fs.existsSync(path.join(root, c))) ?? null;
  const epics =
    pick(['_bmad-output/planning-artifacts/epics.md', '_bmad-output/epics.md', 'docs/epics.md', 'docs/planning/epics.md']) ??
    findFirst(root, ['_bmad-output', 'docs'], /^epics?.*\.md$/i);
  const prd = pick(['_bmad-output/planning-artifacts/prd.md', '_bmad-output/prd.md', 'docs/prd.md', 'docs/planning/prd.md']) ?? findFirst(root, ['_bmad-output', 'docs'], /^prd.*\.md$/i);
  const architecture = pick(['_bmad-output/planning-artifacts/architecture.md', 'docs/architecture.md']);
  const ux = pick(['_bmad-output/planning-artifacts/ux-design-specification.md', '_bmad-output/planning-artifacts/ux-spec.md', 'docs/ux-spec.md']);
  return { prd, epics, architecture, ux };
}

function findFirst(root, dirs, re) {
  for (const d of dirs) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) continue;
    const stack = [abs];
    while (stack.length) {
      const dir = stack.pop();
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !['node_modules', 'design'].includes(e.name)) stack.push(path.join(dir, e.name));
        else if (re.test(e.name)) return path.relative(root, path.join(dir, e.name)).split(path.sep).join('/');
      }
    }
  }
  return null;
}

export function parseEpics(md) {
  const epics = [];
  let epic = null;
  let story = null;
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    let m;
    if (!fence && (m = EPIC.exec(line))) {
      epic = { num: Number(m[2]), title: clean(m[3]), stories: [], body: [] };
      epics.push(epic);
      story = null;
      continue;
    }
    if (!fence && (m = STORY.exec(line))) {
      const num = `${Number(m[2])}.${Number(m[3])}`;
      if (!epic || epic.num !== Number(m[2])) {
        epic = epics.find((e) => e.num === Number(m[2])) ?? { num: Number(m[2]), title: `Epic ${m[2]}`, stories: [], body: [] };
        if (!epics.includes(epic)) epics.push(epic);
      }
      story = { num, title: clean(m[4]), body: [], deps: [], refs: [] };
      epic.stories.push(story);
      continue;
    }
    if (!fence && /^#{1,3}\s/.test(line) && !EPIC.test(line) && story && !/acceptance|criteria|tasks?|notes?|technical|given|dev/i.test(line)) {
      // a new top-level section (e.g. "## FR Coverage Map") ends the story
      story = null;
      if (/^#{1,2}\s/.test(line)) epic = null;
      continue;
    }
    if (story) {
      story.body.push(line);
      const dm = DEPENDS.exec(line);
      if (dm) {
        for (const s of dm[1].matchAll(/Story\s+(\d+\.\d+)|\b(\d+\.\d+)\b/gi)) story.deps.push(s[1] ?? s[2]);
      }
      for (const f of line.matchAll(FR)) story.refs.push(f[0]);
    } else if (epic) {
      epic.body.push(line);
    }
  }
  for (const e of epics) {
    for (const s of e.stories) {
      s.body = s.body.join('\n').trim();
      s.deps = [...new Set(s.deps)].filter((d) => d !== s.num);
      s.refs = [...new Set(s.refs.map((r) => r.toUpperCase().replace('-', '')))];
    }
    e.body = e.body.join('\n').trim();
  }
  return epics;
}

const clean = (s) => s.replace(/<a id="[^"]*"><\/a>/g, '').replace(/[*_`]/g, '').trim();

const UI_HINT = /\b(screen|page|view|button|form|layout|navigation|tab|modal|UI|UX|display|shows?|tap|click)\b/i;

/**
 * Turn parsed epics into ticket specs (one per story). The lead can split
 * them into smaller single-domain tickets afterwards.
 */
export function storyTickets(epics, epicsFile) {
  const out = [];
  for (const e of epics) {
    for (const s of e.stories) {
      const key = normalizeKey(`Story ${s.num}`);
      const body = s.body.length > 2500 ? `${s.body.slice(0, 2500)}\n\n…(truncated; see source)` : s.body;
      out.push({
        source: key,
        title: `Story ${s.num}: ${s.title}`,
        epic: `E${e.num}`,
        epicTitle: e.title,
        body: `${body}\n\nSource: [Story ${s.num}](${epicsFile}#${key})`,
        refs: [`Story ${s.num}`, ...s.refs],
        ui: UI_HINT.test(`${s.title} ${s.body}`),
        storyDeps: s.deps,
      });
    }
  }
  return out;
}
