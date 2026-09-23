/**
 * The HTTP edge — bodies, cookies, CORS, security headers, rate limits
 * (auth-spec §3.4, backend-spec §5).
 *
 * Copied into a generated server; imports only node built-ins.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

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
 * The client's address for rate limiting. X-Forwarded-For is believed only
 * when AZ_TRUST_PROXY says a proxy you control sets it — otherwise any
 * visitor could pick their own limit bucket.
 */
export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const first = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * A sliding-window limiter, in memory. One process: behind several
 * instances, each keeps its own count (backend-spec §5 says so plainly).
 */
export function createLimiter(limit: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return {
    /** Record an attempt; false when the key is over its limit. */
    take(key: string): boolean {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(t);
      hits.set(key, recent);
      return true;
    },
    /** Forget old keys, so the map cannot grow without bound. */
    sweep(): void {
      const t = now();
      for (const [k, v] of hits) if (v.every((x) => t - x >= windowMs)) hits.delete(k);
    },
  };
}
