import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeCore, TEAM } from './helpers.js';
import { parseTeam } from '../src/config.js';
import { shipUnit } from '../src/git.js';
import { scanProject } from '../src/scan.js';
import { setMode, init } from '../src/setup.js';

const RELEASE_TEAM = TEAM.replace('max_parallel: 2', 'max_parallel: 2\nmode: ui-mvp\ndeploy: [Vercel deploys main]');

// the full ticket gate, so tests read like the real flow
function finish(core, id, dev = 'arjun', reviewer = 'qa') {
  core.claim(dev, id);
  core.submit(dev, id, { summary: 'done', checks: { test: 'pass' } });
  core.review(reviewer, id, { verdict: 'approve' });
  core.markMerged('cli', id);
}

test('modes: validated, spec by default for older projects, ui-mvp in new ones', () => {
  assert.equal(parseTeam(TEAM).mode, 'spec');
  assert.throws(() => parseTeam(TEAM.replace('max_parallel: 2', 'mode: waterfall')), /mode must be one of/);
  const { paths, root } = makeCore({ git: true });
  init(paths, { log: () => {}, skills: false, mode: 'brownfield' });
  assert.match(fs.readFileSync(paths.team, 'utf8'), /mode: brownfield/);
  setMode(paths, 'mvp');
  const agent = fs.readFileSync(path.join(root, '.claude', 'agents', 'mc-arjun.md'), 'utf8');
  assert.match(agent, /## How this project is built: MVP-driven/);
});

test('releases: tickets join the current release, merge into release/rN, and need your review', () => {
  const { core, notices } = makeCore({ team: RELEASE_TEAM });
  core.startDay('lead');
  assert.throws(() => core.planRelease('lead', { title: 'MVP screens' }), /needs a title and a goal/);
  const r1 = core.planRelease('lead', { title: 'MVP screens', goal: 'Click through sign-up and the task list on mock data' }).release;
  assert.equal(r1.id, 'R1');
  const t = core.createTicket('lead', { title: 'Task list screen', ui: false }).ticket;
  assert.equal(t.release, 'R1', 'new tickets join the current release');
  assert.equal(core.claim('arjun', t.id).git.base, 'release/r1');
  core.submit('arjun', t.id, { summary: 'done', checks: { test: 'pass' } });
  assert.throws(() => core.readyForReview('lead', 'R1'), /still has open tickets/);
  core.review('qa', t.id, { verdict: 'approve' });
  core.markMerged('cli', t.id);

  core.readyForReview('lead', 'R1');
  assert.equal(core.units()[0].status, 'review');
  assert.throws(() => core.reviewUnit('lead', 'R1', { verdict: 'approve' }), /Only a person/);
  assert.throws(() => core.reviewUnit('you', 'R1', { verdict: 'changes' }), /Say what should change/);

  // changes go back to the team as a ticket in the same release
  const ch = core.reviewUnit('you', 'R1', { verdict: 'changes', notes: 'Make the empty state friendlier' });
  assert.equal(core.ticket(ch.ticket).release, 'R1');
  assert.equal(core.units()[0].status, 'building');
  assert.ok(notices.all().some((n) => n.kind === 'release' && /asked for changes to R1/.test(n.text)));
  finish(core, ch.ticket);
  core.readyForReview('lead', 'R1');
  const ok = core.reviewUnit('you', 'R1', { verdict: 'approve' });
  assert.equal(ok.status, 'approved');
  assert.ok(fs.existsSync(path.join(core.paths.root, '.madcompany/releases/r1.md')), 'release notes are written');
  assert.ok(notices.all().some((n) => n.kind === 'release' && /npx madcompany ship R1/.test(n.text)));

  // the next release becomes current
  core.planRelease('lead', { title: 'Working MVP', goal: 'Sign up and add a task for real' });
  assert.equal(core.createTicket('lead', { title: 'Tasks API' }).ticket.release, 'R2');
});

test('human help: filed by agents, deduplicated, blocks and resumes tickets, checks .env without reading values', () => {
  const { core, notices, root } = makeCore({ team: RELEASE_TEAM });
  core.startDay('lead');
  core.planRelease('lead', { title: 'Payments', goal: 'Pay for a plan' });
  const t = core.createTicket('lead', { title: 'Checkout API' }).ticket;
  core.claim('arjun', t.id);
  const h = core.requestHelp('arjun', {
    title: 'Create a Stripe account and test API keys',
    kind: 'secret',
    service: 'Stripe',
    why: 'Checkout needs real test payments',
    steps: ['Sign up at https://dashboard.stripe.com/register', 'Developers → API keys → copy the test secret key', 'Add STRIPE_SECRET_KEY=… to .env'],
    env: ['STRIPE_SECRET_KEY'],
    tickets: [t.id],
  });
  assert.equal(h.id, 'HELP-1');
  assert.throws(() => core.requestHelp('arjun', { title: 'x', env: ['not a key'] }), /environment variable/);
  const again = core.requestHelp('lena', { title: 'Stripe keys please', kind: 'secret', service: 'stripe' });
  assert.equal(again.id, 'HELP-1', 'same service and kind is the same request');
  assert.ok(notices.all().some((n) => n.kind === 'help'));

  core.block('arjun', t.id, { blockedBy: ['HELP-1'], done: 'mock adapter', next: 'switch to the live Stripe client' });
  assert.throws(() => core.claim('arjun', t.id), /still blocked by HELP-1/);
  assert.equal(core.dashboard().help.blocking, 1);

  assert.throws(() => core.helpDone('arjun', 'HELP-1'), /Only a person/);
  assert.throws(() => core.helpDone('you', 'HELP-1'), /Not found in \.env or \.env\.local: STRIPE_SECRET_KEY/);
  fs.writeFileSync(path.join(root, '.env.local'), '# test keys\nexport STRIPE_SECRET_KEY="sk_test_123"\nEMPTY=\n');
  assert.deepEqual(core.envStatus(['STRIPE_SECRET_KEY', 'EMPTY', 'NOPE']), { STRIPE_SECRET_KEY: true, EMPTY: false, NOPE: false });
  const view = core.helpView()[0];
  assert.deepEqual(view.envSet, { STRIPE_SECRET_KEY: true });
  assert.ok(!JSON.stringify(view).includes('sk_test'), 'values never leave the file');
  assert.deepEqual(view.waiting, [t.id]);

  const done = core.helpDone('you', 'HELP-1', { note: 'Test keys added' });
  assert.deepEqual(done.canResume, [t.id]);
  assert.ok(notices.all().some((n) => n.kind === 'ready' && n.ticket === t.id && /HELP-1 done/.test(n.text)));
  assert.equal(core.claim('arjun', t.id).resolved_blockers[0].note, 'Test keys added');

  // mark done anyway when the key lives somewhere HQ doesn't look
  core.requestHelp('lead', { title: 'Buy the domain', kind: 'money', env: ['DOMAIN_TOKEN'] });
  assert.equal(core.helpDone('you', 'HELP-2', { force: true }).ok, true);
});

test('ship: merges an approved release into main, tags it and hands push and deploy to you', async () => {
  const { core, root, paths, config } = makeCore({ git: true, team: RELEASE_TEAM });
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(root, 'app.txt'), 'v0\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  core.startDay('lead');
  core.planRelease('lead', { title: 'MVP screens', goal: 'Clickable', version: 'v0.1.0' });
  const t = core.createTicket('lead', { title: 'Screens' }).ticket;
  // the agent's work on its ticket branch, then the merge queue's merge into release/r1
  g('branch', 'release/r1');
  g('switch', '-q', '-c', 'mc/app-1');
  fs.writeFileSync(path.join(root, 'app.txt'), 'v1\n');
  g('commit', '-qam', 'screens');
  g('switch', '-q', 'main');
  const client = { call: async (op, ...args) => core[op](...args) };

  await assert.rejects(shipUnit(paths, client, config, 'R1', { log: () => {} }), /ships after you approve it/);
  finish(core, t.id);
  g('branch', '-f', 'release/r1', 'mc/app-1');
  core.readyForReview('lead', 'R1');
  core.reviewUnit('you', 'R1', { verdict: 'approve' });

  fs.writeFileSync(path.join(root, 'app.txt'), 'dirty\n');
  await assert.rejects(shipUnit(paths, client, config, 'R1', { log: () => {} }), /uncommitted changes/);
  g('checkout', '--', 'app.txt');
  fs.appendFileSync(paths.events, ''); // HQ's own files never block a ship

  const out = await shipUnit(paths, client, config, 'R1', { log: () => {} });
  assert.equal(out.tag, 'v0.1.0');
  assert.equal(fs.readFileSync(path.join(root, 'app.txt'), 'utf8'), 'v1\n');
  assert.equal(g('tag', '--list', 'v0.1.0'), 'v0.1.0');
  assert.equal(core.units()[0].status, 'shipped');
  const help = core.helpView().find((h) => h.id === out.help);
  assert.equal(help.kind, 'ship');
  assert.ok(help.steps.some((x) => x.includes('git push origin main && git push origin v0.1.0')));
  assert.ok(help.steps.includes('Vercel deploys main'), 'your deploy steps from team.yaml');
});

test('scan: finds the stack, checks, services and env keys of an existing codebase', () => {
  const { root } = makeCore();
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'shop', scripts: { typecheck: 'tsc --noEmit', lint: 'eslint .', test: 'vitest run' }, dependencies: { next: '15', stripe: '17', '@supabase/supabase-js': '2' }, devDependencies: { vitest: '3', typescript: '5' } }),
  );
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), '');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  fs.writeFileSync(path.join(root, '.env.example'), 'STRIPE_SECRET_KEY=\nNEXT_PUBLIC_SUPABASE_URL=\n');
  fs.mkdirSync(path.join(root, 'src', 'app'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app', 'page.tsx'), '');
  const r = scanProject(root);
  assert.deepEqual(r.checks, ['pnpm run typecheck', 'pnpm run lint', 'pnpm test']);
  assert.deepEqual(r.languages, ['TypeScript']);
  assert.ok(r.frameworks.includes('Next.js') && r.frameworks.includes('Vitest'));
  assert.deepEqual(r.services, ['Stripe', 'Supabase']);
  assert.deepEqual(r.env.keys, ['STRIPE_SECRET_KEY', 'NEXT_PUBLIC_SUPABASE_URL']);
  assert.equal(r.folders[0].path, 'src');
});
