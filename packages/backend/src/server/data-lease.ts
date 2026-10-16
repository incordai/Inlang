/**
 * @az server data-lease
 * Purpose: a named lease shared by every process on one files directory: one image encode at a time, one backfill at a time.
 * Spec: docs/data-spec.md §8
 * Exports: takeLease, Lease, LeaseBusy, LeaseTiming
 * Edit guide: every wait is bounded; a lease is its holder's while its file is fresh; a holder removes only its own file.
 * Tests: packages/backend/test/data-lease.test.ts
 */

/**
 * The image queue (data-images.ts) runs one encode at a time — in one
 * process. `az backend images --confirm` runs the backfill in another, so a
 * live server and a backfill encoded at once, and two backfills on the same
 * files made the same copies over each other. Both now take a lease here,
 * in the files directory both use.
 *
 * A lease is a file `<name>.<token>` in the directory, its mtime refreshed
 * while it is held. To take one, a process makes its own file and then looks
 * for another fresh one: if there is one, it removes its own and waits.
 * Two that try at once can both step back, never both go on: the later of
 * the two files to be made always sees the earlier. Two that stepped back
 * try again after a random pause (no holder stopped them, so even a caller
 * that does not wait does). A file not refreshed for `staleMs` belongs to a
 * process that died, and is removed by whoever finds it. Nothing here
 * depends on a process id, so it holds across containers sharing a volume.
 *
 * Copied into a generated server only when the site declares data; imports
 * only node built-ins.
 */

import { randomBytes } from 'node:crypto';
import { readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface LeaseTiming {
  /** How long to wait for the lease; 0 tries once. */
  readonly waitMs: number;
  /** A lease file not refreshed for this long is a dead holder's. */
  readonly staleMs: number;
  /** How often the holder refreshes its file: well inside staleMs. */
  readonly heartbeatMs: number;
  /** How often a waiter looks again (plus up to as much again, at random). */
  readonly pollMs: number;
}

/** The lease could not be taken within its wait. */
export class LeaseBusy extends Error {}

export interface Lease {
  /** Give it up: the heartbeat stops and the file goes. Safe to call twice. */
  release(): Promise<void>;
}

/** A lease file's name: the lease's own name and a random token, nothing a caller wrote. */
const fileName = (name: string, token: string) => `${name}.${token}`;
const NAME = /^[a-z][a-z-]*$/;
const TOKEN_BYTES = 12;
/**
 * Two that try at the same moment both step back; that is no holder, so
 * they try again after a random pause even when the caller does not wait
 * (waitMs 0) — this many times at most, which two random pauses in a row
 * make all but certain to be enough.
 */
const COLLISIONS_MAX = 8;

/** The other holders' files of `name` that are still fresh; stale ones are removed on the way. */
async function freshRivals(dir: string, name: string, own: string | null, staleMs: number): Promise<string[]> {
  const fresh: string[] = [];
  for (const entry of await readdir(dir)) {
    if (entry === own || !entry.startsWith(`${name}.`)) continue;
    const path = join(dir, entry);
    let mtime: number;
    try {
      mtime = (await stat(path)).mtimeMs;
    } catch {
      continue; // released between the listing and the look
    }
    if (Date.now() - mtime > staleMs) await rm(path, { force: true });
    else fresh.push(entry);
  }
  return fresh;
}

/**
 * Take the lease `name` in `dir`, waiting up to `timing.waitMs`, or throw
 * LeaseBusy. The returned lease is refreshed until it is released.
 */
export async function takeLease(dir: string, name: string, timing: LeaseTiming): Promise<Lease> {
  if (!NAME.test(name)) throw new Error(`data-lease: '${name}' is not a lease name`);
  const own = fileName(name, randomBytes(TOKEN_BYTES).toString('hex'));
  const path = join(dir, own);
  const deadline = Date.now() + timing.waitMs;
  const pause = () => timing.pollMs * (1 + Math.random());
  let collisions = 0;
  for (;;) {
    if ((await freshRivals(dir, name, own, timing.staleMs)).length === 0) {
      await writeFile(path, '', { flag: 'wx', mode: 0o600 });
      if ((await freshRivals(dir, name, own, timing.staleMs)).length === 0) break;
      // Another made its file at the same moment: both step back, and try again apart.
      await rm(path, { force: true });
      if (++collisions <= COLLISIONS_MAX) {
        await sleep(pause());
        continue;
      }
    }
    if (Date.now() >= deadline) throw new LeaseBusy(`${name}: another process holds it`);
    await sleep(Math.min(pause(), Math.max(0, deadline - Date.now())));
  }
  // Refreshed one beat at a time, so a slow disk never stacks them up.
  let beating: Promise<void> = Promise.resolve();
  const beat = setInterval(() => {
    beating = beating.then(() => {
      const t = new Date();
      return utimes(path, t, t).catch(() => undefined);
    });
  }, timing.heartbeatMs);
  beat.unref();
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(beat);
      await beating;
      await rm(path, { force: true });
    },
  };
}
