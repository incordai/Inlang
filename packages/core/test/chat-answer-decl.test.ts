/**
 * `show` (chat-block-spec §3.4, §5.3, §6.2, C2): what a chat's answers may
 * hold reaches its Spec block — the words, the pricing blocks it may quote,
 * the destinations it may link to — and AZ1255 refuses a `show pricing`
 * with nothing to quote. Each rule has a CONTROL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, serialiseSpec, type Manifest } from '../src/index.ts';

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
const PRICING = (title: string, price: string) => `  pricing cards\n    title "${title}"\n    currency usd\n    plan "Team"\n      monthly ${price}\n      cta "Start" /login\n`;
const PAGES = [
  'page /',
  '  hero center',
  '    title "Studio"',
  '    cta "Docs" https://docs.studio.example/start',
  '    alt "Mail us" mailto:help@studio.example',
  '  chat panel',
  '    show feature cta pricing faq',
  'page /pricing',
  PRICING('Plans', '29') + PRICING('More plans', '49').trimEnd(),
  'page /members',
  PRICING('Members only', '9').trimEnd(),
  '  cta card',
  '    title "Secret"',
  '    cta "Hidden" https://hidden.studio.example/',
  'page /signup',
  '  auth signup',
  '    terms /terms',
  '    alt "Sign in" /login',
  '  cta card',
  '    title "Call"',
  '    cta "Call us" tel:+15550100',
  '    alt "Old docs" http://old.studio.example/',
  'page /terms',
  '  text',
  '    title "Terms"',
  '    body "Plain."',
  'page /login',
  '  auth login',
  '    alt "Back" /',
  '',
].join('\n');

const run = (src: string) => compile(src, { manifests });
const errors = (src: string) => run(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
const chatOf = (src: string) => run(src).spec!.pages[0].blocks.find((b) => b.word === 'chat')!.chat!;

test('show reaches the chat block: its words in the closed order, the quotable pricing blocks, the declared destinations', () => {
  const src = HEAD + PAGES;
  assert.deepEqual(errors(src), []);
  const answer = chatOf(src).answer!;
  assert.deepEqual(answer.show, ['pricing', 'faq', 'cta', 'feature'], 'the closed list\'s order, whatever the file wrote');
  // Each pricing block a signed-out visitor can open, numbered per page; the protected page's prices are not quotable.
  assert.deepEqual(answer.quotes.map((q) => [q.route, q.n, q.block.props.title]), [['/pricing', 0, 'Plans'], ['/pricing', 1, 'More plans']]);
  assert.equal(answer.quotes[0].block.word, 'pricing');
  // Every page, and every https, mailto and tel destination the file writes — exactly as written.
  // Not http, and not one only a protected page holds.
  assert.deepEqual(answer.destinations, [
    '/', '/login', '/members', '/pricing', '/signup', '/terms',
    'https://docs.studio.example/start', 'mailto:help@studio.example', 'tel:+15550100',
  ]);
});

test('quotes come only with pricing, destinations only with cta: the shell carries no more than its answers can use', () => {
  const faqOnly = chatOf((HEAD + PAGES).replace('show feature cta pricing faq', 'show faq'));
  assert.deepEqual(faqOnly.answer, { show: ['faq'], quotes: [], destinations: [] });
  // CONTROL: a chat without show is prose only and serialises exactly as before — no answer key at all.
  const src = (HEAD + PAGES).replace('    show feature cta pricing faq\n', '');
  assert.equal(chatOf(src).answer, undefined);
  assert.equal(serialiseSpec(run(src).spec!).includes('"answer"'), false);
});

test('AZ1255: show pricing with no pricing block to quote', () => {
  const none = HEAD + 'page /\n  chat panel\n    show pricing\npage /members\npage /login\n  auth login\n    alt "Back" /\n';
  assert.deepEqual(errors(none), ['AZ1255']);
  assert.equal(run(none).diagnostics.find((d) => d.code === 'AZ1255')!.message,
    'chat: show pricing, but no page has a pricing block to quote — add one, or remove pricing from show');
  // A pricing block only on a protected page cannot be quoted to a stranger either.
  const hidden = HEAD + `page /\n  chat panel\n    show pricing\npage /members\n${PRICING('Members', '9')}page /login\n  auth login\n    alt "Back" /\n`;
  assert.deepEqual(errors(hidden), ['AZ1255']);
  // CONTROL: one public pricing block is enough; and without pricing in show nothing is asked of the site.
  assert.deepEqual(errors(HEAD + PAGES), []);
  assert.deepEqual(errors(none.replace('show pricing', 'show faq')), []);
});

test('two builds of the same file give the same answer, byte for byte', () => {
  const a = serialiseSpec(run(HEAD + PAGES).spec!);
  const b = serialiseSpec(run(HEAD + PAGES).spec!);
  assert.equal(a, b);
  assert.ok(a.includes('"destinations"'));
});
