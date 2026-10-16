/**
 * `az build` with and without a backend, and `az backend init` (backend-spec §4, §8).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/az.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const BIN = join(ROOT, 'packages/cli/bin/az.js');

const SITE = (backend: string) => `az 1\nsite studio\n  auth\n    adapter azbackend\n${backend}page /\n  hero center\n    title "Hi"\n`;
const BACKEND = '  backend\n    database sqlite\n    email smtp\n';

function project(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'az-be-'));
  writeFileSync(join(dir, 'site.az'), source, 'utf8');
  return { dir, file: join(dir, 'site.az'), out: join(dir, 'out') };
}

const env = { ...process.env, AZ_PUBLIC_BACKEND_URL: 'http://127.0.0.1:8787' };
const az = (...args: string[]) => spawnSync(process.execPath, [...process.execArgv, BIN, ...args], { encoding: 'utf8', env: { ...env, AZ_WORDS: WORDS } });

test('a site that declares a backend gets server/ with every source file copied verbatim — the data modules only with tables, the chat modules only with a chat panel', () => {
  process.env.AZ_PUBLIC_BACKEND_URL = 'http://127.0.0.1:8787';
  const p = project(SITE(BACKEND));
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, true, r.report);
  const src = join(ROOT, 'packages/backend/src/server');
  assert.ok(readdirSync(src).some((f) => f.startsWith('chat')), 'CONTROL: the server has chat modules to leave out');
  for (const f of readdirSync(src)) {
    if (f.startsWith('data-') || f.startsWith('chat')) {
      assert.ok(!existsSync(join(p.out, 'server/src', f)), `${f}: no tables or chat, no such module`);
      continue;
    }
    assert.equal(readFileSync(join(p.out, 'server/src', f), 'utf8'), readFileSync(join(src, f), 'utf8'), f);
  }
  for (const f of ['package.json', 'az.config.json', '.env.example', '.gitignore', 'README.md']) {
    assert.ok(existsSync(join(p.out, 'server', f)), f);
  }
  for (const f of ['data.json', 'openapi.json']) assert.ok(!existsSync(join(p.out, 'server', f)), `${f} only with tables`);
  assert.ok(!existsSync(join(p.out, 'server/.env')), 'a build never writes .env');

  const d = project(SITE(`${BACKEND}  data notes\n    title text required\n    allow anyone read\n`));
  assert.equal(az('backend', 'schema', d.file).status, 0);
  const withData = build({ source: d.file, outDir: d.out, wordsDir: WORDS });
  assert.equal(withData.ok, true, withData.report);
  for (const f of readdirSync(src).filter((x) => !x.startsWith('chat'))) {
    assert.equal(readFileSync(join(d.out, 'server/src', f), 'utf8'), readFileSync(join(src, f), 'utf8'), `with tables: ${f}`);
  }
  for (const f of ['data.json', 'openapi.json']) assert.ok(existsSync(join(d.out, 'server', f)), `with tables: ${f}`);

  // A chat panel brings the chat modules, its prompt and context — and no data modules.
  const c = project(SITE(`${BACKEND}    model default\n`).replace('    title "Hi"\n', '    title "Hi"\n  chat panel\n'));
  const withChat = build({ source: c.file, outDir: c.out, wordsDir: WORDS });
  assert.equal(withChat.ok, true, withChat.report);
  for (const f of readdirSync(src)) {
    // chat-query.ts reads the tables (chat-block-spec §20.5): with chat and tables only.
    if (f.startsWith('data-') || f === 'chat-query.ts') { assert.ok(!existsSync(join(c.out, 'server/src', f)), `chat, no tables: ${f}`); continue; }
    assert.equal(readFileSync(join(c.out, 'server/src', f), 'utf8'), readFileSync(join(src, f), 'utf8'), `with chat: ${f}`);
  }
  for (const f of ['chat/prompt.txt', 'chat/context.json']) assert.ok(existsSync(join(c.out, 'server', f)), `with chat: ${f}`);
  assert.ok(!existsSync(join(p.out, 'server/chat')), 'CONTROL: without chat, no server/chat/');
  assert.ok(!existsSync(join(d.out, 'server/src/chat-query.ts')), 'CONTROL: tables without chat, no chat figures');

  // Chat and tables: the figures module too, verbatim.
  const both = project(SITE(`${BACKEND}    model default\n  data notes\n    title text required\n    allow anyone read\n`).replace('    title "Hi"\n', '    title "Hi"\n  chat panel\n'));
  assert.equal(az('backend', 'schema', both.file).status, 0);
  const withBoth = build({ source: both.file, outDir: both.out, wordsDir: WORDS });
  assert.equal(withBoth.ok, true, withBoth.report);
  assert.equal(readFileSync(join(both.out, 'server/src/chat-query.ts'), 'utf8'), readFileSync(join(src, 'chat-query.ts'), 'utf8'));
});

test('CONTROL: a site without one gets no server/ at all', () => {
  const p = project(SITE(''));
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, true, r.report);
  assert.ok(r.files.every((f) => !f.path.startsWith('server/')));
});

test('az backend init: .env with a fresh secret, owner-only, never overwritten', () => {
  const p = project(SITE(BACKEND));
  assert.equal(az('build', p.file, '--out', p.out).status, 0);
  const server = join(p.out, 'server');
  const first = az('backend', 'init', server);
  assert.equal(first.status, 0, first.stderr);
  const envFile = join(server, '.env');
  assert.equal(statSync(envFile).mode & 0o777, 0o600, 'owner read/write only');
  const secret = /^AZ_SESSION_SECRET=(.+)$/m.exec(readFileSync(envFile, 'utf8'))![1];
  assert.equal(Buffer.from(secret, 'base64url').length, 32);
  const second = az('backend', 'init', server);
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /already exists — not overwritten/);
  assert.equal(/^AZ_SESSION_SECRET=(.+)$/m.exec(readFileSync(envFile, 'utf8'))![1], secret, 'the secret did not change');
  // A rebuild over the same output leaves .env alone.
  assert.equal(az('build', p.file, '--out', p.out).status, 0);
  assert.ok(existsSync(envFile));
});

test('az backend images refuses a folder that is not a built server, and any flag but --confirm', () => {
  const empty = az('backend', 'images', mkdtempSync(join(tmpdir(), 'az-be-empty-')), '--confirm');
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no built server in .* — point at the server\/ folder az build wrote/);
  const flag = az('backend', 'images', mkdtempSync(join(tmpdir(), 'az-be-empty-')), '--yes');
  assert.equal(flag.status, 2);
  assert.match(flag.stderr, /try: az backend images <server-dir> \[--confirm\]/);
});

test('az backend init lists the chat keys only for a server whose config says chat (key left blank)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'az-be-chat-'));
  writeFileSync(join(dir, 'az.config.json'), JSON.stringify({ siteName: 'studio', database: 'sqlite', email: 'smtp', chat: true }));
  assert.equal(az('backend', 'init', dir).status, 0);
  const text = readFileSync(join(dir, '.env'), 'utf8');
  assert.match(text, /^AZ_CHAT_API=completions$/m);
  assert.match(text, /^AZ_CHAT_KEY=$/m);
  const plain = mkdtempSync(join(tmpdir(), 'az-be-nochat-'));
  writeFileSync(join(plain, 'az.config.json'), JSON.stringify({ siteName: 'studio', database: 'sqlite', email: 'smtp' }));
  assert.equal(az('backend', 'init', plain).status, 0);
  assert.doesNotMatch(readFileSync(join(plain, '.env'), 'utf8'), /AZ_CHAT_/, 'CONTROL: no chat, no chat keys');
});

test('az backend init refuses a folder that is not a generated server', () => {
  const r = az('backend', 'init', mkdtempSync(join(tmpdir(), 'az-be-empty-')));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no az\.config\.json/);
});

test('the generated server refuses to start, naming every missing key', () => {
  const p = project(SITE(BACKEND));
  assert.equal(az('build', p.file, '--out', p.out).status, 0);
  const r = spawnSync(process.execPath, ['src/main.ts'], { cwd: join(p.out, 'server'), encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  for (const k of ['AZ_SESSION_SECRET', 'AZ_BACKEND_PUBLIC_URL', 'AZ_ALLOWED_ORIGINS', 'AZ_EMAIL_FROM', 'AZ_SMTP_HOST', 'AZ_SMTP_PORT']) {
    assert.match(r.stderr, new RegExp(`${k} is missing`), k);
  }
});
