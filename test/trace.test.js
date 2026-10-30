import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeCore, tmpProject, TEAM } from './helpers.js';
import { createHq } from '../src/hq/server.js';
import { scanDoc, keyOf, mentionKeys } from '../src/hq/graph.js';
import { hqEntries } from '../src/refs/ids.js';

const PRD = `# PRD

## Functional Requirements

- <a id="fr1"></a>FR1: Users can sign up.
- <a id="fr2"></a>FR2: A task has exactly one assignee.
  The assignee shows on the card.

## Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| <a id="nfr1"></a>NFR1 | The list loads in under 1 second. |
`;
const EPICS = `# Epics

## <a id="epic-1"></a>Epic 1: Tasks

### <a id="story-1-1"></a>Story 1.1: Assign a task

Covers [FR2](prd.md#fr2).

**Depends on:** Story 1.2

### <a id="story-1-2"></a>Story 1.2: Sign up

Covers FR1.
`;

/** A project with a PRD and epics, in the given traceability mode. */
function project(mode = 'strict') {
  const ctx = makeCore({ team: TEAM.replace('max_parallel: 2', `max_parallel: 2\ntraceability: ${mode}`) });
  fs.mkdirSync(path.join(ctx.root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, 'docs', 'prd.md'), PRD);
  fs.writeFileSync(path.join(ctx.root, 'docs', 'epics.md'), EPICS);
  ctx.core.startDay('you');
  return ctx;
}

/** Take a ticket through review and merge. */
function finish(core, id, dev = 'arjun') {
  if (core.ticket(id).status !== 'in_progress') core.claim(dev, id);
  core.submit(dev, id, { summary: 'done', checks: { test: 'pass' } });
  core.review('qa', id, { verdict: 'approve' });
  core.markMerged('lead', id);
}

