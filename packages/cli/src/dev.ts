/**
 * `az dev` — watch and recompile.
 *
 * PRD §6.7 calls sub-second recompile "the single best demo we have — the
 * thing AI generators structurally cannot do". The measured compile is ~0.5ms,
 * so the interesting engineering here is not speed; it is not making the watch
 * loop the slow part, and not lying about what happened.
 *
 * Kept separate from `az.ts` because a watcher owns a process and a timer,
 * and build does not.
 */

import { watch, statSync, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { build, type BuildOutcome } from './az.ts';

/**
 * How often the source is re-checked against what was last built.
 *
 * File events are a fast path, not a guarantee: macOS delivers them through
 * FSEvents, which starts asynchronously and can drop a change that lands
 * just after the watch begins. A cheap stat on this tick reconciles any
 * missed event, so a save is never silently ignored.
 */
const RECONCILE_MS = 250;

export interface DevOptions {
  readonly source: string;
  readonly outDir: string;
  readonly wordsDir: string;
  /** Coalesce bursts of change events. Editors write a file several times. */
  readonly debounceMs?: number;
  readonly onResult?: (outcome: BuildOutcome, ms: number) => void;
}

export interface DevHandle {
  readonly close: () => void;
  /** Compile once, now. Exposed so a test can drive it without a timer. */
  readonly rebuild: () => BuildOutcome;
}

/**
 * Compile once and report honestly.
 *
 * A failed compile must NOT leave the previous output in place silently — the
 * author would be looking at a stale site while their file is broken, which is
 * the worst possible feedback. So the outcome is reported either way, and the
 * caller decides what to show.
 */
function once(options: DevOptions): { outcome: BuildOutcome; ms: number } {
  const t0 = performance.now();
  let outcome: BuildOutcome;
  try {
    outcome = build({
      source: options.source,
      outDir: options.outDir,
      wordsDir: options.wordsDir,
    });
  } catch (e) {
    // A rebuild runs from a timer, where a throw is an uncaught exception
    // that ends the session and orphans the dev server. The source vanishing
    // mid-session (a branch switch) or any other failure is a failed build,
    // reported like one; the next save tries again.
    outcome = { ok: false, files: [], assets: [], report: (e as Error).message, exit: 1 };
  }
  return { outcome, ms: performance.now() - t0 };
}

export function dev(options: DevOptions): DevHandle {
  const debounceMs = options.debounceMs ?? 40;
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  /** mtime and size of the source as last compiled; null when unreadable. */
  let built: string | null = null;

  const stamp = (): string | null => {
    try {
      const st = statSync(options.source);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  };

  const run = () => {
    // Stamped BEFORE compiling, so a save during the compile differs from it
    // and is picked up on the next tick.
    built = stamp();
    const { outcome, ms } = once(options);
    options.onResult?.(outcome, ms);
    return outcome;
  };

  // Debounce: an editor save can fire several events, and recompiling per
  // event would report three builds for one edit.
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
  };

  // The DIRECTORY, not the file. Many editors save by writing a temporary
  // file and renaming it over the original; a watch on the file follows the
  // replaced inode and goes quiet after the first such save.
  const file = basename(options.source);
  try {
    watcher = watch(dirname(options.source), (_event, name) => {
      if (name === null || name === file) schedule();
    });
  } catch {
    // Unwatchable (a missing directory): the reconcile tick below still
    // notices the file once it can be read. `az dev` refuses a missing source
    // before it gets here, so this is only reached if the folder goes away.
  }

  run();
  const reconcile = setInterval(() => {
    if (stamp() !== built) schedule();
  }, RECONCILE_MS);

  return {
    close: () => {
      if (timer) clearTimeout(timer);
      clearInterval(reconcile);
      watcher?.close();
    },
    rebuild: run,
  };
}

/** Format one dev-loop result for a terminal. */
export function devLine(outcome: BuildOutcome, ms: number): string {
  if (!outcome.ok) {
    const first = outcome.report.split('\n')[0] ?? 'compile failed';
    return `az: ${first}`;
  }
  const warnings = outcome.report ? ' (with warnings)' : '';
  return `az: ${outcome.files.length} files in ${ms.toFixed(1)}ms${warnings}`;
}
