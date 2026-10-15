/**
 * Nothing the author writes is dropped without a diagnostic — GRAMMAR §4–§5.
 *
 * Each of these compiled with "no problems found" while losing or ignoring
 * part of the file: unquoted copy kept its first word (`title made by hand`
 * became "made"), `theme` under a page was never read, a key written twice
 * kept one value, a button's route named no page, and `assets/x.jpg` was
 * taken as a path without its `./`. Each test names the ID and the
 * line:col it must be reported at; each has a control showing the valid
 * form still compiles.
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

/** A site with one page holding `body`, and the pages its links name. */
const page = (body: string, pages = '') => `az 1\nsite studio\npage /\n${body}${pages}`;
const hero = (lines: string) => page(`  hero center\n${lines}`);

/* ---- 1. unquoted copy ------------------------------------------------------ */

test('unquoted copy after a key is AZ1406 at its second word, with the quoted line as the fix', () => {
  const r = only(hero('    title made by hand\n'));
  assert.equal(r.at, 'AZ1406 5:16');
  assert.equal(r.message, `hero: 'title' takes one value — quote the copy: title "made by hand"`);
});

test('CONTROL: the quoted title compiles and keeps every word', () => {
  const src = hero('    title "made by hand"\n');
  clean(src);
  assert.equal(run(src).spec?.pages[0].blocks[0].props.title, 'made by hand');
});

test('a second value on a one-value key is AZ1406 at that value, in a block and in a fill', () => {
  assert.equal(only(hero('    title "a"\n    height peek tall\n')).at, 'AZ1406 6:17');
  assert.match(only(hero('    title "a"\n    height peek tall\n')).message, /'height' takes one value — remove 'tall'/);
  const fill = page('  feature grid\n    item "Cut"\n      text "One hide."\n    item "Sewn"\n      text every seam\n');
  assert.equal(only(fill).at, 'AZ1406 8:18');
});

test('CONTROL: a list key still takes every value on its line', () => {
  clean('az 1\nsite studio\n  auth\n    adapter session\npage /\npage /login\n  auth login\n    methods password link\n');
});

/* ---- 2. theme (and font) outside site ------------------------------------- */

test('`theme` under a page is AZ1503 at the theme line', () => {
  const r = only(page('  theme paper\n  hero center\n    title "x"\n'));
  assert.equal(r.at, 'AZ1503 4:3');
  assert.equal(r.message, 'theme: declared under a page — move it to site level, one theme per site');
});

test('`font` under a page, and `theme` or `font` at file level, are AZ1503', () => {
  assert.equal(only(page('  font\n    display serif\n')).at, 'AZ1503 4:3');
  assert.equal(only('az 1\ntheme paper\nsite studio\npage /\n').at, 'AZ1503 2:1');
  assert.equal(only('az 1\nsite studio\nfont\n  display serif\npage /\n').at, 'AZ1503 3:1');
});

test('CONTROL: `theme` and `font` under site compile and reach the Spec', () => {
  const src = 'az 1\nsite studio\n  theme paper\n  font\n    display serif\npage /\n';
  clean(src);
  assert.equal(run(src).spec?.site.theme, 'paper');
  assert.equal(run(src).spec?.site.fonts.display, 'serif');
});

/* ---- 3. a key set twice ---------------------------------------------------- */

test('a key twice in one block is AZ1504 at the second line; the first is kept', () => {
  const src = hero('    title "a"\n    title "b"\n');
  const r = only(src);
  assert.equal(r.at, 'AZ1504 6:5');
  assert.equal(r.message, "hero: 'title' set twice — keep one");
});

test('a key twice in one fill is AZ1504', () => {
  assert.equal(only(page('  faq\n    title "Asked"\n    item "Why?"\n      text "Because."\n      text "Again."\n')).at, 'AZ1504 8:7');
});

test('the site settings once: theme twice is AZ1502, width or font twice AZ1504', () => {
  const site = (lines: string) => `az 1\nsite studio\n${lines}page /\n`;
  assert.equal(only(site('  theme paper\n  theme clay\n')).at, 'AZ1502 4:3');
  assert.equal(only(site('  width wide\n  width narrow\n')).at, 'AZ1504 4:3');
  assert.equal(only(site('  font\n    body sans\n  font\n    display serif\n')).at, 'AZ1504 5:3');
});

test('CONTROL: a repeatable fill is not a repeated key — two hero buttons compile', () => {
  clean(page('  hero center\n    title "x"\n    cta "One" /\n    cta "Two" #more\n'));
});

/* ---- 4. a link to an undeclared route -------------------------------------- */

test('a button to a route that is not a page is AZ1215 at the route', () => {
  const r = only(hero('    title "a"\n    cta "Go" /nowhere\n'));
  assert.equal(r.at, 'AZ1215 6:14');
  assert.equal(r.message, "cta: '/nowhere' is not a page in this site — add it or fix the link");
});

