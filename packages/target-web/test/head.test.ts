/**
 * What a page's <head> says beyond its title (head.ts, emit.ts indexHtml):
 * a meta description — the page's, else the site's (GRAMMAR §4.4), else
 * its own lead copy — and an icon: `site icon` with its type read from the
 * file, else an empty one so the browser requests no /favicon.ico.
 *
 * Found by `pnpm test:lighthouse` (ASSUMPTIONS A6, pre-M5): every generated
 * page lacked a meta description (SEO) and logged a 404 for /favicon.ico
 * (best practices: console errors).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emit, emitProject } from '../src/emit.ts';
import { pageDescription, DESCRIPTION_MAX, IconError } from '../src/head.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}
const html = (src: string, path = 'index.html') => {
  const r = compile(src, { manifests });
  assert.ok(r.spec, JSON.stringify(r.diagnostics));
  return emit(r.spec, { emitters: WEB_EMITTERS }).find((f) => f.path === path)!.content;
};
const description = (page: string) => /<meta name="description" content="([^"]*)" \/>/.exec(page)?.[1] ?? null;

const HERO = `az 1
site aurora
  nav split
    link "Work" /work
  footer
    tagline "Footer copy is the site's, not the page's."
    link "About" /about
page /
  hero center
    eyebrow "Limited run"
    title   "Built in the dark"
    sub     "Handmade. Forty pairs a month."
page /work
  text
    title "Work"
    body  "Every pair we made this year, with the people who wear them."
page /about
`;

test("a page's description is its hero's sub — the paragraph under the title, not the eyebrow above it", () => {
  assert.equal(description(html(HERO)), 'Handmade. Forty pairs a month.');
});

test('each page gets its own description, from its own content', () => {
  assert.equal(description(html(HERO, 'work/index.html')), 'Every pair we made this year, with the people who wear them.');
});

test('a page with no lead paragraph gets no description — not the footer\'s copy, not an invented one', () => {
  const about = html(HERO, 'about/index.html');
  assert.equal(description(about), null);
  assert.doesNotMatch(about, /name="description"/);
});

test('SECURITY: author copy in the description is HTML-escaped and cannot leave the attribute', () => {
  const page = html(`az 1
site aurora
page /
  hero center
    title "T"
    sub   "\\"/><script>alert(1)</script> & 'more'"
`);
  assert.doesNotMatch(page, /<script>alert/);
  assert.equal(description(page), '&quot;/&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;more&#39;');
});

test('every page declares its icon, so no /favicon.ico is requested', () => {
  for (const path of ['index.html', 'work/index.html', 'about/index.html']) {
    assert.match(html(HERO, path), /<link rel="icon" href="data:," \/>/, path);
  }
});

/* ---- `description` and `icon` written by the author (GRAMMAR §4.4) ---- */

const WRITTEN = `az 1
site aurora
  description "Handmade shoes from a two-person workshop."
page /
  description "Reserve a pair from the autumn run."
  hero center
    title "Built in the dark"
    sub   "Handmade. Forty pairs a month."
page /about
page /work
  text
    title "Work"
    body  "Every pair we made this year, with the people who wear them."
`;

test("a page's own description wins over its lead copy and over the site's", () => {
  assert.equal(description(html(WRITTEN)), 'Reserve a pair from the autumn run.');
});

test("the site's description is every other page's — lead copy or none", () => {
  assert.equal(description(html(WRITTEN, 'about/index.html')), 'Handmade shoes from a two-person workshop.');
  assert.equal(description(html(WRITTEN, 'work/index.html')), 'Handmade shoes from a two-person workshop.');
});

test('CONTROL: with nothing written the lead copy is still the fallback', () => {
  assert.equal(description(html(HERO)), 'Handmade. Forty pairs a month.');
});

test('SECURITY: a written description is HTML-escaped and cannot leave the attribute', () => {
  const page = html(`az 1
site aurora
  description "\\"/><script>alert(1)</script> & 'more'"
page /
`);
  assert.doesNotMatch(page, /<script>alert/);
  assert.equal(description(page), '&quot;/&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;more&#39;');
});

