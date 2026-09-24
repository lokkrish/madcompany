import { normalizeKey } from './ids.js';

// An ID at the start of a line, followed by ":" "." "-" or ")" — that's a definition.
const ID = String.raw`(Epic\s+\d+|Story\s+\d+\.\d+|(?:FR|NFR|UXR|AR)-?\d+|[A-Z][A-Z0-9]{1,9}-\d+)`;
const HEADING = new RegExp(String.raw`^(#{1,6}\s+)(\**)${ID}(\**)(\s*[:.\-–—)]|\s*$)`);
const ITEM = new RegExp(String.raw`^(\s*(?:[-*+]|\d+\.)\s+)?(\**)${ID}(\**)(\s*[:.\-–—)])`);
const ROW = new RegExp(String.raw`^(\|\s*)(\**)${ID}(\**)(\s*\|)`);

/**
 * Add a stable <a id="..."></a> anchor to every line that defines an ID
 * (requirements, epics, stories). Safe to run repeatedly.
 */
export function anchorMarkdown(md) {
  const added = [];
  const seen = new Set();
  let fence = false;
  const lines = md.split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      return line;
    }
    if (fence) return line;
    for (const re of [HEADING, ROW, ITEM]) {
      const m = re.exec(line);
      if (!m) continue;
      const key = normalizeKey(m[3]);
      if (line.includes(`<a id="${key}"`) || seen.has(key)) return line;
      seen.add(key);
      added.push(key);
      const prefix = m[1] ?? '';
      return `${prefix}<a id="${key}"></a>${line.slice(prefix.length)}`;
    }
    for (const m of line.matchAll(/<a id="([a-z0-9-]+)"><\/a>/g)) seen.add(m[1]);
    return line;
  });
  return { text: lines.join('\n'), added };
}