test('a nav link, a dropdown link and a footer group link to an undeclared route are AZ1215', () => {
  const site = (lines: string) => `az 1\nsite studio\n${lines}page /\n`;
  assert.equal(only(site('  nav bar\n    link "Work" /work\n')).at, 'AZ1215 4:17');
  assert.equal(only(site('  nav bar\n    group "Shop" as dropdown\n      link "Bags" /bags\n')).at, 'AZ1215 5:19');
  assert.equal(only(site('  footer columns\n    group "Shop"\n      link "Bags" /bags\n    group "Us"\n      link "Mail" mailto:a@b.test\n')).at,
    'AZ1215 5:19');
});

test('CONTROL: a declared route, with a query or an anchor, compiles; so do anchors and schemes', () => {
  clean(hero('    title "a"\n    cta "Go" /work#team\n    alt "Call" tel:+15550100\n') + 'page /work\n');
  clean(`az 1\nsite studio\n  nav bar\n    link "Work" /work\n    link "Top" #top\npage /\npage /work\n`);
});

test("CONTROL: a site with data tables links to the admin pages the build generates", () => {
  const src = `az 1
site shop
  auth
    adapter azbackend
  backend
    database sqlite
    email smtp
  data notes
    body text
    allow anyone read
  nav bar
    link "Admin" /admin
    link "Notes" /admin/notes
page /
page /login
  auth login
`;
  clean(src);
  assert.equal(only(src.replace('/admin/notes', '/admin/other')).at, 'AZ1215 13:18');
});

/* ---- 5. a path without ./ -------------------------------------------------- */

test('a path written without ./ is AZ1402 at the value, and the fix is the path with ./', () => {
  const r = only(hero('    title "a"\n    poster assets/x.jpg\n'));
  assert.equal(r.at, 'AZ1402 6:12');
  assert.equal(r.message, "hero: 'assets/x.jpg' is not a path — write './assets/x.jpg'");
});

test('a URL in a path key is AZ1402: not a project file', () => {
  assert.match(only(hero('    title "a"\n    poster https://cdn.test/x.jpg\n')).message,
    /hero: poster 'https:\/\/cdn\.test\/x\.jpg' is not a project file — write: poster \.\/file\.jpg/);
});

test('CONTROL: ./ paths compile, bare or quoted (a name with a space needs the quotes)', () => {
  clean(hero('    title "a"\n    poster ./assets/x.jpg\n'));
  clean(hero('    title "a"\n    poster "./assets/a b.jpg"\n'));
});

/* ---- the audit: every other part of a line that was dropped silently ------ */

test('a flag key alone is its value; a flag given a value is AZ1406', () => {
  const items = (lead: string) => page(`  feature bento\n    item "Cut"\n${lead}    item "Sewn"\n    item "Soled"\n`);
  clean(items('      lead\n'));
  assert.equal(only(items('      lead on\n')).at, 'AZ1406 6:12');
});

test("`as` on a key is AZ1406; an indented body under a key is AZ1219", () => {
  assert.equal(only(hero('    title "a" as ghost\n')).at, 'AZ1406 5:5');
  assert.equal(only(hero('    title "a"\n      sub "b"\n')).at, 'AZ1219 6:7');
});

test("copy or a link on a block's own line is AZ1204, not carried to nothing", () => {
  const r = errors(page('  hero center "Built in the dark" /work\n    title "a"\n', 'page /work\n'));
  assert.deepEqual(r.map((d) => `${d.code} ${d.pos.line}:${d.pos.col}`), ['AZ1204 4:15', 'AZ1204 4:35']);
});

test('extra values on site, page, theme, width, a font role, and a value on font are refused', () => {
  assert.equal(only('az 1\nsite studio extra\npage /\n').at, 'AZ1406 2:13');
  assert.equal(only('az 1\nsite studio\npage / extra\n').at, 'AZ1406 3:8');
  assert.equal(only('az 1\nsite studio\n  theme paper clay\npage /\n').at, 'AZ1406 3:15');
  assert.equal(only('az 1\nsite studio\n  width wide narrow\npage /\n').at, 'AZ1406 3:14');
  assert.equal(only('az 1\nsite studio\n  font\n    display serif sans\npage /\n').at, 'AZ1406 4:19');
  assert.equal(only('az 1\nsite studio\n  font serif\n    display serif\npage /\n').at, 'AZ1219 3:8');
});

test('a button past its label and destination is AZ1406 at the first extra value', () => {
  assert.equal(only(hero('    title "a"\n    cta "Go" / extra words\n')).at, 'AZ1406 6:16');
  clean(hero('    title "a"\n    cta "Go" / as ghost\n'));
});

test('`page` and `site` nested where they are never read are AZ1202', () => {
  assert.equal(only('az 1\nsite studio\n  page /x\npage /\n').at, 'AZ1202 3:3');
  assert.equal(only('az 1\nsite studio\npage /\n  site other\n').at, 'AZ1202 4:3');
});
