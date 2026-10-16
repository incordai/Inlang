/**
 * `text` body files — text-spec §5 (the subset), §8 (headings, keyboard
 * regions, alt) and §10 (the checks that need the file read).
 *
 * The file becomes nodes, never an HTML string: hostile markup in the file
 * must not reach the tree in any form.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emitProject } from '../src/emit.ts';
import { markdownText, markdownToNodes, MarkdownError } from '../src/markdown.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';
import { resolve, THEMES } from '../../theme/src/index.ts';
import type { EmittedNode, ThemeLike } from '../../core/src/emit-contract.ts';

const theme = resolve(THEMES.midnight, 'dark') as unknown as ThemeLike;
const asset = (p: string) => `/assets/${p.replace(/^\.\//, '')}`;
const md = (source: string, titled = false) => markdownToNodes(source, { file: 'content/about.md', titled, theme, asset });

const walk = (nodes: readonly (EmittedNode | string)[], out: EmittedNode[] = []): EmittedNode[] => {
  for (const n of nodes) {
    if (typeof n === 'string') continue;
    out.push(n);
    walk(n.children ?? [], out);
  }
  return out;
};
const tags = (nodes: EmittedNode[]) => walk(nodes).map((n) => n.tag);
const texts = (nodes: readonly (EmittedNode | string)[]): string =>
  nodes.map((n) => (typeof n === 'string' ? n : texts(n.children ?? []))).join('');

test('§5: the subset renders as elements — paragraphs, emphasis, lists, quote, code, rule, strikethrough', () => {
  const { nodes } = md('Hello *there* **you** ~~old~~ `x`.\n\n- a\n- b\n\n1. one\n\n> said\n\n```\ncode\n```\n\n---\n');
  const t = tags(nodes);
  for (const tag of ['p', 'em', 'strong', 'del', 'code', 'ul', 'li', 'ol', 'blockquote', 'pre', 'hr']) {
    assert.ok(t.includes(tag), `no <${tag}> in ${t.join(',')}`);
  }
});

test('SECURITY §5: raw HTML is stripped with a warning — no element, no text of it', () => {
  const { nodes, warnings } = md('Hi <script>alert(1)</script> there\n\n<div onclick="x()">block</div>\n\n<!-- note -->\n');
  const t = tags(nodes);
  assert.ok(!t.includes('script') && !t.includes('div'), t.join(','));
  assert.ok(!/script|onclick|note/.test(texts(nodes)), texts(nodes));
  assert.ok(warnings.includes("text: html in 'about.md' is stripped — use the 'raw' word if you need markup"), warnings.join('\n'));
});

test('SECURITY §10: javascript:, vbscript: and data: links and images are errors', () => {
  for (const src of ['[x](javascript:alert(1))', '[x](JavaScript:alert(1))', '[x]( vbscript:msgbox )', '![a](data:image/png;base64,AA)', '[x][r]\n\n[r]: javascript:alert(1)']) {
    assert.throws(() => md(src), (e: unknown) => e instanceof MarkdownError && /is not allowed — use a path or an https url/.test((e as Error).message), src);
  }
  assert.throws(() => md('[x](javascript:alert(1))'), { message: "text: 'javascript:' link in 'about.md' is not allowed — use a path or an https url" });
});

test('CONTROL: https, mailto, tel, routes and anchors are links as written', () => {
  const links = walk(md('[Shop](https://example.com) [Mail](mailto:a@b.c) [Call](tel:+1) [Pricing](/pricing) [Top](#top)').nodes)
    .filter((n) => n.tag === 'a').map((n) => n.attrs?.href);
  assert.deepEqual(links, ['https://example.com', 'mailto:a@b.c', 'tel:+1', '/pricing', '#top']);
});

test('§5: an external link opens a new tab, says so to a screen reader, and carries noopener', () => {
  const a = walk(md('[Shop](https://example.com)').nodes).find((n) => n.tag === 'a')!;
  assert.equal(a.attrs?.target, '_blank');
  assert.equal(a.attrs?.rel, 'noopener noreferrer');
  assert.match(texts([a]), /\(opens in new tab\)/);
  const local = walk(md('[Pricing](/pricing)').nodes).find((n) => n.tag === 'a')!;
  assert.equal(local.attrs?.target, undefined);
});

test('§4/§8: prose links are underlined and have a focus ring', () => {
  const a = walk(md('[Pricing](/pricing)').nodes).find((n) => n.tag === 'a')!;
  assert.equal(a.style?.textDecoration, 'underline');
  assert.match(String(a.states?.focusVisible?.outline), /solid/);
});

test('§8: headings shift — # is never an h1; under a title the file starts at h3', () => {
  const plain = md('# Story\n\n## Materials\n');
  assert.deepEqual(tags(plain.nodes).filter((x) => /^h\d$/.test(x)), ['h2', 'h3']);
  assert.ok(plain.warnings.includes("text: '# Story' becomes an h2 — the page h1 belongs to the hero"), plain.warnings.join('\n'));
  const titled = md('## Materials\n\n### Oak\n', true);
  assert.deepEqual(tags(titled.nodes).filter((x) => /^h\d$/.test(x)), ['h3', 'h4']);
  assert.equal(titled.warnings.length, 0, titled.warnings.join('\n'));
});

test('§8: levels clamp at h4, with the docs-page warning; a skipped level is named', () => {
  const deep = md('# A\n\n## B\n\n### C\n\n#### D\n', true);
  assert.ok(tags(deep.nodes).every((x) => !/^h[1256]$/.test(x)), tags(deep.nodes).join(','));
  assert.ok(deep.warnings.includes("text: 4 heading levels is a docs page — flatten it, or use 'content'"), deep.warnings.join('\n'));
  const skip = md('## Story\n\n#### Materials\n');
  assert.ok(skip.warnings.includes("text: 'Materials' jumps from h2 to h4 — use the next level down"), skip.warnings.join('\n'));
});

test('§8/§10: weak link text is warned about', () => {
  const { warnings } = md('To order, [click here](/order).');
  assert.ok(warnings.includes("text: 'click here' says nothing out of context — name the destination"), warnings.join('\n'));
  assert.equal(md('[See the order form](/order)').warnings.length, 0);
});

test('§8: code blocks and tables scroll inside a keyboard-reachable region', () => {
  const { nodes } = md('```\nx\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n');
  const pre = walk(nodes).find((n) => n.tag === 'pre')!;
  assert.equal(pre.attrs?.tabindex, '0');
  const region = walk(nodes).find((n) => n.children?.some((c) => typeof c !== 'string' && c.tag === 'table'))!;
  assert.equal(region.attrs?.tabindex, '0');
  assert.equal(region.attrs?.role, 'region');
  assert.equal(region.style?.overflowX, 'auto');
  const th = walk(nodes).find((n) => n.tag === 'th')!;
  assert.equal(th.attrs?.scope, 'col');
});

test('§10: a table wider than 6 columns is warned about', () => {
  const row = (n: number, c: string) => `|${Array.from({ length: n }, () => ` ${c} `).join('|')}|`;
  const table = (n: number) => `${row(n, 'h')}\n${row(n, '---')}\n${row(n, '1')}\n`;
  assert.ok(md(table(8)).warnings.includes("text: an 8-column table will scroll on a phone — cut columns, or wait for 'compare'"));
  assert.ok(md(table(7)).warnings.includes("text: a 7-column table will scroll on a phone — cut columns, or wait for 'compare'"));
  assert.equal(md(table(6)).warnings.length, 0);
});

test('§5/§8: images go through the asset sandbox, lazily, with the alt as written (empty = decorative)', () => {
  const imgs = walk(md('![Oak bench](./img/bench.webp)\n\n![](./img/rule.webp)\n').nodes).filter((n) => n.tag === 'img');
  assert.deepEqual(imgs.map((i) => [i.attrs?.src, i.attrs?.alt, i.attrs?.loading]), [
    ['/assets/img/bench.webp', 'Oak bench', 'lazy'],
    ['/assets/img/rule.webp', '', 'lazy'],
  ]);
  // A root path is not a file the build can check, so it goes to the sandbox too.
  const seen: string[] = [];
  markdownToNodes('![a](/etc/x.png)', { file: 'a.md', titled: false, theme, asset: (p) => { seen.push(p); return p; } });
  assert.deepEqual(seen, ['/etc/x.png']);
});

test('footnotes and other syntax outside the subset render nothing extra', () => {
  const { nodes } = md('Text[^1].\n\n[^1]: A note.\n');
  assert.ok(!tags(nodes).includes('section') && !tags(nodes).includes('sup'), tags(nodes).join(','));
});

// ---- the build: the file is read and becomes part of the page ----------------

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}

function project(file: string | null, title = '') {
  const r = compile(`az 1\nsite "Bench"\n\npage /\n  text prose\n${title}    body ./content/about.md\n`, { manifests });
  assert.ok(r.spec, r.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  const read: string[] = [];
  const p = emitProject(r.spec, { emitters: WEB_EMITTERS, readText: (path) => { read.push(path); return file; } });
  return { ...p, read, app: p.files.map((f) => f.content).join('\n') };
}

test('build: a .md body is read through the sandbox and rendered as elements, never as HTML', () => {
  const p = project('## Our bench\n\nMade of *oak*. <img src=x onerror=alert(1)>\n', '    title "Why oak"\n');
  assert.deepEqual(p.read, ['content/about.md']);
  assert.match(p.app, /"tag": ?"h3"/);
  assert.match(p.app, /"tag": ?"em"/);
  assert.ok(!p.app.includes('./content/about.md'), 'the path is not the body');
  assert.ok(!/onerror|dangerouslySetInnerHTML|innerHTML/.test(p.app), 'html reached the output');
  assert.ok(p.warnings.some((w) => w.startsWith('text: html in')), p.warnings.join('\n'));
});

test('build: a missing file and a javascript: link stop the build', () => {
  assert.throws(() => project(null), { message: "text: './content/about.md' does not exist — add the file or fix the path" });
  assert.throws(() => project('[x](javascript:alert(1))'), MarkdownError);
});

test('build: an image in the file ships as an asset, found relative to the file', () => {
  assert.deepEqual(project('![Oak bench](img/bench.webp)\n').assets, ['content/img/bench.webp']);
  assert.deepEqual(project('![Oak bench](../img/bench.webp)\n').assets, ['img/bench.webp']);
  assert.throws(() => project('![x](../../etc/passwd.png)\n'), /points outside the project/);
  assert.throws(() => project('![x](/etc/passwd.png)\n'), /is an absolute path/);
});

test('CONTROL: an inline body is text, and nothing is read', () => {
  const r = compile('az 1\nsite "Bench"\n\npage /\n  text centered\n    body "Forty pairs a month."\n', { manifests });
  const read: string[] = [];
  const p = emitProject(r.spec!, { emitters: WEB_EMITTERS, readText: (path) => { read.push(path); return ''; } });
  assert.deepEqual(read, []);
  assert.ok(p.files.some((f) => f.content.includes('Forty pairs a month.')));
});

test('markdownText (chat-block-spec §8.1): a body file\'s words, a blank line between blocks — no address, image, raw HTML or definition', () => {
  const source = [
    '# Care', '', 'Wax them **monthly**, see [the guide](https://evil.example/x?d=1) or [ref][g].', '',
    '![a lamp](https://img.example/lamp.png)', '', '<script>alert(1)</script>', '', '- Brush\n- Air dry', '',
    '| Part | Weeks |\n|---|---|\n| Sole | 4 |', '', '[g]: https://refs.example/g', '', '```\ncode stays text\n```',
  ].join('\n');
  assert.equal(markdownText(source), 'Care\n\nWax them monthly, see the guide or ref.\n\nBrush\n\nAir dry\n\nPart · Weeks\n\nSole · 4\n\ncode stays text');
  assert.ok(!/https?:|example|script|lamp/.test(markdownText(source)), 'no URL, no image alt, no markup');
  assert.equal(markdownText(''), '');
});
