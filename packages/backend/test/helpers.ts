/**
 * Test harness for the backend: a real HTTP server over in-memory SQLite, a
 * captured mailer, a controllable clock, and a local OpenID provider that
 * signs RS256 id_tokens with a rotatable key. Test-only.
 */

import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createApp } from '../src/server/app.ts';
import { migrateChat, usageReport } from '../src/server/chat-usage.ts';
import { createShareStore } from '../src/server/chat-share.ts';
import { migrate, openSqlite, type Db } from '../src/server/db.ts';
import { createData } from '../src/server/data-api.ts';
import type { Images } from '../src/server/data-images.ts';
import { migrateData, type DataStep } from '../src/server/data-migrate.ts';
import { ownedRowDeletes, type Table } from '../src/server/data-values.ts';
import { loadConfig, type Config } from '../src/server/env.ts';
import { createOidc } from '../src/server/oidc.ts';
import { createStore } from '../src/server/store.ts';
import type { Message } from '../src/server/email.ts';
import type { Tiles } from '../src/server/chat-tiles.ts';
import { SERVER_PACKAGES, serverImports } from '../src/emit.ts';

/** The server's own sources, as the CLI copies them into a site's server/src/. */
export const SERVER_SRC = fileURLToPath(new URL('../src/server/', import.meta.url));

/**
 * A server folder's sources as `az build` copies them (cli az.ts): the
 * server's own files that `keep` lets through, each chat package it imports
 * by alias into src/<name>/ (whole with a chat, else only `withoutChat`), and
 * a package.json that maps the aliases there — so a started server resolves
 * exactly what a generated one does.
 */
export function copyServer(dir: string, chat: boolean, keep: (src: string) => boolean = () => true): void {
  cpSync(SERVER_SRC, join(dir, 'src'), { recursive: true, filter: keep });
  for (const p of SERVER_PACKAGES) {
    const from = fileURLToPath(new URL(`../../${p.name}/src/`, import.meta.url));
    const files = readdirSync(from).filter((f) => f.endsWith('.ts') && (chat || p.withoutChat.includes(f)));
    if (files.length > 0) mkdirSync(join(dir, 'src', p.name), { recursive: true });
    for (const f of files) cpSync(join(from, f), join(dir, 'src', p.name, f));
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', imports: serverImports() }));
}

export const SITE = 'http://127.0.0.1:5173';
export const SECRET = randomBytes(32).toString('base64url');

export const listen = (server: Server) => new Promise<string>((done) =>
  server.listen(0, '127.0.0.1', () => done(`http://127.0.0.1:${(server.address() as { port: number }).port}`)));

export const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** A local OpenID provider: discovery, JWKS, authorize (auto-approves), token. */
export async function startIdp(opts: { email: string; verified: boolean; sub?: string }) {
  let key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  let kid = 'k1';
  const codes = new Map<string, { challenge: string; nonce: string; redirect: string }>();
  const tamper: { alg?: string; nonce?: string; iss?: string; aud?: string; exp?: number } = {};
  const user = { ...opts };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const json = (s: number, d: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(d));
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    }
    if (url.pathname === '/jwks') {
      return json(200, { keys: [{ ...(key.publicKey as KeyObject).export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }] });
    }
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) return json(400, { error: 'invalid_request' });
      const code = b64u(randomBytes(12));
      codes.set(code, { challenge: q.get('code_challenge')!, nonce: q.get('nonce') ?? '', redirect: q.get('redirect_uri')! });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state')!);
      return res.writeHead(302, { location: back.href }).end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const c of req) raw += c;
      const f = new URLSearchParams(raw);
      const grant = codes.get(f.get('code') ?? '');
      codes.delete(f.get('code') ?? '');
      const pkce = grant && b64u(createHash('sha256').update(f.get('code_verifier') ?? '').digest()) === grant.challenge;
      if (!grant || !pkce || f.get('client_secret') !== 'idp-secret' || f.get('redirect_uri') !== grant.redirect) return json(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: tamper.alg ?? 'RS256', kid, typ: 'JWT' };
      const payload = {
        iss: tamper.iss ?? issuer, aud: tamper.aud ?? 'idp-client', sub: user.sub ?? 'sub-1', email: user.email,
        email_verified: user.verified, nonce: tamper.nonce ?? grant.nonce, iat: now, exp: tamper.exp ?? now + 300, name: 'Provider Person',
      };
      const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
      const sig = header.alg === 'none' ? '' : b64u(sign('sha256', Buffer.from(input), key.privateKey));
      return json(200, { token_type: 'Bearer', id_token: `${input}.${sig}` });
    }
    return json(404, {});
  });
  const url = await listen(server);
  return {
    url, tamper, user,
    /** Rotate to a new signing key under a new kid (the old one disappears). */
    rotate() { key = generateKeyPairSync('rsa', { modulusLength: 2048 }); kid = `k${Number(kid.slice(1)) + 1}`; },
    close: () => server.close(),
  };
}

export interface Harness {
  readonly url: string;
  readonly mail: Message[];
  readonly clock: { now: number };
  readonly config: Config;
  readonly db: Db;
  close(): Promise<void>;
}

/**
 * Start a backend over in-memory SQLite. `env` extends a valid minimal
 * environment; `over` replaces the captured mailer or the silent log, and
 * `data` gives it tables (their steps applied, the /data routes mounted).
 */
