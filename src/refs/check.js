import path from 'node:path';
import { MENTION, normalizeKey } from './ids.js';

/**
 * Walk the prose parts of a markdown document (not code, not existing links)
 * and call fn for each ID mention that the registry knows about.
 */
function eachMention(md, registry, fn) {
  let fence = false;
  return md.split('\n').map((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return line;
    }
    if (fence) return line;
    // protect inline code, links, images and anchors from rewriting
    const protectedParts = [];
    const masked = line.replace(/`[^`]*`|!?\[[^\]]*\]\([^)]*\)|<a [^>]*><\/a>|<[^>]+>|https?:\/\/\S+/g, (m) => {
      protectedParts.push(m);
      return `\u0000${protectedParts.length - 1}\u0000`;
    });
    const definedHere = new Set([...line.matchAll(/<a id="([a-z0-9-]+)">/g)].map((m) => m[1]));
    const replaced = masked.replace(MENTION, (text, offset) => {
      const key = normalizeKey(text);
      if (!registry[key] || definedHere.has(key)) return text;
      return fn({ text, key, line: i + 1, col: offset + 1, entry: registry[key] }) ?? text;
    });
    return replaced.replace(/\u0000(\d+)\u0000/g, (_, n) => protectedParts[Number(n)]);
  });
}

export function findBareRefs(md, registry) {
  const found = [];
  eachMention(md, registry, (m) => {
    found.push({ id: m.text, key: m.key, line: m.line, col: m.col });
  });
  return found;
}

/** Relative markdown link from one repo file to a registry entry. */
export function hrefFromFile(fromFile, entry) {
  if (entry.file) {
    const rel = path.posix.relative(path.posix.dirname(fromFile), entry.file) || path.posix.basename(entry.file);
    return `${rel}#${entry.anchor}`;
  }
  return null;
}

export function fixBareRefs(md, registry, fromFile) {
  let count = 0;
  const text = eachMention(md, registry, (m) => {
    const href = hrefFromFile(fromFile, m.entry);
    if (!href) return null;
    count += 1;
    return `[${m.text}](${href})`;
  }).join('\n');
  return { text, count };
}

/** For HQ's file viewer: every known ID becomes a link inside the app. */
export function linkifyForHq(md, registry) {
  return eachMention(md, registry, (m) => {
    const href = m.entry.hq ?? `#/file/${m.entry.file}?a=${m.entry.anchor}`;
    return `[${m.text}](${href} "${(m.entry.title ?? '').replace(/"/g, "'")}")`;
  }).join('\n');
}
