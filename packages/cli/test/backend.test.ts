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

test('a site that declares a backend gets server/ with every source file copied verbatim — the data modules only with tables', () => {
  process.env.AZ_PUBLIC_BACKEND_URL = 'http://127.0.0.1:8787';
  const p = project(SITE(BACKEND));
  const r = build({ source: p.file, outDir: p.out, wordsDir: WORDS });
  assert.equal(r.ok, true, r.report);
  const src = join(ROOT, 'packages/backend/src/server');
  for (const f of readdirSync(src)) {
    if (f.startsWith('data-')) {
      assert.ok(!existsSync(join(p.out, 'server/src', f)), `${f}: no tables, no data module`);
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
  for (const f of readdirSync(src)) {
    assert.equal(readFileSync(join(d.out, 'server/src', f), 'utf8'), readFileSync(join(src, f), 'utf8'), `with tables: ${f}`);
  }
  for (const f of ['data.json', 'openapi.json']) assert.ok(existsSync(join(d.out, 'server', f)), `with tables: ${f}`);
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
