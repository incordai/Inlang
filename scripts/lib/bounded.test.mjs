/**
 * The run watchdog stops what the run started: a child process gets SIGTERM,
 * then SIGKILL after a short grace — one that ignores SIGTERM cannot outlive
 * the run (review #9).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stopChild, within } from './bounded.mjs';

/** A node process that ignores SIGTERM (or not) and runs until killed. */
const stubborn = (ignoreTerm) => spawn(process.execPath, ['-e',
  `${ignoreTerm ? "process.on('SIGTERM', () => {});" : ''} setInterval(() => {}, 1000); process.stdout.write('ready\\n');`], { stdio: ['ignore', 'pipe', 'ignore'] });
const ready = (child) => within(5_000, 'child ready', new Promise((done) => child.stdout.once('data', done)));
const exitOf = (child) => (child.exitCode !== null || child.signalCode !== null
  ? Promise.resolve(child.signalCode)
  : within(5_000, 'child exit', new Promise((done) => child.once('exit', (_, signal) => done(signal)))));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

test('stopChild: a child that ignores SIGTERM is killed after the grace', async () => {
  const child = stubborn(true);
  try {
    await ready(child);
    await stopChild(child, 300);
    assert.equal(await exitOf(child), 'SIGKILL');
  } finally { child.kill('SIGKILL'); }
});

test('CONTROL: stopChild: a child that honours SIGTERM ends by it, never SIGKILL', async () => {
  const child = stubborn(false);
  try {
    await ready(child);
    await stopChild(child, 3_000);
    assert.equal(await exitOf(child), 'SIGTERM');
  } finally { child.kill('SIGKILL'); }
});

test('watchdog: past the run deadline, a child ignoring SIGTERM is killed before the run exits 124', async () => {
  const bounded = fileURLToPath(new URL('./bounded.mjs', import.meta.url));
  const run = spawn(process.execPath, ['--input-type=module', '-e', `
    import { spawn } from 'node:child_process';
    import { watchdog } from ${JSON.stringify(bounded)};
    const g = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('up');"], { stdio: ['ignore', 'pipe', 'ignore'] });
    g.stdout.once('data', () => {
      process.stdout.write(String(g.pid) + '\\n');
      watchdog(100, 'probe', { children: [g] }, 300);
    });
    setInterval(() => {}, 1000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let grandchild = 0;
  try {
    grandchild = Number(await within(5_000, 'grandchild pid', new Promise((done) => run.stdout.once('data', (c) => done(String(c).trim())))));
    const code = await within(10_000, 'run exit', new Promise((done) => run.once('exit', (c) => done(c))));
    assert.equal(code, 124);
    // A SIGKILL'd process is gone once the kill is delivered; allow it a moment.
    await within(5_000, 'grandchild gone', async () => { while (alive(grandchild)) await new Promise((r) => setTimeout(r, 25)); });
    assert.equal(alive(grandchild), false);
  } finally {
    run.kill('SIGKILL');
    if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
  }
});
