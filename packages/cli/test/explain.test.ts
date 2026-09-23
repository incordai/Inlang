/**
 * `az explain <term...>` through the real binary.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const az = (...args: string[]) => spawnSync(process.execPath, [...process.execArgv, BIN, ...args], { encoding: 'utf8' });

test('az explain hero center prints the word and its variant', () => {
  const r = az('explain', 'hero', 'center');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split('\n'), [
    "hero (word): Page opener: the page's only h1, text and actions",
    'hero center (variant): Centred statement; visual behind or below',
  ]);
});

test('az explain resolves keywords, settings and values', () => {
  const r = az('explain', 'backend', 'database', 'postgres');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /backend\.database postgres \(value\): PostgreSQL via AZ_DATABASE_URL/);
});

test('an unknown term exits 1 with a suggestion', () => {
  const r = az('explain', 'nav', 'stiky');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /stiky: unknown — did you mean 'sticky'\?/);
});

test('CONTROL: explain with no term is a usage error', () => {
  assert.equal(az('explain').status, 2);
});