const ICONED = 'az 1\nsite aurora\n  icon ./brand/icon.svg\npage /\npage /about\n';
const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 64]);
const SVG_HEAD = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"/>');
const project = (src: string, readBytes?: (p: string) => Uint8Array | null) => {
  const r = compile(src, { manifests });
  assert.ok(r.spec, JSON.stringify(r.diagnostics));
  return emitProject(r.spec, { emitters: WEB_EMITTERS, readBytes });
};
const page = (p: ReturnType<typeof project>, path = 'index.html') => p.files.find((f) => f.path === path)!.content;

test("every page declares the site icon, its type read from the file's bytes", () => {
  const asked: string[] = [];
  const p = project(ICONED, (path) => { asked.push(path); return SVG_HEAD; });
  for (const path of ['index.html', 'about/index.html']) {
    assert.match(page(p, path), /<link rel="icon" type="image\/svg\+xml" href="\/brand\/icon\.svg" \/>/, path);
    assert.doesNotMatch(page(p, path), /data:,/, path);
  }
  assert.deepEqual(asked, ['brand/icon.svg'], 'read once, through the sandboxed project path');
  assert.ok(p.assets.includes('brand/icon.svg'), 'the icon is copied with the other assets');
});

test('a PNG icon is declared image/png', () => {
  const p = project('az 1\nsite aurora\n  icon ./icon.png\npage /\n', () => PNG_HEAD);
  assert.match(page(p), /<link rel="icon" type="image\/png" href="\/icon\.png" \/>/);
});

test('without a reader (tests, a playground) the icon is declared with no type — never one guessed from its name', () => {
  assert.match(page(project(ICONED)), /<link rel="icon" href="\/brand\/icon\.svg" \/>/);
});

test('the second gate: bytes that are not the format the name says are refused, not declared', () => {
  assert.throws(() => project(ICONED, () => PNG_HEAD), IconError);
  assert.throws(() => project(ICONED, () => null), IconError);
  assert.throws(() => project(ICONED, () => new TextEncoder().encode('GIF89a')), IconError);
});

/* ---- pageDescription on its own --------------------------------------- */

const p = (text: string, attrs?: Record<string, string>) => ({ tag: 'p', ...(attrs ? { attrs } : {}), children: [text] });

test('the first paragraph after the first heading, at any depth', () => {
  assert.equal(pageDescription([
    { tag: 'section', children: [p('Eyebrow'), { tag: 'div', children: [{ tag: 'h2', children: ['Title'] }] }, { tag: 'div', children: [p('Lead copy.')] }] },
  ]), 'Lead copy.');
});

test('a div holding only text is a paragraph; a div holding elements is not', () => {
  assert.equal(pageDescription([{ tag: 'h1', children: ['T'] },
    { tag: 'div', children: [{ tag: 'a', children: ['A link'] }] }, { tag: 'div', children: ['Body copy.'] }]), 'Body copy.');
});

test('inline markup inside the paragraph is read as text, whitespace collapsed', () => {
  assert.equal(pageDescription([{ tag: 'h1', children: ['T'] },
    { tag: 'p', children: ['Made  by ', { tag: 'strong', children: ['hand'] }, ',\n  slowly.'] }]), 'Made by hand, slowly.');
});

test('hidden copy is not described: hidden and aria-hidden subtrees and empty paragraphs are skipped', () => {
  assert.equal(pageDescription([{ tag: 'h1', children: ['T'] }, p('Secret', { hidden: 'hidden' }),
    p('Decorative', { 'aria-hidden': 'true' }), p('   '), p('Visible.')]), 'Visible.');
});

test(`long copy is cut at a word within ${DESCRIPTION_MAX} characters`, () => {
  const long = `${'word '.repeat(60).trim()}.`;
  const d = pageDescription([{ tag: 'h1', children: ['T'] }, p(long)])!;
  assert.ok(d.length <= DESCRIPTION_MAX, `${d.length}`);
  assert.match(d, /word…$/);
});

test('CONTROL: no heading, or no paragraph after it, is no description', () => {
  assert.equal(pageDescription([p('Before any heading')]), null);
  assert.equal(pageDescription([p('Before'), { tag: 'h1', children: ['T'] }]), null);
  assert.equal(pageDescription([]), null);
});
