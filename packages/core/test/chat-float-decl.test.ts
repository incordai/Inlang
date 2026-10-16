/**
 * C3 (chat-block-spec §3.1, §3.4, §8.2, §14): `chat float` declared under
 * `site` is inherited by every page as nav and footer are — a page's own
 * panel replaces it, `chat none` leaves it out, a page's own float beside it
 * is AZ2229 — and each page's copy asks from that page. `knows` names up to
 * three tables a signed-out visitor can read and only the site fills; the
 * Spec carries their public fields only. Every rule has a CONTROL.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { blocksFor, compile, serialiseSpec, type Manifest } from '../src/index.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(file)) {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}

const HEAD = 'az 1\nsite studio\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\n    model default\n';
const TABLES = [
  '  data questions',
  '    question text     required search',
  '    answer   longtext required search',
  '    note     text     private',
  '    photo    image',
  '    allow anyone read',
  '  data comments',
  '    body text required',
  '    allow anyone read',
  '    allow anyone create',
  '  data posts',
  '    body text required',
  '    allow anyone read',
  '    allow signedin create',
  '    allow owner edit delete',
  '  data orders',
  '    total number required',
  '    allow owner read',
  '    allow signedin create',
  '  data members',
  '    name text required',
  '    allow signedin read',
  '  data secrets',
  '    code text private',
  '    allow anyone read',
  '  data alpha',
  '    x text',
  '    allow anyone read',
  '  data bravo',
  '    x text',
  '    allow anyone read',
  '  data charlie',
  '    x text',
  '    allow anyone read',
].join('\n') + '\n';
const FLOAT = (lines = '') => `  chat float\n    title "Ask Studio"\n    allow anyone\n${lines}`;
const PAGES = 'page /\n  hero center\n    title "Studio"\npage /about\n  hero center\n    title "About"\npage /login\n  auth login\n    alt "Back" /\n';
const run = (src: string) => compile(src, { manifests });
const errors = (src: string) => run(src).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
const message = (src: string, code: string) => run(src).diagnostics.find((d) => d.code === code)?.message ?? '';
const chatOn = (src: string, route: string) => {
  const spec = run(src).spec!;
  return blocksFor(spec, spec.pages.find((p) => p.route === route)!).filter((b) => b.word === 'chat');
};

test('a float under site compiles and is on every page, after the content, asking from that page', () => {
  const src = `${HEAD}${FLOAT()}${PAGES}`;
  assert.deepEqual(errors(src), []);
  const spec = run(src).spec!;
  assert.deepEqual(spec.site.inherited.map((b) => `${b.word} ${b.variant}`), ['chat float']);
  assert.equal(spec.site.inherited[0].chat?.route, '', 'the site\'s float names no page of its own');
  for (const route of ['/', '/about', '/login']) {
    const page = spec.pages.find((p) => p.route === route)!;
    const blocks = blocksFor(spec, page);
    assert.equal(blocks.at(-1)?.word, 'chat', `${route}: the launcher closes the page`);
    assert.deepEqual(blocks.at(-1)?.chat, { route, signin: null }, `${route}: asks from ${route}`);
  }
});

test('chat none leaves the float out of one page; a page\'s own panel replaces it there', () => {
  const src = `${HEAD}${FLOAT()}${PAGES}page /quiet\n  chat none\npage /help\n  chat panel\n    title "Help"\n    allow anyone\n`;
  assert.deepEqual(errors(src), []);
  assert.deepEqual(chatOn(src, '/quiet'), [], 'chat none: no chat at all');
  const help = chatOn(src, '/help');
  assert.deepEqual(help.map((b) => `${b.variant} ${b.props.title}`), ['panel Help'], 'one chat: the page\'s own');
  assert.deepEqual(chatOn(src, '/').map((b) => b.variant), ['float'], 'CONTROL: every other page keeps the float');
});

test('AZ2229: a page\'s own float under the site\'s is refused where the page wrote it', () => {
  const src = `${HEAD}${FLOAT()}${PAGES}page /twice\n  chat float\n    allow anyone\n`;
  assert.deepEqual(errors(src), ['AZ2229']);
  assert.equal(message(src, 'AZ2229'), "chat: this page already has the site's chat float — remove this one, or write chat none to leave it out here");
  assert.equal(run(src).diagnostics.find((d) => d.code === 'AZ2229')?.pos.line, src.split('\n').lastIndexOf('  chat float') + 1, 'at the page\'s own line');
  // CONTROL: a float on one page of a site without one is that page's own.
  const own = `${HEAD}${PAGES}page /one\n  chat float\n    allow anyone\n`;
  assert.deepEqual(errors(own), []);
  assert.deepEqual(chatOn(own, '/one').map((b) => b.chat?.route), ['/one']);
  assert.deepEqual(chatOn(own, '/'), []);
});

test('chat none asks nothing of the backend: no AZ1250 without a model, no chat counted', () => {
  const noModel = HEAD.replace('    model default\n', '');
  assert.deepEqual(errors(`${noModel}${PAGES}page /quiet\n  chat none\n`), []);
  assert.ok(errors(`${noModel}${FLOAT()}${PAGES}`).includes('AZ1250'), 'CONTROL: a float does need the model');
});

test('AZ1251 points at the float now; AZ1259 holds for a site whose only chat is the site\'s float', () => {
  const unused = `${HEAD}${PAGES}`;
  assert.equal(run(unused).diagnostics.find((d) => d.code === 'AZ1251')?.message, 'backend: model default but no page shows chat — remove it, or add under site: chat float');
  assert.ok(errors(`${HEAD}${FLOAT()}${PAGES}page /chat/shared\n`).includes('AZ1259'));
  assert.ok(!errors(`${HEAD}${PAGES}page /chat/shared\n`).includes('AZ1259'), 'CONTROL: without a chat the route is free');
});

test('a float serialises deterministically, and a site without one exactly as before', () => {
  const src = `${HEAD}${FLOAT()}${PAGES}`;
  assert.deepEqual(errors(src), []);
  assert.equal(serialiseSpec(run(src).spec!), serialiseSpec(run(src).spec!));
  assert.match(serialiseSpec(run(src).spec!), /"inherited": \[\s*\{[\s\S]*"word": "chat"/, 'the float is the site\'s, inherited');
  assert.ok(!serialiseSpec(run(`${HEAD}${PAGES}page /c\n  chat panel\n`).spec!).includes('"knows"'), 'CONTROL: no knows, no key');
});

/* ---- knows (§8.2) ---- */

