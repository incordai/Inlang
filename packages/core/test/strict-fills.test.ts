/**
 * Nothing on a line is dropped without a diagnostic — the gaps strict-values
 * left open (GRAMMAR §3.3, §4.1, §4.5, §5.2).
 *
 * Each compiled with "no problems found" while ignoring part of the file:
 * one bare word for copy (`title made`) was taken as the copy, a value past
 * a fill's label and destination (`link "Shoes" /shoes extra`) was dropped,
 * a nav key under a `group` (`mobile drawer`) set nothing, a block inside a
 * block or a fill was rendered by nothing, and a block under `site` that is
 * not inherited (`hero`) was dropped from every page. Each test names the ID
 * and the line:col it must be reported at; each has a control showing the
 * valid form still compiles.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type Manifest } from '../src/index.ts';

const WORDS = fileURLToPath(new URL('../../words/', import.meta.url));
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(WORDS)) {
  try {
    const m = JSON.parse(readFileSync(join(WORDS, n, 'word.json'), 'utf8')) as Manifest;
    manifests.set(m.name, m);
  } catch { /* not a word directory */ }
}

const run = (src: string) => compile(src, { manifests: new Map(manifests) });
const errors = (src: string) => run(src).diagnostics.filter((d) => d.severity === 'error');
/** The source's only error: its ID, where it is, and its message. */
const only = (src: string) => {
  const e = errors(src);
  assert.equal(e.length, 1, JSON.stringify(e));
  return { at: `${e[0].code} ${e[0].pos.line}:${e[0].pos.col}`, message: e[0].message };
};
const clean = (src: string) => assert.deepEqual(errors(src), []);

/** A site with one page holding `body`. */
const page = (body: string) => `az 1\nsite studio\npage /\n${body}`;
/** A site whose `site` holds `lines`, and one page. */
const site = (lines: string) => `az 1\nsite studio\n${lines}page /\n`;

/* ---- 1. one bare word for copy ------------------------------------------- */

test('one bare word for a string key is AZ1406 at the word, and the fix is the quoted line', () => {
  const r = only(page('  hero center\n    title made\n'));
  assert.equal(r.at, 'AZ1406 5:11');
  assert.equal(r.message, `hero: 'title' is copy and takes quotes — write: title "made"`);
  // In a fill too: an item's text is copy.
  assert.equal(only(page('  feature grid\n    title "Made"\n    item "Cut"\n      text leather\n    item "Sewn"\n')).at, 'AZ1406 7:12');
});

test('CONTROL: quoted copy compiles and keeps its text; a bare number stays a value', () => {
  const src = page('  hero center\n    title "made"\n');
  clean(src);
  assert.equal(run(src).spec?.pages[0].blocks[0].props.title, 'made');
  clean(page('  pricing cards\n    title "Plans"\n    currency usd\n    plan "Studio"\n      monthly 29\n      cta "Start" /\n'));
});

/* ---- 2. a value past a fill's line --------------------------------------- */

test('a value past a nav link is AZ1406 at that value', () => {
  const r = only(site('  nav bar\n    link "Work" / extra\n'));
  assert.equal(r.at, 'AZ1406 4:19');
  assert.equal(r.message, "link: takes a label and a destination — remove 'extra'");
});

test('a value past the line of a feature item, an image, a plan row, a footer link and a question is AZ1406', () => {
  const items = page('  feature grid\n    title "Made"\n    item "Cut" lead\n      text "a"\n    item "Sewn" big\n      text "b"\n');
  assert.deepEqual(only(items), { at: 'AZ1406 8:17', message: "item: takes a label and 'lead' — remove 'big'" });
  assert.deepEqual(only(page('  gallery grid\n    title "Work"\n    image ./a.jpg ./b.jpg\n      alt "a"\n    image ./c.jpg\n      alt "c"\n')),
    { at: 'AZ1406 6:19', message: "image: takes a file — remove './b.jpg'" });
  assert.deepEqual(only(page('  pricing cards\n    title "Plans"\n    currency usd\n    plan "Studio"\n      monthly 29\n      feature "Seats" "10" "more"\n      cta "Start" /\n')),
    { at: 'AZ1406 9:28', message: "feature: takes a label and a value — remove 'more'" });
  assert.equal(only(site('  footer minimal\n    link "Mail" mailto:a@b.test extra\n')).at, 'AZ1406 4:33');
  assert.equal(only(page('  faq list\n    title "Asked"\n    item "Why?" now\n      text "Because."\n')).at, 'AZ1406 6:17');
});

test('CONTROL: every fill written to its line compiles', () => {
  clean(page('  feature grid\n    title "Made"\n    item "Cut" lead\n      text "a"\n    item "Sewn"\n      text "b"\n'));
  clean(page('  pricing cards\n    title "Plans"\n    currency usd\n    plan "Studio"\n      monthly 29\n      feature "Seats" "10"\n      feature "Support"\n      cta "Start" /\n'));
  clean(site('  nav bar\n    link "Work" /\n    group "Shop" as dropdown\n      link "Bags" /\n    cta "Go" / as ghost\n'));
});

