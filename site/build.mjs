#!/usr/bin/env node
/**
 * Builds the GitHub Pages site into _site/ from site/pages/*.md.
 * The steps and release ladders for each workflow come from src/modes.js,
 * the same place `npx madcompany mode` reads them, so the site can't drift
 * from what the CLI prints. Fails on any broken link or missing image.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { MODES } from '../src/modes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const out = path.resolve(process.argv[2] ?? path.join(repo, '_site'));
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const GITHUB = 'https://github.com/lokkrish/madcompany';

// page file for each mode
export const MODE_PAGES = { ui: 'ui-driven', mvp: 'mvp-driven', 'ui-mvp': 'ui-mvp', brownfield: 'brownfield', spec: 'spec-driven' };

const NAV = [
  ['index', 'Overview'],
  ['workflows', 'Workflows'],
  ['human-help', 'Human help'],
  ['mcp-and-plugins', 'MCP & plugins'],
  ['commands', 'Commands'],
];

// GitHub-style heading ids, so #quick-start and page.html#steps work
const slug = (t) => String(t).toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^\w\- ]/g, '').trim().replace(/ /g, '-');
marked.use({
  renderer: {
    heading({ tokens, depth, text }) {
      return `<h${depth} id="${slug(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
    },
  },
});

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const inline = (s) => marked.parseInline(String(s));
const WHERE = { Terminal: 'term', 'Claude Code': 'cc', HQ: 'hq' };

function steps(name) {
  const m = MODES[name];
  return `<ol class="steps">${m.flow
    .map(([where, command, what]) => `<li><span class="where ${WHERE[where]}">${esc(where)}</span><div><code>${esc(command)}</code><p>${inline(what)}</p></div></li>`)
    .join('')}</ol>`;
}

function ladder(name) {
  const m = MODES[name];
  const label = (i) => (m.unit === 'release' ? `R${i + 1}${i === m.ladder.length - 1 ? '+' : ''}` : 'Each epic');
  return `<div class="ladder">${m.ladder.map(([title, what], i) => `<div><span class="rn">${label(i)}</span><b>${esc(title)}</b><p>${esc(what)}</p></div>`).join('<span class="arrow" aria-hidden="true">→</span>')}</div>`;
}

function modeCards() {
  return `<div class="cards">${Object.entries(MODES)
    .map(
      ([k, m]) => `<a class="card mode" href="${MODE_PAGES[k]}.html"><span class="unit ${m.unit}">${m.unit === 'release' ? 'Release by release' : 'Epic by epic'}</span><h3>${esc(m.title)}</h3><p>${esc(m.for)}</p><p class="first">${m.unit === 'release' ? `<b>First release:</b> ${esc(m.ladder[0][0])}` : '<b>Delivers:</b> one epic at a time, approved at its demo'}</p><code>init --mode ${esc(k)}</code></a>`,
    )
    .join('')}</div>`;
}

function expand(md) {
  return md
    .replace(/<!--\s*steps:([a-z-]+)\s*-->/g, (_, n) => steps(n))
    .replace(/<!--\s*ladder:([a-z-]+)\s*-->/g, (_, n) => ladder(n))
    .replace(/<!--\s*modes\s*-->/g, () => modeCards())
    .replace(/<!--\s*version\s*-->/g, pkg.version);
}

function frontMatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  const meta = {};
  if (m) for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m ? text.slice(m[0].length) : text };
}

function layout({ name, meta, html }) {
  const nav = NAV.map(([p, label]) => `<a href="${p}.html"${p === name || (p === 'workflows' && Object.values(MODE_PAGES).includes(name)) ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title ?? 'madcompany')}</title>
<meta name="description" content="${esc(meta.description ?? pkg.description)}">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="style.css">
</head>
<body class="page-${esc(name)}">
<header class="top"><div class="wrap"><a class="brand" href="index.html"><img src="icon.svg" alt="" width="24" height="24"> madcompany</a><nav aria-label="Site">${nav}<a href="${GITHUB}">GitHub</a></nav></div></header>
<main class="wrap">${html}</main>
<footer><div class="wrap">madcompany ${esc(pkg.version)} · MIT · <a href="${GITHUB}">Source on GitHub</a> · Compatible with BMad Method v6; not affiliated with BMad Code, LLC.</div></footer>
</body>
</html>
`;
}

export function build(dest = out) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.join(dest, 'img'), { recursive: true });
  const pagesDir = path.join(here, 'pages');
  const names = fs.readdirSync(pagesDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3));
  for (const k of Object.keys(MODES)) if (!names.includes(MODE_PAGES[k])) throw new Error(`No page for mode ${k} (site/pages/${MODE_PAGES[k]}.md)`);
  for (const name of names) {
    const { meta, body } = frontMatter(fs.readFileSync(path.join(pagesDir, `${name}.md`), 'utf8'));
    const html = marked.parse(expand(body));
    fs.writeFileSync(path.join(dest, `${name}.html`), layout({ name, meta, html }));
  }
  fs.copyFileSync(path.join(here, 'style.css'), path.join(dest, 'style.css'));
  fs.copyFileSync(path.join(repo, 'ui', 'icon.svg'), path.join(dest, 'icon.svg'));
  for (const f of fs.readdirSync(path.join(repo, 'docs', 'images'))) fs.copyFileSync(path.join(repo, 'docs', 'images', f), path.join(dest, 'img', f));
  fs.writeFileSync(path.join(dest, '.nojekyll'), '');

  // every local link, image and #anchor must exist
  const broken = [];
  const ids = (f) => new Set([...fs.readFileSync(path.join(dest, f), 'utf8').matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const f of fs.readdirSync(dest).filter((x) => x.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(dest, f), 'utf8');
    for (const [, url, hash] of html.matchAll(/(?:href|src)="([^"#]*)(?:#([^"]*))?"/g)) {
      if (/^(https?:|mailto:)/.test(url)) continue;
      const target = url || f;
      if (!fs.existsSync(path.join(dest, target))) broken.push(`${f} → ${url}`);
      else if (hash && target.endsWith('.html') && !ids(target).has(hash)) broken.push(`${f} → ${target}#${hash}`);
    }
  }
  if (broken.length) throw new Error(`Broken links:\n${broken.join('\n')}`);
  return { dest, pages: names.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = build();
  console.log(`Built ${r.pages} pages into ${path.relative(process.cwd(), r.dest) || r.dest}`);
}
