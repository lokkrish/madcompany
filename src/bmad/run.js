import fs from 'node:fs';
import path from 'node:path';
import { anchorMarkdown } from '../refs/anchor.js';
import { buildRegistry } from '../refs/ids.js';
import { fixBareRefs } from '../refs/check.js';
import { findBmadDocs, parseEpics, storyTickets } from './import.js';

/**
 * BMad bridge: anchor every requirement/epic/story in the planning docs so
 * they're clickable, then turn stories into tickets (one per story, deps from
 * "Depends on:" lines). Safe to run again: existing stories are skipped.
 */
export async function importBmad(paths, client, { epics, prd, log = console.log } = {}) {
  const found = findBmadDocs(paths.root);
  const epicsFile = epics ?? found.epics;
  const docs = [prd ?? found.prd, epicsFile, found.architecture, found.ux].filter(Boolean);
  if (!epicsFile) throw new Error('No epics file found. Pass --epics <path> (BMad v6 writes _bmad-output/planning-artifacts/epics.md).');

  for (const rel of docs) {
    const abs = path.join(paths.root, rel);
    const { text, added } = anchorMarkdown(fs.readFileSync(abs, 'utf8'));
    if (added.length) {
      fs.writeFileSync(abs, text);
      log(`  anchored ${added.length} IDs in ${rel}`);
    }
  }

  // then make references inside the planning docs clickable too ("covers FR1" → link)
  const registry = buildRegistry(paths.root);
  for (const rel of docs) {
    const abs = path.join(paths.root, rel);
    const { text, count } = fixBareRefs(fs.readFileSync(abs, 'utf8'), registry, rel);
    if (count) {
      fs.writeFileSync(abs, text);
      log(`  linked ${count} references in ${rel}`);
    }
  }

  const parsed = parseEpics(fs.readFileSync(path.join(paths.root, epicsFile), 'utf8'));
  const specs = storyTickets(parsed, epicsFile);
  const byStory = {};
  const created = [];
  for (const spec of specs) {
    const { storyDeps, ...fields } = spec;
    const res = await client.call('createTicket', 'cli', fields);
    byStory[spec.source.replace('story-', '').replace('-', '.')] = res.ticket.id;
    if (!res.existing) created.push({ id: res.ticket.id, storyDeps });
  }
  for (const c of created) {
    const deps = c.storyDeps.map((n) => byStory[n]).filter(Boolean);
    if (deps.length) await client.call('updateTicket', 'cli', c.id, { deps });
  }
  log(`  ${parsed.length} epics, ${specs.length} stories → ${created.length} new tickets${specs.length - created.length ? ` (${specs.length - created.length} already imported)` : ''}`);
  return { epics: parsed.length, stories: specs.length, created: created.length };
}
