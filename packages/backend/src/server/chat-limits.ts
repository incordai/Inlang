/**
 * @az server chat-limits
 * Purpose: the chat's cost bounds besides the budget: per-address and per-account windows kept in the database, so every instance counts the same, and the answer queue.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §6.5, §20.7, §21.2.4)
 * Exports: createWindows, createRateLimits, createQueue, limitsKey, Windows, WindowsOptions, RateLimits, Queue, HOUR_MS, DAY_MS, QUEUE_WAIT_MS, QUEUE_FACTOR,
 *   WINDOW_SLOTS, WINDOW_ROWS_MAX
 * Edit guide: a window's count is read and taken in the database — never a per-process map; a subject is stored only as a keyed hash;
 *   the take is one conditional UPDATE (atomic on every engine); a queued request never waits past QUEUE_WAIT_MS; every slot taken is released.
 * Tests: packages/backend/test/chat-limits.test.ts, scripts/backend-db-chat.mjs
 */

/**
 * Who may ask how often, and how many answers stream at once (chat-block-spec
 * §6.5). The windows — messages per address and per account, share creates,
 * tool calls (§20.7, §21.2.4) — are counted in the database every instance
 * of the server shares (`az_chat_limits`, a chat migration), so two
 * instances behind one proxy give an address one allowance, not two. The
 * answer queue stays per process: it bounds this process's open streams,
 * which is what it is for. (A shared answer's public reads and deletes keep
 * the per-process limiter the data reads use: an anonymous GET flood must
 * not write rows, nor fill the table chat's own limits live in.)
 *
 * A window of W is kept as WINDOW_SLOTS slots of W / WINDOW_SLOTS. An attempt
 * at time t counts every slot that overlaps (t − W, t], the oldest one whole,
 * and is let through only while that sum is under the limit — so no window
 * of length W ever holds more than the limit, and an address may wait at most
 * one slot longer than an exact window would make it. The current slot is
 * taken by one `UPDATE … SET n = n + 1 WHERE id = ? AND n < ?`: atomic on
 * SQLite, PostgreSQL and MySQL, so two instances taking the last place at once
 * cannot both get it. Refused attempts are not counted (as before).
 *
 * The table holds no address and no account: each row's id is an HMAC of the
 * window, its slot and the subject under a key derived from
 * AZ_SESSION_SECRET (its own label), and rows are swept once their slot can
 * no longer count (`expires`), with the server's other prunes.
 *
 * Bounded: a flood from many addresses makes a row per new subject, so past
 * WINDOW_ROWS_MAX rows a subject with no row in its slot yet is refused until
 * the sweep frees room — fail closed, never a forgotten limit. Each process
 * counts the table at every sweep and after every COUNT_EVERY rows it made,
 * so the table holds at most the cap and COUNT_EVERY more per instance.
 *
 * Copied into a generated server; imports only its siblings and node built-ins.
 */

import { createHmac } from 'node:crypto';
import type { Db } from './db.ts';
import type { ChatRate } from './env.ts';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** The longest a request waits for a free answer slot before `busy`. */
export const QUEUE_WAIT_MS = 10_000;
/** The queue holds this many times the concurrency (16 waiting at the default 4). */
export const QUEUE_FACTOR = 4;
/** Slots per window: the coarsest an address's wait can be off by is one of them (10 minutes of an hour). */
export const WINDOW_SLOTS = 6;
/** The most rows the windows' table holds (about 75 MB at most): past it a subject new to its slot is refused until the sweep frees room. */
export const WINDOW_ROWS_MAX = 500_000;
/** Rows one process makes between two counts of the table. */
const COUNT_EVERY = 10_000;

/** The limits key: its own label under AZ_SESSION_SECRET, so a row id is never another tag. */
export const limitsKey = (secret: Buffer): Buffer => createHmac('sha256', secret).update('az-chat-limits-v1').digest();

export interface Windows {
  /**
   * Count one attempt by `subject` against `limit` per `windowMs` in
   * `scope`; false (and nothing counted) when the window is full.
   */
  take(scope: string, limit: number, windowMs: number, subject: string): Promise<boolean>;
  /** Delete every row whose slot can no longer count; how many went. */
  sweep(): Promise<number>;
}

export interface WindowsOptions {
  readonly now?: () => number;
  /** WINDOW_ROWS_MAX, smaller in a test. */
  readonly maxRows?: number;
}

