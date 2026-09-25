import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mcPaths } from '../src/paths.js';
import { parseTeam } from '../src/config.js';
import { Store } from '../src/hq/store.js';
import { createCore } from '../src/hq/core.js';
import { createNotices } from '../src/hq/notices.js';

export const TEAM = `
project:
  name: Demo
  key: APP
max_parallel: 2
limits:
  attempts: 3
  memory_chars: 200
team:
  - id: lead
    role: Tech lead
  - id: arjun
    role: Backend developer
    domain: [Node API, payments]
  - id: lena
    role: Mobile developer
    domain: [Expo screens]
  - id: qa
    role: QA engineer
    domain: [E2E tests]
`;

export function tmpProject({ git = false, team = TEAM } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-test-'));
  if (git) {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  }
  const paths = mcPaths(root);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.team, team);
  return { root, paths };
}

export function makeCore(opts) {
  const { root, paths } = tmpProject(opts);
  const config = parseTeam(fs.readFileSync(paths.team, 'utf8'));
  const store = new Store(paths.events);
  const core = createCore({ store, config, paths });
  const notices = createNotices(core);
  return { root, paths, config, store, core, notices };
}
