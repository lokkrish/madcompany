import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './paths.js';

/**
 * Sign-in links for the people who use HQ. Only a SHA-256 hash of each
 * token is kept, in .madcompany/run/access.json (git-ignored). A new link
 * for a person replaces their old one.
 */
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

export function createAccess(paths) {
  const file = path.join(paths.run, 'access.json');
  const load = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { tokens: {} };
    }
  };
  const save = (a) => {
    ensureDir(paths.run);
    fs.writeFileSync(file, JSON.stringify(a, null, 1), { mode: 0o600 });
  };
  return {
    issue(person) {
      const token = crypto.randomBytes(32).toString('base64url');
      const a = load();
      for (const [h, v] of Object.entries(a.tokens)) if (v.person === person) delete a.tokens[h];
      a.tokens[hash(token)] = { person, created: new Date().toISOString() };
      save(a);
      return token;
    },
    verify(token) {
      if (!token || typeof token !== 'string' || token.length > 200) return null;
      return load().tokens[hash(token)]?.person ?? null;
    },
    revoke(person) {
      const a = load();
      for (const [h, v] of Object.entries(a.tokens)) if (v.person === person) delete a.tokens[h];
      save(a);
    },
    hasLink(person) {
      return Object.values(load().tokens).some((v) => v.person === person);
    },
  };
}

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
