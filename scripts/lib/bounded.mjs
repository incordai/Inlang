/**
 * Bounded waits for the check scripts — every wait has a deadline.
 *
 * Playwright bounds navigation, locators and waitForFunction with the page's
 * default timeout, but NOT `page.evaluate`: a script that never resolves, or
 * a renderer that never answers, waits forever. A `close()` on a stuck page
 * or browser can wait forever too. One such wait once held the gate for
 * 4h18m with a headless Firefox spinning. These helpers put a deadline on
 * any promise and turn a missed one into a named failure, so a stuck engine
 * is a FAIL that says where it stuck — and the run continues or ends.
 *
 * A deadline cannot cancel the work it gave up on: the caller must throw
 * away whatever was stuck (the page, context or browser) and use a new one.
 * Playwright kills every browser it launched when the Node process exits,
 * so ending the process is the last-resort kill (`watchdog`).
 */

/** A wait that missed its deadline. `label` names what was being waited on. */
export class Overdue extends Error {
  constructor(label, ms) {
    super(`${label}: no answer after ${(ms / 1000).toFixed(0)}s`);
    this.name = 'Overdue';
    this.label = label;
    this.ms = ms;
  }
}

/** Slowest completions seen, by label — printed so deadlines stay grounded in measurement. */
export const timings = new Map();

/**
 * `work` (a promise, or a function returning one) or `Overdue` after `ms`.
 * The timer is always cleared, so a finished wait leaves nothing pending.
 */
export async function within(ms, label, work) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Overdue(label, ms)), ms); });
  const started = performance.now();
  let pending;
  try { pending = Promise.resolve(typeof work === 'function' ? work() : work); } catch (e) { pending = Promise.reject(e); }
  // Work given up on keeps running and may reject later, once its page is
  // closed; a rejection nobody handles would end the whole run (Node 22).
  // The race below still sees the rejection when it comes in time.
  pending.catch(() => {});
  try {
    const result = await Promise.race([pending, deadline]);
    const took = performance.now() - started;
    const key = label.split(' @ ')[0];
    if (took > (timings.get(key) ?? 0)) timings.set(key, took);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Close a page, context, browser or server within `ms`. True when it closed
 * (or was already closed); false when it would not — the caller abandons it
 * and the process exit kills what is left.
 */
export async function closeWithin(target, ms, label) {
  try {
    await within(ms, label, () => target.close());
    return true;
  } catch (e) {
    if (e instanceof Overdue) {
      process.stderr.write(`bounded: ${e.message} — abandoned; the process exit kills it\n`);
      return false;
    }
    return true;   // "already closed" and similar: nothing is left open
  }
}

/**
 * The whole-run deadline. Past it the run is stuck somewhere no other
 * deadline caught: print what it was doing and end the process — which also
 * kills every browser Playwright launched. `progress.last` names the last
 * step that completed. What the run started itself (a server process, a
 * dev watcher, a container) is not Playwright's: `progress.cleanup`, a
 * synchronous function, stops it before the exit. Unref'd, so it never
 * holds a finished run open.
 */
export function watchdog(ms, label, progress = {}) {
  const timer = setTimeout(() => {
    process.stderr.write(`\nFAIL  ${label}: still running after ${(ms / 1000).toFixed(0)}s, the run deadline` +
      ` — last step: ${progress.last ?? 'none'}\n`);
    try {
      progress.cleanup?.();
    } catch (e) {
      process.stderr.write(`${label}: cleanup at the run deadline failed — ${e.message}\n`);
    }
    process.exit(124);
  }, ms);
  timer.unref();
  return { clear: () => clearTimeout(timer) };
}

/** `5m 30s` for a deadline print-out. */
export const human = (ms) => {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}` : `${s}s`;
};

/** The slowest observed completions, for the end-of-run print-out. */
export function slowest(n = 6) {
  return [...timings.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
    .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join(', ');
}
