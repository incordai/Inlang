/**
 * ROADMAP M1 exit criteria that need a real process, not a function call:
 *   - `az build` succeeds with network disabled
 *   - cold compile < 1s on the reference fixture (GRAMMAR §8)
 * Byte-identical rebuilds are covered in cli.test.ts (DETERMINISM).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const POISON = join(ROOT, 'packages/cli/test/no-network.mjs');
const WORDS = join(ROOT, 'packages/words');

/** ROADMAP M1: "cold compile < 1s on the reference fixture". */
const COLD_BUDGET_MS = 1000;
const COLD_RUNS = 3;

function fixtureProject() {
  const dir = mkdtempSync(join(tmpdir(), 'az-m1-'));
  cpSync(join(ROOT, 'packages/core/test/fixture-site.az'), join(dir, 'site.az'));
  cpSync(join(ROOT, 'packages/core/test/fixture-assets'), dir, { recursive: true });
  return dir;
}

const az = (nodeArgs: string[], args: string[]) =>
  spawnSync(process.execPath, [...process.execArgv, ...nodeArgs, BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, AZ_WORDS: WORDS },
  });

test('az build succeeds with every network path disabled', () => {
  const dir = fixtureProject();
  const r = az(['--import', POISON], ['build', join(dir, 'site.az'), '--out', join(dir, 'out')]);
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /NETWORK ATTEMPT/, 'the build must not even try the network');
  assert.ok(existsSync(join(dir, 'out/src/App.tsx')));
});

test('CONTROL: the poison really blocks the network', () => {
  const r = spawnSync(process.execPath,
    ['--import', POISON, '-e', 'fetch("http://127.0.0.1:9").catch(() => {})'],
    { encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'a fetch under the poison must throw');
  assert.match(r.stderr, /NETWORK ATTEMPT: fetch/);
});

test(`cold compile of the reference fixture is under ${COLD_BUDGET_MS}ms`, () => {
  const dir = fixtureProject();
  // A fresh process each run, so "cold" includes startup and module loading.
  // The best of a few runs, so one scheduler stall on a busy CI machine does
  // not read as a regression; the budget itself is not relaxed.
  const times: number[] = [];
  for (let i = 0; i < COLD_RUNS; i++) {
    const t0 = performance.now();
    const r = az([], ['build', join(dir, 'site.az'), '--out', join(dir, `out${i}`)]);
    times.push(performance.now() - t0);
    assert.equal(r.status, 0, r.stderr);
  }
  const best = Math.min(...times);
  assert.ok(best < COLD_BUDGET_MS, `best cold build ${best.toFixed(0)}ms (runs: ${times.map((t) => t.toFixed(0)).join(', ')})`);
});
