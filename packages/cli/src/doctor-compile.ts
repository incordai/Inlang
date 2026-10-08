/**
 * @az module doctor-compile
 * Purpose: az doctor's compile of the .az file, run as a worker thread so the check's timeout can end it.
 * Spec: docs/word-quality-gate.md §5.4
 * Exports: CompileJob
 * Edit guide: manifests only — never the project's own word code; posts exactly one message, a Compiled.
 * Tests: packages/cli/test/doctor.test.ts
 */

/**
 * Compiling is synchronous: a file that keeps the compiler busy would hold
 * the whole doctor run, deadlines included, if it ran on the main thread.
 * Here it holds only this thread, which doctor terminates at its timeout.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { compile } from '../../core/src/index.ts';
import { compileReader, wordsFor } from './az.ts';
import { lockOption, lockPath } from './data-schema.ts';
import type { Compiled } from './doctor.ts';

/** What the worker is given: the absolute .az file and the word set. */
export interface CompileJob {
  readonly source: string;
  readonly wordsDir: string;
}

function compileJob({ source, wordsDir }: CompileJob): Compiled {
  // The file and its lock are read synchronously: a named pipe in their
  // place would block this thread in a read no termination can end, so it
  // is refused before anything is opened.
  const irregular = [source, lockPath(source)].find((f) => existsSync(f) && !statSync(f).isFile());
  if (irregular) return { error: `${basename(irregular)} is not a regular file` };
  try {
    const manifests = wordsFor({ source, wordsDir }, false).manifests;
    return { manifests, result: compile(readFileSync(source, 'utf8'), { manifests, lock: lockOption(source), readBytes: compileReader(source) }) };
  } catch (e) {
    return { error: String((e as Error).message ?? e).split('\n')[0] };
  }
}

parentPort?.postMessage(compileJob(workerData as CompileJob));
