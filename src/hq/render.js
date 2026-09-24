import path from 'node:path';
import { Marked } from 'marked';
import { linkifyForHq } from '../refs/check.js';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Render a repo markdown file for HQ's viewer. Raw HTML is escaped except
 * our own <a id="..."></a> anchors; relative links open inside HQ.
 */
export function renderMarkdown(md, { file, registry = {} }) {
  const dir = path.posix.dirname(file);
  const marked = new Marked({
    gfm: true,
    renderer: {
      html({ text }) {
        // marked hands us inline tags one at a time, so allow the opening and closing halves separately
        return text.replace(/<a id="([a-z0-9-]+)">|<\/a>|[^]/g, (m, id) => (id ? `<a id="${id}" class="anchor">` : m === '</a>' ? m : escapeHtml(m)));
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        let url = href ?? '';
        let external = false;
        if (/^https?:\/\//i.test(url)) external = true;
        else if (url.startsWith('#/')) {
          // already an HQ route
        } else if (url.startsWith('#')) {
          url = `#/file/${file}?a=${encodeURIComponent(url.slice(1))}`;
        } else if (/^[a-z]+:/i.test(url)) {
          url = '#'; // javascript:, data:, etc.
        } else {
          const [p, a] = url.split('#');
          const target = path.posix.normalize(path.posix.join(dir, decodeURIComponent(p)));
          url = `#/file/${target}${a ? `?a=${encodeURIComponent(a)}` : ''}`;
        }
        const t = title ? ` title="${escapeHtml(title)}"` : '';
        return `<a href="${escapeHtml(url)}"${t}${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${label}</a>`;
      },
      image({ href, text }) {
        if (/^https?:\/\//i.test(href)) return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(text || href)}</a>`;
        const target = path.posix.normalize(path.posix.join(dir, href));
        return `<img alt="${escapeHtml(text)}" src="/raw/${encodeURI(target)}">`;
      },
    },
  });
  return marked.parse(linkifyForHq(md, registry));
}

export function renderCode(text) {
  return text
    .split('\n')
    .map((l, i) => `<div class="ln" id="L${i + 1}"><span class="n">${i + 1}</span>${escapeHtml(l) || ' '}</div>`)
    .join('');
}

export { escapeHtml };
