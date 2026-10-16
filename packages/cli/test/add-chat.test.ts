/**
 * `az add chat` (chat-block-spec §19.15): the edit in place, and its safety —
 * a backup before any change and never over one; nothing changed when the
 * file does not compile, is a link, leaves the page's chat out, or the edit
 * would not pass `az check`; a second run adds nothing. The full loop
 * (fresh site → check → az dev serving the demo answers) is
 * scripts/add-chat-e2e.mjs (`pnpm test:dev`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addChat, ENV_MARK, planChat } from '../src/add-chat.ts';
import { compile, type Manifest } from '../../core/src/index.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const BIN = join(ROOT, 'packages/cli/bin/az.js');

const manifests = new Map<string, Manifest>();
for (const n of readdirSync(WORDS)) {
  const f = join(WORDS, n, 'word.json');
  if (existsSync(f)) {
    const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
}

const FRESH = 'az 1\nsite demo\n  theme midnight\n\npage /\n  hero center\n    title "Hello"\n';

function project(source = FRESH) {
  const dir = mkdtempSync(join(tmpdir(), 'az-add-'));
  const file = join(dir, 'site.az');
  writeFileSync(file, source, 'utf8');
  return { dir, file, out: join(dir, '.az-build') };
}
const run = (file: string, over: Partial<{ float: boolean; page: string | null; show: string[] | null }> = {}) =>
  addChat({ file, float: false, page: null, show: null, wordsDir: WORDS, outDir: join(file, '..', '.az-build'), ...over });
const errorsOf = (text: string) => compile(text, { manifests }).diagnostics.filter((d) => d.severity === 'error');
const filesIn = (dir: string) => readdirSync(dir).sort();

test('a fresh site gets the backend lines, a panel on / open to anyone and the model keys; the file was backed up; it compiles', () => {
  const p = project();
  const r = run(p.file, { show: ['all'] });
  assert.ok(r.ok, r.ok ? '' : r.message);
  const text = readFileSync(p.file, 'utf8');
  assert.equal(text, `az 1
site demo
  theme midnight
  backend
    database sqlite
    model    default

page /
  hero center
    title "Hello"
  chat panel
    title    "Ask demo"
    greeting "Hi! Ask me anything about this site."
    ask      "What can you help me with?"
    ask      "How do I get in touch?"
    show     all
    allow    anyone
`);
  assert.deepEqual(errorsOf(text), []);
  assert.deepEqual(r.backups, [`${p.file}.bak`]);
  assert.equal(readFileSync(`${p.file}.bak`, 'utf8'), FRESH, 'the backup is the file as it was');
  assert.match(r.check, /az: no problems found$/);
  const env = readFileSync(join(p.dir, '.az-dev/backend.env'), 'utf8');
  assert.ok(env.startsWith(`${ENV_MARK}\n`));
  for (const k of ['AZ_CHAT_API=completions', 'AZ_CHAT_URL=', 'AZ_CHAT_KEY=', 'AZ_CHAT_MODEL=']) assert.match(env, new RegExp(`^# ${k}$`, 'm'));
  assert.doesNotMatch(env, /^AZ_/m, 'every key is commented: az dev keeps the demo script');
  assert.equal(statSync(join(p.dir, '.az-dev/backend.env')).mode & 0o777, 0o600);
  assert.ok(existsSync(join(p.dir, '.az-dev/.gitignore')), '.az-dev ignores itself');
});

test('twice is once: the second run changes no file and makes no backup', () => {
  const p = project();
  assert.ok(run(p.file).ok);
  const text = readFileSync(p.file, 'utf8');
  const env = readFileSync(join(p.dir, '.az-dev/backend.env'), 'utf8');
  const before = filesIn(p.dir);
  const again = run(p.file);
  assert.ok(again.ok);
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.backups, []);
  assert.deepEqual(again.kept, ['backend: already talks to a model (model default)', 'chat: page / already has a chat']);
  assert.equal(readFileSync(p.file, 'utf8'), text);
  assert.equal(readFileSync(join(p.dir, '.az-dev/backend.env'), 'utf8'), env);
  assert.deepEqual(filesIn(p.dir), before);
});

test('a file that does not compile is refused, and nothing is written — no backup, no keys', () => {
  const broken = `${FRESH}  hero split\n`;
  const p = project(broken);
  const r = run(p.file);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.message, /does not compile as it is — fix it first, nothing was changed/);
  assert.equal(readFileSync(p.file, 'utf8'), broken);
  assert.deepEqual(filesIn(p.dir), ['site.az']);
});

test('an edit that would not pass az check (a word answers can never show) is refused before anything is written', () => {
  const p = project();
  const r = run(p.file, { show: ['auth'] });
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.message, /would not pass az check — nothing was changed[\s\S]*AZ1254/);
  assert.equal(readFileSync(p.file, 'utf8'), FRESH);
  assert.deepEqual(filesIn(p.dir), ['site.az']);
});

test('a link is never written through, and a page that leaves its chat out is refused', () => {
  const p = project();
  const link = join(p.dir, 'link.az');
  symlinkSync(p.file, link);
  const r = run(link);
  assert.equal(r.ok, false);
  assert.match(r.ok ? '' : r.message, /is a link/);
  assert.equal(readFileSync(p.file, 'utf8'), FRESH);
  const none = project(`az 1
site demo
  backend
    database sqlite
    model    default
  chat float
    allow anyone

page /
page /checkout
  chat none
`);
  const refused = run(none.file, { page: '/checkout' });
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? '' : refused.message, /page \/checkout says chat none/);
  assert.deepEqual(filesIn(none.dir), ['site.az']);
});

test('--page /help makes the page when it is missing; on a page with its own footer the panel goes before the footer', () => {
  const plan = planChat(FRESH, { float: false, page: '/help', show: null });
  assert.ok(!('error' in plan));
  assert.ok(plan.text.endsWith('\n\npage /help\n  chat panel\n    title    "Ask demo"\n    greeting "Hi! Ask me anything about this site."\n    ask      "What can you help me with?"\n    ask      "How do I get in touch?"\n    allow    anyone\n'), plan.text);
  assert.deepEqual(errorsOf(plan.text), []);
  const footed = `${FRESH}  footer minimal\n    link "Home" /\n`;
  const withFooter = planChat(footed, { float: false, page: '/', show: null });
  assert.ok(!('error' in withFooter));
  const lines = withFooter.text.split('\n');
  assert.ok(lines.indexOf('  chat panel') < lines.indexOf('  footer minimal'), withFooter.text);
  assert.deepEqual(errorsOf(withFooter.text), []);
});

test('--float puts a chat float under site after the new backend; a site that has one keeps it', () => {
  const plan = planChat(FRESH, { float: true, page: null, show: ['figures'] });
  assert.ok(!('error' in plan));
  const lines = plan.text.split('\n');
  assert.deepEqual(lines.slice(3, 13), [
    '  backend', '    database sqlite', '    model    default',
    '  chat float', '    title    "Ask demo"', '    greeting "Hi! Ask me anything about this site."',
    '    ask      "What can you help me with?"', '    ask      "How do I get in touch?"', '    show     figures', '    allow    anyone',
  ]);
  assert.deepEqual(errorsOf(plan.text), []);
  const again = planChat(plan.text, { float: true, page: null, show: null });
  assert.ok(!('error' in again));
  assert.equal(again.text, plan.text);
  assert.deepEqual(again.kept, ['backend: already talks to a model (model default)', 'chat: the site already has a chat float']);
});

test('a site that keeps accounts gets model default under its backend and a chat for signed-in visitors (no allow line)', () => {
  const accounts = `az 1
site studio
  auth
    adapter azbackend
  backend
    database postgres
    email    api

page /
  hero center
    title "Studio"
page /login
  auth login
    alt "Back" /
`;
  const plan = planChat(accounts, { float: false, page: null, show: null });
  assert.ok(!('error' in plan));
  assert.equal(plan.allow, 'signedin');
  assert.match(plan.text, /    email    api\n    model    default\n/);
  assert.doesNotMatch(plan.text, /allow/);
  assert.deepEqual(errorsOf(plan.text), []);
});

test('an existing .az-dev/backend.env is backed up and kept, the keys appended once; CRLF files stay CRLF', () => {
  const p = project(FRESH.replace(/\n/g, '\r\n'));
  mkdirSync(join(p.dir, '.az-dev'));
  writeFileSync(join(p.dir, '.az-dev/backend.env'), 'AZ_ADMIN_EMAILS=me@demo.test', 'utf8');
  const r = run(p.file);
  assert.ok(r.ok, r.ok ? '' : r.message);
  assert.deepEqual(r.backups, [`${p.file}.bak`, join(p.dir, '.az-dev/backend.env.bak')]);
  const env = readFileSync(join(p.dir, '.az-dev/backend.env'), 'utf8');
  assert.ok(env.startsWith(`AZ_ADMIN_EMAILS=me@demo.test\n\n${ENV_MARK}\n`), env);
  const text = readFileSync(p.file, 'utf8');
  assert.equal(text.split('\r\n').length, text.split('\n').length, 'every line still ends CRLF');
  assert.ok(run(p.file).ok);
  assert.equal(readFileSync(join(p.dir, '.az-dev/backend.env'), 'utf8'), env, 'the keys are not appended twice');
});

test('a backup is never overwritten: a second change takes the next free name', () => {
  const p = project();
  writeFileSync(`${p.file}.bak`, 'an older backup', 'utf8');
  const r = run(p.file);
  assert.ok(r.ok);
  assert.deepEqual(r.backups, [`${p.file}.bak.2`]);
  assert.equal(readFileSync(`${p.file}.bak`, 'utf8'), 'an older backup');
  assert.equal(readFileSync(`${p.file}.bak.2`, 'utf8'), FRESH);
});

test('the command: usage errors exit 2 and change nothing; a run says what it did and ends with az check', () => {
  const p = project();
  const az = (...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: p.dir, env: { ...process.env, AZ_WORDS: WORDS }, timeout: 60_000 });
  for (const args of [['add'], ['add', 'banana', 'site.az'], ['add', 'chat'], ['add', 'chat', 'site.az', '--float', '--page', '/help'], ['add', 'chat', 'site.az', '--show'], ['add', 'chat', 'site.az', '--nope']]) {
    const r = az(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
  }
  assert.equal(readFileSync(p.file, 'utf8'), FRESH);
  const ok = az('add', 'chat', 'site.az', '--page', '/help', '--show', 'faq,cta');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /az: page \/help: added, with a chat panel open to anyone/);
  assert.match(ok.stdout, /az: no problems found\n/);
  assert.match(readFileSync(p.file, 'utf8'), /\n    show     faq cta\n/);
  const check = az('check', 'site.az');
  assert.equal(check.status, 0, check.stderr);
});