export async function startBackend(
  env: Record<string, string> = {},
  over: {
    log?: (line: string) => void;
    mailer?: { send(m: Message): Promise<void> };
    data?: { tables: readonly Table[]; steps: readonly DataStep[] };
    /** AZ_ADMIN_EMAILS, already parsed (lower-cased). */
    admins?: readonly string[];
    /** Image storage, for tables with an image field, and its upload cap in bytes. */
    images?: Images;
    uploadLimit?: number;
    /** A site with chat: its tables made, and its usage report at GET /admin/chat (chat-block-spec §11.4). */
    chatUsage?: { readonly dailyTokens: number; readonly sharesEnabled: boolean };
    /** A chat that shows maps: its tile route (chat-block-spec §21.4.3). */
    tiles?: Tiles;
  } = {},
): Promise<Harness> {
  const clock = { now: Date.now() };
  const loaded = loadConfig({
    AZ_SESSION_SECRET: SECRET,
    AZ_BACKEND_PUBLIC_URL: 'http://127.0.0.1:9',          // replaced below once the port is known
    AZ_ALLOWED_ORIGINS: SITE,
    AZ_EMAIL_FROM: 'Studio <no-reply@studio.test>',
    AZ_SMTP_HOST: '127.0.0.1',
    AZ_SMTP_PORT: '2525',
    ...env,
  }, { database: 'sqlite', email: 'smtp' }, 'Studio');
  if (!loaded.ok) throw new Error(loaded.problems.join('\n'));
  const db = await openSqlite(':memory:');
  await migrate(db);
  if (over.data) await migrateData(db, over.data.steps, { confirm: Infinity });
  if (over.chatUsage) await migrateChat(db);
  const chatUsage = over.chatUsage;
  const mail: Message[] = [];
  let config = loaded.config;
  const server = createServer();
  const url = await listen(server);
  config = { ...config, publicUrl: url };
  const app = createApp({
    config,
    store: createStore(db, config.secret, () => clock.now, { idleMs: config.sessionIdleMs, maxMs: config.sessionMaxMs },
      over.data ? ownedRowDeletes(db.dialect, over.data.tables) : []),
    mailer: over.mailer ?? { send: async (m) => { mail.push(m); } },
    oidc: createOidc((...a) => fetch(...a), () => clock.now), now: () => clock.now, log: over.log ?? (() => {}),
    ...(over.data ? {
      data: createData({
        db, tables: over.data.tables, admins: over.admins ?? [], now: () => clock.now, publicUrl: url, ...(over.log ? { log: over.log } : {}),
        ...(over.images ? { images: over.images } : {}), ...(over.uploadLimit ? { uploadLimit: over.uploadLimit } : {}),
        ...(chatUsage ? {
          chatUsage: () => usageReport(db, chatUsage, clock.now),
          removeChatShare: (id: string) => createShareStore({ db, days: 30, max: 10_000, now: () => clock.now }).removeAny(id),
        } : {}),
      }),
    } : {}),
    ...(over.tiles ? { tiles: over.tiles } : {}),
  });
  server.on('request', (req, res) => { void app.handler(req, res); });
  return { url, mail, clock, config, db, close: async () => { server.close(); await db.close(); } };
}

/** A tiny cookie-keeping client, as a browser on SITE would be. */
export function client(base: string, origin = SITE) {
  const jar = new Map<string, string>();
  const keep = (r: Response) => {
    for (const c of r.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const [name, value] = [pair.slice(0, i), pair.slice(i + 1)];
      if (/Max-Age=0/i.test(c) || value === '') jar.delete(name); else jar.set(name, value);
    }
  };
  const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return {
    jar,
    async post(path: string, body: unknown, headers: Record<string, string> = {}) {
      const r = await fetch(`${base}${path}`, {
        method: 'POST', redirect: 'manual',
        headers: { origin, 'content-type': 'application/json', 'x-az-request': '1', cookie: cookieHeader(), ...headers },
        body: JSON.stringify(body),
      });
      keep(r);
      return r;
    },
    /** Any method, as the site's fetch would send it: JSON, the CSRF header, cookies. */
    async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      const r = await fetch(`${base}${path}`, {
        method, redirect: 'manual',
        headers: {
          origin, 'x-az-request': '1', cookie: cookieHeader(),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers,
        },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
      keep(r);
      return r;
    },
    /** Raw bytes, as the typed client's upload sends them. */
    async upload(method: string, path: string, bytes: Uint8Array, headers: Record<string, string> = {}) {
      const r = await fetch(`${base}${path}`, {
        method, redirect: 'manual',
        headers: { origin, 'x-az-request': '1', cookie: cookieHeader(), 'content-type': 'application/octet-stream', ...headers },
        body: bytes,
      });
      keep(r);
      return r;
    },
    async get(path: string, headers: Record<string, string> = {}) {
      const r = await fetch(`${base}${path}`, { redirect: 'manual', headers: { origin, cookie: cookieHeader(), ...headers } });
      keep(r);
      return r;
    },
    /** A top-level navigation: no Origin, no CSRF header, cookies sent. */
    async navigate(href: string) {
      const r = await fetch(href, { redirect: 'manual', headers: { cookie: cookieHeader() } });
      keep(r);
      return r;
    },
  };
}
