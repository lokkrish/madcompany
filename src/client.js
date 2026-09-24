import fs from 'node:fs';
import { loadConfig } from './config.js';
import { Store } from './hq/store.js';
import { createCore } from './hq/core.js';
import { createViewWriter } from './hq/views.js';
import { buildRegistry, writeRegistry } from './refs/ids.js';

/**
 * CLI commands go through the running HQ when there is one (it's the only
 * writer of the event log). With HQ off, the CLI opens the log itself.
 */
export async function connect(paths) {
  const lock = readLock(paths);
  if (lock && alive(lock.pid)) {
    const base = `http://127.0.0.1:${lock.port}`;
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return httpClient(base);
    } catch {
      // stale lock
    }
    throw new Error(`HQ looks like it is running (pid ${lock.pid}, port ${lock.port}) but isn't answering. Stop it, or delete ${paths.lock}.`);
  }
  return localClient(paths);
}

export function readLock(paths) {
  try {
    return JSON.parse(fs.readFileSync(paths.lock, 'utf8'));
  } catch {
    return null;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function httpClient(base) {
  return {
    remote: true,
    base,
    async call(op, ...args) {
      const res = await fetch(`${base}/api/cli`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-storyfront-cli': '1' }, body: JSON.stringify({ op, args }) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? res.statusText);
      return out;
    },
    async close() {
      await fetch(`${base}/api/refresh-ids`, { method: 'POST', headers: { 'x-storyfront-cli': '1' } }).catch(() => {});
    },
  };
}

function localClient(paths) {
  const config = loadConfig(paths);
  const store = new Store(paths.events);
  const core = createCore({ store, config, paths });
  return {
    remote: false,
    core,
    async call(op, ...args) {
      return core[op](...args);
    },
    async close() {
      createViewWriter(core).flush();
      writeRegistry(paths.ids, buildRegistry(paths.root));
    },
  };
}
