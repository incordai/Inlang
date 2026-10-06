/**
 * @az module data-schema
 * Purpose: the data schema lock on disk; az backend plan and az backend schema.
 * Spec: docs/data-spec.md §6.1–§6.2
 * Exports: lockPath, lockOption, readLockSteps, runDataPlan, runDataSchema, parseSchemaFlags
 * Edit guide: core decides (plan, checkLock); this file only reads, prints and writes the lock.
 * Tests: packages/cli/test/data-schema.test.ts
 */

/**
 * The lock is `<name>.data.json` beside `<name>.az`. A build only reads it
 * (Q11: a schema change is a reviewed diff); `az backend schema` is the one
 * writer, and it writes through a temporary file and a rename so a crash
 * never leaves half a lock.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  compile, formatDiagnostics, LockError, parseLock, plan, replay, serialiseLock,
  type LockFlags, type LockStep, type Manifest,
} from '../../core/src/index.ts';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** `site.az` → `site.data.json`, in the same folder. */
export const lockPath = (source: string) =>
  join(dirname(source), `${basename(source).replace(/\.az$/, '')}.data.json`);

/** The compile option that makes a build check the file against its lock. */
export function lockOption(source: string) {
  const path = lockPath(source);
  return {
    text: existsSync(path) ? readFileSync(path, 'utf8') : null,
    source: basename(source),
    name: basename(path),
    digest: sha256,
  };
}

/** The lock's steps — empty when there is no lock; a LockError when it is damaged. */
export function readLockSteps(source: string): readonly LockStep[] {
  const { text } = lockOption(source);
  return text === null ? [] : parseLock(text, sha256).steps;
}

export type FlagParse = { readonly ok: true; readonly flags: LockFlags } | { readonly ok: false; readonly message: string };

/** `--rename a=b`, `--drop x`, `--unique t.f`, each repeatable; nothing else. */
export function parseSchemaFlags(args: readonly string[]): FlagParse {
  const rename: string[] = [];
  const drop: string[] = [];
  const unique: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    const into = flag === '--rename' ? rename : flag === '--drop' ? drop : flag === '--unique' ? unique : null;
    if (!into) return { ok: false, message: `unknown option '${flag}' — use --rename old=new, --drop name or --unique table.field` };
    if (value === undefined || value.startsWith('--')) return { ok: false, message: `${flag} needs a value, e.g. ${flag} products.title${flag === '--rename' ? '=name' : ''}` };
    into.push(value);
    i++;
  }
  return { ok: true, flags: { rename, drop, unique } };
}

type Out = { readonly out: (s: string) => void; readonly err: (s: string) => void };

/** Compile without the lock check (the lock is what is being planned) and plan against the lock. */
function planned(source: string, manifests: Map<string, Manifest>, flags: LockFlags, io: Out) {
  const r = compile(readFileSync(source, 'utf8'), { manifests });
  if (r.diagnostics.length > 0) io.err(`${formatDiagnostics(r.diagnostics, source)}\n`);
  if (!r.ok || !r.spec) return null;
  let steps: readonly LockStep[];
  try {
    steps = readLockSteps(source);
  } catch (e) {
    if (!(e instanceof LockError)) throw e;
    io.err(`${source}: error AZ1706  data: ${basename(lockPath(source))} is edited by hand or damaged (${e.message}) — restore it from version control\n`);
    return null;
  }
  return { steps, result: plan(replay(steps), r.spec.site.data ?? [], flags) };
}

function report(p: NonNullable<ReturnType<typeof planned>>, source: string, io: Out): void {
  for (const c of p.result.changes) io.out(`  ${c.kind === 'safe' ? 'safe       ' : 'destructive'}  ${c.text}\n`);
  for (const x of p.result.problems) io.err(`${source}: error ${x.code}  ${x.message}\n`);
  for (const f of p.result.flagErrors) io.err(`az: ${f}\n`);
}

/** `az backend plan <file.az>` — print the step the file needs; write nothing. 0 when it could be recorded. */
export function runDataPlan(source: string, manifests: Map<string, Manifest>, io: Out): number {
  const p = planned(source, manifests, { rename: [], drop: [], unique: [] }, io);
  if (!p) return 1;
  if (p.result.ops.length === 0 && p.result.problems.length === 0) {
    io.out(`az: ${basename(lockPath(source))} matches the file — nothing to record\n`);
    return 0;
  }
  io.out(`az: step ${p.steps.length + 1} would:\n`);
  report(p, source, io);
  return p.result.problems.length > 0 ? 1 : 0;
}

/**
 * `az backend schema <file.az> [--rename a=b] [--drop x] [--unique t.f]` —
 * append the step. Refuses (and writes nothing) while anything is blocked.
 */
export function runDataSchema(source: string, manifests: Map<string, Manifest>, args: readonly string[], io: Out): number {
  const parsed = parseSchemaFlags(args);
  if (!parsed.ok) {
    io.err(`az: ${parsed.message}\n`);
    return 2;
  }
  const p = planned(source, manifests, parsed.flags, io);
  if (!p) return 1;
  if (p.result.flagErrors.length > 0 || p.result.problems.length > 0) {
    report(p, source, io);
    io.err('az: nothing written\n');
    return p.result.flagErrors.length > 0 ? 2 : 1;
  }
  const path = lockPath(source);
  if (p.result.ops.length === 0) {
    io.out(`az: ${basename(path)} matches the file — nothing to record\n`);
    return 0;
  }
  const version = p.steps.length + 1;
  // Created fresh (`wx`), so a link left at the temporary name is never followed.
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, serialiseLock([...p.steps, { version, ops: p.result.ops }], sha256), { encoding: 'utf8', flag: 'wx' });
  renameSync(tmp, path);
  io.out(`az: recorded step ${version} in ${basename(path)}:\n`);
  report(p, source, io);
  return 0;
}
