/**
 * Inheritance, override and suppression — nav-spec §8, footer-spec §1,
 * GRAMMAR §5.2.
 *
 * These are LANGUAGE rules, so they live in core and every target gets them.
 * Each was broken before this file existed, and none of the 165 tests noticed,
 * because every one of them checked the emitted FILES rather than which blocks
 * a page contains:
 *
 *   - `page /login` with `nav none` rendered TWO navs — the inherited one plus
 *     the suppression itself
 *   - the FOOTER RENDERED ABOVE THE PAGE CONTENT, because targets simply
 *     concatenated `[...site.inherited, ...page.blocks]`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { compile, blocksFor, type Manifest } from '../src/index.ts';

const dir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(dir)) {
  try {
    const m = JSON.parse(readFileSync(new URL(`${n}/word.json`, dir), 'utf8')) as Manifest;
    manifests.set(m.name, m);
  } catch { /* not a word directory */ }
}

/** The words a page renders, in order. */
function wordsOf(src: string, route = '/'): string[] {
  const result = compile(src, { manifests });
  // A null spec means the source did not compile — assert it rather than
  // letting `!` turn a broken fixture into a confusing null dereference.
  assert.ok(result.spec, 'source failed to compile:\n' +
    result.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  const spec = result.spec;
  const page = spec.pages.find((p) => p.route === route)!;
  return blocksFor(spec, page).map((b) => b.word);
}

const SITE_NAV_FOOTER =
  'az 1\nsite a\n  nav bar\n  footer minimal\n';

test('a site-level block is inherited by a page', () => {
  const words = wordsOf(SITE_NAV_FOOTER + 'page /\n  hero center\n    title "Hi"\n');
  assert.deepEqual(words, ['nav', 'hero', 'footer']);
});

test('nav opens the page and footer closes it', () => {
  // The ORDER is the assertion. Both were present before and in the order
  // nav, footer, hero — a valid document describing the wrong page.
  const words = wordsOf(SITE_NAV_FOOTER + 'page /\n  hero center\n    title "Hi"\n  text prose\n    title "T"\n    body "B"\n');
  assert.deepEqual(words, ['nav', 'hero', 'text', 'footer']);
  assert.equal(words.at(-1), 'footer', 'the footer must be last');
});

test('`none` suppresses an inherited block — GRAMMAR §5.2', () => {
  const words = wordsOf(SITE_NAV_FOOTER + 'page /\n  nav none\n  hero center\n    title "Hi"\n');
  assert.deepEqual(words, ['hero', 'footer'], 'no nav at all, and not twice');
  assert.equal(words.filter((w) => w === 'nav').length, 0);
});

test('CONTROL: without `none`, the inherited nav is still there', () => {
  // Otherwise a bug that dropped every nav would satisfy the test above.
  const words = wordsOf(SITE_NAV_FOOTER + 'page /\n  hero center\n    title "Hi"\n');
  assert.equal(words.filter((w) => w === 'nav').length, 1);
});

test('a page-level declaration OVERRIDES the inherited one — footer-spec §1', () => {
  const spec = compile(
    SITE_NAV_FOOTER + 'page /\n  footer columns\n    group "Shop"\n      link "Shoes" /shoes\n',
    { manifests }).spec!;
  const blocks = blocksFor(spec, spec.pages[0]);
  const footers = blocks.filter((b) => b.word === 'footer');
  assert.equal(footers.length, 1, 'one footer, not the inherited one as well');
  assert.equal(footers[0].variant, 'columns', "the PAGE's variant must win");
  assert.equal(blocks.at(-1)!.word, 'footer', 'an override keeps the end placement');
});

test('a page-level block with no site-level counterpart still places correctly', () => {
  const words = wordsOf('az 1\nsite a\n\npage /\n  hero center\n    title "Hi"\n  nav bar\n');
  assert.deepEqual(words, ['nav', 'hero'], 'a nav declared last still opens the page');
});

test('ordinary blocks keep their source order', () => {
  const words = wordsOf(
    'az 1\nsite a\n\npage /\n  hero center\n    title "Hi"\n  feature grid\n  cta band\n    title "T"\n');
  assert.deepEqual(words, ['hero', 'feature', 'cta']);
});
