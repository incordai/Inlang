/**
 * @az server chat-limits
 * Purpose: the chat's cost bounds besides the budget: per-address and per-account message windows, and the answer queue.
 * Spec: docs/backend-spec.md §5 (the chat block spec §6.5)
 * Exports: createRateLimits, createQueue, RateLimits, Queue, HOUR_MS, DAY_MS, QUEUE_WAIT_MS, QUEUE_FACTOR
 * Edit guide: reuse http.ts createLimiter (bounded keys); a queued request never waits past QUEUE_WAIT_MS; every slot taken is released.
 * Tests: packages/backend/test/chat-limits.test.ts
 */

/**
 * Who may ask how often, and how many answers stream at once (chat-spec
 * §6.5). The windows reuse the backend's sliding-window limiter, so an
 * address counts as its /64 and a flood of addresses cannot grow memory
 * past LIMITER_MAX_KEYS per window. Counted per process: behind several
 * instances, limit at the proxy too (the budget table is shared).
 *
 * Copied into a generated server; imports only its siblings.
 */

import type { ChatRate } from './env.ts';
import { createLimiter, LIMITER_MAX_KEYS } from './http.ts';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
/** The longest a request waits for a free answer slot before `busy`. */
export const QUEUE_WAIT_MS = 10_000;
/** The queue holds this many times the concurrency (16 waiting at the default 4). */
export const QUEUE_FACTOR = 4;

type Limiter = ReturnType<typeof createLimiter>;

export interface RateLimits {
  /** Count one message from `address` and, signed in, `account`; false when either is over a window. */
  take(address: string, account: string | null): boolean;
  sweep(): void;
  /** Keys held, per window — bounded by LIMITER_MAX_KEYS each. */
  sizes(): number[];
}

function windows(rate: ChatRate, now: () => number, maxKeys: number): Limiter[] {
  return [
    ...(rate.hour ? [createLimiter(rate.hour, HOUR_MS, now, maxKeys)] : []),
    ...(rate.day ? [createLimiter(rate.day, DAY_MS, now, maxKeys)] : []),
  ];
}

export function createRateLimits(
  perAddress: ChatRate, perAccount: ChatRate, now: () => number = Date.now, maxKeys = LIMITER_MAX_KEYS,
): RateLimits {
  const address = windows(perAddress, now, maxKeys);
  const account = windows(perAccount, now, maxKeys);
  return {
    take(ip, user) {
      // Shortest window first, stopping at the first refusal: a message the
      // hour refuses is not also charged to the day (or to the account).
      return address.every((l) => l.take(ip)) && (user === null || account.every((l) => l.take(user)));
    },
    sweep() {
      for (const l of [...address, ...account]) l.sweep();
    },
    sizes: () => [...address, ...account].map((l) => l.size()),
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
