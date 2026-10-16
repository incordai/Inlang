/**
 * C2b (chat-block-spec §20): the rich components are values of `show`, never
 * words; a chat that lists them gets, in its Spec block, the public tables it
 * may take figures from (public fields only, money with its digits) and the
 * gallery images a card may name by key; AZ1270 refuses a dashboard with
 * nothing to hold; AZ1259 refuses an author's page at the shared-answer
 * route. Each rule has a CONTROL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type Manifest } from '../src/index.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(file)) {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}

const HEAD = 'az 1\nsite studio\n  auth\n    adapter azbackend\n    protect /members\n  backend\n    database sqlite\n    email smtp\n    model default\n';
const DATA = [
  '  data orders',
  '    status   choice   paid open required',
  '    total    money    jpy required',
  '    placed   datetime required',
  '    note     text     private',
  '    allow anyone read',
  '    allow signedin create',
  '  data notes',
  '    body     text     required',
  '    allow owner read',
  '    allow signedin create',
].join('\n') + '\n';
const page = (show: string, more = '') => [
  'page /',
  '  gallery grid',
  '    image "./a.jpg"',
  '      alt "A linen shirt"',
  '    image "./b.jpg"',
  '      alt ""',
  '  chat panel',
  `    show ${show}`,
  'page /members',
  '  gallery grid',
  '    image "./secret.jpg"',
  '      alt "Members only"',
  '    image "./secret2.jpg"',
  '      alt "Members too"',
  more,
].join('\n') + '\n';
const run = (src: string) => compile(src, { manifests });
const errors = (src: string) => run(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
const chatOf = (src: string) => run(src).spec?.pages[0].blocks.find((b) => b.word === 'chat');

test('show takes the rich components; the Spec carries the public tables and the public, described images', () => {
  const src = `${HEAD}${DATA}${page('chart table stats cards dashboard')}`;
  assert.deepEqual(errors(src), []);
  const answer = chatOf(src)?.chat?.answer;
  assert.deepEqual(answer?.show, ['chart', 'table', 'stats', 'cards', 'dashboard']);
  assert.deepEqual(answer?.tables, [{
    name: 'orders',
    fields: [
      { name: 'status', type: 'choice', choices: ['paid', 'open'] },
      { name: 'total', type: 'money', currency: 'jpy', digits: 0 },
      { name: 'placed', type: 'datetime' },
    ],
  }], 'the owner-only table and the private field are not there');
  assert.deepEqual(answer?.images, [{ key: 'i1', src: './a.jpg', alt: 'A linen shirt' }],
    'no image without alt, none from a protected page');
});

test('CONTROL: without a rich word there are no tables; without cards there are no images', () => {
  const plain = chatOf(`${HEAD}${DATA}${page('faq')}`)?.chat?.answer;
  assert.equal(plain?.tables, undefined);
  assert.equal(plain?.images, undefined);
  const chartOnly = chatOf(`${HEAD}${DATA}${page('chart')}`)?.chat?.answer;
  assert.ok(chartOnly?.tables);
  assert.equal(chartOnly?.images, undefined);
});

test('AZ1270: a dashboard with nothing it can hold', () => {
  assert.deepEqual(errors(`${HEAD}${page('dashboard')}`), ['AZ1270']);
  assert.deepEqual(errors(`${HEAD}${page('dashboard faq')}`), ['AZ1270'], 'faq is not a tile');
  assert.deepEqual(errors(`${HEAD}${page('dashboard stats')}`), [], 'CONTROL');
});

test('C7 (§21.3): explore is a value of show — it takes the public tables; a dashboard cannot hold one (AZ1270); a page cannot write one', () => {
  const src = `${HEAD}${DATA}${page('explore')}`;
  assert.deepEqual(errors(src), []);
  const answer = chatOf(src)?.chat?.answer;
  assert.deepEqual(answer?.show, ['explore']);
  assert.deepEqual(answer?.tables?.map((t) => t.name), ['orders'], 'an explore may take a table\'s rows');
  assert.equal(answer?.images, undefined);
  assert.deepEqual(errors(`${HEAD}${page('dashboard explore')}`), ['AZ1270'], 'an explore is not a tile');
  assert.deepEqual(errors(`${HEAD}${page('dashboard explore chart')}`), [], 'CONTROL');
  // The table named tool is refused beside an explore too: it takes `from`.
  assert.deepEqual(errors(`${HEAD}${DATA.replace('  data orders', '  data tool')}${page('explore')}`), ['AZ1272']);
  assert.ok(errors(`${HEAD}page /\n  explore\n    title "x"\n  chat panel\n`).length > 0, 'not a word');
  assert.ok(!manifests.has('explore'));
});

test('AZ1272: a public table named tool, where a chat shows a component with from — that word is the data tools\'', () => {
  const TOOL = DATA.replace('  data orders', '  data tool');
  const r = run(`${HEAD}${TOOL}${page('chart')}`);
  const d = r.diagnostics.filter((x) => x.severity === 'error');
  assert.deepEqual(d.map((x) => x.code), ['AZ1272']);
  assert.match(d[0].message, /chat: answers read "from tool" as the server's data tools, so the table 'tool' could never give figures — rename it, then run: az backend schema <file\.az> --rename tool=<new name>/);
  // At the chat's show line, where the reader sees which chat it is.
  assert.equal(d[0].pos.line, `${HEAD}${TOOL}`.split('\n').length - 1 + 8);
  for (const show of ['table', 'stats', 'cards', 'dashboard stats']) assert.deepEqual(errors(`${HEAD}${TOOL}${page(show)}`), ['AZ1272'], show);
  // CONTROL: no component that takes figures, or a table no answer could read, or another name.
  assert.deepEqual(errors(`${HEAD}${TOOL}${page('faq cta')}`), [], 'no from in faq or cta');
  assert.deepEqual(errors(`${HEAD}${DATA.replace('  data notes', '  data tool')}${page('chart')}`), [], 'an owner-only table named tool is never figures');
  assert.deepEqual(errors(`${HEAD}${DATA.replace('  data orders', '  data tools')}${page('chart')}`), [], 'tools is another name');
});

test('AZ1259: the shared-answer page is the chat\'s own, in any case', () => {
  assert.deepEqual(errors(`${HEAD}${page('chart', 'page /chat/shared\n  hero center\n    title "Mine"')}`), ['AZ1259']);
  assert.deepEqual(errors(`${HEAD}${page('chart', 'page /Chat/Shared\n  hero center\n    title "Mine"')}`), ['AZ1259']);
  const noChat = `${HEAD.replace('    model default\n', '').replace('    protect /members\n', '')}page /chat/shared\n  hero center\n    title "Mine"\n`;
  assert.deepEqual(errors(noChat), [], 'CONTROL: without a chat the route is the author\'s');
});

test('the rich components are not words: a page that writes one is refused as unknown', () => {
  const src = `${HEAD}page /\n  chart bar\n    title "x"\n  chat panel\n`;
  assert.ok(errors(src).length > 0);
  assert.ok(!manifests.has('chart') && !manifests.has('dashboard') && !manifests.has('stats'));
});