/* ---- 3. a parent's key, or another word, under a nested child ------------ */

test('a nav key under a group is AZ1202 at the key, naming where it belongs', () => {
  const r = only(site('  nav bar\n    group "Shop" as dropdown\n      mobile drawer\n      link "Bags" /\n'));
  assert.equal(r.at, 'AZ1202 5:7');
  assert.equal(r.message, "mobile: not allowed inside 'group' — it is a nav key; move it under nav");
});

test('a cta or a group under a group is AZ1202; an indented line under a nav link is AZ1219', () => {
  assert.deepEqual(only(site('  nav bar\n    group "Shop"\n      cta "Go" /\n      link "Bags" /\n')),
    { at: 'AZ1202 5:7', message: "cta: not allowed inside 'group' — group holds link" });
  assert.equal(only(site('  nav bar\n    group "Shop"\n      group "More"\n      link "Bags" /\n')).at, 'AZ1202 5:7');
  assert.deepEqual(only(site('  nav bar\n    link "Work" /\n      link "Bags" /\n')),
    { at: 'AZ1219 5:7', message: 'link: takes no indented lines — write it on one line' });
});

test('a block inside a block, inside a fill, or at column 0 is AZ1202', () => {
  assert.deepEqual(only(page('  hero center\n    title "x"\n    faq list\n      title "f"\n      item "q"\n        text "a"\n')),
    { at: 'AZ1202 6:5', message: "faq: not allowed inside 'hero' — move it to the page" });
  assert.equal(only(page('  faq list\n    title "f"\n    item "q"\n      text "a"\n      hero center\n        title "x"\n')).at, 'AZ1202 8:7');
  assert.deepEqual(only('az 1\nsite studio\npage /\nhero center\n  title "x"\n'),
    { at: 'AZ1202 4:1', message: 'hero: not allowed at column 0 — indent it under the page it belongs to' });
});

test('CONTROL: mobile under nav, links under a group, and blocks under a page compile', () => {
  clean(site('  nav bar\n    mobile sheet\n    group "Shop" as dropdown\n      link "Bags" /\n'));
  clean(page('  hero center\n    title "x"\n  faq list\n    title "f"\n    item "q"\n      text "a"\n'));
});

/* ---- 4. a block under site that is not inherited ------------------------- */

test('a block under site that no page inherits is AZ1202 at the block', () => {
  const r = only(site('  hero center\n    title "On every page?"\n'));
  assert.equal(r.at, 'AZ1202 3:3');
  assert.equal(r.message,
    "hero: not allowed inside 'site' — only nav, footer, scene backdrop and chat float are inherited; move it under the page it belongs to");
  assert.equal(only(site('  text\n    title "x"\n    body "y"\n')).at, 'AZ1202 3:3');
});

test('a scene under site that is not a backdrop is AZ1202: only the backdrop is inherited', () => {
  const r = only(site('  scene inline 3d\n    poster ./a.webp\n    alt "Fog"\n'));
  assert.equal(r.at, 'AZ1202 3:3');
  assert.equal(r.message, "scene: 'inline' is not inherited — only nav, footer, scene backdrop and chat float are; move it under the page it belongs to");
});

test('CONTROL: nav, footer, a scene backdrop and auth settings under site compile; a chat panel there is AZ1202 (only a float is inherited)', () => {
  const src = site('  nav bar\n  footer minimal\n    copyright "Studio"\n  scene backdrop 3d\n    poster ./b.webp\n    alt "Fog"\n');
  clean(src);
  assert.deepEqual(run(src).spec?.site.inherited.map((b) => b.word), ['nav', 'footer', 'scene']);
  clean('az 1\nsite studio\n  auth\n    adapter session\npage /\npage /login\n  auth login\n');
  assert.ok(errors(site('  chat panel\n')).some((d) => d.code === 'AZ1202' && d.pos.line === 3));
  assert.ok(!errors(site('  chat panel\n')).some((d) => d.code === 'AZ1214'), 'the C1 refusal is gone');
});

/* ---- 5. `none` under site, and `none` with more on it -------------------- */

test("'none' under site is AZ1202 at the block: there is no inherited block to leave out", () => {
  const r = only(site('  nav none\n'));
  assert.equal(r.at, 'AZ1202 3:3');
  assert.equal(r.message,
    "nav: 'none' leaves the site's nav out of one page — under 'site' there is no nav to leave out; remove it, or write it under that page");
  // A scene was asked for a backdrop's poster first; a chat compiled as nothing.
  assert.equal(only(site('  scene none\n')).at, 'AZ1202 3:3');
  assert.equal(only(site('  scene none\n    poster ./a.webp\n    alt "Fog"\n')).at, 'AZ1202 3:3');
  assert.equal(only(site('  chat none\n')).at, 'AZ1202 3:3');
});

test("'none' takes no modifiers and no body: AZ1204 at the modifier, AZ1219 at the first line", () => {
  assert.deepEqual(only(page('  nav none sticky\n')), { at: 'AZ1204 4:12', message: "nav: 'none' takes no modifiers — remove 'sticky'" });
  assert.deepEqual(only(page('  nav none\n    link "Work" /\n')), { at: 'AZ1219 5:5', message: "nav: 'none' takes no indented lines — remove them" });
});

