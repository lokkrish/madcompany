import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeCore } from './helpers.js';
import { Store } from '../src/hq/store.js';
import { parseTeam } from '../src/config.js';

function started() {
  const ctx = makeCore();
  ctx.core.startDay('you');
  return ctx;
}

test('team.yaml validation', () => {
  assert.throws(() => parseTeam('team: []'), /at least a lead/);
  assert.throws(() => parseTeam('team:\n  - id: Bad\n'), /lowercase/);
  assert.throws(() => parseTeam('team:\n  - id: you\n'), /reserved/);
  assert.throws(() => parseTeam('team:\n  - id: a\n  - id: b\n'), /exactly one lead/);
  const cfg = parseTeam('team:\n  - id: boss\n    lead: true\n  - id: dev\n');
  assert.equal(cfg.leadId, 'boss');
  assert.equal(cfg.team[1].profile, 'developer');
});

test('tickets get sequential IDs and deps must exist and be acyclic', () => {
  const { core } = started();
  const a = core.createTicket('lead', { title: 'API', epic: 'E1' }).ticket;
  const b = core.createTicket('lead', { title: 'Screen', deps: [a.id], ui: true }).ticket;
  assert.equal(a.id, 'APP-1');
  assert.equal(b.id, 'APP-2');
  assert.throws(() => core.createTicket('lead', { title: 'x', deps: ['APP-9'] }), /doesn't exist/);
  assert.throws(() => core.updateTicket('lead', 'APP-1', { deps: ['APP-2'] }), /cycle/);
  assert.throws(() => core.createTicket('arjun', { title: 'x' }), /Only the lead/);
});

test('a ticket cannot start before its dependencies are done', () => {
  const { core } = started();
  core.createTicket('lead', { title: 'API' });
  core.createTicket('lead', { title: 'Screen', deps: ['APP-1'] });
  assert.throws(() => core.claim('lena', 'APP-2'), /depends on APP-1/);
  const pkg = core.claim('arjun', 'APP-1');
  assert.equal(pkg.git.branch, 'mc/app-1');
  assert.equal(pkg.env.db, 'mc_arjun');
  assert.equal(pkg.env.ports.web, 4100 + 2 * 10);
});

test('park and resume: checkpoint required, resumes only when the blocker is done', () => {
  const { core, notices } = started();
  core.createTicket('lead', { title: 'API' });
  core.createTicket('lead', { title: 'Screen', ui: true });
  core.claim('lena', 'APP-2');
  assert.throws(() => core.block('lena', 'APP-2', { blockedBy: ['APP-1'] }), /checkpoint needs/);
  core.block('lena', 'APP-2', { blockedBy: ['APP-1'], done: 'layout', next: 'wire the API call', files: ['app/checkout.tsx'] });
  assert.equal(core.ticket('APP-2').status, 'blocked');
  assert.throws(() => core.claim('lena', 'APP-2'), /still blocked by APP-1/);

  // finish APP-1 through the full gate: submit → review by someone else → merge
  core.claim('arjun', 'APP-1');
  assert.throws(() => core.submit('arjun', 'APP-1', { summary: 'done' }), /Report your checks/);
  assert.throws(() => core.submit('arjun', 'APP-1', { summary: 'done', checks: { test: 'fail' } }), /Fix failing checks/);
  core.submit('arjun', 'APP-1', { summary: 'Payment API', checks: { test: 'pass', lint: 'n/a' } });
  assert.throws(() => core.review('arjun', 'APP-1', { verdict: 'approve' }), /own ticket/);
  assert.throws(() => core.markMerged('lead', 'APP-1'), /approving review/);
  core.review('qa', 'APP-1', { verdict: 'approve' });
  notices.take();
  const res = core.markMerged('lead', 'APP-1', { sha: 'abc123', commits: ['abc123 add api'] });
  assert.deepEqual(res.nowReady, ['APP-2']);
  const ready = notices.take().filter((x) => x.kind === 'ready');
  assert.equal(ready[0].ticket, 'APP-2');

  const pkg = core.claim('lena', 'APP-2');
  assert.equal(pkg.resume_from.next, 'wire the API call');
  assert.equal(core.ticket('APP-2').attempts, 2);
});

test('UI tickets need a screenshot before review', () => {
  const { core, root } = started();
  core.createTicket('lead', { title: 'Screen', ui: true });
  core.claim('lena', 'APP-1');
  assert.throws(() => core.submit('lena', 'APP-1', { summary: 's', checks: { test: 'pass' } }), /attach at least one screenshot/);
  fs.writeFileSync(path.join(root, 'shot.png'), 'png');
  const { path: saved } = core.attach('lena', 'APP-1', { path: 'shot.png', caption: 'checkout' });
  assert.ok(fs.existsSync(path.join(root, saved)));
  assert.throws(() => core.attach('lena', 'APP-1', { path: 'team.txt' }), /Only png/);
  core.submit('lena', 'APP-1', { summary: 's', checks: { test: 'pass' } });
  assert.equal(core.ticket('APP-1').status, 'in_review');
});

test('attempt limit stops endless retries', () => {
  const { core } = started();
  core.createTicket('lead', { title: 'Flaky' });
  for (let i = 0; i < 3; i++) core.claim('arjun', 'APP-1');
  assert.throws(() => core.claim('arjun', 'APP-1'), /limit of 3 attempts/);
});

test('workday controls reach agents and Stop writes the STOP file', () => {
  const { core, paths } = makeCore();
  core.createTicket('lead', { title: 'x' });
  assert.throws(() => core.claim('arjun', 'APP-1'), /WORKDAY_OFF/);
  core.startDay('lead');
  core.claim('arjun', 'APP-1');
  core.requestEndDay('you');
  assert.match(core.log('arjun', 'APP-1', 'progress').control, /END_DAY/);
  assert.throws(() => core.endDay('lead'), /Still working: arjun/);
  core.stopNow('you');
  assert.ok(fs.existsSync(paths.stop));
  assert.match(core.status('arjun').control, /STOP/);
  core.endDay('lead');
  core.startDay('lead');
  assert.ok(!fs.existsSync(paths.stop));
});

test('questions: DMs, human answers become facts, escalation must be multiple-choice', () => {
  const { core, paths, notices } = started();
  const { id } = core.ask('lena', { to: 'arjun', question: 'Which currency field?' });
  assert.equal(id, 'Q-1');
  assert.equal(core.read('arjun').messages.length, 1);
  assert.equal(core.read('arjun').messages.length, 0, 'cursor advances');
  assert.ok(notices.take().some((x) => x.kind === 'wake' && x.agent === 'arjun'));

  assert.throws(() => core.escalate('arjun', { question: 'q', options: ['a', 'b'] }), /Only the lead/);
  assert.throws(() => core.escalate('lead', { question: 'Stripe or Adyen?', options: ['Stripe'] }), /at least 2 options/);
  const esc = core.escalate('lead', { question: 'Stripe or Adyen?', options: ['Stripe', 'Adyen'], recommended: 'Stripe' });
  core.answer('you', esc.id, 'Stripe');
  assert.equal(core.facts().facts.length, 1);
  assert.match(fs.readFileSync(paths.facts, 'utf8'), /F-1.*Stripe or Adyen\? → Stripe/);
});

test('question ping-pong between two agents goes to the lead', () => {
  const { core, notices } = started();
  core.ask('lena', { to: 'arjun', question: 'a?' });
  core.ask('arjun', { to: 'lena', question: 'b?' });
  notices.take();
  core.ask('lena', { to: 'arjun', question: 'c?' });
  assert.ok(notices.take().some((x) => x.kind === 'question' && /ping-pong/.test(x.text)));
});

test('design docs: owner-only edits, agreed once every consumer approves, changes reset it', () => {
  const { core, root } = started();
  assert.throws(() => core.designWrite('arjun', { path: 'src/x.md', content: 'x' }), /docs\/design/);
  core.designWrite('arjun', { path: 'docs/design/payments/api.md', content: '# API', consumers: ['lena', 'qa'] });
  assert.ok(fs.existsSync(path.join(root, 'docs/design/payments/api.md')));
  assert.throws(() => core.designWrite('lena', { path: 'docs/design/payments/api.md', content: 'hack' }), /owned by arjun/);
  core.designApprove('lena', 'docs/design/payments/api.md');
  assert.equal(core.designApprove('qa', 'docs/design/payments/api.md').design.status, 'agreed');
  const again = core.designWrite('arjun', { path: 'docs/design/payments/api.md', content: '# API v2' });
  assert.equal(again.design.status, 'draft');
  assert.equal(again.design.version, 2);
  assert.ok(core.read('lena').messages.some((m) => /Changed: docs\/design\/payments\/api.md/.test(m.text)));
});

test('memory has a size limit that forces compaction', () => {
  const { core } = started();
  assert.throws(() => core.memoryWrite('arjun', 'work', 'x'.repeat(201)), /limit is 200/);
  core.memoryWrite('arjun', 'work', 'Built payment API');
  core.memoryArchive('arjun', 'old detail');
  assert.equal(core.memoryRead('arjun').work, 'Built payment API');
});

test('event log replays to the same state', () => {
  const { core, paths } = started();
  core.createTicket('lead', { title: 'API' });
  core.claim('arjun', 'APP-1');
  core.post('you', { channel: 'general', text: 'hi @arjun' });
  const replay = new Store(paths.events);
  assert.equal(replay.state.tickets['APP-1'].status, 'in_progress');
  assert.equal(replay.state.messages[0].mentions[0], 'arjun');
  assert.equal(replay.state.seq, core.store.state.seq);
});

test('feedback from the preview becomes a UI ticket and pings the lead', () => {
  const { core, notices } = started();
  const res = core.feedback({ text: 'Button too small', route: '/checkout', selector: 'button.pay', viewport: '390x844' });
  const t = core.ticket(res.ticket.id);
  assert.equal(t.kind, 'feedback');
  assert.match(t.body, /Element: `button.pay`/);
  assert.ok(notices.take().some((x) => x.kind === 'human'));
});

test('dashboard summarises team, epics and blocked work', () => {
  const { core } = started();
  core.createTicket('lead', { title: 'API', epic: 'E1', epicTitle: 'Checkout' });
  core.createTicket('lead', { title: 'Screen', epic: 'E1' });
  core.claim('arjun', 'APP-1');
  const dash = core.dashboard();
  assert.equal(dash.epics[0].title, 'Checkout');
  assert.equal(dash.epics[0].total, 2);
  assert.equal(dash.team.find((m) => m.id === 'arjun').status, 'working');
  assert.equal(dash.team.find((m) => m.id === 'arjun').ticket, 'APP-1');
});

test('mc_wait resolves on the next notice', async () => {
  const { core, notices } = started();
  notices.take();
  const p = notices.wait(2000);
  setTimeout(() => core.post('you', { channel: 'general', text: 'hello' }), 20);
  const got = await p;
  assert.equal(got[0].kind, 'human');
  assert.deepEqual(await notices.wait(50), []);
});
