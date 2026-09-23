/**
 * What `az build` writes for a backend, and the pins it ships (backend-spec §8, §9).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BACKEND_PINS, backendFiles, envExample, envFile, serverDependencies } from '../src/emit.ts';
import { DRIVERS } from '../src/server/drivers.ts';
import { KEYS } from '../src/server/env.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('pins: the server ships exactly the driver versions the repository tests against', () => {
  const root = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { devDependencies: Record<string, string> };
  for (const [name, version] of Object.entries(BACKEND_PINS)) {
    assert.equal(root.devDependencies[name], version, `${name} drifted from the tested version`);
    assert.match(version, /^\d+\.\d+\.\d+$/, 'exact');
  }
});

test('drivers: every loadable module is a built-in or a pinned package', () => {
  for (const d of DRIVERS) {
    const pkg = d.split('/')[0];
    assert.ok(d.startsWith('node:') || pkg in BACKEND_PINS, `${d} is loaded but not pinned`);
  }
});

test('dependencies: only what the setup uses — a SQLite + API server installs nothing', () => {
  assert.deepEqual(serverDependencies({ database: 'sqlite', email: 'api' }), {});
  assert.deepEqual(serverDependencies({ database: 'postgres', email: 'smtp' }), { pg: '8.23.0', nodemailer: '10.0.10' });
  assert.deepEqual(serverDependencies({ database: 'mysql', email: 'api' }), { mysql2: '3.24.4' });
});

test('.env.example: every key the setup reads, described, and no secret value', () => {
  const text = envExample({ database: 'postgres', email: 'smtp' });
  for (const k of KEYS.filter((key) => key.when({ database: 'postgres', email: 'smtp' }))) {
    assert.match(text, new RegExp(`^${k.name}=`, 'm'), k.name);
    if (k.secret) assert.match(text, new RegExp(`^${k.name}=$`, 'm'), `${k.name} has no value`);
  }
  assert.doesNotMatch(text, /^AZ_SQLITE_PATH=/m, 'CONTROL: the other engine\'s key is absent');
  assert.doesNotMatch(text, /^AZ_EMAIL_API_KEY=/m);
});

test('.env from init: a fresh 32-byte secret each time, everything else as the example', () => {
  const a = envFile({ database: 'sqlite', email: 'smtp' });
  const b = envFile({ database: 'sqlite', email: 'smtp' });
  const secret = (t: string) => /^AZ_SESSION_SECRET=(.*)$/m.exec(t)![1];
  assert.equal(Buffer.from(secret(a), 'base64url').length, 32);
  assert.notEqual(secret(a), secret(b));
  assert.equal(a.replace(secret(a), ''), b.replace(secret(b), ''));
});

test('files: server/ holds its config, runbook and ignore rules; the config carries no secret', () => {
  const files = backendFiles('Studio Co', { database: 'sqlite', email: 'smtp' });
  assert.deepEqual(files.map((f) => f.path).sort(),
    ['server/.env.example', 'server/.gitignore', 'server/README.md', 'server/az.config.json', 'server/package.json']);
  const pkg = JSON.parse(files.find((f) => f.path === 'server/package.json')!.content);
  assert.equal(pkg.name, 'studio-co-backend');
  assert.equal(pkg.scripts.start, 'node src/main.ts');
  assert.deepEqual(JSON.parse(files.find((f) => f.path === 'server/az.config.json')!.content),
    { _generated: pkg._generated, siteName: 'Studio Co', database: 'sqlite', email: 'smtp' });
  assert.match(files.find((f) => f.path === 'server/.gitignore')!.content, /^\.env$/m);
});
