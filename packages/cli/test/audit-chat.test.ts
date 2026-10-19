/**
 * `az audit`'s chat checks (audit-chat.ts, and the server-keys check in
 * audit.ts; chat-block-spec §11.2): each against a real build of a chat site
 * with something planted — the model key in a shipped file, a shared-answer
 * page without noindex or a policy, a context naming a private field or a
 * table strangers may write, a key-shaped string in the context, an HTML sink
 * in the page runtime — each with its CONTROL, and no planted value ever in
 * the report.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIT_CHECKS, audit } from '../src/audit.ts';
import { runtimeSinks } from '../src/audit-chat.ts';
import { formatReport, systemProbe, type Probe } from '../src/doctor.ts';
import { findNpmCli } from '../src/serve.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const BIN = join(ROOT, 'packages/cli/bin/az.js');

const SITE = (show = '    show     faq cta\n') => `az 1

site shop
  auth
    adapter azbackend
  backend
    database sqlite
    email    smtp
    model    default
  data guides
    title  text required search
    secret text private
    allow anyone read

page /
  hero center
    title "Shop"
  chat panel
    title    "Ask"
    greeting "Ask me."
${show}    allow    anyone
    knows    guides

page /login
  auth login
    redirect /
`;

/** Planted values: none may reach a report. A key-shaped one (core secrets.ts's prefix rule) for the context. */
const MODEL_KEY = `planted-model-key-${'m4'.repeat(10)}`;
const JUDGE_KEY = `planted-judge-key-${'q8'.repeat(10)}`;
const SHAPED = `sk_live_${'P3x'.repeat(12)}`;

const STRICT = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; object-src 'none'; base-uri 'self'" />`;
const NOINDEX = '<meta name="robots" content="noindex, nofollow" />';
const PAGE = (head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8" />${head}<title>t</title></head><body><p>hi</p></body></html>`;

const az = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS }, timeout: 60_000 });

/** A real build of the chat site, with `dist` files planted where the project's own build would write them. */
function built(source = SITE(), dist: Record<string, string> = { 'index.html': PAGE(STRICT), 'assets/index.js': 'console.log(1);\n' }) {
  const dir = mkdtempSync(join(tmpdir(), 'az-audit-chat-'));
  writeFileSync(join(dir, 'site.az'), source);
  assert.equal(az(dir, 'backend', 'schema', 'site.az').status, 0);
  const b = az(dir, 'build', 'site.az');
  assert.equal(b.status, 0, b.stderr);
  const out = join(dir, '.az-build');
  for (const [path, content] of Object.entries(dist)) {
    mkdirSync(join(out, 'dist', path, '..'), { recursive: true });
    writeFileSync(join(out, 'dist', path), content);
  }
  return { dir, out, server: join(out, 'server') };
}

const fakeProbe = (env: Record<string, string> = {}): Probe => ({ ...systemProbe(findNpmCli), env });

async function check(id: string, b: { dir: string; out: string }, env: Record<string, string> = {}) {
  const c = AUDIT_CHECKS.find((x) => x.id === id);
  assert.ok(c, `no check ${id}`);
  const r = await audit({ outDir: b.out, cwd: b.dir, probe: fakeProbe(env), online: false, checks: [c] });
  const text = formatReport(r, 'az audit') + JSON.stringify(r);
  for (const secret of [MODEL_KEY, JUDGE_KEY, SHAPED, 'm4m4', 'q8q8', 'P3xP3x']) assert.ok(!text.includes(secret), `${id}: a planted value reached the report`);
  return r.checks[0];
}

test('server keys: the model key planted in a shipped file fails by key name and file; the moderation key from the environment too; CONTROL passes', async () => {
  const b = built(SITE(), { 'index.html': PAGE(STRICT), 'assets/index.js': `const k="${MODEL_KEY}";`, 'assets/other.js': `x("${JUDGE_KEY}")` });
  assert.equal((await check('server-keys', b)).line, `server keys: none set in .az-build/server/.env or the environment — nothing to look for`);
  writeFileSync(join(b.server, '.env'), `AZ_CHAT_KEY=${MODEL_KEY}\n`, { mode: 0o600 });
  const one = await check('server-keys', b);
  assert.equal(one.status, 'fail');
  assert.equal(one.line, 'server keys: AZ_CHAT_KEY is in the built site — anyone who loads it can read it');
  assert.deepEqual(one.fix!.slice(0, 1), ['dist/assets/index.js (AZ_CHAT_KEY)']);
  // The server reads its environment over .env: a key set there is looked for too.
  const both = await check('server-keys', b, { AZ_CHAT_MODERATION_KEY: JUDGE_KEY });
  assert.equal(both.line, 'server keys: AZ_CHAT_KEY, AZ_CHAT_MODERATION_KEY are in the built site — anyone who loads it can read them');

  // CONTROL: the same keys, nowhere in what ships.
  const clean = built();
  writeFileSync(join(clean.server, '.env'), `AZ_CHAT_KEY=${MODEL_KEY}\nAZ_SESSION_SECRET=short\n`, { mode: 0o600 });
  const pass = await check('server-keys', clean, { AZ_CHAT_MODERATION_KEY: JUDGE_KEY });
  assert.equal(pass.status, 'warn', 'a value too short to look for is said');
  assert.equal(pass.line, 'server keys: AZ_CHAT_KEY, AZ_CHAT_MODERATION_KEY in none of 2 shipped text files; AZ_SESSION_SECRET too short to look for (under 8 characters)');
  writeFileSync(join(clean.server, '.env'), `AZ_CHAT_KEY=${MODEL_KEY}\n`, { mode: 0o600 });
  assert.deepEqual([(await check('server-keys', clean)).status, (await check('server-keys', clean)).line], ['pass', 'server keys: AZ_CHAT_KEY in none of 2 shipped text files']);
});

