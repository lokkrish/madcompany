import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sfPaths } from './paths.js';
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
  g('config', 'user.email', 'demo@storyfront.local');
  g('config', 'user.name', 'Storyfront demo');
  fs.cpSync(path.join(PKG, 'examples', 'tiny-tasks'), root, { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# Tiny Tasks\n\nA demo app planned with BMad Method and built by a Storyfront team.\n');
  const paths = sfPaths(root);
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
  g('commit', '-q', '-m', 'Plan: Tiny Tasks (BMad) + Storyfront setup');

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
  g('branch', 'sf/tt-4');
  core.submit('arjun', 'TT-4', { summary: 'Sessions contract agreed: docs/design/auth/sessions.md', checks: { lint: 'pass', test: 'n/a' } });
  core.review('lead', 'TT-4', { verdict: 'approve', notes: 'Contract is clear.' });
  core.markMerged('cli', 'TT-4', { sha: 'a1b2c3d', commits: ['a1b2c3d docs: sessions contract'] });
  core.decide('arjun', { title: 'JWT in secure storage', decision: 'Store the session token with expo-secure-store', why: 'Tokens must not sit in AsyncStorage (plain text)', alternatives: 'AsyncStorage, cookies', ticket: 'TT-4' });

  core.claim('lena', 'TT-1');
  const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-demo-shots-'));
  wireframePng(path.join(shots, 'signup.png'), { rows: 2 });
  core.attach('lena', 'TT-1', { path: path.join(shots, 'signup.png'), caption: 'Sign-up screen, 390×844' });
  core.ask('lena', { to: 'arjun', question: 'Do you return field-level errors for a taken email?', ticket: 'TT-1' });
  core.answer('arjun', 'Q-1', 'Yes: 409 with {field:"email", code:"taken"}. Added to the contract.');
  g('branch', 'sf/tt-1');
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
  core.memoryWrite('arjun', 'work', '# arjun: work memory\n\n- Owns docs/design/auth/sessions.md (agreed v1)\n- Sessions: bcrypt + JWT, token in expo-secure-store (DEC-1)\n');
  fs.rmSync(shots, { recursive: true, force: true });
  await c.close();
  log(`Demo project ready: ${root}\nRun:  cd ${root} && npx storyfront hq`);
  return root;
}
