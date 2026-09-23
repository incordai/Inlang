/**
 * `backend` — a site-level structure keyword naming closed choices only
 * (backend-spec §2). Each misuse has its own code; each has a control.
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

const AUTH = '  auth\n    adapter azbackend\n';
const site = (body: string, auth = AUTH) => `az 1\nsite studio\n${auth}${body}page /\n`;
const codes = (src: string) => compile(src, { manifests }).diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);

test('a complete declaration compiles, and reaches the Spec as two choices', () => {
  const r = compile(site('  backend\n    database postgres\n    email api\n'), { manifests });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error'), []);
  assert.deepEqual(r.spec?.site.backend, { database: 'postgres', email: 'api' });
});

test('CONTROL: a site without one serialises exactly as before — no backend key at all', () => {
  const r = compile(site(''), { manifests });
  assert.equal(serialiseSpec(r.spec!).includes('"backend"'), false);
});

test('AZ1412: a choice outside the set — and a connection string is told where it belongs', () => {
  assert.deepEqual(codes(site('  backend\n    database oracle\n    email smtp\n')), ['AZ1412']);
  const r = compile(site('  backend\n    database postgres://user:pass@db/app\n    email smtp\n'), { manifests });
  const d = r.diagnostics.find((x) => x.code === 'AZ1412')!;
  assert.match(d.message, /connection strings and keys go in the backend's \.env/);
});

test('AZ1225: a missing setting is named', () => {
  assert.deepEqual(codes(site('  backend\n    database sqlite\n')), ['AZ1225']);
});

test('AZ1224: an unknown setting', () => {
  assert.deepEqual(codes(site('  backend\n    database sqlite\n    email smtp\n    port 5432\n')), ['AZ1224']);
});

test('AZ1223: only at site level', () => {
  const r = codes('az 1\nsite studio\n' + AUTH + 'page /\n  backend\n    database sqlite\n    email smtp\n');
  assert.ok(r.includes('AZ1223'), r.join(','));
});

test('AZ1506: declared twice', () => {
  assert.deepEqual(codes(site('  backend\n    database sqlite\n    email smtp\n  backend\n    database mysql\n    email api\n')), ['AZ1506']);
});

test('AZ1507: the site must sign in through it (adapter azbackend)', () => {
  assert.deepEqual(codes(site('  backend\n    database sqlite\n    email smtp\n', '  auth\n    adapter hosted\n')), ['AZ1507']);
  assert.deepEqual(codes(site('  backend\n    database sqlite\n    email smtp\n', '')), ['AZ1507'], 'no auth at all');
});
