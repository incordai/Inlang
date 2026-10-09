/**
 * ROADMAP M1 exit criteria that need a real process, not a function call:
 *   - `az build` succeeds with network disabled
 *   - cold compile < 1s on the reference fixture (GRAMMAR §8), in CPU time
 * Byte-identical rebuilds are covered in cli.test.ts (DETERMINISM).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const POISON = join(ROOT, 'packages/cli/test/no-network.mjs');
const WORDS = join(ROOT, 'packages/words');

/** ROADMAP M1: "cold compile < 1s on the reference fixture". */
const COLD_BUDGET_MS = 1000;
const COLD_RUNS = 3;
/** Preload reporting each build process's CPU time (cpu-time.mjs). */
const CPU_TIME = pathToFileURL(join(ROOT, 'packages/cli/test/cpu-time.mjs')).href;
/** The control's preload: spin until this process has used the whole budget of CPU. */
const BURN = `data:text/javascript,${encodeURIComponent(
  `const t0 = process.cpuUsage(); const used = () => { const d = process.cpuUsage(t0); return (d.user + d.system) / 1000; };
   while (used() < ${COLD_BUDGET_MS});`,
)}`;

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

/**
 * One cold `az build` of the fixture, timed by the CPU it spent: every Node
 * process the build starts (az, and any child such as the image resizer)
 * reports its own user + system time through the cpu-time preload, and the
 * total is the build's cost. Wall-clock time would also count the time the
 * build waits while other work has the CPU; CPU time leaves it out. `preload` adds
 * modules to load first in every process (the control's busy loop).
 */
function coldBuild(dir: string, out: string, preload: string[] = []): number {
  const reports = mkdtempSync(join(tmpdir(), 'az-m1-cpu-'));
  const imports = [CPU_TIME, ...preload].map((m) => `--import=${m}`).join(' ');
  const r = spawnSync(process.execPath, [...process.execArgv, BIN, 'build', join(dir, 'site.az'), '--out', join(dir, out)], {
    encoding: 'utf8',
    env: { ...process.env, AZ_WORDS: WORDS, AZ_TEST_CPU_DIR: reports, NODE_OPTIONS: [process.env.NODE_OPTIONS, imports].filter(Boolean).join(' ') },
  });
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(reports);
  assert.ok(files.length > 0, 'the build reported no CPU time');
  return files.reduce((sum, f) => sum + (JSON.parse(readFileSync(join(reports, f), 'utf8')) as { ms: number }).ms, 0);
}

test(`cold compile of the reference fixture is under ${COLD_BUDGET_MS}ms`, () => {
  // A fresh process each run, so "cold" includes startup and module loading.
  // The best of a few runs: CPU time still varies a little run to run (caches,
  // clock speed); the budget itself is not relaxed.
  const dir = fixtureProject();
  const times = Array.from({ length: COLD_RUNS }, (_, i) => coldBuild(dir, `out${i}`));
  const best = Math.min(...times);
  assert.ok(best < COLD_BUDGET_MS, `best cold build ${best.toFixed(0)}ms of CPU (runs: ${times.map((t) => t.toFixed(0)).join(', ')})`);
});

test('CONTROL: a compile that burns more CPU than the budget is over it', () => {
  // Every process of the build first spins for the whole budget, by its own
  // CPU clock — so on any machine, loaded or idle, the build costs more.
  // One run is enough: the burn is the same every time.
  const ms = coldBuild(fixtureProject(), 'out', [BURN]);
  assert.ok(ms >= COLD_BUDGET_MS, `a build that burns ${COLD_BUDGET_MS}ms of CPU measured ${ms.toFixed(0)}ms`);
});