test('server keys: a data tool\'s key (chat-block-spec §21.2.5) planted in a shipped file fails by its name; CONTROL passes', async () => {
  const toolKey = `planted-tool-key-${'t6'.repeat(10)}`;
  const env = `AZ_CHAT_TOOLS=standings,results\nAZ_CHAT_TOOL_STANDINGS_KEY=${toolKey}\n`;
  const b = built(SITE(), { 'index.html': PAGE(STRICT), 'assets/index.js': `fetch(u,{headers:{authorization:"Bearer ${toolKey}"}});` });
  writeFileSync(join(b.server, '.env'), env, { mode: 0o600 });
  const leaked = await check('server-keys', b);
  assert.equal(leaked.status, 'fail');
  assert.equal(leaked.line, 'server keys: AZ_CHAT_TOOL_STANDINGS_KEY is in the built site — anyone who loads it can read it');
  assert.deepEqual(leaked.fix!.slice(0, 1), ['dist/assets/index.js (AZ_CHAT_TOOL_STANDINGS_KEY)']);
  assert.ok(!JSON.stringify(leaked).includes('t6t6'), 'the value is never printed');
  // Declared in the environment instead of .env: looked for all the same.
  writeFileSync(join(b.server, '.env'), '', { mode: 0o600 });
  assert.equal((await check('server-keys', b, { AZ_CHAT_TOOLS: 'standings', AZ_CHAT_TOOL_STANDINGS_KEY: toolKey })).status, 'fail');
  // CONTROL: the same key, nowhere in what ships.
  const clean = built();
  writeFileSync(join(clean.server, '.env'), env, { mode: 0o600 });
  const pass = await check('server-keys', clean);
  assert.deepEqual([pass.status, pass.line], ['pass', 'server keys: AZ_CHAT_TOOL_STANDINGS_KEY in none of 2 shipped text files']);
});

test('chat shared page: noindex and a strict policy pass; without either it fails; a site with no shared page skips', async () => {
  const good = built(SITE(), { 'index.html': PAGE(STRICT), 'chat/shared/index.html': PAGE(STRICT + NOINDEX) });
  assert.deepEqual([(await check('chat-shared-page', good)).status, (await check('chat-shared-page', good)).line], ['pass', 'chat shared page: /chat/shared says noindex and has a strict policy']);
  const indexed = built(SITE(), { 'index.html': PAGE(STRICT), 'chat/shared/index.html': PAGE(STRICT) });
  assert.equal((await check('chat-shared-page', indexed)).line, 'chat shared page: /chat/shared — no robots noindex — search engines may list shared answers');
  const bare = built(SITE(), { 'index.html': PAGE(STRICT), 'chat/shared/index.html': PAGE(NOINDEX) });
  assert.equal((await check('chat-shared-page', bare)).line, 'chat shared page: /chat/shared — no Content-Security-Policy');
  const weak = built(SITE(), { 'index.html': PAGE(STRICT), 'chat/shared/index.html': PAGE(`<meta http-equiv="Content-Security-Policy" content="default-src *" />${NOINDEX}`) });
  const w = await check('chat-shared-page', weak);
  assert.equal(w.status, 'fail');
  assert.match(w.line, /^chat shared page: \/chat\/shared — .*default-src/);
  // The build writes the page's source with both (its policy is added by the site's own build, as for every page).
  assert.match(readFileSync(join(good.out, 'chat/shared/index.html'), 'utf8'), /<meta name="robots" content="noindex, nofollow" \/>/);
  // A chat that shows nothing has no shared page.
  const none = built(SITE(''));
  assert.equal((await check('chat-shared-page', none)).status, 'skip');
});

