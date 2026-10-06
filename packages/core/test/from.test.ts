/**
 * `from <table>` in a block (data-spec §10) — the Spec it builds, and every
 * diagnostic of §12 it owns (AZ1260–AZ1267, AZ1269), each from a fixture
 * that triggers it and a control that does not.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, explain, serialiseSpec, type Manifest } from '../src/index.ts';
import { DESCRIPTION_MAX } from '../src/describe.ts';
import { FROM_EMPTY, FROM_SETTINGS } from '../src/from.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const f = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(f)) continue;
  const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

const TABLES = `  data products
    name     text     required search
    blurb    longtext
    note     text     private
    price    money    usd required
    status   choice   draft live sold default draft
    featured flag
    allow anyone   read
    allow signedin create
    allow owner    edit delete
  data orders
    ref      text     required
    secret   text     private
    allow owner read
    allow signedin create
  data questions
    question text     required
    answer   longtext required
    allow anyone read
  data drafts
    title    text     required
`;

const site = (body: string, extra = '') => `az 1
site shop
  auth
    adapter azbackend
${extra}  backend
    database sqlite
    email smtp
${TABLES}
page /
${body}
page /login
  auth login
`;

const run = (src: string) => compile(src, { manifests });
const found = (src: string, code: string) => run(src).diagnostics.filter((d) => d.code === code);
const errors = (src: string) => run(src).diagnostics.filter((d) => d.severity === 'error');

const FEATURE = `  feature grid
    title "In the shop"
    from products
      title  name
      text   blurb
      sort   created desc
      limit  6
      filter status live
      empty  "Nothing here yet — check back soon"
`;

test('the spec example (§10.1, image line aside; sort written as words) compiles to a SpecFrom', () => {
  const r = run(site(FEATURE));
  assert.deepEqual(errors(site(FEATURE)), []);
  const block = r.spec!.pages[0].blocks[0];
  assert.deepEqual(block.from, {
    table: 'products', slot: 'item', label: 'title',
    map: { text: 'blurb', title: 'name' }, types: { text: 'longtext', title: 'text' },
    sort: '-created', limit: 6, filter: { status: 'live' }, mine: false,
    empty: 'Nothing here yet — check back soon', signin: null,
  });
  assert.equal(block.children.some((c) => c.word === 'from'), false, 'the from line is not a child block');
});

test('defaults: limit from the manifest, the shared empty copy, no sort', () => {
  const r = run(site('  faq\n    title "Asked"\n    from questions\n      question question\n      text answer\n'));
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  const from = r.spec!.pages[0].blocks[0].from!;
  assert.equal(from.limit, 6);
  assert.equal(from.empty, FROM_EMPTY);
  assert.equal(from.sort, null);
});

test('a block without from serialises with no from key at all', () => {
  const src = site('  feature grid\n    item "One"\n    item "Two"\n');
  const text = serialiseSpec(run(src).spec!);
  assert.equal(/"from"/.test(text), false);
  assert.ok(/"item"/.test(text), 'CONTROL: the static items are there');
});

test('the item count rows of the manifest do not run on a from slot', () => {
  // feature AZ2061 (fewer than 2), faq AZ2040 (none), slot min AZ1216.
  const src = site(`${FEATURE}  faq\n    title "Asked"\n    from questions\n      question question\n      text answer\n`);
  const codes = run(src).diagnostics.map((d) => d.code);
  for (const c of ['AZ2061', 'AZ2040', 'AZ1216', 'AZ2044']) assert.ok(!codes.includes(c), `${c} fired: ${codes}`);
  const control = run(site('  feature grid\n    title "x"\n')).diagnostics.map((d) => d.code);
  assert.ok(control.includes('AZ2061'), `CONTROL: an empty static feature is refused (${control})`);
});

test('AZ1260 — an unknown table, with a did-you-mean', () => {
  const [d] = found(site(FEATURE.replace('from products', 'from prodcts')), 'AZ1260');
  assert.equal(d?.message, "feature: from 'prodcts' — no such table; did you mean 'products'?");
  const [far] = found(site(FEATURE.replace('from products', 'from zebras')), 'AZ1260');
  assert.equal(far?.message, "feature: from 'zebras' — no such table; declare it at site level: data zebras");
});

test('AZ1261 — an unknown field', () => {
  const [d] = found(site(FEATURE.replace('title  name', 'title  nmae')), 'AZ1261');
  assert.equal(d?.message, "feature: from products — no field 'nmae'");
  const [near] = found(site(FEATURE.replace('title  name', 'title  nam')), 'AZ1261');
  assert.equal(near?.message, "feature: from products — no field 'nam'; did you mean 'name'?");
});

test('AZ1262 — a field of a type the slot prop cannot show', () => {
  const [d] = found(site(FEATURE.replace('title  name', 'title  price')), 'AZ1262');
  assert.equal(d?.message, "feature: 'title' needs a text field, 'price' is money");
  const faq = site('  faq\n    title "Asked"\n    from questions\n      question question\n      text question\n');
  assert.equal(found(faq, 'AZ1262')[0]?.message, "faq: 'text' needs a longtext field, 'question' is text");
});

test('image fields map to media and src (D3); a text field there is AZ1262', () => {
  const withPhoto = TABLES.replace('    featured flag\n', '    featured flag\n    photo    image\n');
  const src = (body: string) => site(body).replace(TABLES, withPhoto);
  const feature = src(FEATURE.replace('      sort', '      media  photo\n      sort'));
  assert.deepEqual(errors(feature), []);
  const from = run(feature).spec!.pages[0].blocks[0].from!;
  assert.deepEqual([from.map.media, from.types.media], ['photo', 'image']);
  const gallery = src('  gallery grid\n    from products\n      src photo\n      alt name\n');
  assert.deepEqual(errors(gallery), []);
  assert.equal(found(src('  gallery grid\n    from products\n      src name\n      alt name\n'), 'AZ1262')[0]?.message,
    "gallery: 'src' needs an image field, 'name' is text");
});

test('AZ1214 — gallery orbit, carousel and lightbox with from are named as not available yet; grid and masonry compile', () => {
  const withPhoto = TABLES.replace('    featured flag\n', '    featured flag\n    photo    image\n');
  const src = (head: string) => site(`  ${head}\n    from products\n      src photo\n      alt name\n`).replace(TABLES, withPhoto);
  assert.deepEqual(found(src('gallery orbit').replace('gallery orbit', 'gallery orbit\n    poster ./p.webp'), 'AZ1214').map((d) => d.message),
    ["gallery: 'orbit' with 'from' is not available yet — use grid or masonry"]);
  assert.deepEqual(found(src('gallery carousel'), 'AZ1214').map((d) => d.message),
    ["gallery: 'carousel' with 'from' is not available yet — use grid or masonry"]);
  assert.deepEqual(found(src('gallery grid lightbox'), 'AZ1214').map((d) => d.message),
    ["gallery: 'lightbox' with 'from' is not available yet — use grid or masonry"]);
  for (const ok of ['gallery grid', 'gallery masonry']) assert.deepEqual(errors(src(ok)), [], `CONTROL: ${ok}`);
});

test('AZ1263 — static items and from in one block', () => {
  const [d] = found(site(`${FEATURE}    item "Static"\n`), 'AZ1263');
  assert.equal(d?.message, "feature: has items and 'from' — use one");
});

test('AZ1264 — a limit over the slot cap; AZ1407/AZ1408 for a bad number', () => {
  assert.equal(found(site(FEATURE.replace('limit  6', 'limit  20')), 'AZ1264')[0]?.message, 'feature: limit 20, max is 12 for feature');
  assert.equal(found(site(FEATURE.replace('limit  6', 'limit  0')), 'AZ1408').length, 1);
  assert.equal(found(site(FEATURE.replace('limit  6', 'limit  many')), 'AZ1407').length, 1);
  assert.equal(found(site(FEATURE.replace('limit  6', 'limit  12')), 'AZ1264').length, 0, 'CONTROL: the cap itself');
});

test('AZ1265 — schema on with from has no effect; the Spec carries schema off', () => {
  const src = site('  faq\n    title "Asked"\n    schema on\n    from questions\n      question question\n      text answer\n');
  const [d] = found(src, 'AZ1265');
  assert.equal(d?.severity, 'warning');
  assert.equal(d?.message, "faq: schema on has no effect with 'from' — rows load after the page");
  assert.equal(run(src).spec!.pages[0].blocks[0].props.schema, 'off');
  // A static FAQ beside it keeps its FAQPage: one per page is not exceeded (AZ2043).
  const both = site('  faq\n    title "Asked"\n    from questions\n      question question\n      text answer\n'
    + '  faq\n    title "More"\n    item "A?"\n      text "a"\n    item "B?"\n      text "b"\n    item "C?"\n      text "c"\n');
  assert.equal(found(both, 'AZ2043').length, 0);
});

test('AZ1266 — a private field mapped, unless every row read is the visitor\'s own', () => {
  const [d] = found(site(FEATURE.replace('text   blurb', 'text   note')), 'AZ1266');
  assert.equal(d?.message, "feature: 'text' maps a private field — it would be blank for everyone but its owner");
  const mine = site(FEATURE.replace('text   blurb', 'text   note').replace('      sort', '      mine\n      sort'));
  assert.equal(found(mine, 'AZ1266').length, 0, 'mine: the server returns private values on your own rows');
  const owners = site('  feature grid\n    from orders\n      title ref\n      text secret\n', '    protect /\n');
  assert.equal(found(owners, 'AZ1266').length, 0, 'an owner-read table: every row is the reader\'s');
});

test('AZ1267 — signed-out visitors cannot read the table, on an unprotected page', () => {
  const src = site('  feature grid\n    from orders\n      title ref\n');
  const [d] = found(src, 'AZ1267');
  assert.equal(d?.severity, 'warning');
  assert.equal(d?.message, "feature: signed-out visitors can't read 'orders' — protect this page or add: allow anyone read");
  assert.equal(run(src).spec!.pages[0].blocks[0].from?.signin, '/login', 'the sign-in link goes to the login page');
  assert.equal(found(site('  feature grid\n    from orders\n      title ref\n', '    protect /\n'), 'AZ1267').length, 0, 'protected');
  assert.equal(found(site('  feature grid\n    from orders\n      title ref\n      mine\n'), 'AZ1267').length, 0, 'mine says so');
  const nobody = found(site('  feature grid\n    from drafts\n      title title\n'), 'AZ1267')[0];
  assert.equal(nobody?.severity, 'error', 'no read rule at all: the site has no list to call');
  assert.equal(nobody?.message, "feature: no allow line lets the site read 'drafts' — add: allow anyone read");
});

test('AZ1269 — filter and sort are allow-listed like the server\'s', () => {
  assert.equal(found(site(FEATURE.replace('filter status live', 'filter name live')), 'AZ1269')[0]?.message,
    "feature: filter 'name' is not a choice or flag field of products");
  assert.equal(found(site(FEATURE.replace('sort   created desc', 'sort   blurb')), 'AZ1269')[0]?.message,
    "feature: sort 'blurb' is not created, updated or a required field of products");
  assert.equal(found(site(FEATURE.replace('sort   created desc', 'sort   price desc')), 'AZ1269').length, 0, 'CONTROL: required money sorts');
  assert.equal(run(site(FEATURE.replace('sort   created desc', 'sort   name'))).spec!.pages[0].blocks[0].from?.sort, 'name', 'ascending by default');
  assert.equal(found(site(FEATURE.replace('sort   created desc', 'sort   created down')), 'AZ1208')[0]?.message,
    "feature: 'down' is not a direction — try: asc, desc");
  assert.equal(found(site(FEATURE.replace('filter status live', 'filter status gone')), 'AZ1208')[0]?.message,
    "feature: 'gone' is not a status — try: draft, live, sold");
  assert.equal(found(site(FEATURE.replace('filter status live', 'filter featured on')), 'AZ1269').length, 0, 'CONTROL: a flag filters');
  const three = FEATURE.replace('filter status live', 'filter status live\n      filter featured on\n      filter status sold');
  assert.ok(found(site(three), 'AZ1504').length === 1, 'the same field twice');
});

test('AZ1207 — a required mapping missing; AZ1405 — an unknown line; AZ1201 — from on a word without it', () => {
  assert.equal(found(site(FEATURE.replace('      title  name\n', '')), 'AZ1207')[0]?.message,
    "feature: from products needs 'title' — add: title <field>");
  assert.match(found(site(FEATURE.replace('      sort', '      colour red\n      sort')), 'AZ1405')[0]?.message ?? '',
    /^feature: 'colour' is not a from setting — use title, text, media, sort, limit, filter, mine, empty$/);
  const hero = found(site('  hero center\n    title "Hi"\n    from products\n'), 'AZ1201')[0];
  assert.equal(hero?.message, "hero: takes no 'from' — rows load into faq, feature, gallery");
});

test('az explain reaches from and its lines; every description fits', () => {
  const e = explain(['feature', 'from', 'title', 'sort'], manifests);
  assert.deepEqual(e.unknown, []);
  assert.deepEqual(e.lines.map((l) => `${l.of}|${l.term}|${l.kind}`),
    ['|feature|word', 'feature|from|child', 'feature.from|title|setting', 'feature.from|sort|setting']);
  for (const [k, v] of Object.entries(FROM_SETTINGS)) assert.ok(v.length <= DESCRIPTION_MAX, `${k}: ${v.length}`);
});
