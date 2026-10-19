/**
 * Fewer model calls, at the language (chat-block-spec §19.17): a preset's
 * `keywords` (AZ1278), names joined by hyphens, the presets the build makes
 * with `show auto` (or `show all`) from public tables and lists, and a
 * suggested question that answers with a preset or a quote (`ask "…" use
 * <name>`, `ask "…" show faq /help #2`: AZ1279, AZ1280, AZ1276, AZ1277).
 * Each rule has a CONTROL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, type AnswerCheck, type Manifest } from '../src/index.ts';
import { autoPresets, chatAnswers, expandShow, presetParts, AUTO_WORD } from '../src/chat.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(file)) {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}

const site = (show: string, chat = '') => `az 1
site studio
  auth
    adapter azbackend
    protect /members
  backend
    database sqlite
    email smtp
    model default
  data orders
    item   text     required
    status choice   paid open required
    total  money    usd required
    placed datetime required
    allow anyone read
  data stores
    name      text   required
    latitude  number required
    longitude number required
    allow anyone read
  data notes
    body  text required
    total money usd required
    kind  choice a b required

page /
  hero center
    title "Studio"
  chat panel
    show ${show}
    allow anyone
${chat}

page /pricing
  pricing cards
    title    "Plans"
    currency usd
    plan "Home"
      monthly 9
      cta     "Start" /

page /help
  faq
    title "Questions"
    item "Do you ship abroad?"
      text "Yes."
    item "Is there a warranty?"
      text "Two years."
    item "Can I cancel?"
      text "Yes, any time."
  faq
    title "More"
    schema off
    item "One?"
      text "Yes."
    item "Two?"
      text "Yes."
    item "Three?"
      text "Yes."

page /login
  auth login
    redirect /

page /members
  faq
    title "Members"
    item "Secret one?"
      text "Members only."
    item "Secret two?"
      text "Members only."
    item "Secret three?"
      text "Members only."
`;

const codes = (r: ReturnType<typeof compile>) => r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
const chatOf = (r: ReturnType<typeof compile>) => r.spec!.pages[0].blocks.find((b) => b.word === 'chat')!.chat!;

test('keywords: one line of quoted words under answer, split from the body — the parser never sees them', () => {
  assert.deepEqual(presetParts('keywords "orders" "this month"\ncta "Go" /\n'), { text: 'cta "Go" /\n', keywords: ['orders', 'this month'], problem: null });
  const r = compile(site('cta', '    answer talk\n      keywords "contact" "talk"\n      cta "Talk to us" /'), { manifests });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diagnostics));
  assert.deepEqual(chatOf(r).presets, [{ name: 'talk', text: 'cta "Talk to us" /\n', keywords: ['contact', 'talk'] }]);
  // CONTROL: without the line, no keywords — and the Spec says so.
  assert.deepEqual(chatOf(compile(site('cta', '    answer talk\n      cta "Talk to us" /'), { manifests })).presets, [{ name: 'talk', text: 'cta "Talk to us" /\n', keywords: [] }]);
});

test('AZ1278: keywords not quoted, none, too many, too long, written twice, or with lines under it', () => {
  for (const [line, why] of [
    ['keywords contact talk', /takes quoted words/],
    ['keywords', /has no words/],
    [`keywords ${Array.from({ length: 13 }, (_, i) => `"w${i}"`).join(' ')}`, /has 13 words, maximum is 12/],
    [`keywords "${'x'.repeat(41)}"`, /1 to 40 characters/],
    ['keywords "a"\n      keywords "b"', /written twice/],
    ['keywords "a"\n        cta "Hidden" /', /takes no indented lines/],
  ] as const) {
    const r = compile(site('cta', `    answer talk\n      ${line}\n      cta "Talk to us" /`), { manifests });
    assert.deepEqual(codes(r), ['AZ1278'], line);
    assert.match(r.diagnostics.find((d) => d.code === 'AZ1278')!.message, why, line);
  }
});

test('a preset name may join words with hyphens, at most 32 characters; AZ1273 for a hyphen at an end or two together', () => {
  assert.deepEqual(codes(compile(site('cta', '    answer talk-to-us\n      cta "Go" /'), { manifests })), []);
  for (const name of ['talk-', 'talk--us', `t${'-x'.repeat(16)}`]) {
    assert.deepEqual(codes(compile(site('cta', `    answer ${name}\n      cta "Go" /`), { manifests })), ['AZ1273'], name);
  }
});

test('show auto: the build makes presets of the public tables and lists, for the components show lists, in a fixed order', () => {
  const r = compile(site('dashboard stats chart map faq pricing auto'), { manifests });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diagnostics));
  const presets = chatOf(r).presets!;
  assert.deepEqual(presets.map((p) => p.name), ['orders-overview', 'orders-by-month', 'stores-map', 'pricing', 'help-faq', 'help-faq-2']);
  assert.deepEqual(presets.map((p) => p.text), [
    'dashboard "Orders"\n  stat "Orders" from orders count\n  stat "Total" from orders sum total\n  chart bar "Orders by status" from orders count by status\n',
    'chart line "Orders by month" from orders count by placed month\n',
    'map "Stores" from stores label name lat latitude lon longitude\n',
    'show pricing /pricing\n',
    'show faq /help\n',
    'show faq /help#2\n',
  ]);
  assert.deepEqual(presets[0].keywords, ['orders', 'total', 'status', 'overview', 'summary']);
  assert.deepEqual(presets[4].keywords, ['help', 'questions', 'faq']);
  assert.ok(presets.every((p) => typeof p.auto === 'string' && p.auto.length > 0), 'each says what it shows');
  // Never a table signed-out visitors can't read (notes), never a protected page's list.
  assert.ok(!JSON.stringify(presets).includes('notes') && !JSON.stringify(presets).includes('members'));
  // Deterministic.
  assert.deepEqual(chatOf(compile(site('dashboard stats chart map faq pricing auto'), { manifests })).presets, presets);
});

test('show auto makes only what show lists; show all brings auto; an author\'s preset of the same name wins; eight at most', () => {
  assert.deepEqual(chatOf(compile(site('chart auto'), { manifests })).presets!.map((p) => p.name), ['orders-by-month'], 'chart alone: no dashboard, no map, no quote');
  assert.equal(chatOf(compile(site('dashboard stats chart map faq pricing'), { manifests })).presets, undefined, 'CONTROL: without auto, none');
  assert.deepEqual(expandShow(['all'], true).at(-1), AUTO_WORD);
  assert.deepEqual(chatOf(compile(site('all'), { manifests })).presets!.map((p) => p.name).slice(0, 3), ['orders-overview', 'orders-by-month', 'stores-map']);
  const own = chatOf(compile(site('chart auto', '    answer orders-by-month\n      chart bar "Mine" from orders count by status'), { manifests })).presets!;
  assert.deepEqual(own, [{ name: 'orders-by-month', text: 'chart bar "Mine" from orders count by status\n', keywords: [] }], 'the author\'s, not the build\'s');
  const many = Array.from({ length: 7 }, (_, i) => `    answer p${i}\n      cta "Go" /`).join('\n');
  const capped = chatOf(compile(site('cta chart dashboard stats map faq pricing auto', many), { manifests })).presets!;
  assert.equal(capped.length, 8);
  assert.deepEqual(capped.map((p) => p.name).slice(6), ['p6', 'orders-overview']);
});

test('AZ1281 (warning): show auto with no component to make presets of', () => {
  const r = compile(site('auto'), { manifests });
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'AZ1281').map((d) => d.severity), ['warning']);
  assert.ok(!r.diagnostics.some((d) => d.code === 'AZ1254'), 'auto is a word show takes');
  assert.ok(!compile(site('faq auto'), { manifests }).diagnostics.some((d) => d.code === 'AZ1281'), 'CONTROL');
});

test('the build\'s presets are judged like the author\'s: AZ1277 when the chat server\'s parser would drop one', () => {
  const check: AnswerCheck = (_rules, text) => (text.startsWith('chart line') ? 'figures' : null);
  const r = compile(site('chart auto'), { manifests, checkAnswer: check });
  assert.deepEqual(codes(r), ['AZ1277']);
  assert.match(r.diagnostics.find((d) => d.code === 'AZ1277')!.message, /^answer orders-by-month \(made by show auto\): the chat would drop it \(figures\) — write an answer orders-by-month of your own to replace it/);
  // CONTROL: the author's preset of that name replaces it, and is judged instead.
  assert.deepEqual(codes(compile(site('chart auto', '    answer orders-by-month\n      chart bar "Mine" from orders count by status'), { manifests, checkAnswer: check })), []);
});

test('a suggested question may answer with a preset or a quote; the Spec carries the line the server reads', () => {
  const r = compile(site('faq cta auto', '    ask "Is there a warranty?" show faq /help #2\n    ask "Talk?" use talk\n    ask "Any faq?" use help-faq\n    ask "Plain?"\n    answer talk\n      cta "Talk to us" /'), { manifests });
  assert.deepEqual(codes(r), [], JSON.stringify(r.diagnostics));
  assert.deepEqual(chatOf(r).asks, [
    { text: 'Is there a warranty?', answer: 'show faq /help #2' },
    { text: 'Talk?', answer: 'use talk' },
    { text: 'Any faq?', answer: 'use help-faq' },
  ], 'a question without an answer is the model\'s, and not listed');
});

test('AZ1279 an answer of another shape; AZ1280 a preset the chat lacks; AZ1276 a word it does not show; AZ1277 a quote the parser drops', () => {
  for (const tail of ['use', 'use a b', 'show faq', 'show faq /help #x', 'show faq help', 'frobnicate', '"two strings"']) {
    assert.deepEqual(codes(compile(site('faq', `    ask "Q?" ${tail}`), { manifests })), ['AZ1279'], tail);
  }
  const missing = compile(site('faq', '    ask "Q?" use nothing'), { manifests });
  assert.deepEqual(codes(missing), ['AZ1280']);
  assert.match(missing.diagnostics.find((d) => d.code === 'AZ1280')!.message, /use 'nothing', but this chat has no such preset — add one: answer nothing/);
  assert.deepEqual(codes(compile(site('faq', '    ask "Q?" show feature /help'), { manifests })), ['AZ1276']);
  const check: AnswerCheck = (_rules, text) => (text === 'show faq /help #9\n' ? 'no_quote' : null);
  const dropped = compile(site('faq', '    ask "Q?" show faq /help #9'), { manifests, checkAnswer: check });
  assert.deepEqual(codes(dropped), ['AZ1277']);
  assert.match(dropped.diagnostics.find((d) => d.code === 'AZ1277')!.message, /^ask "Q\?": the chat would drop show faq \/help #9 \(no_quote\)/);
  // CONTROL: a sound one passes with the parser.
  assert.deepEqual(codes(compile(site('faq', '    ask "Q?" show faq /help #2'), { manifests, checkAnswer: check })), []);
});

test('the quotable lists core sees are the server\'s: public pages only, items in order, numbered per page', () => {
  const r = compile(site('faq'), { manifests });
  const pages = r.spec!.pages.map((p) => ({ route: p.route, blocks: p.blocks }));
  const lists = chatAnswers(pages, [], new Set(['/members'])).lists;
  assert.deepEqual(lists.map((l) => [l.route, l.n, l.title, l.items.length]), [['/help', 0, 'Questions', 3], ['/help', 1, 'More', 3]]);
  assert.deepEqual(lists[0].items[1], { title: 'Is there a warranty?', text: 'Two years.' });
  assert.deepEqual(autoPresets(['faq'], chatAnswers(pages, [], new Set(['/members']))), [], 'CONTROL: no auto, no presets');
});
