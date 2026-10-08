/**
 * @az module audit-site
 * Purpose: az audit's read of the built site, run as a worker thread so the audit's timeout can end it.
 * Spec: docs/word-quality-gate.md §5.5
 * Exports: SiteJob
 * Edit guide: posts exactly one message, analyseSite's SiteReport; reads only — nothing from the build is loaded or run.
 * Tests: packages/cli/test/audit.test.ts
 */

/**
 * The scans over the built pages are synchronous: one page they are slow
 * on would hold the whole audit, deadlines included, on the main thread.
 * Here it holds only this thread, which the audit terminates at its timeout.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { analyseSite } from './audit.ts';

/** What the worker is given: the output folder, and the public values the build inlined. */
export interface SiteJob {
  readonly outDir: string;
  readonly allow: readonly string[];
}

const job = workerData as SiteJob;
parentPort?.postMessage(await analyseSite(job.outDir, job.allow));
