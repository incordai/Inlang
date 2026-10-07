/**
 * What a page's <head> says beyond its title (head.ts, emit.ts indexHtml):
 * a meta description from the page's own lead copy, and an icon declared
 * so the browser does not request a /favicon.ico that is not there.
 *
 * Found by `pnpm test:lighthouse` (ASSUMPTIONS A6, pre-M5): every generated
 * page lacked a meta description (SEO) and logged a 404 for /favicon.ico
 * (best practices: console errors).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emit } from '../src/emit.ts';
import { pageDescription, DESCRIPTION_MAX } from '../src/head.ts';
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
