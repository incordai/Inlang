/**
 * Bounded waits for the spike's browser scripts — the same rules as the
 * repository's scripts/lib/bounded.mjs, kept local because the spike is its
 * own package (its own lockfile and strict tsconfig over `scripts/`) and
 * does not import the root's untyped scripts.
 *
 * A `close()` on a stuck context or browser, and a `page.evaluate`, can wait
 * forever; Playwright bounds neither. Every such wait gets a deadline, a
 * missed one is a named failure, and a whole-run watchdog ends the process
 * (which kills every browser Playwright launched) after stopping the
 * children the run started: SIGTERM, then SIGKILL after a short grace.
 */

import type { ChildProcess } from 'node:child_process';

/** A wait that missed its deadline. */
export class Overdue extends Error {
  constructor(label: string, ms: number) {
    super(`${label}: no answer after ${(ms / 1000).toFixed(0)}s`);
    this.name = 'Overdue';
  }
}

/** `work` or Overdue after `ms`; the timer is always cleared. */
export async function within<T>(ms: number, label: string, work: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Overdue(label, ms)), ms); });
  const pending = work();
  // Work given up on may reject later; unhandled, that would end the run.
  pending.catch(() => {});
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Close within `ms`; false when it would not (abandoned — the process exit kills it). */
export async function closeWithin(target: { close(): Promise<unknown> }, ms: number, label: string): Promise<boolean> {
  try {
    await within(ms, label, () => target.close());
    return true;
  } catch (e) {
    if (e instanceof Overdue) {
      process.stderr.write(`bounded: ${e.message} — abandoned; the process exit kills it\n`);
      return false;
    }
    return true;   // already closed: nothing is left open
  }
}

/** How long a child asked to stop gets before SIGKILL. */
export const KILL_GRACE_MS = 3_000;

const exited = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

/** SIGTERM, then SIGKILL if the child has not exited within `graceMs`. */
export async function stopChild(child: ChildProcess, graceMs = KILL_GRACE_MS): Promise<void> {
  if (exited(child)) return;
  const gone = new Promise<'gone'>((done) => child.once('exit', () => done('gone')));
  child.kill('SIGTERM');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<'late'>((done) => { timer = setTimeout(() => done('late'), graceMs); });
  try {
    if ((await Promise.race([gone, late])) === 'late' && !exited(child)) child.kill('SIGKILL');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The whole-run deadline: past it, say the last step, stop `children`
 * (SIGTERM, then SIGKILL), and exit 124. Unref'd, so it never holds a
 * finished run open.
 */
export function watchdog(ms: number, label: string, progress: { last?: string; children: ChildProcess[] }): { clear(): void } {
  const timer = setTimeout(async () => {
    process.stderr.write(`\nFAIL  ${label}: still running after ${(ms / 1000).toFixed(0)}s — last step: ${progress.last ?? 'none'}\n`);
    await Promise.all(progress.children.map((c) => stopChild(c)));
    process.exit(124);
  }, ms);
  timer.unref();
  return { clear: () => clearTimeout(timer) };
}
