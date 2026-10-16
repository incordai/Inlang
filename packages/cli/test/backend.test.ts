/**
 * `az build` with and without a backend, `az backend init` and `az backend usage` (backend-spec §4, §8; chat-block-spec §11.4).
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
    // chat-query.ts and chat-knows.ts read the tables (chat-block-spec §20.5, §8.2): with chat and tables only.
    if (f.startsWith('data-') || f === 'chat-query.ts' || f === 'chat-knows.ts') { assert.ok(!existsSync(join(c.out, 'server/src', f)), `chat, no tables: ${f}`); continue; }
    assert.equal(readFileSync(join(c.out, 'server/src', f), 'utf8'), readFileSync(join(src, f), 'utf8'), `with chat: ${f}`);
  }
  for (const f of ['chat/prompt-1.txt', 'chat/context.json']) assert.ok(existsSync(join(c.out, 'server', f)), `with chat: ${f}`);
  assert.ok(!existsSync(join(p.out, 'server/chat')), 'CONTROL: without chat, no server/chat/');
  assert.ok(!existsSync(join(d.out, 'server/src/chat-query.ts')), 'CONTROL: tables without chat, no chat figures');
  assert.ok(!existsSync(join(d.out, 'server/src/chat-knows.ts')), 'CONTROL: tables without chat, no rows read for a chat');

  // Chat and tables: the figures module too, verbatim.
  const both = project(SITE(`${BACKEND}    model default\n  data notes\n    title text required\n    allow anyone read\n`).replace('    title "Hi"\n', '    title "Hi"\n  chat panel\n'));
  assert.equal(az('backend', 'schema', both.file).status, 0);
  const withBoth = build({ source: both.file, outDir: both.out, wordsDir: WORDS });
  assert.equal(withBoth.ok, true, withBoth.report);
  for (const f of ['chat-query.ts', 'chat-knows.ts']) assert.equal(readFileSync(join(both.out, 'server/src', f), 'utf8'), readFileSync(join(src, f), 'utf8'), `with both: ${f}`);
});

test('a public chat site (no auth, no email) gets a server without accounts, and of the auth runtime only the address check the guard imports', () => {
  const p = project('az 1\nsite demo\n  backend\n    database sqlite\n    model    default\n\npage /\n  chat panel\n    allow anyone\n');
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.ok(r.ok, r.report);
  assert.deepEqual(readdirSync(join(p.out, 'src/az-auth')).sort(), ['azbackend.ts', 'contract.ts', 'session.ts']);
  const config = JSON.parse(readFileSync(join(p.out, 'server/az.config.json'), 'utf8')) as Record<string, unknown>;
  assert.equal('email' in config, false);
  assert.equal(config.chat, true);
  const init = az('backend', 'init', join(p.out, 'server'));
  assert.equal(init.status, 0, init.stderr);
  const dotenv = readFileSync(join(p.out, 'server/.env'), 'utf8');
  assert.match(dotenv, /^AZ_SESSION_SECRET=[A-Za-z0-9_-]{43}$/m);
  assert.doesNotMatch(dotenv, /^AZ_(EMAIL|SMTP|OAUTH)/m);
});

test('a chat that shows maps gets the default world basemap in its server (§19.15); a chat without maps does not', () => {
  const src = (show: string) => `az 1\nsite demo\n  backend\n    database sqlite\n    model    default\n\npage /\n  chat panel\n${show}    allow anyone\n`;
  const map = project(src('    show map\n'));
  assert.ok(build({ source: map.file, outDir: map.out, wordsDir: WORDS }).ok);
  const copied = join(map.out, 'server/tiles/world.pmtiles');
  assert.ok(existsSync(copied));
  assert.ok(readFileSync(copied).equals(readFileSync(join(ROOT, 'packages/backend/assets/basemap/world.pmtiles'))), 'byte for byte the committed basemap');
  const plain = project(src(''));
  assert.ok(build({ source: plain.file, outDir: plain.out, wordsDir: WORDS }).ok);
  assert.equal(existsSync(join(plain.out, 'server/tiles')), false);
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

test('a chat site\'s context holds a text body kept in a file, as its plain text — its words, never its addresses (chat-block-spec §8.1)', () => {
  const source = SITE(`${BACKEND}    model default\n  chat float\n    allow anyone\n`).replace('    title "Hi"\n', '    title "Hi"\npage /about\n  text\n    title "About"\n    body ./about.md\n');
  const p = project(source);
  writeFileSync(join(p.dir, 'about.md'), '## Our shop\n\nWe resole **any** pair, see [the form](https://forms.example/resole).\n');
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS, imageCache: null });
  assert.equal(r.ok, true, r.report);
  const ctx = JSON.parse(readFileSync(join(p.out, 'server/chat/context.json'), 'utf8')) as { pages: { route: string; blocks: { body?: string }[] }[] };
  assert.equal(ctx.pages.find((x) => x.route === '/about')?.blocks[0].body, 'Our shop\n\nWe resole any pair, see the form.');
  assert.ok(!JSON.stringify(ctx).includes('forms.example'));
});

test('az backend usage (chat-block-spec §11.4): the built server\'s daily counts, read only — never the key, never a message', async () => {
  // Refused: a folder that is no chat server, and any flag but --json.
  const empty = az('backend', 'usage', mkdtempSync(join(tmpdir(), 'az-be-empty-')));
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no built server with a chat in .* — point at the server\/ folder az build wrote/);
  assert.equal(az('backend', 'usage', mkdtempSync(join(tmpdir(), 'az-be-empty-')), '--all').status, 2);

  const p = project(SITE(`${BACKEND}    model default\n`).replace('    title "Hi"\n', '    title "Hi"\n  chat panel\n    allow anyone\n'));
  assert.equal(az('build', p.file, '--out', p.out).status, 0);
  const server = join(p.out, 'server');
  assert.equal(az('backend', 'init', server).status, 0);
  const key = `planted-model-key-${Date.now()}`;
  const envFile = join(server, '.env');
  writeFileSync(envFile, readFileSync(envFile, 'utf8')
    .replace(/^AZ_SMTP_HOST=$/m, 'AZ_SMTP_HOST=smtp.invalid')
    .replace(/^AZ_CHAT_URL=$/m, 'AZ_CHAT_URL=https://models.example.test/v1')
    .replace(/^AZ_CHAT_MODEL=$/m, 'AZ_CHAT_MODEL=model-a')
    .replace(/^AZ_CHAT_KEY=$/m, `AZ_CHAT_KEY=${key}`));
  // Before the server ever started there is no database, and none is made.
  const before = az('backend', 'usage', server);
  assert.equal(before.status, 1);
  assert.match(before.stderr, /no database at \.\/data\/app\.db yet — start the server once/);
  assert.ok(!existsSync(join(server, 'data/app.db')), 'a report makes no database');

  // The tables as the server makes them, and a day of answers and a share in them.
  const { openSqlite, migrate } = await import('../../backend/src/server/db.ts');
  const { createUsage, migrateChat, utcDay } = await import('../../backend/src/server/chat-usage.ts');
  const { createShareStore } = await import('../../backend/src/server/chat-share.ts');
  const db = await openSqlite(join(server, 'data/app.db'));
  const words = 'a-visitor-question-never-printed';
  try {
    await migrate(db);
    await migrateChat(db);
    await createUsage(db).add(utcDay(Date.now()), 4_200, 310, 1, 0);
    await createUsage(db).block(utcDay(Date.now()));
    await createShareStore({ db, days: 30, max: 10, now: Date.now }).create(JSON.stringify([{ type: 'text', s: words }]), words);
  } finally { await db.close(); }

  const text = az('backend', 'usage', server);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /^chat usage — today is \d{4}-\d{2}-\d{2} \(UTC\)\n {2}budget 300,000 tokens a day · spent today 4,510 · left 295,490\n {2}shared answers: on · 1 kept now\n/);
  assert.match(text.stdout, / {2}day +messages +input tokens +cached input +output tokens +dropped +blocked +shares\n {2}\d{4}-\d{2}-\d{2} +1 +4,200 +0 +310 +1 +1 +1\n$/);
  const json = az('backend', 'usage', server, '--json');
  assert.equal(json.status, 0, json.stderr);
  const r = JSON.parse(json.stdout) as { budget: { spent: number }; days: { messages: number; blocked: number; shares: number }[]; shares: { kept: number } };
  assert.deepEqual([r.budget.spent, r.days[0].messages, r.days[0].blocked, r.days[0].shares, r.shares.kept], [4_510, 1, 1, 1, 1]);
  for (const out of [text.stdout + text.stderr, json.stdout + json.stderr]) {
    assert.ok(!out.includes(key), 'the model key is never printed');
    assert.ok(!out.includes(words), 'no message text');
  }
});

test('az backend shares --delete (chat-block-spec §20.7): the operator deletes one shared answer by id or link — an audit line, never the answer', async () => {
  // Refused: a folder that is no chat server, a missing or malformed id, any other flag.
  const empty = az('backend', 'shares', mkdtempSync(join(tmpdir(), 'az-be-empty-')), '--delete', 'AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /no built server with a chat in .* — point at the server\/ folder az build wrote/);
  assert.equal(az('backend', 'shares', mkdtempSync(join(tmpdir(), 'az-be-empty-'))).status, 2);
  assert.equal(az('backend', 'shares', mkdtempSync(join(tmpdir(), 'az-be-empty-')), '--list').status, 2);

  const p = project(SITE(`${BACKEND}    model default\n`).replace('    title "Hi"\n', '    title "Hi"\n  chat panel\n    allow anyone\n    show cta\n'));
  assert.equal(az('build', p.file, '--out', p.out).status, 0);
  const server = join(p.out, 'server');
  assert.equal(az('backend', 'init', server).status, 0);
  const envFile = join(server, '.env');
  writeFileSync(envFile, readFileSync(envFile, 'utf8')
    .replace(/^AZ_SMTP_HOST=$/m, 'AZ_SMTP_HOST=smtp.invalid')
    .replace(/^AZ_CHAT_URL=$/m, 'AZ_CHAT_URL=https://models.example.test/v1')
    .replace(/^AZ_CHAT_MODEL=$/m, 'AZ_CHAT_MODEL=model-a')
    .replace(/^AZ_CHAT_KEY=$/m, 'AZ_CHAT_KEY=planted-model-key'));
  const { openSqlite, migrate } = await import('../../backend/src/server/db.ts');
  const { migrateChat } = await import('../../backend/src/server/chat-usage.ts');
  const { createShareStore } = await import('../../backend/src/server/chat-share.ts');
  const db = await openSqlite(join(server, 'data/app.db'));
  const words = 'a-shared-answer-never-printed';
  let ids: string[] = [];
  try {
    await migrate(db);
    await migrateChat(db);
    const store = createShareStore({ db, days: 30, max: 10, now: Date.now });
    for (let i = 0; i < 2; i++) {
      const made = await store.create(JSON.stringify([{ type: 'text', s: words }]), words);
      if (made === 'full') throw new Error('full');
      ids = [...ids, made.id];
    }
  } finally { await db.close(); }

  assert.equal(az('backend', 'shares', server, '--delete', 'not-a-share-id').status, 2, 'no share id in it');
  const byId = az('backend', 'shares', server, '--delete', ids[0]);
  assert.equal(byId.status, 0, byId.stderr);
  assert.match(byId.stdout, new RegExp(`^backend: shared answer ${ids[0]} deleted by the operator at \\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z\\n$`));
  // A delete link pasted whole: its id is used, its token never printed.
  const token = 'T'.repeat(43);
  const byLink = az('backend', 'shares', server, '--delete', `https://shop.example/chat/shared#${ids[1]}&${token}`);
  assert.equal(byLink.status, 0, byLink.stderr);
  assert.ok(byLink.stdout.includes(ids[1]) && !byLink.stdout.includes(token));
  const again = az('backend', 'shares', server, '--delete', ids[0]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /no shared answer .* already gone/);
  for (const r of [byId, byLink, again]) assert.ok(!(r.stdout + r.stderr).includes(words) && !(r.stdout + r.stderr).includes('planted-model-key'));
  const check = await openSqlite(join(server, 'data/app.db'));
  try {
    assert.equal(Number((await check.get('SELECT COUNT(*) AS n FROM az_chat_shares'))?.n), 0, 'both gone');
  } finally { await check.close(); }
});
