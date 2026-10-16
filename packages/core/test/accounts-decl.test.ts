/**
 * What needs accounts from the built-in backend (core accounts.ts,
 * chat-block-spec §19.15): a chat open to anyone needs none, so its backend
 * needs neither `email` (AZ1225) nor `auth adapter azbackend` (AZ1507); each
 * thing that does need accounts is named by the diagnostic it causes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { compile, serialiseSpec, type Manifest } from '../src/index.ts';
import { accountNeeds } from '../src/accounts.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (existsSync(file)) {
    const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}

const errors = (src: string) => compile(src, { manifests }).diagnostics.filter((d) => d.severity === 'error');
const codes = (src: string) => errors(src).map((d) => d.code);
const message = (src: string, code: string) => errors(src).find((d) => d.code === code)?.message ?? '';

/** The smallest public chat site, exactly as issue #3 wrote it. */
const PUBLIC = `az 1
site demo
  backend
    database sqlite
    model    default

page /
  chat panel
    allow anyone
`;

test('a chat open to anyone needs only backend + database + model default: no email, no auth, no sign-in pages', () => {
  const r = compile(PUBLIC, { manifests });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  // Q3 (chat-block-spec §17): signedin stays the default, so the public chat is explicit and warned.
  assert.deepEqual(r.diagnostics.map((d) => d.code), ['AZ1256']);
  assert.deepEqual(r.spec?.site.backend, { database: 'sqlite', model: 'default' });
  assert.equal(serialiseSpec(r.spec!).includes('"email"'), false, 'a server without accounts has no email choice in the Spec');
});

test('a site float open to anyone needs no accounts either; chat none asks nothing', () => {
  const src = `az 1
site demo
  backend
    database postgres
    model    default
  chat float
    allow anyone

page /
page /checkout
  chat none
`;
  assert.deepEqual(codes(src), []);
});

test('a chat for signed-in visitors (the default) needs accounts: AZ1225 and AZ1507 name that chat and the way out', () => {
  const src = PUBLIC.replace('    allow anyone\n', '');
  assert.deepEqual(codes(src).sort(), ['AZ1225', 'AZ1507']);
  assert.equal(message(src, 'AZ1225'),
    'backend: no email — the chat on / is for signed-in visitors only (allow signedin is the default), and accounts need email for sign-in links and password resets — add: email smtp|api, or under that chat write: allow anyone');
  assert.equal(message(src, 'AZ1507'),
    "backend: the chat on / is for signed-in visitors only (allow signedin is the default), so the site's auth must sign in with this server — add at site level: auth / adapter azbackend, or under that chat write: allow anyone");
});

test('an explicit allow signedin is named as written; the site float is named as the float', () => {
  const page = PUBLIC.replace('allow anyone', 'allow signedin');
  assert.match(message(page, 'AZ1225'), /the chat on \/ is for signed-in visitors only \(allow signedin\)/);
  const float = `az 1
site demo
  backend
    database sqlite
    model    default
  chat float

page /help
`;
  assert.match(message(float, 'AZ1225'), /the site's chat float is for signed-in visitors only/);
});

test('one signed-in chat among public ones still needs accounts, and names its own page', () => {
  const src = `${PUBLIC}page /members
  chat panel
    allow signedin
`;
  assert.match(message(src, 'AZ1225'), /the chat on \/members/);
});

test('data tables need accounts: /admin is for signed-in admins', () => {
  const src = `az 1
site demo
  backend
    database sqlite
  data notes
    body text
    allow anyone read

page /
`;
  assert.deepEqual(codes(src).sort(), ['AZ1225', 'AZ1507']);
  assert.match(message(src, 'AZ1225'), /the table 'notes' is kept on \/admin by signed-in admins/);
  const two = src.replace('page /', '  data posts\n    title text\n    allow anyone read\n\npage /');
  assert.match(message(two, 'AZ1225'), /the tables \('notes' and 1 more\) are kept on \/admin/);
});

test("the site's auth signing in with this server needs email: AZ1225 alone, saying so", () => {
  const src = `az 1
site demo
  auth
    adapter azbackend
  backend
    database sqlite

page /
`;
  assert.deepEqual(codes(src), ['AZ1225']);
  assert.match(message(src, 'AZ1225'), /the site's auth signs people in with this server \(adapter azbackend\)/);
});

test('email with nothing that signs in is AZ1507: remove it for a server without accounts, or add the auth', () => {
  const src = PUBLIC.replace('    model    default\n', '    email    smtp\n    model    default\n');
  assert.deepEqual(codes(src), ['AZ1507']);
  assert.equal(message(src, 'AZ1507'),
    'backend: email smtp is for accounts, but nothing on the site signs in — remove the email line for a server without accounts, or add at site level: auth / adapter azbackend');
});

test('an auth with another adapter beside the backend is AZ1507 as before, even for a public chat', () => {
  const src = PUBLIC.replace('site demo\n', 'site demo\n  auth\n    adapter hosted\n');
  assert.ok(codes(src).includes('AZ1507'), codes(src).join(','));
  assert.equal(message(src, 'AZ1507'), "backend: the site's auth must use it — add at site level: auth / adapter azbackend");
});

test('CONTROL: the full accounts setup compiles as before, email in the Spec', () => {
  const src = `az 1
site demo
  auth
    adapter azbackend
  backend
    database sqlite
    email    api
    model    default

page /
  chat panel
page /login
  auth login
    alt "Create an account" /signup
page /signup
  auth signup
    terms /terms
    alt "Sign in" /login
page /terms
`;
  const r = compile(src, { manifests });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.deepEqual(r.spec?.site.backend, { database: 'sqlite', email: 'api', model: 'default' });
});

test('a written email line without a value is AZ1205 once, never also "no email"', () => {
  const src = PUBLIC.replace('allow anyone', 'allow signedin').replace('    model    default\n', '    email\n    model    default\n');
  assert.ok(codes(src).includes('AZ1205'), codes(src).join(','));
  assert.equal(codes(src).includes('AZ1225'), false, codes(src).join(','));
});

test('database is still required by link (AZ1225), whatever needs accounts', () => {
  const src = PUBLIC.replace('    database sqlite\n', '');
  assert.match(message(src, 'AZ1225'), /^backend: no database — add: database sqlite\|postgres\|mysql$/);
});

test('accountNeeds lists the auth, then each chat, then the tables — and nothing for public chats alone', () => {
  const pos = { line: 1, col: 1 };
  assert.deepEqual(accountNeeds({ auth: undefined, chats: [{ allow: 'anyone', route: '/', pos }], tables: [] }), []);
  const needs = accountNeeds({
    auth: { adapter: 'azbackend', pos },
    chats: [{ allow: undefined, route: null, pos }, { allow: 'anyone', route: '/', pos }],
    tables: [{ name: 'notes', pos }],
  });
  assert.deepEqual(needs.map((n) => n.why), [
    "the site's auth signs people in with this server (adapter azbackend)",
    "the site's chat float is for signed-in visitors only (allow signedin is the default)",
    "the table 'notes' is kept on /admin by signed-in admins",
  ]);
});
