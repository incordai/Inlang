/**
 * @az server http
 * Purpose: the HTTP edge: JSON bodies, cookies, CORS, security headers, rate limits, client IP.
 * Spec: docs/backend-spec.md §5
 * Exports: readJson, readRaw, sendFile, cookie, corsHeaders, clientIp, createLimiter, requestListener, createBackendServer
 * Edit guide: trust X-Forwarded-For only by hop count; exact-origin CORS; cap limiter memory.
 * Tests: packages/backend/test/security.test.ts
 */

/**
 * The HTTP edge — bodies, cookies, CORS, security headers, rate limits
 * (auth-spec §3.4, backend-spec §5).
 *
 * Copied into a generated server; imports only node built-ins.
 */

import { createWriteStream } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** The largest request body read; auth bodies are a few hundred bytes. */
export const BODY_LIMIT = 16 * 1024;

export class BodyError extends Error {}

/** A JSON object body, or throws. Only `application/json` is read, at most `limit` bytes. */
export async function readJson(req: IncomingMessage, limit: number = BODY_LIMIT): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new BodyError('not json');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new BodyError('too large');
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

/**
 * A raw body streamed to a new file at `to`, at most `limit` bytes — refused
 * by its declared length before a byte is read, and counted while reading,
 * so an over-cap body never reaches the disk beyond `limit` (data-spec §8).
 * On any failure the partial file is removed; throws BodyError('too large')
 * for the cap. The file is created exclusively, readable only by the server.
 */
export async function readRaw(req: IncomingMessage, limit: number, to: string): Promise<void> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new BodyError('too large');
  let size = 0;
  const out = createWriteStream(to, { flags: 'wx', mode: 0o600 });
  try {
    await pipeline(req, async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        size += chunk.length;
        if (size > limit) throw new BodyError('too large');
        yield chunk;
      }
    }, out);
  } catch (e) {
    await rm(to, { force: true });
    if (e instanceof BodyError) throw e;
    throw new BodyError('aborted');
  }
}

/**
 * A stored file streamed back with the given headers over the security set;
 * a file gone since its row was read answers 404 like an absent row.
 */
export async function sendFile(res: ServerResponse, path: string, headers: Record<string, string>, cors: Record<string, string>): Promise<void> {
  let fh;
  try {
    fh = await open(path, 'r');
  } catch {
    return send(res, 404, { error: 'not_found' }, cors);
  }
  try {
    const { size } = await fh.stat();
    res.writeHead(200, { ...SECURITY_HEADERS, ...cors, ...headers, 'content-length': String(size) });
    await pipeline(fh.createReadStream({ autoClose: false }), res);
  } catch {
    // The client went away mid-file; nothing more can be sent.
    res.destroy();
  } finally {
    await fh.close();
  }
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

/**
 * CORS for one exact allowed origin — never `*`, which credentials forbid
 * anyway. The auth routes allow GET and POST; /data passes its wider set.
 */
export function corsHeaders(origin: string, methods = 'GET, POST'): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-credentials': 'true',
    'access-control-allow-headers': 'content-type, x-az-request',
    'access-control-allow-methods': methods,
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
 * The server's request listener. The handler answers its own failures; this
 * catch is the last line, so one request can never become an unhandled
 * rejection that ends the process — and its 500 goes through send(), with
 * the security set, like every other answer.
 */
export function requestListener(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  log: (line: string) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handle(req, res).catch((e: unknown) => {
      log(`request failed: ${(e as Error)?.name ?? 'Error'}`);
      if (!res.headersSent) send(res, 500, { error: 'unknown' }); else res.end();
    });
  };
}

/** The status Node itself answers each parser failure with; any other is a 400. */
const CLIENT_ERROR_STATUS: Readonly<Record<string, number>> = {
  HPE_HEADER_OVERFLOW: 431,
  HPE_CHUNK_EXTENSIONS_OVERFLOW: 413,
  ERR_HTTP_REQUEST_TIMEOUT: 408,
};

/** How long a refused connection may take to flush its answer before it is destroyed regardless. */
const CLIENT_ERROR_FLUSH_MS = 1_000;

/**
 * The raw answer to a request Node could not parse: a status line and the
 * security set, no body. Built from the error's code alone — nothing the
 * client sent is echoed.
 */
function clientErrorResponse(code: string | undefined): string {
  const status = (code === undefined ? undefined : CLIENT_ERROR_STATUS[code]) ?? 400;
  const headers = { ...SECURITY_HEADERS, 'content-length': '0', connection: 'close' };
  return `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}\r\n`;
}

/**
 * The backend's HTTP server. Requests go to requestListener; a request Node
 * cannot parse (a malformed request line, oversized headers, a timeout) is
 * answered by the 'clientError' listener, since Node's own answer to it
 * carries no security headers. There is no response object there, so the
 * answer is written raw to the socket (Node's documented pattern) — only
 * while the socket is writable and no response on it has begun, never on a
 * reset — and the socket is then destroyed.
 */
export function createBackendServer(
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  log: (line: string) => void,
): Server {
  const listener = requestListener(handle, log);
  // The responses still open on each connection: a raw answer written once
  // one of them has begun would corrupt the stream the client is reading.
  const inFlight = new WeakMap<Duplex, Set<ServerResponse>>();
  const server = createServer((req, res) => {
    const responses = inFlight.get(req.socket) ?? new Set<ServerResponse>();
    inFlight.set(req.socket, responses);
    responses.add(res);
    res.once('close', () => responses.delete(res));
    listener(req, res);
  });
  server.on('clientError', (err: NodeJS.ErrnoException, socket: Duplex) => {
    const begun = [...(inFlight.get(socket) ?? [])].some((res) => res.headersSent);
    if (err.code === 'ECONNRESET' || !socket.writable || begun) {
      socket.destroy();
      return;
    }
    const timer = setTimeout(() => socket.destroy(), CLIENT_ERROR_FLUSH_MS);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    socket.end(clientErrorResponse(err.code), () => socket.destroy());
  });
  return server;
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
