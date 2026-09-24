import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeKey, buildRegistry } from '../src/refs/ids.js';
import { anchorMarkdown } from '../src/refs/anchor.js';
import { findBareRefs, fixBareRefs, linkifyForHq } from '../src/refs/check.js';
import { parseEpics, storyTickets, findBmadDocs } from '../src/bmad/import.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'tiny-tasks');

function copyFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-refs-'));
  fs.cpSync(FIX, dir, { recursive: true });
  return dir;
}

test('normalizeKey treats spelling variants as the same ID', () => {
  assert.equal(normalizeKey('FR-012'), 'fr12');
  assert.equal(normalizeKey('FR12'), 'fr12');
  assert.equal(normalizeKey('NFR-3'), 'nfr3');
  assert.equal(normalizeKey('Story 1.2'), 'story-1-2');
  assert.equal(normalizeKey('Epic 03'), 'epic-3');
  assert.equal(normalizeKey('APP-42'), 'app-42');
  assert.equal(normalizeKey('TEAM-3'), 'team-3');
  assert.equal(normalizeKey('D1'), 'd1');
});

test('anchorMarkdown anchors definitions once and skips code blocks', () => {
  const md = fs.readFileSync(path.join(FIX, '_bmad-output/planning-artifacts/prd.md'), 'utf8');
  const { text, added } = anchorMarkdown(md);
  assert.deepEqual(added, ['fr1', 'fr2', 'fr3', 'nfr1']);
  assert.match(text, /^- <a id="fr1"><\/a>FR1: Users can sign up/m);
  assert.match(text, /^- <a id="fr2"><\/a>\*\*FR2:\*\*/m);
  assert.match(text, /^\| <a id="nfr1"><\/a>NFR1 \|/m);
  assert.match(text, /^FR9: this is inside a code block/m);
  assert.deepEqual(anchorMarkdown(text).added, [], 'idempotent');

  const epics = anchorMarkdown(fs.readFileSync(path.join(FIX, '_bmad-output/planning-artifacts/epics.md'), 'utf8'));
  assert.ok(epics.added.includes('epic-1') && epics.added.includes('story-1-2'));
  assert.match(epics.text, /^## <a id="epic-1"><\/a>Epic 1: Accounts/m);
  assert.match(epics.text, /^### <a id="story-2-1"><\/a>Story 2.1: Task list/m);
});

test('registry prefers the PRD definition and bare refs can be fixed into links', () => {
  const root = copyFixture();
  for (const f of ['prd.md', 'epics.md']) {
    const p = path.join(root, '_bmad-output/planning-artifacts', f);
    fs.writeFileSync(p, anchorMarkdown(fs.readFileSync(p, 'utf8')).text);
  }
  const reg = buildRegistry(root);
  assert.equal(reg.fr1.file, '_bmad-output/planning-artifacts/prd.md');
  assert.equal(reg['story-1-2'].file, '_bmad-output/planning-artifacts/epics.md');
  assert.match(reg.fr1.title, /Users can sign up/);

  const note = 'Story 1.2 needs FR1 and FR-003. Not `FR2` in code, not [FR2](x.md), not UTF-8.';
  const bare = findBareRefs(note, reg).map((b) => b.id);
  assert.deepEqual(bare, ['Story 1.2', 'FR1', 'FR-003']);
  const { text, count } = fixBareRefs(note, reg, 'docs/design/api.md');
  assert.equal(count, 3);
  assert.match(text, /\[FR1\]\(\.\.\/\.\.\/_bmad-output\/planning-artifacts\/prd\.md#fr1\)/);
  assert.match(text, /`FR2` in code, not \[FR2\]\(x\.md\)/);
  assert.equal(findBareRefs(text, reg).length, 0);

  const hq = linkifyForHq('See FR2 and APP-1', { ...reg, 'app-1': { hq: '#/ticket/APP-1', title: 'APP-1 API' } });
  assert.match(hq, /\[FR2\]\(#\/file\/_bmad-output\/planning-artifacts\/prd\.md\?a=fr2 /);
  assert.match(hq, /\[APP-1\]\(#\/ticket\/APP-1 "APP-1 API"\)/);
});

test('parseEpics reads epics, stories, dependencies and requirement refs', () => {
  const root = copyFixture();
  const docs = findBmadDocs(root);
  assert.equal(docs.epics, '_bmad-output/planning-artifacts/epics.md');
  assert.equal(docs.prd, '_bmad-output/planning-artifacts/prd.md');
  const epics = parseEpics(fs.readFileSync(path.join(root, docs.epics), 'utf8'));
  assert.deepEqual(epics.map((e) => [e.num, e.title, e.stories.length]), [[1, 'Accounts', 2], [2, 'Tasks', 1]]);
  const [s11, s12] = epics[0].stories;
  assert.deepEqual(s12.deps, ['1.1']);
  assert.deepEqual(s11.refs, ['FR1']);
  assert.deepEqual(epics[1].stories[0].refs, ['FR2', 'FR003']);
  assert.ok(!epics[1].stories[0].body.includes('Coverage Map'));

  const tickets = storyTickets(epics, docs.epics);
  assert.equal(tickets[0].title, 'Story 1.1: Sign-up screen');
  assert.equal(tickets[0].ui, true);
  assert.equal(tickets[1].ui, false);
  assert.equal(tickets[0].source, 'story-1-1');
  assert.match(tickets[0].body, /Source: \[Story 1\.1\]\(_bmad-output\/planning-artifacts\/epics\.md#story-1-1\)/);
});