test('chat context: public fields only — a private field, a writable known table, a figures table strangers can\'t read, a key-shaped string each fail; CONTROL passes', async () => {
  const b = built();
  const good = await check('chat-context', b);
  assert.equal(good.status, 'pass', good.line);
  assert.equal(good.line, 'chat context: public content only — 0 tables for figures and 1 known table, each readable signed out, every field public, known tables written by admins only');

  const file = join(b.server, 'chat/context.json');
  const original = readFileSync(file, 'utf8');
  const edit = (change: (c: { knows: { name: string; fields: { name: string; type: string }[] }[]; answer?: { tables?: unknown[] }; site: { name: string } }) => void) => {
    const c = JSON.parse(original);
    change(c);
    writeFileSync(file, JSON.stringify(c));
  };
  edit((c) => { c.knows[0].fields.push({ name: 'secret', type: 'text' }); });
  const priv = await check('chat-context', b);
  assert.equal(priv.status, 'fail');
  assert.equal(priv.line, "chat context: 1 problem in what every question sends the model — chat knows 'guides.secret', which is not a public field here");

  edit((c) => { c.answer = { ...(c.answer ?? {}), tables: [{ name: 'guides', fields: [{ name: 'secret', type: 'text' }] }] }; });
  assert.equal((await check('chat-context', b)).line, "chat context: 1 problem in what every question sends the model — chat figures name 'guides.secret', which is private");
  edit((c) => { c.answer = { ...(c.answer ?? {}), tables: [{ name: 'orders', fields: [] }] }; });
  assert.equal((await check('chat-context', b)).line, "chat context: 1 problem in what every question sends the model — chat figures name 'orders', which the server has no table for");

  edit((c) => { c.site.name = `Shop ${SHAPED}`; });
  const shaped = await check('chat-context', b);
  assert.equal(shaped.status, 'fail');
  assert.match(shaped.line, /^chat context: 1 problem in what every question sends the model — a secret-prefix-shaped string at offset \d+$/);

  writeFileSync(file, '{ not json');
  assert.equal((await check('chat-context', b)).line, 'chat context: server/chat/context.json is not JSON — the server would refuse to start');

  // The built tables: a known table others may write is refused, as the server refuses it at start.
  writeFileSync(file, original);
  const dataFile = join(b.server, 'data.json');
  const data = JSON.parse(readFileSync(dataFile, 'utf8')) as { tables: { name: string; rules: Record<string, string[]> }[] };
  data.tables[0].rules.edit = ['signedin'];
  writeFileSync(dataFile, JSON.stringify(data));
  assert.equal((await check('chat-context', b)).line, "chat context: 1 problem in what every question sends the model — chat knows 'guides', which others than the site's admins can write to");
});

test('chat runtime: an HTML sink planted in a runtime copy fails by file and sink; a comment naming one is not one; CONTROL passes', async () => {
  const b = built();
  const good = await check('chat-runtime', b);
  assert.equal(good.status, 'pass', good.line);
  assert.equal(good.line, 'chat runtime: 17 files, none with innerHTML, insertAdjacentHTML, outerHTML, document.write, eval, Function or setHTML');

  const logic = join(b.out, 'src/az/chat-render/chat-logic.ts');
  const original = readFileSync(logic, 'utf8');
  appendFileSync(logic, '\n// Never innerHTML here.\n');
  const commented = await check('chat-runtime', b);
  assert.equal(commented.status, 'warn', 'no sink, but not az\'s own copy');
  assert.equal(commented.line, 'chat runtime: no sink, but src/az/chat-render/chat-logic.ts is not what this az writes');

  writeFileSync(logic, `${original}\nexport const draw = (el: HTMLElement, s: string) => { el.innerHTML = s; };\n`);
  const sunk = await check('chat-runtime', b);
  assert.equal(sunk.status, 'fail');
  assert.equal(sunk.line, 'chat runtime: 1 way from a string to markup or code in the chat\'s page runtime — a model\'s words could run as code');
  assert.equal(sunk.fix![0], 'src/az/chat-render/chat-logic.ts: innerHTML');

  // A site without chat has no runtime to judge.
  const plain = mkdtempSync(join(tmpdir(), 'az-audit-chat-'));
  writeFileSync(join(plain, 'site.az'), 'az 1\nsite aurora\npage /\n  hero center\n    title "Hi"\n');
  assert.equal(az(plain, 'build', 'site.az').status, 0);
  assert.equal((await check('chat-runtime', { dir: plain, out: join(plain, '.az-build') })).status, 'skip');
});

test('runtimeSinks: each §11.2 sink is found in code, none in a comment', () => {
  for (const [line, sink] of [
    ['el.innerHTML = s;', 'innerHTML'], ['el.outerHTML = s;', 'outerHTML'], ['el.insertAdjacentHTML("beforeend", s);', 'insertAdjacentHTML'],
    ['document.write(s);', 'document.write'], ['eval(s);', 'eval('], ['new Function(s);', 'Function('], ['Function ("x")', 'Function('],
  ] as const) assert.deepEqual(runtimeSinks(line), [sink], line);
  assert.deepEqual(runtimeSinks('/* innerHTML */\n// eval(s)\nconst evaluate = (x: number) => x;\nel.textContent = s;\n'), []);
});
