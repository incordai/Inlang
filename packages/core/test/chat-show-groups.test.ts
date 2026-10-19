/**
 * `show` groups (chat-block-spec §19.15): `show all` and the group names in
 * core chat.ts SHOW_GROUPS expand, once the file is read, to the components
 * they stand for — the Spec is the one the full list makes — and `az explain
 * show all` prints the expansion. A group never brings a component the site
 * cannot use: pricing only with a public pricing block to quote.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, explain, serialiseSpec, type Manifest } from '../src/index.ts';
import { CHAT_ANSWER_WORDS, CHAT_REFUSED, SHOW_GROUPS, expandShow } from '../src/chat.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(file)) {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}

const PRICING = 'page /pricing\n  pricing cards\n    title "Plans"\n    currency usd\n    plan "Team"\n      monthly 29\n      cta "Start" /contact\npage /contact\n';
const site = (show: string, pages = '', auth = '') => `az 1
site demo
${auth}  backend
    database sqlite
    model    default

page /
  chat panel
    show ${show}
    allow anyone
${pages}`;

const answerShow = (src: string) => {
  const r = compile(src, { manifests });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), [], src);
  return r.spec!.pages[0].blocks.find((b) => b.word === 'chat')!.chat!.answer!.show;
};

test('show all is every component; without a public pricing block, every component but pricing', () => {
  assert.deepEqual(answerShow(site('all')), CHAT_ANSWER_WORDS.filter((w) => w !== 'pricing'));
  assert.deepEqual(answerShow(site('all', PRICING)), CHAT_ANSWER_WORDS);
});

test('the Spec of show all is the Spec of the full list it stands for, and auto (§19.17)', () => {
  const full = `${CHAT_ANSWER_WORDS.join(' ')} auto`;
  assert.equal(serialiseSpec(compile(site('all', PRICING), { manifests }).spec!), serialiseSpec(compile(site(full, PRICING), { manifests }).spec!));
});

test('show figures is chart table stats cards dashboard; groups and words mix, each component once, in the order written', () => {
  assert.deepEqual(answerShow(site('figures')), ['chart', 'table', 'stats', 'cards', 'dashboard']);
  assert.deepEqual(SHOW_GROUPS.figures, ['chart', 'table', 'stats', 'cards', 'dashboard']);
  assert.deepEqual(expandShow(['map', 'figures', 'chart'], false), ['map', 'chart', 'table', 'stats', 'cards', 'dashboard']);
  assert.deepEqual(answerShow(site('figures map')), ['chart', 'table', 'stats', 'cards', 'dashboard', 'map']);
});

test('show sections brings pricing only when a public page has a pricing block — a protected one does not count', () => {
  assert.deepEqual(answerShow(site('sections')), ['faq', 'cta', 'feature']);
  assert.deepEqual(answerShow(site('sections', PRICING)), ['pricing', 'faq', 'cta', 'feature']);
  const authed = `${site('sections', `${PRICING}page /login\n  auth login\n    alt "Back" /\n`, '  auth\n    adapter azbackend\n    protect /pricing\n').replace('    model    default\n', '    email    smtp\n    model    default\n')}`;
  assert.deepEqual(answerShow(authed), ['faq', 'cta', 'feature']);
});

test('a site float takes groups too', () => {
  const src = `az 1
site demo
  backend
    database sqlite
    model    default
  chat float
    show figures
    allow anyone

page /
`;
  const r = compile(src, { manifests });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.deepEqual(r.spec!.site.inherited.find((b) => b.word === 'chat')!.chat!.answer!.show, SHOW_GROUPS.figures);
});

test('CONTROL: pricing written by name still needs a block to quote (AZ1255); an unknown word names the groups (AZ1254)', () => {
  const pricing = compile(site('pricing'), { manifests }).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
  assert.deepEqual(pricing, ['AZ1255']);
  const bad = compile(site('everything'), { manifests }).diagnostics.find((d) => d.code === 'AZ1254');
  assert.match(bad?.message ?? '', /or a group: all, figures, sections$/);
});

test('the one table: no group is a component, a refused word or a word; every member is a component; each is described for authors', () => {
  const described = (manifests.get('chat')!.props!.show as { valueDescriptions?: Record<string, string> }).valueDescriptions ?? {};
  for (const [name, members] of Object.entries(SHOW_GROUPS)) {
    assert.equal(CHAT_ANSWER_WORDS.includes(name), false, name);
    assert.equal(Object.hasOwn(CHAT_REFUSED, name), false, name);
    assert.equal(manifests.has(name), false, name);
    for (const m of members) assert.ok(CHAT_ANSWER_WORDS.includes(m), `${name}: ${m}`);
    assert.ok(described[name], `${name} has a valueDescription`);
  }
  assert.deepEqual(SHOW_GROUPS.all, CHAT_ANSWER_WORDS);
});

test('az explain show all prints the expansion, one component a line; so does chat show figures', () => {
  const all = explain(['show', 'all'], manifests);
  assert.deepEqual(all.unknown, []);
  assert.deepEqual(all.lines.slice(0, 2).map((l) => `${l.of} ${l.term} ${l.kind}`), ['chat show prop', 'chat.show all value']);
  assert.deepEqual(all.lines.slice(2).map((l) => l.term), CHAT_ANSWER_WORDS);
  assert.ok(all.lines.slice(2).every((l) => l.kind === 'component' && l.of === 'chat.show.all' && l.text.length > 0));
  const figures = explain(['chat', 'show', 'figures'], manifests);
  assert.deepEqual(figures.lines.filter((l) => l.kind === 'component').map((l) => l.term), SHOW_GROUPS.figures);
  // CONTROL: a component explains as one line, with no expansion.
  assert.equal(explain(['show', 'map'], manifests).lines.length, 2);
});
