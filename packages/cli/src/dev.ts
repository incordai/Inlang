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

import { watch, type FSWatcher } from 'node:fs';
import { build, type BuildOutcome } from './az.ts';

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
  const outcome = build({
    source: options.source,
    outDir: options.outDir,
    wordsDir: options.wordsDir,
  });
  return { outcome, ms: performance.now() - t0 };
}

export function dev(options: DevOptions): DevHandle {
  const debounceMs = options.debounceMs ?? 40;
  let timer: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;

  const run = () => {
    const { outcome, ms } = once(options);
    options.onResult?.(outcome, ms);
    return outcome;
  };

  run();

  try {
    watcher = watch(options.source, () => {
      // Debounce: an editor save can fire `change` two or three times, and
      // recompiling per event would report three builds for one edit.
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, debounceMs);
    });
  } catch {
    // A missing file is reported by the first build; not being able to watch
    // it is not a second error worth crashing over.
  }

  return {
    close: () => {
      if (timer) clearTimeout(timer);
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