test('docs are indexed like code: sections, containment, dependencies and mentions', () => {
  const prd = scanDoc('docs/prd.md', PRD);
  const fr2 = prd.items.find((i) => i.key === 'fr2');
  assert.equal(fr2.form, 'item');
  assert.equal(fr2.end - fr2.start, 1, 'a list item keeps its continuation line');
  assert.equal(prd.items.find((i) => i.key === 'nfr1').form, 'row');
  const epics = scanDoc('docs/epics.md', EPICS);
  const s11 = epics.items.find((i) => i.key === 'story-1-1');
  assert.equal(s11.parent, 'epic-1');
  assert.deepEqual(
    s11.mentions.map((m) => [m.key, m.depends]),
    [['fr2', false], ['story-1-2', true]],
  );
  assert.equal(keyOf('E1'), 'epic-1');
  assert.equal(keyOf('[FR12](docs/prd.md#fr12)'), 'fr12');
  assert.ok(mentionKeys('see docs/design/auth/api.md and FR-003').includes('docs/design/auth/api.md'));
  assert.ok(mentionKeys('see docs/design/auth/api.md and FR-003').includes('fr3'));

  const { core } = project();
  // mc_section returns just the definition, with a table row's header
  assert.equal(core.section('lead', 'FR2').text, '- FR2: A task has exactly one assignee.\n  The assignee shows on the card.');
  assert.match(core.section('lead', 'NFR1').text, /\| ID \| Requirement \|[\s\S]*NFR1/);
  assert.match(core.section('lead', 'Story 1.1').text, /^### Story 1\.1: Assign a task[\s\S]*Depends on/);
  const card = core.ref('lead', 'Story 1.1');
  assert.deepEqual(card['part of'].map((x) => x.id), ['Epic 1']);
  assert.deepEqual(card['depends on'].map((x) => x.id), ['Story 1.2']);
  assert.deepEqual(card['refers to'].map((x) => x.id), ['FR2']);
  assert.equal(core.ref('lead', 'FR2').text, 'A task has exactly one assignee. The assignee shows on the card.');
  assert.throws(() => core.ref('lead', 'FR99'), /Nothing is registered as FR99/);
});

test('strict: tickets, decisions, questions and agent messages must trace to a requirement', () => {
  const { core } = project();
  assert.throws(() => core.createTicket('lead', { title: 'Untraced' }), /isn't linked to a requirement[\s\S]*kind "chore"/);
  assert.throws(() => core.createTicket('lead', { title: 'Typo', refs: ['FR99'] }), /FR99 isn't defined anywhere/);
  core.createTicket('lead', { title: 'Assign API', refs: ['Story 1.1'] });
  core.createTicket('lead', { title: 'Set up lint', kind: 'chore' });
  assert.throws(() => core.updateTicket('lead', 'APP-1', { refs: [] }), /isn't linked to a requirement/);
  core.updateTicket('lead', 'APP-2', { kind: 'task', refs: ['NFR1'] });

  core.claim('arjun', 'APP-1');
  assert.throws(() => core.post('arjun', { channel: 'general', text: 'Morning all' }), /Mention the ticket or requirement/);
  assert.ok(core.post('arjun', { channel: 'general', text: 'APP-1: the assign endpoint is up' }).ok);
  assert.ok(core.post('arjun', { channel: 'ticket:APP-1', text: 'Starting on it' }).ok, 'a ticket thread is already about the ticket');
  assert.ok(core.post('lead', { channel: 'general', text: 'Morning all' }).ok, 'the lead talks freely');
  assert.ok(core.post('you', { channel: 'general', text: 'Looks great' }).ok, 'people are never blocked');

  assert.throws(() => core.decide('arjun', { title: 'Use UUIDs', decision: 'UUID v7', why: 'sortable' }), /This decision isn't linked/);
  assert.ok(core.decide('arjun', { title: 'Use UUIDs', decision: 'UUID v7', why: 'sortable', refs: ['FR2'] }).ok);
  assert.throws(() => core.ask('arjun', { to: 'lena', question: 'Free for a review?' }), /This question isn't linked/);
  assert.ok(core.ask('arjun', { to: 'lena', question: 'Do you show the assignee avatar?', ticket: 'APP-1' }).ok);
  assert.throws(() => core.escalate('lead', { question: 'Paid plan?', options: ['Yes', 'No'] }), /isn't linked/);
  assert.throws(() => core.note('arjun', { about: ['FR77'], text: 'x' }), /FR77 isn't defined/);
  assert.ok(core.note('arjun', { about: ['Story 1.1'], text: 'PUT /tasks/:id/assignee' }).ok);

  const cov = core.traceSummary().coverage;
  assert.deepEqual(cov.tickets, { traced: 2, total: 2 });
  assert.equal(cov.decisions.traced, 1);
});

test('warn and off: the same checks only warn, or are skipped', () => {
  const warn = project('warn').core;
  const res = warn.createTicket('lead', { title: 'Untraced' });
  assert.match(res.warning, /isn't linked to a requirement/);
  const claimed = warn.claim('arjun', res.ticket.id);
  assert.match(claimed.warning, /isn't linked to any requirement/);
  assert.match(warn.post('arjun', { channel: 'general', text: 'hello' }).warning, /Mention the ticket/);
  assert.ok(warn.traceSummary().diagnostics.some((d) => /APP-1 isn't linked to any requirement/.test(d)));

  const off = project('off').core;
  assert.equal(off.createTicket('lead', { title: 'Untraced' }).warning, undefined);
  assert.equal(off.post('lena', { channel: 'general', text: 'hello' }).warning, undefined);
});

test('change requests: mapped to what they amend or extend before work starts, with the impact computed', () => {
  const { core, notices } = project();
  core.createTicket('lead', { title: 'Assign API', refs: ['Story 1.1', 'FR2'] });
  core.createTicket('lead', { title: 'Assign screen', refs: ['Story 1.1'] });
  core.createTicket('lead', { title: 'Sign-up API', refs: ['Story 1.2'] });
  finish(core, 'APP-1');
  core.claim('lena', 'APP-2');

  const chg = core.change({ text: 'A task may have no assignee' }, 'you').ticket.id;
  assert.equal(chg, 'APP-4');
  assert.match(notices.take().find((n) => n.ticket === chg).text, /mc_map_change/);
  assert.throws(() => core.claim('arjun', chg), /isn't mapped to the requirements it amends or extends/);
  assert.ok(core.traceSummary().diagnostics.some((d) => d.startsWith(`${chg} (change) isn't mapped`)));
  assert.throws(() => core.mapChange('arjun', chg, { amends: ['FR2'] }), /Only the lead, the product manager or a person/);
  assert.throws(() => core.mapChange('lead', chg, {}), /Say which requirements it amends/);
  assert.throws(() => core.mapChange('lead', chg, { amends: ['APP-1'] }), /APP-1 isn't a requirement, story or epic \(it's a ticket\)/);
  assert.throws(() => core.mapChange('lead', 'APP-1', { amends: ['FR2'] }), /is a task ticket/);

  const res = core.mapChange('lead', chg, { amends: ['FR2'] });
  assert.equal(core.ticket(chg).epic, 'E1', 'it merges with Epic 1, where FR2 is built (Story 1.1)');
  assert.equal(res.epic, 'E1');
  assert.deepEqual(res.affected.tickets.map((t) => t.id), ['APP-1', 'APP-2'], 'tickets on FR2, and on Story 1.1 that covers it');
  assert.deepEqual(res.affected.stories.map((x) => x.id), ['Story 1.1']);
  assert.match(res.line, /^Impact of APP-4: amends FR2; tickets APP-1 \(done\), APP-2 \(in_progress\); stories Story 1\.1\.$/);
  assert.ok(core.store.state.messages.some((m) => m.channel === `ticket:${chg}` && m.text === res.line), 'the impact is posted in the change thread');
  assert.deepEqual(core.ticketInfo('lead', chg).activity.slice(-2).map((a) => a.text), ['mapped: amends FR2', 'updated epic']);

  // work done or in progress on what the change amends is flagged until someone decides
  let diags = core.traceSummary().diagnostics;
  assert.ok(diags.some((d) => d.startsWith('APP-1 was done before APP-4 amended FR2')));
  assert.ok(diags.some((d) => d.startsWith('APP-2 (in_progress, lena) implements FR2, which APP-4 amended after work started')));
  assert.ok(!diags.some((d) => d.includes('APP-3')), 'tickets on other requirements are untouched');
  core.decide('lead', { title: 'APP-1 holds', decision: 'The API already allows a null assignee', why: 'nullable column', refs: ['APP-1', chg] });
  diags = core.traceSummary().diagnostics;
  assert.ok(!diags.some((d) => d.startsWith('APP-1 was done')), 'a decision on both clears it');

  // the new wording is proposed until the change is built; the PRD stays as written
  assert.throws(() => core.defineRequirement('lead', { id: 'FR2', text: 'At most one assignee.' }), /needs the change request behind it/);
  assert.equal(core.defineRequirement('lead', { id: 'FR2', text: 'A task has at most one assignee.', change: chg }).state, 'proposed');
  let fr2 = core.ref('lead', 'FR2');
  assert.equal(fr2.text, 'A task has exactly one assignee. The assignee shows on the card.', 'what holds until the change is built');
  assert.deepEqual(fr2.proposed, { text: 'A task has at most one assignee.', change: chg, change_status: 'todo' });
  assert.deepEqual(fr2['amended by'].map((x) => x.id), [chg]);
  assert.match(core.section('lead', 'FR2').text, /exactly one assignee/);
  assert.equal(core.section('lead', 'FR2').amendments[0].state, 'proposed');
  assert.match(core.index.contextFor('APP-2').context.requirements.find((r) => r.id === 'FR2').proposed.note, /Not in effect until APP-4 is done/);

  // work split from the change traces through it, builds the new wording, and makes it hold when merged
  const part = core.createTicket('lead', { title: 'Unassign button', refs: [chg] }).ticket.id;
  assert.deepEqual(core.index.trace(part), ['FR2', 'Epic 1']);
  assert.ok(!core.index.impact(chg).affected.tickets.some((t) => t.id === part), 'its own tickets are not "affected"');
  const target = core.claim('arjun', part).context.requirements.find((r) => r.id === 'FR2');
  assert.match(target.proposed.note, /Your ticket builds this wording/);
  finish(core, part);
  assert.equal(core.ticket(chg).status, 'done', 'a change split into tickets is done when they all are');
  fr2 = core.ref('lead', 'FR2');
  assert.equal(fr2.text, 'A task has at most one assignee.');
  assert.equal(fr2.amended_by, chg);
  assert.equal(fr2.proposed, undefined);
});

test('a change nobody started can be withdrawn: its tickets go, its wording and requirements drop', () => {
  const { core, notices } = project();
  core.createTicket('lead', { title: 'Assign API', refs: ['FR2'] });
  const busy = core.change({ text: 'Colour-code assignees', extends: ['FR2'] }, 'you').ticket.id;
  const busyPart = core.createTicket('lead', { title: 'Colours', refs: [busy] }).ticket.id;
  core.claim('arjun', busyPart);
  assert.throws(() => core.withdrawChange('lead', busy, 'not now'), /APP-3 \(in_progress\) already started on it/);

  const chg = core.change({ text: 'Several assignees', amends: ['FR2'] }, 'you').ticket.id;
  core.defineRequirement('lead', { id: 'FR2', text: 'Up to 3 assignees.', change: chg });
  const added = core.defineRequirement('lead', { title: 'Assignee limit', text: 'At most 3.', extends: ['FR2'], change: chg }).id;
  const part = core.createTicket('lead', { title: 'Multi-assign', refs: [chg] }).ticket.id;
  const waiting = core.createTicket('lead', { title: 'Avatars', refs: ['FR2'], deps: [part] }).ticket.id;
  assert.equal(core.ref('lead', 'FR2').proposed.change, chg);
  assert.equal(core.ref('lead', added).status, 'proposed');
  assert.throws(() => core.withdrawChange('arjun', chg, 'no'), /Only the lead/);
  assert.throws(() => core.withdrawChange('lead', chg, ' '), /Say why/);
  assert.throws(() => core.withdrawChange('lead', 'APP-1', 'x'), /only change requests and feedback/);
  notices.take();
  const res = core.withdrawChange('you', chg, 'Out of scope for the MVP');
  assert.deepEqual(res.withdrawn, [chg, part]);
  assert.match(res.line, /wording it proposed for FR2 is dropped\. FR3 no longer applies\./);
  assert.ok(core.ticket(chg).withdrawn && core.ticket(chg).status === 'done');
  assert.equal(core.ref('lead', 'FR2').proposed, undefined, 'the proposed wording is gone');
  assert.equal(core.index.isRequirement(added), false, 'FR3 no longer counts as a requirement');
  assert.equal(core.section('lead', 'FR2').amendments[0].state, 'withdrawn');
  assert.ok(notices.take().some((n) => n.kind === 'ready' && n.ticket === waiting), 'work waiting on it can go ahead');
  assert.throws(() => core.claim('arjun', chg), /is done/);
  assert.throws(() => core.withdrawChange('lead', chg, 'again'), /already withdrawn/);
});

test('what was written, decided or answered before a change is flagged until someone checks it', () => {
  const { core } = project();
  core.createTicket('lead', { title: 'Assign API', refs: ['Story 1.1'] });
  core.claim('arjun', 'APP-1');
  const old = core.decide('arjun', { title: 'Reject empty', decision: 'assign("") throws', why: 'see FR2', refs: ['FR2'] }).id;
  core.decide('arjun', { title: 'Use UUIDs', decision: 'uuid v7', why: 'sortable', ticket: 'APP-1' });
  core.ask('arjun', { to: 'lead', question: 'Can a task have two assignees?', refs: ['FR2'] });
  core.escalate('lead', { q: 'Q-1', options: ['No', 'Yes'] });
  core.answer('you', 'Q-1', 'No');
  core.note('arjun', { about: ['FR2'], text: 'An empty assignee is a 400' });
  const chg = core.change({ text: 'Allow unassigning', amends: ['FR2'] }, 'you').ticket.id;

  let diags = core.traceSummary().diagnostics;
  assert.ok(diags.some((d) => d.startsWith(`Story 1.1 covers FR2, which ${chg} amends, and still says what it said before`)), diags.join('\n'));
  assert.ok(diags.some((d) => d.startsWith(`${old} was decided on FR2 before ${chg} amended FR2`)));
  assert.ok(diags.some((d) => d.startsWith(`F-1 (an answer from the human) was given before ${chg} amended FR2`)));
  assert.ok(!diags.some((d) => d.startsWith('DEC-2')), "a decision about the ticket alone isn't about FR2's wording");
  const card = core.ref('lead', 'FR2');
  assert.equal(card.decisions.find((d) => d.id === old).before_change, chg);
  assert.equal(card.notes[0].before_change, chg);
  const ctx = core.index.contextFor('APP-1').context.requirements.find((r) => r.id === 'FR2');
  assert.equal(ctx.decisions.find((d) => d.id === old).before_change, chg);
  assert.match(ctx.facts[0], new RegExp(`given before ${chg} changed this`));

  // reword the story, supersede the decision, confirm the answer: all settled
  core.defineRequirement('lead', { id: 'Story 1.1', text: 'Assigning sets the assignee; null clears it.', change: chg });
  const newer = core.decide('lead', { title: 'Null clears', decision: 'assign(id, null) clears the assignee', why: chg, refs: ['FR2'], supersedes: old }).id;
  core.decide('lead', { title: 'F-1 holds', decision: 'Still one assignee at most', why: 'unassigning adds no assignees', refs: ['F-1', chg] });
  diags = core.traceSummary().diagnostics;
  assert.ok(!diags.some((d) => /Story 1\.1 covers|DEC-1 was decided|F-1 \(an answer/.test(d)), diags.join('\n'));
  const after = core.index.contextFor('APP-1').context.requirements.find((r) => r.id === 'FR2');
  assert.ok(!after.decisions.some((d) => d.id === old), 'a superseded decision leaves the context');
  assert.equal(core.ref('lead', 'FR2').decisions.find((d) => d.id === old).superseded_by, newer);
});

test('a change can be mapped when raised, and new requirements get the next number', () => {
  const { core, notices } = project();
  core.createTicket('lead', { title: 'Assign API', refs: ['FR2'] });
  notices.take();
  const res = core.change({ text: 'Let people assign several people', extends: ['Epic 1'] }, 'you');
  assert.match(res.impact, /^Impact of APP-2: extends Epic 1/);
  assert.match(notices.take().find((n) => n.ticket === 'APP-2').text, /Impact of APP-2/);
  assert.ok(core.index.mapping(core.ticket('APP-2')).mapped);
  assert.equal(core.ticket('APP-2').epic, 'E1', 'a change mapped when raised joins its epic too');
  assert.throws(() => core.change({ text: 'x', amends: ['APP-1'] }, 'you'), /isn't a requirement/);
  assert.equal(Object.keys(core.store.state.tickets).length, 2, 'a bad mapping creates nothing');

  assert.throws(() => core.defineRequirement('lead', { title: 'Co-assignees', text: 'Up to 3 assignees', change: 'APP-1' }), /isn't a change request/);
  assert.throws(() => core.defineRequirement('arjun', { title: 'x', text: 'y' }), /Only the lead/);
  const r = core.defineRequirement('lead', { title: 'Co-assignees', text: 'A task can have up to 3 assignees.', extends: ['FR2'], change: 'APP-2' });
  assert.equal(r.id, 'FR3');
  assert.deepEqual(core.ticket('APP-2').extends, ['Epic 1', 'FR2'], 'the change now also extends what its requirement builds on');
  assert.equal(core.defineRequirement('lead', { title: 'Fast assign', text: 'Under 200 ms', kind: 'NFR' }).id, 'NFR2');
  assert.equal(core.ref('lead', 'FR3')['defined by'][0].id, 'APP-2');
  assert.equal(core.ref('lead', 'FR2')['extended by'][0].id, 'FR3');
  const entries = hqEntries(core.store.state);
  assert.equal(entries.fr3.file, '.madcompany/log/requirements.md');
});

test('a project without requirements yet: the first change defines them', () => {
  const ctx = makeCore({ team: TEAM.replace('max_parallel: 2', 'max_parallel: 2\ntraceability: strict') });
  const { core } = ctx;
  core.startDay('you');
  assert.throws(() => core.createTicket('lead', { title: 'Export' }), /none are defined yet/);
  const chg = core.change({ text: 'Export tasks as CSV' }, 'you').ticket.id;
  assert.throws(() => core.claim('arjun', chg), /isn't mapped/);
  core.defineRequirement('lead', { title: 'CSV export', text: 'Users can export their tasks as CSV.', change: chg });
  assert.ok(core.index.mapping(core.ticket(chg)).mapped, 'with nothing to extend, defining the requirement maps it');
  assert.ok(core.createTicket('lead', { title: 'CSV endpoint', refs: ['FR1'] }).ticket);
});

test('claiming a ticket brings its requirements as they stand, and only the facts that concern them', () => {
  const { core } = project();
  core.createTicket('lead', { title: 'Assign API', refs: ['Story 1.1'] });
  core.createTicket('lead', { title: 'Sign-up API', refs: ['Story 1.2'] });
  core.claim('arjun', 'APP-2');
  core.note('arjun', { about: ['Story 1.1'], text: 'The assignee must be a team member' });
  core.ask('arjun', { to: 'lead', question: 'Email verification?', ticket: 'APP-2' });
  core.escalate('lead', { q: 'Q-1', options: ['Yes', 'No'] });
  core.answer('you', 'Q-1', 'No');
  core.escalate('lead', { question: 'Assign to people outside the team?', options: ['No', 'Yes'], refs: ['FR2'] });
  core.answer('you', 'Q-2', 'No');
  const chg = core.change({ text: 'Allow no assignee', amends: ['FR2'] }, 'you').ticket.id;
  core.defineRequirement('lead', { id: 'FR2', text: 'At most one assignee.', change: chg });

  const pkg = core.claim('lena', 'APP-1');
  const reqs = Object.fromEntries(pkg.context.requirements.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(reqs), ['Story 1.1', 'FR2']);
  assert.equal(reqs.FR2.text, 'A task has exactly one assignee. The assignee shows on the card.');
  assert.equal(reqs.FR2.proposed.text, 'At most one assignee.');
  assert.match(reqs.FR2.proposed.note, new RegExp(`Not in effect until ${chg} is done`));
  assert.deepEqual(reqs.FR2.facts, [`Assign to people outside the team? → No (given before ${chg} changed this: check it)`]);
  assert.match(reqs['Story 1.1'].notes[0].text, /must be a team member/);
  assert.deepEqual(pkg.facts, ['F-2: Assign to people outside the team? → No'], 'the sign-up fact stays out');
  assert.match(pkg.facts_elsewhere, /1 more/);
  assert.match(pkg.context.how, /mc_ref/);
});

test('HQ: the index over MCP and the API, and the requirements log', async () => {
  const ctx = tmpProject();
  fs.writeFileSync(ctx.paths.team, TEAM.replace('max_parallel: 2', 'max_parallel: 2\ntraceability: strict'));
  fs.mkdirSync(path.join(ctx.root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, 'docs', 'prd.md'), PRD);
  fs.writeFileSync(path.join(ctx.root, 'docs', 'epics.md'), EPICS);
  const hq = createHq({ paths: ctx.paths, port: 0, quiet: true });
  const base = `http://127.0.0.1:${await hq.listen()}`;
  try {
    const client = new Client({ name: 'test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      return r.isError ? { error: r.content[0].text } : JSON.parse(r.content[0].text);
    };
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const n of ['mc_ref', 'mc_section', 'mc_note', 'mc_map_change', 'mc_requirement', 'mc_trace']) assert.ok(names.includes(n), n);
    await call('mc_start_day', { as: 'lead' });
    assert.match((await call('mc_create_ticket', { as: 'lead', title: 'x' })).error, /isn't linked to a requirement/);
    assert.equal((await call('mc_create_ticket', { as: 'lead', title: 'Assign API', refs: ['FR2'] })).ticket.id, 'APP-1');
    assert.equal((await call('mc_ref', { as: 'arjun', id: 'FR2' })).tickets[0].id, 'APP-1');
    assert.match((await call('mc_section', { as: 'arjun', id: 'Story 1.1' })).text, /Covers \[FR2\]/);

    const res = await fetch(`${base}/api/change`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'No assignee', amends: ['FR2'] }) });
    assert.equal((await res.json()).ticket.id, 'APP-2');
    assert.ok((await call('mc_requirement', { as: 'lead', id: 'FR2', text: 'At most one assignee.', change: 'APP-2' })).amended);
    assert.ok((await call('mc_trace', { as: 'lead' })).coverage);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(state.trace.tickets['APP-1'], ['FR2']);
    assert.deepEqual(state.trace.unmapped, []);
    const trace = await (await fetch(`${base}/api/trace`)).json();
    assert.equal(trace.requirements.find((r) => r.id === 'FR2').proposed.change, 'APP-2');
    assert.equal((await (await fetch(`${base}/api/ref?id=nope-1`)).json()).error.startsWith('Nothing is registered'), true);
    hq.views.flush();
    assert.match(fs.readFileSync(path.join(ctx.paths.log, 'requirements.md'), 'utf8'), /\*\*FR2\*\*.*At most one assignee/);
  } finally {
    await hq.close();
  }
});