test("CONTROL: 'none' under a page compiles and leaves the site's block out; a page's scene none needs no poster", () => {
  const src = 'az 1\nsite studio\n  nav bar\n    link "Home" /\npage /\npage /login\n  nav none\n  scene none\n';
  clean(src);
  const spec = run(src).spec!;
  assert.deepEqual(spec.site.inherited.map((b) => b.word), ['nav']);
  assert.deepEqual(spec.pages[1].blocks.map((b) => `${b.word} ${b.variant}`), ['nav none', 'scene none']);
});

/* ---- 6. a fill's label is copy ------------------------------------------- */

test('a bare word as a label is AZ1406 at the word, and the fix is the quoted line', () => {
  assert.deepEqual(only(site('  nav bar\n    link work /\n')),
    { at: 'AZ1406 4:10', message: 'link: its label is copy and takes quotes — write: link "work" /' });
  // Unquoted copy splits into words: the fix quotes them all, not "remove".
  assert.deepEqual(only(site('  nav bar\n    link our work /\n')),
    { at: 'AZ1406 4:10', message: 'link: its label is copy and takes quotes — write: link "our work" /' });
  // A flag after the label stays the flag.
  assert.deepEqual(only(page('  feature grid\n    title "Made"\n    item sewn by hand lead\n      text "a"\n    item "Cut"\n      text "b"\n')),
    { at: 'AZ1406 6:10', message: 'item: its label is copy and takes quotes — write: item "sewn by hand" lead' });
});

test("every fill's label role is checked: buttons, nav children, footer, faq, feature, pricing", () => {
  const code = (src: string) => only(src).at.split(' ')[0];
  assert.equal(code(page('  hero center\n    title "x"\n    cta start /\n')), 'AZ1406');
  assert.equal(code(page('  hero center\n    title "x"\n    cta "Go" /\n    alt more /\n')), 'AZ1406');
  assert.equal(code(site('  nav bar\n    group shop\n      link "Bags" /\n')), 'AZ1406');
  assert.equal(code(site('  nav bar\n    cta go /\n')), 'AZ1406');
  assert.equal(code(site('  footer minimal\n    copyright "Studio"\n    legal terms /\n')), 'AZ1406');
  assert.equal(code(page('  faq list\n    title "Asked"\n    item why\n      text "Because."\n    item "How?"\n      text "So."\n')), 'AZ1406');
  assert.equal(code(page('  pricing cards\n    title "Plans"\n    currency usd\n    plan studio\n      monthly 29\n      cta "Start" /\n')), 'AZ1406');
  assert.equal(code(page('  pricing cards\n    title "Plans"\n    currency usd\n    plan "Studio"\n      monthly 29\n      feature seats "10"\n      cta "Start" /\n')), 'AZ1406');
});

test('a label missing from its line is AZ1205: a destination alone is not a label', () => {
  assert.deepEqual(only(site('  nav bar\n    link /\n')), { at: 'AZ1205 4:10', message: 'link: has no label — write: link "…" /' });
  assert.deepEqual(only(site('  nav bar\n    link\n')), { at: 'AZ1205 4:5', message: 'link: has no label — write: link "…"' });
  assert.equal(only(page('  feature grid\n    title "Made"\n    item lead\n      text "a"\n    item "Cut"\n      text "b"\n')).at, 'AZ1205 6:10');
});

test('a label or a value the lexer refused (AZ1008) is reported once, not again as missing', () => {
  assert.deepEqual(errors(site('  nav bar\n    link Work /\n')).map((d) => d.code), ['AZ1008']);
  assert.deepEqual(errors(page('  hero center\n    title Made\n')).map((d) => d.code), ['AZ1008']);
});

test('CONTROL: a quoted label, or a bare number, compiles', () => {
  clean(site('  nav bar\n    link "Work" /\n    group "Shop"\n      link "Bags" /\n'));
  clean(site('  nav bar\n    group 2026\n      link "Bags" /\n'));
});

/* ---- 7. a refused key is not also reported missing ----------------------- */

test("a fill's required key on a refused line is reported once: no 'has no answer' after AZ1406", () => {
  const src = page('  faq list\n    title "Asked"\n    item "Why?"\n      text because\n    item "How?"\n      text "So."\n');
  assert.deepEqual(only(src), { at: 'AZ1406 7:12', message: `item: 'text' is copy and takes quotes — write: text "because"` });
  // Two values on the line, or none, are refusals too.
  assert.equal(only(page('  faq list\n    title "Asked"\n    item "Why?"\n      text "a" "b"\n    item "How?"\n      text "So."\n')).at, 'AZ1406 7:16');
  assert.equal(only(page('  faq list\n    title "Asked"\n    item "Why?"\n      text\n    item "How?"\n      text "So."\n')).at, 'AZ1205 7:7');
});

test('CONTROL: a fill with no answer line at all is still AZ2041', () => {
  assert.equal(only(page('  faq list\n    title "Asked"\n    item "Why?"\n    item "How?"\n      text "So."\n')).at, 'AZ2041 6:5');
});
