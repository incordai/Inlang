/**
 * `chat` and `backend … model default` (chat-block-spec §3): every code the
 * block can raise in C1 has a case that triggers it, and each rule has a
 * CONTROL that holds it to the file it judges.
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

const BACKEND = '  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\n';
const MODEL = '    model default\n';
/** A site with a backend (and a model unless `model` is false) and one page holding `body`. */
const site = (body: string, { model = true, extra = '' } = {}) =>
  `az 1\nsite studio\n${BACKEND}${model ? MODEL : ''}${extra}page /\n${body}page /login\n  auth login\n    alt "Back to the studio" /\n`;
const chat = (lines = '') => `  chat panel\n${lines}`;
const run = (src: string) => compile(src, { manifests });
const errors = (src: string) => run(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
const warnings = (src: string) => run(src).diagnostics.filter((d) => d.severity === 'warning').map((d) => d.code);
const message = (src: string, code: string) => run(src).diagnostics.find((d) => d.code === code)?.message ?? '';

test('a chat panel with a model compiles, and the Spec carries the model and the chat route', () => {
  const r = run(site(chat('    title "Ask Studio"\n    ask "What do you make?"\n')));
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.deepEqual(r.spec?.site.backend, { database: 'sqlite', email: 'smtp', model: 'default' });
  const block = r.spec!.pages[0].blocks.find((b) => b.word === 'chat')!;
  assert.equal(block.variant, 'panel');
  assert.deepEqual(block.chat, { route: '/', signin: '/login' });
  assert.equal(block.props.allow, 'signedin', 'signed-in visitors only, by default (Q3)');
  assert.equal(block.props.limit, '20');
  assert.equal(block.props.title, 'Ask Studio');
});

test('allow anyone has no sign-in page to offer', () => {
  const r = run(site(chat('    allow anyone\n')));
  assert.deepEqual(r.spec!.pages[0].blocks.find((b) => b.word === 'chat')!.chat, { route: '/', signin: null });
});

test('CONTROL: a site without chat or a model serialises exactly as before — no model, no chat key', () => {
  const r = run(site('  hero center\n    title "Studio"\n', { model: false }));
  const json = serialiseSpec(r.spec!);
  assert.equal(json.includes('"model"'), false);
  assert.equal(json.includes('"chat"'), false);
});

test('AZ1250: chat needs a backend that talks to a model', () => {
  assert.deepEqual(errors(site(chat(), { model: false })), ['AZ1250']);
  assert.match(message(site(chat(), { model: false }), 'AZ1250'), /^chat: needs a backend with a model — add under backend: model default$/);
  // No backend at all is the same answer: the model line is what is missing.
  assert.ok(errors(`az 1\nsite studio\npage /\n${chat()}`).includes('AZ1250'));
});

test('AZ1251: a model nothing uses is a warning, not an error', () => {
  const src = site('  hero center\n    title "Studio"\n');
  assert.deepEqual(errors(src), []);
  assert.deepEqual(warnings(src), ['AZ1251']);
  assert.deepEqual(warnings(site(chat())), [], 'CONTROL: a page with chat uses the model');
});

test('AZ1412: the model is the operator\'s choice — an id or an address is told where it goes', () => {
  for (const value of ['some-model-id', 'https://models.example.org/v1']) {
    const src = site(chat()).replace('model default', `model ${value}`);
    assert.ok(errors(src).includes('AZ1412'), value);
    assert.equal(message(src, 'AZ1412'), "backend: the model is chosen in the server's .env (AZ_CHAT_API, AZ_CHAT_MODEL) — write: model default");
  }
});

test('CONTROL: backend still needs database and email, but never model', () => {
  const noEmail = `az 1\nsite studio\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    model default\npage /\n${chat()}`;
  assert.deepEqual(errors(noEmail), ['AZ1225']);
  assert.deepEqual(errors(site('  hero center\n    title "Studio"\n', { model: false })), []);
});

test('AZ1254: a word an answer can never show is refused with its reason', () => {
  const src = site(chat('    show auth\n'));
  assert.deepEqual(errors(src), ['AZ1254']);
  assert.equal(message(src, 'AZ1254'),
    "chat: 'auth' can't be in an answer (a sign-in form placed by a model is a phishing form) — show takes pricing, faq, cta or feature");
  assert.deepEqual(errors(site(chat('    show banana\n'))), ['AZ1254'], 'an unknown word too');
});

test('AZ1214: show and site-level chat are not available in C1', () => {
  assert.deepEqual(errors(site(chat('    show pricing faq\n'))), ['AZ1214', 'AZ1214']);
  assert.match(message(site(chat('    show cta\n')), 'AZ1214'), /show 'cta' is not available yet — answers are text for now/);
  const atSite = `az 1\nsite studio\n${BACKEND}${MODEL}  chat panel\npage /\n`;
  assert.ok(errors(atSite).includes('AZ1214'));
});

test('AZ1256: allow anyone spends the operator\'s budget on strangers — a warning', () => {
  const src = site(chat('    allow anyone\n'));
  assert.deepEqual(errors(src), []);
  assert.deepEqual(warnings(src), ['AZ1256']);
  assert.deepEqual(warnings(site(chat('    allow signedin\n'))), [], 'CONTROL: the default is silent');
});

test('the per-word rows AZ2220–AZ2228 each fire, and only on what they judge', () => {
  const cases: [string, string, string][] = [
    ['AZ2220', 'two chats on one page', site(`${chat()}${chat()}`)],
    ['AZ2221', 'a 61-character title', site(chat(`    title "${'t'.repeat(61)}"\n`))],
    ['AZ2222', 'a 201-character greeting', site(chat(`    greeting "${'g'.repeat(201)}"\n`))],
    ['AZ2223', 'an 81-character suggestion', site(chat(`    ask "${'a'.repeat(81)}"\n`))],
    ['AZ2224', 'five suggestions', site(chat([1, 2, 3, 4, 5].map((n) => `    ask "Question ${n}?"\n`).join('')))],
    ['AZ2226', 'an empty title', site(chat('    title " "\n'))],
    ['AZ2227', 'an empty greeting', site(chat('    greeting ""\n'))],
    ['AZ2228', 'an empty suggestion', site(chat('    ask ""\n'))],
  ];
  for (const [code, what, src] of cases) assert.deepEqual(errors(src), [code], what);
  assert.deepEqual(warnings(site(chat('    ask "Same?"\n    ask "Same?"\n'))), ['AZ2225'], 'a suggestion twice');
  // CONTROL: exactly at each limit, nothing fires.
  const edge = site(chat(`    title "${'t'.repeat(60)}"\n    greeting "${'g'.repeat(200)}"\n`
    + [1, 2, 3].map((n) => `    ask "Question ${n}?"\n`).join('') + `    ask "${'a'.repeat(80)}"\n`));
  assert.deepEqual(run(edge).diagnostics, []);
});

test('limit is a whole number from 1 to 50 (AZ1407, AZ1408)', () => {
  assert.deepEqual(errors(site(chat('    limit 0\n'))), ['AZ1408']);
  assert.deepEqual(errors(site(chat('    limit 51\n'))), ['AZ1408']);
  assert.deepEqual(errors(site(chat('    limit many\n'))), ['AZ1407']);
  assert.deepEqual(errors(site(chat('    limit 50\n'))), [], 'CONTROL: 50 is allowed');
});

test('float is not a variant in C1 (AZ1204), and a key in a string is AZ1411 as everywhere', () => {
  assert.deepEqual(errors(site('  chat float\n')), ['AZ1204']);
  const key = `sk_live_${'aB3dE5gH7jK9mN1pQ3sT5vW7yZ9bC1dF'}`;
  assert.ok(errors(site(chat(`    greeting "${key}"\n`))).includes('AZ1411'));
});
