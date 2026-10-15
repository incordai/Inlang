/**
 * Preload that lists every module a process loads.
 *
 * Loaded through `--import`, it registers a load hook that appends each
 * module's URL — the project's files and node's own built-ins alike — as one
 * line of the file AZ_TEST_MODULES names. startup-imports.test.ts reads it to
 * see what `az build` and `az check` really import, dynamic imports included.
 */
import { register } from 'node:module';

const out = process.env.AZ_TEST_MODULES;
if (!out) throw new Error('loaded-modules.mjs: AZ_TEST_MODULES names no file to list into');

const hooks = `
import { appendFileSync } from 'node:fs';
let out;
export function initialize(data) { out = data.out; }
export async function load(url, context, next) {
  appendFileSync(out, url + '\\n');
  return next(url, context);
}`;

register(`data:text/javascript,${encodeURIComponent(hooks)}`, { data: { out } });