/** The database's windows: one row per (scope, window, slot, subject), named by a keyed hash. */
export function createWindows(db: Db, secret: Buffer, o: WindowsOptions = {}): Windows {
  const now = o.now ?? Date.now;
  const maxRows = o.maxRows ?? WINDOW_ROWS_MAX;
  const key = limitsKey(secret);
  /** The table was at its cap when this process last counted it; rows made since. */
  let full = false;
  let made = 0;
  const recount = async () => {
    made = 0;
    full = Number((await db.get('SELECT COUNT(*) AS n FROM az_chat_limits'))?.n ?? 0) >= maxRows;
  };
  const idOf = (scope: string, windowMs: number, slot: number, subject: string) =>
    createHmac('sha256', key).update(`${scope}\n${windowMs}\n${slot}\n${subject}`).digest('base64url');
  // Makes the slot's row if it is not there yet; never changes one that is.
  const ensure = db.dialect === 'mysql'
    ? 'INSERT INTO az_chat_limits (id, n, expires) VALUES (?, 0, ?) ON DUPLICATE KEY UPDATE id = id'
    : 'INSERT INTO az_chat_limits (id, n, expires) VALUES (?, 0, ?) ON CONFLICT (id) DO NOTHING';
  return {
    async take(scope, limit, windowMs, subject) {
      const size = windowMs / WINDOW_SLOTS;
      if (!Number.isInteger(size) || size <= 0 || !Number.isInteger(limit) || limit < 1) {
        throw new Error('chat-limits: a window must be a whole number of slots and a limit at least 1');
      }
      const t = now();
      const slot = Math.floor(t / size);
      // The slots before this one that still overlap the window (the oldest whole), summed: they are closed, so they no longer change.
      const before = Array.from({ length: WINDOW_SLOTS }, (_, i) => idOf(scope, windowMs, slot - 1 - i, subject));
      const held = await db.get(`SELECT COALESCE(SUM(n), 0) AS n FROM az_chat_limits WHERE id IN (${before.map(() => '?').join(', ')})`, before);
      const room = limit - Number(held?.n ?? 0);
      if (room <= 0) return false;
      const id = idOf(scope, windowMs, slot, subject);
      const bump = () => db.run('UPDATE az_chat_limits SET n = n + 1 WHERE id = ? AND n < ?', [id, room]);
      if ((await bump()) === 1) return true;
      // The slot's first attempt anywhere: make its row (it counts until a whole window has passed after it), then take —
      // unless the table is at its cap, when a subject new to its slot waits for the sweep (fail closed).
      if (++made >= COUNT_EVERY) await recount();
      if (full) return false;
      await db.run(ensure, [id, (slot + 1) * size + windowMs]);
      return (await bump()) === 1;
    },
    async sweep() {
      const gone = await db.run('DELETE FROM az_chat_limits WHERE expires <= ?', [now()]);
      await recount();
      return gone;
    },
  };
}

export interface RateLimits {
  /** Count one attempt from `address` and, signed in, `account`; false when either is over a window. */
  take(address: string, account: string | null): Promise<boolean>;
}

/** The per-address and per-account windows of `scope` (`chat`, `share`, `tool`…), counted in `windows`. */
export function createRateLimits(windows: Windows, scope: string, perAddress: ChatRate, perAccount: ChatRate): RateLimits {
  const of = (rate: ChatRate): (readonly [number, number])[] => [
    ...(rate.hour ? [[rate.hour, HOUR_MS] as const] : []),
    ...(rate.day ? [[rate.day, DAY_MS] as const] : []),
  ];
  const address = of(perAddress);
  const account = of(perAccount);
  return {
    async take(ip, user) {
      // Shortest window first, stopping at the first refusal: an attempt the
      // hour refuses is not also charged to the day (or to the account).
      for (const [limit, ms] of address) if (!(await windows.take(`${scope}:address`, limit, ms, ip))) return false;
      if (user === null) return true;
      for (const [limit, ms] of account) if (!(await windows.take(`${scope}:account`, limit, ms, user))) return false;
      return true;
    },
  };
}

export interface Queue {
  /**
   * A slot to stream one answer in, or null: the queue is full, the wait
   * passed `waitMs`, or `signal` aborted (the visitor left). Call the
   * returned release exactly once.
   */
  enter(signal: AbortSignal): Promise<(() => void) | null>;
  readonly running: () => number;
  readonly waiting: () => number;
}

export function createQueue(concurrency: number, maxWaiting: number = concurrency * QUEUE_FACTOR, waitMs: number = QUEUE_WAIT_MS): Queue {
  let running = 0;
  const waiters: { go: () => void }[] = [];
  const release = () => {
    const next = waiters.shift();
    if (next) next.go(); else running--;
  };
  const slot = () => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  };
  return {
    running: () => running,
    waiting: () => waiters.length,
    enter(signal) {
      if (signal.aborted) return Promise.resolve(null);
      if (running < concurrency) {
        running++;
        return Promise.resolve(slot());
      }
      if (waiters.length >= maxWaiting) return Promise.resolve(null);
      return new Promise((done) => {
        const waiter = {
          // A finished answer hands its slot straight to the next in line.
          go: () => { clearTimeout(timer); signal.removeEventListener('abort', leave); done(slot()); },
        };
        const leave = () => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          clearTimeout(timer);
          signal.removeEventListener('abort', leave);
          done(null);
        };
        const timer = setTimeout(leave, waitMs);
        signal.addEventListener('abort', leave, { once: true });
        waiters.push(waiter);
      });
    },
  };
}