const KNOWS = (names: string) => `${HEAD}${TABLES}${FLOAT(`    knows ${names}\n`)}${PAGES}`;

test('knows: a public table only the site fills compiles; the Spec carries its public fields, never a private or image one', () => {
  const src = KNOWS('questions');
  assert.deepEqual(errors(src), []);
  const chat = chatOn(src, '/about')[0];
  assert.deepEqual(chat.chat?.knows, [{
    name: 'questions',
    fields: [{ name: 'question', type: 'text', search: true }, { name: 'answer', type: 'longtext', search: true }],
  }]);
});

test('knows on a page panel carries its tables too, and three tables are the most', () => {
  const src = `${HEAD}${TABLES}page /\n  chat panel\n    allow anyone\n    knows alpha bravo charlie\n${PAGES.replace('page /\n  hero center\n    title "Studio"\n', '')}`;
  assert.deepEqual(errors(src), []);
  assert.deepEqual(chatOn(src, '/')[0].chat?.knows?.map((t) => t.name), ['alpha', 'bravo', 'charlie']);
});

test('AZ1252: a table signed-out visitors can\'t read — owner-only, signed-in only — or none of whose fields they can', () => {
  for (const t of ['orders', 'members']) {
    assert.deepEqual(errors(KNOWS(t)), ['AZ1252'], t);
    assert.equal(message(KNOWS(t), 'AZ1252'), `chat: knows '${t}', which signed-out visitors can't read — chat only knows tables with: allow anyone read`);
  }
  assert.deepEqual(errors(KNOWS('secrets')), ['AZ1252']);
  assert.match(message(KNOWS('secrets'), 'AZ1252'), /no field signed-out visitors can read/);
});

test('AZ1253: a table strangers write to — anyone or signed-in create, owner edit — is refused, so their text never steers the model', () => {
  assert.deepEqual(errors(KNOWS('comments')), ['AZ1253']);
  assert.equal(message(KNOWS('comments'), 'AZ1253'),
    "chat: knows 'comments', which takes rows from strangers (allow anyone create) — their text would steer the model; pick a table only you fill");
  assert.deepEqual(errors(KNOWS('posts')), ['AZ1253']);
  assert.match(message(KNOWS('posts'), 'AZ1253'), /\(allow signedin create\)/);
  // CONTROL: the same table without its write rules is one only the site fills.
  const quiet = KNOWS('posts').replace('    allow signedin create\n    allow owner edit delete\n', '');
  assert.deepEqual(errors(quiet), []);
});

test('AZ1253 holds for an edit rule alone: changing a row is writing it', () => {
  const src = KNOWS('questions').replace('    photo    image\n    allow anyone read\n', '    photo    image\n    allow anyone read\n    allow owner edit\n');
  assert.deepEqual(errors(src), ['AZ1253']);
  assert.match(message(src, 'AZ1253'), /lets strangers change its rows \(allow owner edit\)/);
});

test('AZ1258: a table named twice, or a fourth table', () => {
  assert.ok(errors(KNOWS('questions questions')).includes('AZ1258'));
  assert.equal(message(KNOWS('questions questions'), 'AZ1258'), "chat: knows 'questions' twice — keep one");
  assert.deepEqual(errors(KNOWS('alpha bravo charlie questions')), ['AZ1258']);
  assert.equal(message(KNOWS('alpha bravo charlie questions'), 'AZ1258'), 'chat: knows 4 tables, max is 3 — remove 1');
});

test('AZ1271: a name that is no table — with tables, and on a site with none', () => {
  assert.deepEqual(errors(KNOWS('faqs')), ['AZ1271']);
  assert.equal(message(KNOWS('faqs'), 'AZ1271'), "chat: knows 'faqs', which is not a table — declare it under site with: data faqs, or remove it");
  assert.ok(errors(`${HEAD}${FLOAT('    knows faqs\n')}${PAGES}`).includes('AZ1271'));
});
