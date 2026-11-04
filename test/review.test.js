import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeCore, TEAM } from './helpers.js';

const PRD = `# PRD

## Functional Requirements

- <a id="fr1"></a>FR1: Users can sign up.
- <a id="fr2"></a>FR2: A task has exactly one assignee.

## UX Requirements

- <a id="uxr1"></a>UXR1: Tasks are listed newest first; tapping one opens it.
`;
const EPICS = `# Epics

## <a id="epic-1"></a>Epic 1: Tasks

### <a id="story-1-1"></a>Story 1.1: Assign a task

Covers [FR2](prd.md#fr2).

### <a id="story-1-2"></a>Story 1.2: Sign up

Covers FR1.

### <a id="story-1-3"></a>Story 1.3: Task list

Covers UXR1.
`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function project(mode = 'strict') {
  const ctx = makeCore({ team: TEAM.replace('max_parallel: 2', `max_parallel: 2\ntraceability: ${mode}`) });
  fs.mkdirSync(path.join(ctx.root, 'docs', 'design', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(ctx.root, 'docs', 'prd.md'), PRD);
  fs.writeFileSync(path.join(ctx.root, 'docs', 'epics.md'), EPICS);
  fs.writeFileSync(path.join(ctx.root, 'docs', 'design', 'tasks', 'list.png'), Buffer.from(PNG.split(',')[1], 'base64'));
  ctx.core.startDay('you');
  return ctx;
}
function finish(core, id, dev = 'arjun') {
  if (core.ticket(id).status !== 'in_progress') core.claim(dev, id);
  core.submit(dev, id, { summary: 'done', checks: { test: 'pass' } });
  core.review('qa', id, { verdict: 'approve' });
  core.markMerged('lead', id);
}
/** Two screens, the tickets that built them, and a decision on assigning. */
function built(ctx) {
  const { core } = ctx;
  assert.throws(() => core.defineScreen('lead', { title: 'Task list', route: '/tasks' }), /isn't linked to a requirement/);
  core.defineScreen('lead', { title: 'Task list', route: '/tasks', implements: ['Story 1.3', 'UXR1'], mockups: ['docs/design/tasks/list.png'] });
  core.defineScreen('lead', { title: 'Task', route: '/tasks/:id', implements: ['Story 1.1'] });
  assert.throws(() => core.defineScreen('lead', { title: 'Again', route: '/tasks/', implements: ['UXR1'] }), /SCR-1 \(Task list\) already has the route/);
  assert.throws(() => core.defineScreen('lead', { title: 'X', implements: ['UXR1'], mockups: ['docs/design/nope.png'] }), /No mockup at docs\/design\/nope.png/);
  // a UI ticket says which screen it builds; that traces it to the screen's stories
  const list = core.createTicket('lead', { title: 'Build the task list', refs: ['SCR-1'], ui: true }).ticket.id;
  assert.deepEqual(core.index.trace(list).sort(), ['Story 1.3', 'UXR1']);
  const api = core.createTicket('lead', { title: 'Assign API', refs: ['Story 1.1'] }).ticket.id;
  ctx.store.append('ticket.attach', 'lena', { id: list, kind: 'screenshot', path: 'x.png' });
  finish(core, list, 'lena');
  finish(core, api);
  const dec = core.decide('arjun', { title: 'Show the assignee as an avatar', decision: 'Avatar on the card', why: 'Space', refs: ['Story 1.1'] }).id;
  return { list, api, dec };
}

test('screens: routes and mockups find the screen, and a screen traces to its stories', () => {
  const ctx = project();
  const { core } = ctx;
  built(ctx);
  assert.equal(core.screenFor({ route: '/tasks' }).id, 'SCR-1');
  assert.equal(core.screenFor({ route: '/tasks/42?tab=2' }).id, 'SCR-2');
  assert.equal(core.screenFor({ route: '/#/tasks/7' }).id, 'SCR-2', 'hash routing');
  assert.equal(core.screenFor({ route: 'http://localhost:3000/tasks' }).id, 'SCR-1');
  assert.equal(core.screenFor({ mockup: 'docs/design/tasks/list.png' }).id, 'SCR-1');
  assert.equal(core.screenFor({ route: '/settings' }), null);
  const card = core.ref('lead', 'SCR-1');
  assert.equal(card.kind, 'screen');
  assert.equal(card.route, '/tasks');
  assert.deepEqual(card.implements.map((x) => x.id).sort(), ['Story 1.3', 'UXR1']);
  assert.ok(card.tickets.some((x) => x.id === 'APP-1'));
  assert.ok(card.designs.some((x) => x.id === 'docs/design/tasks/list.png'));
  // UXR1's card lists the screens implementing it
  assert.ok(core.ref('lead', 'UXR1').screens.some((x) => x.id === 'SCR-1'));
  const view = core.screensView();
  assert.deepEqual(view.find((x) => x.id === 'SCR-1').built_by, ['APP-1 (done)']);
});

test('comment levels: an element change stays on its screen; a UX change reaches every screen implementing it', () => {
  const ctx = project();
  const { core } = ctx;
  const { list, api } = built(ctx);
  const c = core.feedback({ text: 'Make the add button bigger', route: '/tasks', selector: '#add', snippet: '+ Add' });
  assert.equal(c.screen.id, 'SCR-1', 'the comment lands on its screen');
  const t = core.ticket(c.ticket.id);
  assert.equal(t.where.selector, '#add');
  assert.match(t.body, /Screen: SCR-1 Task list \(\/tasks\)/);
  // not classified yet: nobody starts it, and the lead is told
  assert.throws(() => core.claim('lena', t.id), /nobody has classified/);
  assert.ok(core.index.diagnostics().some((d) => d.code === 'unmapped-change' && d.ids.includes(t.id)));
  assert.throws(() => core.mapChange('lead', t.id, {}), /level is "element"/);
  assert.throws(() => core.mapChange('lead', t.id, { level: 'element', amends: ['UXR1'] }), /amends nothing/);
  const el = core.mapChange('lead', t.id, { level: 'element' });
  assert.equal(el.level, 'element');
  assert.deepEqual(el.affected.screens.map((x) => x.id), ['SCR-1']);
  assert.deepEqual(el.affected.tickets.map((x) => x.id), [list], 'the ticket that built the screen');
  assert.deepEqual(el.affected.designs.map((x) => x.id), ['docs/design/tasks/list.png']);
  assert.match(el.next, /assign APP-\d+ to whoever built the screen \(APP-1 by lena\)/);
  assert.match(el.line, /element change on SCR-1/);
  assert.equal(core.index.mapping(core.ticket(t.id)).mapped, true);
  assert.doesNotThrow(() => core.claim('lena', t.id));
  assert.ok(!core.index.diagnostics().some((d) => d.code === 'unchecked' && d.ids.includes(t.id)), 'an element change agrees nothing new');

  // a UX change: every screen implementing UXR1, their tickets and mockups
  const ux = core.feedback({ text: 'Sort by due date, not newest first', route: '/tasks' });
  const imp = core.mapChange('lead', ux.ticket.id, { level: 'ux', amends: ['UXR1'] });
  assert.deepEqual(imp.affected.screens.map((x) => x.id), ['SCR-1']);
  assert.ok(imp.affected.tickets.some((x) => x.id === list));
  assert.ok(imp.affected.stories.some((x) => x.id === 'Story 1.3'));
  // a story change on the Task screen reaches the API ticket too
  const st = core.feedback({ text: 'Several assignees per task', route: '/tasks/3' });
  const imp2 = core.mapChange('lead', st.ticket.id, { level: 'story', amends: ['FR2'] });
  assert.ok(imp2.affected.tickets.some((x) => x.id === api));
  assert.ok(imp2.affected.screens.some((x) => x.id === 'SCR-2'));
  // comments that amend now count for stale knowledge, like change requests
  assert.ok(core.index.diagnostics().some((d) => d.code === 'done-before-change' && d.ids.includes(api) && d.ids.includes(st.ticket.id)));
});

test('batched comments wait in a review, are planned together, and HQ applies the plan the human approves', () => {
  const ctx = project();
  const { core, notices } = ctx;
  const { list, api, dec } = built(ctx);
  notices.take();
  const c1 = core.feedback({ text: 'Let me assign several people to a task', route: '/tasks/7', batch: true });
  assert.equal(c1.review.id, 'REV-1', 'the first batched comment opens a review');
  const c2 = core.feedback({ text: "Show every assignee's avatar", route: '/tasks/7', batch: true, level: 'story' });
  const c3 = core.feedback({ text: 'Sort by due date', route: '/tasks', batch: true, sketch: PNG });
  const c4 = core.feedback({ text: 'Typo in the header', mockup: 'docs/design/tasks/list.png', x: 10, y: 4, batch: true });
  const [a1, a2, a3, a4] = [c1, c2, c3, c4].map((c) => c.ticket.id);
  assert.equal(c3.sketch, `.madcompany/shots/${a3.toLowerCase()}-sketch-1.png`);
  assert.ok(fs.existsSync(path.join(ctx.root, c3.sketch)));
  assert.equal(c4.screen.id, 'SCR-1', 'a mockup comment lands on the screen that mockup belongs to');
  assert.deepEqual(core.ticket(a4).where, { mockup: 'docs/design/tasks/list.png', x: 10, y: 4 });
  assert.deepEqual(core.reviewView('you', 'REV-1').comments.map((c) => c.id), [a1, a2, a3, a4]);
  // batched: the lead isn't pinged per comment, nothing is ready, nothing nags
  assert.ok(!notices.take().some((n) => n.kind === 'human'));
  assert.ok(!core.status('lead').ready.some((t) => [a1, a2, a3, a4].includes(t.id)));
  assert.throws(() => core.claim('lena', a3), /in review REV-1/);
  assert.ok(!core.index.diagnostics().some((d) => d.code === 'unmapped-change' && [a1, a2, a3, a4].some((x) => d.ids.includes(x))));
  // one comment can be taken out (handled now) and put back
  core.batchComment('you', a4, null);
  assert.equal(core.ticket(a4).batch, null);
  assert.ok(notices.take().some((n) => n.kind === 'human' && n.text.includes(a4)));
  core.batchComment('you', a4, true);
  assert.equal(core.ticket(a4).batch, 'REV-1');
  assert.throws(() => core.planReview('lead', 'REV-1', {}), /still commenting/);

  core.submitReview('you', 'REV-1');
  assert.ok(notices.take().some((n) => n.kind === 'review' && n.text.includes('REV-1')));
  assert.ok(core.index.diagnostics().some((d) => d.code === 'review-to-plan'));
  let view = core.reviewView('lead', 'REV-1');
  assert.ok(view.checks.filter((c) => c.kind === 'unmapped').length === 4);
  assert.deepEqual(view.comments.find((c) => c.id === a1).suggest.screen_implements, ['Story 1.1']);
  assert.deepEqual(view.comments.find((c) => c.id === a3).sketches, [c3.sketch]);

  core.mapChange('lead', a1, { level: 'story', amends: ['FR2'] });
  core.mapChange('lead', a2, { level: 'story', amends: ['FR2'] });
  core.mapChange('lead', a3, { level: 'ux', amends: ['UXR1'] });
  core.mapChange('lead', a4, { level: 'element' });
  view = core.reviewView('lead', 'REV-1');
  const keys = view.checks.map((c) => c.key);
  for (const k of ['overlap:FR2', `rework:${api}`, `rework:${list}`, 'story:Story 1.1', 'story:Story 1.3', `decision:${dec}`]) assert.ok(keys.includes(k), `check ${k}: ${keys}`);
  assert.ok(!keys.some((k) => k.startsWith('unmapped')));
  assert.ok(view.affected.screens.some((x) => x.id === 'SCR-2' && x.comments.includes(a1)));
  // mapping a batched comment doesn't nag about stale work yet: the plan answers for it
  assert.ok(!core.index.diagnostics().some((d) => d.code === 'done-before-change' && d.ids.includes(a1)));

  // a plan that leaves things out is refused, with every gap named
  const bad = (() => {
    try {
      core.planReview('lead', 'REV-1', { summary: 'x', items: [{ comment: a1, action: 'fix' }] });
    } catch (e) {
      return e.message;
    }
  })();
  for (const gap of [`${a2} isn't in the plan`, 'FR2, but the plan gives FR2 no new wording', 'overlap:FR2', `rework:${api}`, `decision:${dec}`]) assert.ok(bad.includes(gap), `${gap} in: ${bad}`);
  assert.throws(() => core.planReview('you', 'REV-1', {}), /the human approves it/);

  const plan = {
    summary: 'Tasks get several assignees (FR2, Story 1.1) and the list sorts by due date (UXR1). The header typo is fixed.',
    items: [
      { comment: a1, action: 'split' },
      { comment: a2, action: 'merge', into: a1 },
      { comment: a3, action: 'fix', assignee: 'lena' },
      { comment: a4, action: 'fix', assignee: 'lena' },
    ],
    amendments: [
      { id: 'FR2', text: 'A task has one or more assignees.', comments: [a1, a2] },
      { id: 'Story 1.1', text: 'Assign one or more people to a task; the card shows every avatar.', comments: [a1] },
      { id: 'UXR1', text: 'Tasks are listed by due date; tapping one opens it.', comments: [a3] },
    ],
    tickets: [
      { title: 'Several assignees in the API', comment: a1, refs: ['Story 1.1'], assignee: 'arjun' },
      { title: 'Avatars for every assignee', comment: a1, refs: ['SCR-2'], ui: true },
    ],
    reopen: [{ ticket: api, reason: 'one assignee becomes several' }],
    resolutions: {
      [`rework:${list}`]: 'Only the sort changes; the fix is the comment itself.',
      'story:Story 1.3': 'Still holds: it points at UXR1.',
      [`decision:${dec}`]: 'Still holds: avatars, now one per assignee.',
    },
  };
  const ok = core.planReview('lead', 'REV-1', plan);
  assert.equal(ok.status, 'proposed');
  assert.ok(core.index.diagnostics().some((d) => d.code === 'review-to-approve'));
  assert.equal(core.dashboard().reviews[0].status, 'proposed');
  assert.throws(() => core.claim('lena', a3), /in review REV-1 \(proposed\)/);
  assert.throws(() => core.decideReview('you', 'REV-1', { verdict: 'revise' }), /Say what should change/);
  core.decideReview('you', 'REV-1', { verdict: 'revise', notes: 'Keep the avatar decision explicit.' });
  assert.equal(core.reviewView('you', 'REV-1').review.status, 'submitted');
  assert.ok(notices.take().some((n) => n.kind === 'review' && n.text.includes('Keep the avatar decision explicit')));
  core.planReview('lead', 'REV-1', plan);

  const out = core.decideReview('you', 'REV-1', { verdict: 'approve' });
  assert.equal(out.status, 'applied');
  assert.deepEqual(out.merged, [`${a2} → ${a1}`]);
  assert.deepEqual(out.reopened, [api]);
  assert.equal(out.tickets.length, 2);
  assert.ok(core.ticket(a2).withdrawn);
  assert.equal(core.ticket(api).status, 'todo');
  assert.equal(core.ticket(a3).assignee, 'lena');
  const t1 = core.ticket(out.tickets[0]);
  assert.deepEqual(t1.refs, [a1, 'Story 1.1']);
  assert.equal(t1.assignee, 'arjun');
  // the new wording is proposed until the comment behind it is done
  assert.equal(core.ref('lead', 'FR2').proposed.text, 'A task has one or more assignees.');
  assert.equal(core.ref('lead', 'FR2').proposed.change, a1);
  // the human's OK is a decision; it settles what the plan answered
  const d = core.store.state.decisions.at(-1);
  assert.match(d.title, /Plan for REV-1 approved/);
  assert.equal(d.by, 'you');
  const diags = core.index.diagnostics();
  assert.ok(!diags.some((x) => x.code === 'done-before-change' && x.ids.includes(list)), 'kept by the plan');
  assert.ok(!diags.some((x) => x.code === 'stale-decision' && x.ids.includes(dec)), 'confirmed by the plan');
  assert.ok(!diags.some((x) => x.code === 'stale-story' && x.ids.includes('Story 1.3')));
  assert.ok(!diags.some((x) => x.code.startsWith('review-')));
  assert.ok(!diags.some((x) => x.code === 'done-before-change' && x.ids.includes(a2)), 'a merged (withdrawn) comment built nothing');
  assert.ok(!diags.some((x) => x.code === 'unchecked' && [a1, a3, 'FR2', 'UXR1'].some((i) => x.ids.includes(i))), 'an approved plan is a consistency review');
  // the work starts now; the sketch goes to whoever does it
  assert.ok(core.status('lead').ready.some((t) => t.id === a3));
  const claimed = core.claim('lena', a3);
  assert.deepEqual(claimed.sketches.files, [c3.sketch]);
  assert.match(claimed.sketches.note, /Open each image/);
  assert.equal(claimed.context.screen.id, 'SCR-1');
  assert.ok(notices.take().some((n) => n.kind === 'review' && n.text.includes('applied')));
});

test('a plan that no longer holds goes back; a discarded review withdraws its comments; the lead relays comments from elsewhere', () => {
  const ctx = project();
  const { core } = ctx;
  const { dec } = built(ctx);
  const c = core.feedback({ text: 'Sort by due date', route: '/tasks', batch: true }).ticket.id;
  core.submitReview('you');
  core.mapChange('lead', c, { level: 'ux', amends: ['UXR1'] });
  const resolutions = { 'rework:APP-1': 'The fix is the comment.', 'story:Story 1.3': 'Still holds.' };
  core.planReview('lead', 'REV-1', { summary: 'Sort by due date.', items: [{ comment: c, action: 'fix' }], amendments: [{ id: 'UXR1', text: 'By due date.', comments: [c] }], resolutions });
  // meanwhile someone decides something on UXR1: the plan doesn't answer it
  const late = core.decide('lead', { title: 'Newest first stays for the archive', decision: 'x', why: 'y', refs: ['UXR1'] }).id;
  const out = core.decideReview('you', 'REV-1', { verdict: 'approve' });
  assert.equal(out.ok, false);
  assert.ok(out.problems.some((p) => p.includes(`decision:${late}`)));
  assert.equal(core.reviewView('lead', 'REV-1').review.status, 'submitted');

  // discard: comments nobody started are withdrawn
  core.feedback({ text: 'Bigger font', route: '/tasks', batch: true });
  const r2 = core.reviewView('you').reviews.find((r) => r.status === 'open');
  core.cancelReview('you', r2.id, 'changed my mind');
  assert.ok(core.store.state.reviews[r2.id].comments.every((x) => core.ticket(x).withdrawn));

  // relayed from a Claude artifact comment: traced the same way, from the human
  assert.throws(() => core.feedback({ text: 'x', sketch: 'data:image/png;base64,PGh0bWw+' }), /isn't a PNG image/);
  assert.throws(() => core.relayComment('lead', { text: 'x' }), /source/);
  assert.throws(() => core.relayComment('arjun', { text: 'x', source: 'chat' }), /lead or the product manager/);
  const relayed = core.relayComment('lead', { text: 'The empty state needs a hint', source: 'https://claude.ai/artifact/abc', route: '/tasks' });
  const rt = core.ticket(relayed.ticket.id);
  assert.equal(rt.from, 'you');
  assert.equal(rt.screen, 'SCR-1');
  assert.match(rt.body, /From: https:\/\/claude.ai\/artifact\/abc/);

  // building on a story can contradict what was decided about it, and another change may be rewording it
  const ext = core.feedback({ text: 'Let me also assign by email address', route: '/tasks/3', batch: true }).ticket.id;
  const rev = core.submitReview('you').review;
  core.mapChange('lead', ext, { level: 'story', extends: ['Story 1.1'] });
  const other = core.change({ text: 'An assignee must be a team member', amends: ['Story 1.1'] }, 'you').ticket.id;
  const checks = core.reviewView('lead', rev).checks;
  assert.ok(checks.some((c) => c.key === `decision:${dec}` && c.text.includes('Story 1.1')), JSON.stringify(checks));
  assert.ok(checks.some((c) => c.key === `pending:${other}` && c.text.includes('builds on')));
  assert.ok(!checks.some((c) => c.kind === 'rework'), 'building on a story leaves built work as it is');
});

test('HQ: screens and reviews in the state, the trace page and the API', async () => {
  const ctx = project();
  built(ctx);
  ctx.core.feedback({ text: 'Bigger add button', route: '/tasks', batch: true });
  const { createHq } = await import('../src/hq/server.js');
  const hq = createHq({ paths: ctx.paths, port: 0, quiet: true });
  await hq.listen();
  const port = hq.server.address().port;
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.json());
  const post = (p, body) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const st = await get('/api/state');
    assert.ok(st.screens['SCR-1']);
    assert.equal(st.reviews['REV-1'].status, 'open');
    assert.ok(st.trace.coverage.requirements.total > 0, 'coverage counts tickets, not screens');
    assert.equal((await get('/api/feedback/review')).review.id, 'REV-1');
    // a comment from HQ with a sketch, on a mockup
    const c = await post('/api/comment', { text: 'Header colour', mockup: 'docs/design/tasks/list.png', x: 20, y: 5, sketch: PNG, batch: true, from: 'someone-else' });
    assert.equal(c.status, 200);
    assert.equal(c.body.screen.id, 'SCR-1');
    assert.ok(c.body.sketch);
    assert.equal(hq.store.state.tickets[c.body.ticket.id].from, null, 'nobody comments as someone else');
    assert.equal((await post('/api/review/submit', { id: 'REV-1' })).status, 200);
    const v = await get('/api/reviews?id=REV-1');
    assert.equal(v.comments.length, 2);
    // the mockup picker is only added when asked, and the mockup stays sandboxed
    fs.writeFileSync(path.join(ctx.root, 'docs', 'design', 'tasks', 'm.html'), '<html><body><button>Add</button></body></html>');
    const res = await fetch(`http://127.0.0.1:${port}/raw/docs/design/tasks/m.html?pick=1`);
    assert.match(res.headers.get('content-security-policy'), /sandbox/);
    assert.match(await res.text(), /<script src="\/pick.js" defer><\/script><\/body>/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/sketch.js`)).status, 200);
    // the readable copies
    hq.views.flush();
    assert.match(fs.readFileSync(path.join(ctx.paths.log, 'screens.md'), 'utf8'), /SCR-1: Task list/);
    assert.match(fs.readFileSync(path.join(ctx.paths.log, 'reviews.md'), 'utf8'), /REV-1/);
  } finally {
    hq.server.close();
  }
});
