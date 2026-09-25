import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mcPaths } from './paths.js';
import { init, staff } from './setup.js';
import { connect } from './client.js';
import { importBmad } from './bmad/run.js';

const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A tiny PNG "wireframe" so the demo has screenshots without a browser. */
export function wireframePng(file, { accent = [31, 111, 235], rows = 4, button = true } = {}) {
  const w = 390;
  const h = 844;
  const px = Buffer.alloc(w * h * 4, 255);
  const rect = (x, y, rw, rh, [r, g, b]) => {
    for (let j = y; j < Math.min(h, y + rh); j++) for (let i = x; i < Math.min(w, x + rw); i++) px.set([r, g, b, 255], (j * w + i) * 4);
  };
  rect(0, 0, w, 96, accent);
  rect(20, 50, 160, 18, [255, 255, 255]);
  for (let k = 0; k < rows; k++) {
    rect(20, 130 + k * 110, w - 40, 92, [240, 242, 245]);
    rect(36, 148 + k * 110, 180, 14, [140, 149, 159]);
    rect(36, 172 + k * 110, 240, 10, [200, 205, 212]);
  }
  if (button) rect(20, h - 110, w - 40, 56, accent);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let j = 0; j < h; j++) px.copy(raw, j * (w * 4 + 1) + 1, j * w * 4, (j + 1) * w * 4);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** Put one commit on a ticket branch without touching the checkout. */
