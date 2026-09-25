import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build, MODE_PAGES } from '../site/build.mjs';
import { MODES } from '../src/modes.js';

test('the Pages site builds, has a page per workflow, and every link and anchor resolves', () => {
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mc-site-')), '_site');
  const r = build(dest); // throws on any broken link, image or #anchor
  assert.ok(r.pages >= 9);
  for (const [mode, page] of Object.entries(MODE_PAGES)) {
    const html = fs.readFileSync(path.join(dest, `${page}.html`), 'utf8');
    // the steps come from src/modes.js, the same list `npx madcompany mode` prints
    for (const [, command] of MODES[mode].flow) assert.ok(html.includes(command.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')), `${page}: ${command}`);
  }
  assert.ok(fs.existsSync(path.join(dest, 'img', 'hq-human-help.png')));
});
