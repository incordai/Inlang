/**
 * @az server http
 * Purpose: the HTTP edge: JSON bodies, cookies, CORS, security headers, rate limits, client IP.
 * Spec: docs/backend-spec.md §5
 * Exports: readJson, cookie, corsHeaders, clientIp, createLimiter
 * Edit guide: trust X-Forwarded-For only by hop count; exact-origin CORS; cap limiter memory.
 * Tests: packages/backend/test/security.test.ts
 */

/**
 * The HTTP edge — bodies, cookies, CORS, security headers, rate limits
 * (auth-spec §3.4, backend-spec §5).
 *
 * Copied into a generated server; imports only node built-ins.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';

/** The largest request body read; auth bodies are a few hundred bytes. */
export const BODY_LIMIT = 16 * 1024;

export class BodyError extends Error {}

/** A JSON object body, or throws. Only `application/json` is read. */
export async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new BodyError('not json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new BodyError('too large');
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new BodyError('bad json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BodyError('not an object');
  return parsed as Record<string, unknown>;
}

export function readCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export interface CookieOptions {
  readonly maxAgeSeconds?: number;
  readonly path?: string;
  readonly sameSite: 'Lax' | 'None' | 'Strict';
}

/** Always HttpOnly and Secure (auth-spec §3.4). */
export function cookie(name: string, value: string, o: CookieOptions): string {
  return [
    `${name}=${value}`, 'HttpOnly', 'Secure', `Path=${o.path ?? '/'}`, `SameSite=${o.sameSite}`,
    ...(o.maxAgeSeconds !== undefined ? [`Max-Age=${o.maxAgeSeconds}`] : []),
  ].join('; ');
}

/** On every response: nothing here is a page, and nothing may be cached or framed. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'strict-transport-security': 'max-age=31536000',
  'cross-origin-resource-policy': 'same-site',
};

/** CORS for one exact allowed origin — never `*`, which credentials forbid anyway. */
export function corsHeaders(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type, x-az-request',
    'access-control-allow-methods': 'GET, POST',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string | string[]> = {}): void {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    ...(text ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    ...headers,
  });
  res.end(text);
}

export function redirect(res: ServerResponse, to: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(302, { ...SECURITY_HEADERS, location: to, ...headers });
  res.end();
}

/**
 * The client's address for rate limiting.
 *
 * With `hops` 0 the socket peer is the client. Behind `hops` proxies you
 * control, the address is the one the OUTERMOST trusted proxy appended —
 * `hops` entries from the right of X-Forwarded-For. Proxies append; they do
 * not replace. The left-most entry is whatever the client sent, so reading
 * it let every request pick its own limit bucket. Anything that is not an
 * IP address falls back to the socket peer.
 */
export function clientIp(req: IncomingMessage, hops: number): string {
  if (hops > 0) {
    const entries = String(req.headers['x-forwarded-for'] ?? '').split(',').map((e) => e.trim()).filter(Boolean);
    const candidate = entries[entries.length - hops];
    if (candidate && isIP(candidate)) return candidate;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** The eight groups of an IPv6 address, as numbers. Only called after `isIP(...) === 6`. */
function groups6(ip: string): number[] {
  let s = ip.split('%')[0].toLowerCase();
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = `${s.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array<string>(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16));
}

/**
 * The bucket an address counts against. A single subscriber is routinely
 * given a whole IPv6 /64, so counting per /128 gave one attacker 2^64
 * buckets; an IPv6 address counts as its /64. An IPv4-mapped IPv6 address
 * is its IPv4 address.
 */
export function rateKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (isIP(ip) !== 6) return ip;
  return `${groups6(ip).slice(0, 4).map((g) => g.toString(16)).join(':')}::/64`;
}

/** The most keys one limiter holds; past it the least recently seen are dropped. */
export const LIMITER_MAX_KEYS = 50_000;

/**
 * A sliding-window limiter, in memory. One process: behind several
 * instances, each keeps its own count (backend-spec §5 says so plainly).
 *
 * Bounded: at `maxKeys` it first sweeps expired keys, then drops the least
 * recently seen. Without the bound, a flood of distinct addresses grew the
 * map by a key per request until the next sweep.
 */
export function createLimiter(limit: number, windowMs: number, now: () => number = Date.now, maxKeys = LIMITER_MAX_KEYS) {
  const hits = new Map<string, number[]>();
  const sweep = (): void => {
    const t = now();
    for (const [k, v] of hits) if (v.every((x) => t - x >= windowMs)) hits.delete(k);
  };
  return {
    /** Record an attempt; false when the key is over its limit. */
    take(key: string): boolean {
      const t = now();
      const seen = hits.get(key);
      if (!seen && hits.size >= maxKeys) {
        sweep();
        // Map order is insertion order, and every take re-inserts its key:
        // the first key is the least recently seen.
        while (hits.size >= maxKeys) hits.delete(hits.keys().next().value as string);
      }
      const recent = (seen ?? []).filter((x) => t - x < windowMs);
      hits.delete(key);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
    /** Forget old keys. Also called on a timer. */
    sweep,
    size: () => hits.size,
  };
}