function demoCommit(root, branch, file) {
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: `// ${branch}\n`, encoding: 'utf8' }).trim();
  const tmpIndex = path.join(os.tmpdir(), `mc-demo-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  execFileSync('git', ['read-tree', 'HEAD'], { cwd: root, env });
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { cwd: root, env });
  const tree = execFileSync('git', ['write-tree'], { cwd: root, env, encoding: 'utf8' }).trim();
  const commit = execFileSync('git', ['commit-tree', tree, '-p', 'HEAD', '-m', `${branch}: demo work`], { cwd: root, encoding: 'utf8' }).trim();
  g('branch', '-f', branch, commit);
  fs.rmSync(tmpIndex, { force: true });
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * Create a demo project with a BMad plan and a day of simulated team
 * activity, so you can explore HQ before running a real team.
 */
export async function createDemo(dir, { log = console.log } = {}) {
  const root = path.resolve(dir);
  if (fs.existsSync(root) && fs.readdirSync(root).length) throw new Error(`${root} isn't empty.`);
  fs.mkdirSync(root, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'ignore' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'demo@madcompany.local');
  g('config', 'user.name', 'madcompany demo');
  fs.cpSync(path.join(PKG, 'examples', 'tiny-tasks'), root, { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Tiny Tasks\n\nA demo app planned with BMad Method and built by a madcompany team.\n');
  const paths = mcPaths(root);
  init(paths, { log: () => {} });
  fs.writeFileSync(
    paths.team,
    fs
      .readFileSync(paths.team, 'utf8')
      .replace('name: My app', 'name: Tiny Tasks')
      .replace('key: APP', 'key: TT'),
  );
  staff(paths, { log: () => {} });
  g('add', '-A');
  g('commit', '-q', '-m', 'Plan: Tiny Tasks (BMad) + madcompany setup');

  const c = await connect(paths);
  const call = (op, ...a) => c.call(op, ...a);
  await importBmad(paths, c, { log: () => {} });
  const core = c.core; // demo runs with HQ off, straight on the log
  core.startDay('lead');
  core.createTicket('lead', { title: 'Session API contract (OpenAPI)', epic: 'E1', domain: 'Node API', refs: ['FR1'], body: 'Design pack for sign-up and sessions.' });
  core.updateTicket('lead', 'TT-2', { deps: ['TT-4'], domain: 'Node API' });
  core.updateTicket('lead', 'TT-1', { domain: 'Expo screens' });
  core.updateTicket('lead', 'TT-3', { domain: 'Expo screens', ui: true, deps: [] }); // UI first: build on mock data

  core.claim('arjun', 'TT-4');
  core.designWrite('arjun', {
    path: 'docs/design/auth/sessions.md',
    consumers: ['lena'],
    content: '# Sessions API\n\nCovers [FR1](../../../_bmad-output/planning-artifacts/prd.md#fr1).\n\n```mermaid\nsequenceDiagram\n  App->>API: POST /sessions {email, password}\n  API-->>App: 201 {token}\n```\n\n| Method | Path | Body | Returns |\n|---|---|---|---|\n| POST | /users | email, password | 201 user |\n| POST | /sessions | email, password | 201 token |\n',
  });
  core.designApprove('lena', 'docs/design/auth/sessions.md');
  demoCommit(root, 'mc/tt-4', 'docs/design/auth/.keep');
  core.submit('arjun', 'TT-4', { summary: 'Sessions contract agreed: docs/design/auth/sessions.md', checks: { lint: 'pass', test: 'n/a' } });
  core.review('lead', 'TT-4', { verdict: 'approve', notes: 'Contract is clear.' });
  core.markMerged('cli', 'TT-4', { sha: 'a1b2c3d', commits: ['a1b2c3d docs: sessions contract'] });
  core.decide('arjun', { title: 'JWT in secure storage', decision: 'Store the session token with expo-secure-store', why: 'Tokens must not sit in AsyncStorage (plain text)', alternatives: 'AsyncStorage, cookies', ticket: 'TT-4' });

  core.claim('lena', 'TT-1');
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-demo-shots-'));
  wireframePng(path.join(shots, 'signup.png'), { rows: 2 });
  core.attach('lena', 'TT-1', { path: path.join(shots, 'signup.png'), caption: 'Sign-up screen, 390×844' });
  core.ask('lena', { to: 'arjun', question: 'Do you return field-level errors for a taken email?', ticket: 'TT-1' });
  core.answer('arjun', 'Q-1', 'Yes: 409 with {field:"email", code:"taken"}. Added to the contract.');
  demoCommit(root, 'mc/tt-1', 'app/signup.tsx');
  core.submit('lena', 'TT-1', { summary: 'Sign-up screen with validation, mock API client', checks: { typecheck: 'pass', lint: 'pass', test: 'pass' } });
  core.review('qa', 'TT-1', { verdict: 'approve', notes: 'Checked on 390 and 820 widths.' });
  core.markMerged('cli', 'TT-1', { sha: 'e4f5a6b', commits: ['e4f5a6b feat(signup): screen + validation'] });

  core.claim('arjun', 'TT-2');
  core.log('arjun', 'TT-2', 'POST /sessions done with bcrypt + JWT; writing tests');
  core.claim('lena', 'TT-3');
  wireframePng(path.join(shots, 'tasks.png'), { rows: 5, button: false, accent: [130, 80, 223] });
  core.attach('lena', 'TT-3', { path: path.join(shots, 'tasks.png'), caption: 'Task list, empty and filled states' });
  core.block('lena', 'TT-3', { blockedBy: ['TT-2'], done: 'List UI and empty state against mock data', next: 'Replace mock client with real /tasks once sessions land', files: ['app/(tabs)/tasks.tsx'] });
  core.escalate('lead', { question: 'Should unfinished tasks roll over to the next day automatically?', options: ['Yes, roll over', 'No, leave them on their date', 'Ask the user each morning'], recommended: 'Yes, roll over', links: ['FR2'] });
  core.post('lead', { channel: 'general', text: 'Morning: TT-2 (sessions) in progress with @arjun; TT-3 parked until it lands. One question for you in the Inbox.' });
  core.post('qa', { channel: 'ticket:TT-1', text: 'Approved. Error message for taken email matches the contract in docs/design/auth/sessions.md' });
  core.minutes('lead', {
    title: 'Planning kickoff with the PM and architect agents',
    kind: 'planning',
    attendees: ['you', 'BMad PM agent', 'BMad architect agent', 'lead'],
    summary: 'Agreed the MVP scope for Tiny Tasks: sign-up, a daily task list and adding tasks. Offline sync and reminders wait until after the MVP.',
    keyPoints: ['You want to add a task in under 5 seconds', 'Phone first; the web version can come later', 'Keep reminders out of the MVP'],
    decisions: ['Stack: Expo + Node (Fastify) + Postgres on Azure', 'Email and password sign-up only for now'],
    actions: [{ what: 'Write the PRD and epics', who: 'BMad PM agent' }, { what: 'Staff the team and plan Epic 1', who: 'lead' }],
    openQuestions: ['Do unfinished tasks roll over to the next day?'],
    links: ['[PRD](_bmad-output/planning-artifacts/prd.md)', '[Architecture](_bmad-output/planning-artifacts/architecture.md)'],
    source: 'Claude Code planning session',
  });
  core.minutes('lead', {
    title: 'UI sprint: sign-up and task list',
    kind: 'ui-sprint',
    attendees: ['you', 'maya', 'lena', 'lead'],
    summary: 'Reviewed design directions A and B in Preview. You picked A (blue) and asked for a bigger New task button. The sign-up screen is signed off.',
    keyPoints: ['Direction A (blue) chosen', 'New task button must be thumb-reachable'],
    decisions: ['UI signed off for Story 1.1', 'API contract written to docs/design/auth/sessions.md'],
    actions: [{ what: 'Wire the sign-up screen to the sessions API', who: 'lena' }],
    links: ['[Design directions](_bmad-output/planning-artifacts/ux-design-directions.html)', '[Sessions contract](docs/design/auth/sessions.md)'],
  });
  core.addLink('you', { title: 'Tiny Tasks: clickable prototype (Claude artifact)', url: 'https://claude.ai/code/artifact/0b7d5c2e-demo-prototype', note: 'The prototype from the ideation session' });
  core.addLink('maya', { title: 'Tiny Tasks: design system (Figma)', url: 'https://www.figma.com/design/demo/tiny-tasks-design-system' });
  core.post('maya', { channel: 'general', text: 'Competitor teardown I used for the empty state: https://claude.ai/code/artifact/5f1e9a44-demo-teardown' });
  core.memoryWrite('arjun', 'work', '# arjun: work memory\n\n- Owns docs/design/auth/sessions.md (agreed v1)\n- Sessions: bcrypt + JWT, token in expo-secure-store (DEC-1)\n');
  fs.rmSync(shots, { recursive: true, force: true });
  await c.close();
  log(`Demo project ready: ${root}\nRun:  cd ${root} && npx madcompany hq`);
  return root;
}
