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
import type { LockStep, SpecTable } from '../../core/src/index.ts';
import { backendDataOf as dataOf } from './data-fixture.ts';

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
  assert.deepEqual(serverDependencies({ database: 'postgres', email: 'smtp' }), { pg: '8.23.1', nodemailer: '10.0.16' });
  assert.deepEqual(serverDependencies({ database: 'mysql', email: 'api' }), { mysql2: '3.24.5' });
});

test('the image library is installed only for a site with an image field (data-spec §8)', () => {
  assert.deepEqual(serverDependencies({ database: 'sqlite', email: 'api', data: true }), {}, 'tables without images: nothing new');
  assert.deepEqual(serverDependencies({ database: 'sqlite', email: 'api', data: true, images: true }), { sharp: '0.35.5' });
  const withImages = dataOf('  data notes\n    body text\n    photo image\n    allow anyone read\n');
  const without = dataOf('  data notes\n    body text\n    allow anyone read\n');
  const pkg = (d?: { tables: readonly SpecTable[]; steps: readonly LockStep[] }) =>
    backendFiles('Studio', { database: 'sqlite', email: 'api' }, d).find((f) => f.path === 'server/package.json')!.content;
  assert.equal(JSON.parse(pkg(withImages)).dependencies.sharp, '0.35.5');
  assert.equal(pkg(without), pkg(undefined), 'a data site without images: package.json byte-identical to a site without data');
  const files = (d: typeof withImages) => backendFiles('Studio', { database: 'sqlite', email: 'api' }, d);
  const env = (d: typeof withImages) => files(d).find((f) => f.path === 'server/.env.example')!.content;
  assert.match(env(withImages), /^AZ_FILES_DIR=\.\/data\/files$/m);
  assert.match(env(withImages), /^AZ_UPLOAD_MAX_MB=5$/m);
  assert.doesNotMatch(env(without), /AZ_FILES_DIR|AZ_UPLOAD_MAX_MB/);
  const config = (d: typeof withImages) => JSON.parse(files(d).find((f) => f.path === 'server/az.config.json')!.content);
  assert.deepEqual([config(withImages).images, config(without).images], [true, undefined]);
  assert.match(files(withImages).find((f) => f.path === 'server/README.md')!.content, /\*\*Images\.\*\*/);
  assert.doesNotMatch(files(without).find((f) => f.path === 'server/README.md')!.content, /\*\*Images\.\*\*/);
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
  const config = JSON.parse(files.find((f) => f.path === 'server/az.config.json')!.content);
  assert.deepEqual({ ...config, _generated: undefined },
    { _generated: undefined, siteName: 'Studio Co', database: 'sqlite', email: 'smtp' });
  assert.match(files.find((f) => f.path === 'server/.gitignore')!.content, /^\.env$/m);
});

test('headers: each server file says what it is and points to AZ.md, as every generated file does', () => {
  const files = backendFiles('Studio Co', { database: 'sqlite', email: 'smtp' });
  const first = (path: string) => files.find((f) => f.path === path)!.content.split('\n')[0];
  const pointer = /Do not edit: change the \.az source and rebuild \(map: AZ\.md\)\.( -->)?$/;
  assert.match(first('server/README.md'), /^<!-- GENERATED BY AZ — how to run, configure and deploy/);
  assert.match(first('server/.env.example'), /^# GENERATED BY AZ — every backend key with its meaning/);
  assert.match(first('server/.gitignore'), /^# GENERATED BY AZ — keeps \.env/);
  for (const p of ['server/README.md', 'server/.env.example', 'server/.gitignore']) assert.match(first(p), pointer, p);
  for (const p of ['server/package.json', 'server/az.config.json']) {
    const g = JSON.parse(files.find((f) => f.path === p)!.content)._generated as string;
    assert.match(g, /^BY AZ — .+\. Do not edit: change the \.az source and rebuild \(map: AZ\.md\)\.$/, p);
  }
  assert.notEqual(JSON.parse(files.find((f) => f.path === 'server/package.json')!.content)._generated,
    JSON.parse(files.find((f) => f.path === 'server/az.config.json')!.content)._generated, 'each says what IT is');
});
