/**
 * @az server app
 * Purpose: the azbackend routes exactly: sign-in/up, link, reset, password, session, providers, oauth; the /data, /admin, /chat and /tiles edge.
 * Spec: docs/auth-block-spec.md §3.4 · docs/backend-spec.md §5 · docs/data-spec.md §5.4 · docs/chat-block-spec.md §21.4.3
 * Exports: createApp, isEmail, isSitePath, COOKIE_NAMES, DataRequest, DataRoutes, DataResult, DataFile, ChatRequest, ChatRoutes
 * Edit guide: same answer for unknown account and wrong password; rate-limit before hashing; claim unverified accounts safely.
 * Tests: packages/backend/test/backend.test.ts, packages/backend/test/security.test.ts, packages/backend/test/data-api.test.ts, packages/backend/test/chat-route.test.ts
 */

/**
 * The routes — auth-spec §3.4, the azbackend protocol, exactly.
 *
 * Two kinds of request reach this server. FETCHES from the site (everything
 * under /auth except the three below) must come from an allowed origin, and
 * a POST must carry `x-az-request: 1`; a forged form on another site can do
 * neither. NAVIGATIONS — provider start and callback, and the emailed
 * sign-in link — arrive with no Origin and no custom header, and are
 * protected instead by the origin allow-list, single-use state, PKCE,
 * nonce and single-use tokens.
 *
 * Errors are only ever codes from the closed set; nothing here writes a
 * message meant for a person onto the page.
 *
 * Copied into a generated server; imports only its siblings and node built-ins.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { keepsAccounts, type Config, type Provider } from './env.ts';
import { decoyHash, hashPassword, MAX_PASSWORD, MIN_PASSWORD, pkceChallenge, randomToken, safeEqual, verifyPassword } from './crypto.ts';
import { linkMessage, resetMessage, type Mailer } from './email.ts';
import { BodyError, clientIp, cookie, corsHeaders, createLimiter, rateKey, readCookies, readJson, readRaw, redirect, send, sendFile } from './http.ts';
import { ProviderError, type Oidc } from './oidc.ts';
import { normaliseEmail, OAUTH_STATE_TTL_MS, TOKEN_TTL_MS, type Store, type User } from './store.ts';
import type { Tiles } from './chat-tiles.ts';

/**
 * Cookie names. In production every cookie is Secure, so the session takes
 * the `__Host-` prefix (Secure, Path=/, no Domain — a sibling subdomain can
 * neither set nor shadow it) and the path-scoped ones `__Secure-`. The
 * prefixes need Secure, which `az dev` drops on loopback, so it passes
 * `plainCookieNames` and gets the bare names.
 */
export const COOKIE_NAMES = {
  secure: { session: '__Host-az_session', state: '__Secure-az_oauth_state', link: '__Secure-az_link' },
  plain: { session: 'az_session', state: 'az_oauth_state', link: 'az_link' },
} as const;
const MAX_NAME = 200;
const MAX_LOCATION = 200;
const MAX_EMAIL = 254;
const MAX_LOCAL = 64;
/** The subject column's size; a longer provider id cannot be stored. */
const MAX_SUBJECT = 255;
const MAX_NEXT = 2048;
const MINUTE = 60 * 1000;
const NAV_BASE = 'https://site.invalid';

/** A /data request as the data routes see it (data-api.ts); the edge checks are done. */
export interface DataRequest {
  readonly method: string;
  readonly url: URL;
  /** The rate-limit key of the client's address. */
  readonly ip: string;
  /** The signed-in account's id, or null. */
  user(): Promise<string | null>;
  /** The signed-in account's id, address and whether it is verified — for the admin check. */
  account(): Promise<{ id: string; email: string; verified: boolean } | null>;
  /** The JSON body, at most `limit` bytes; throws BodyError. */
  body(limit: number): Promise<Record<string, unknown>>;
  /** The raw body streamed to a new file at `to`, at most `limit` bytes; throws BodyError (data-spec §8). */
  upload(limit: number, to: string): Promise<void>;
}

/**
 * A stored image to stream back (data-spec §8). `shared`: anyone may read it
 * and the URL names this exact upload, so caches and other sites may keep it.
 */
export interface DataFile { readonly path: string; readonly type: string; readonly shared: boolean }

export type DataResult = { status: number; body?: unknown; file?: DataFile };

/** The data tables' routes — present only when the site declares data. */
export interface DataRoutes {
  handle(req: DataRequest): Promise<DataResult>;
  sweep(): void;
}

/** A POST /chat as the chat route sees it (chat.ts); the edge checks are done. */
export interface ChatRequest {
  /** The rate-limit key of the client's address. */
  readonly ip: string;
  /** The CORS headers every answer to this request carries. */
  readonly cors: Record<string, string>;
  /** The signed-in account's id, or null. Used for limits only — never sent to a model. */
  user(): Promise<string | null>;
  /** The JSON body (16 KB cap unless `limit` says otherwise); throws BodyError. */
  body(limit?: number): Promise<Record<string, unknown>>;
  /** Aborts when the client goes away before the answer has ended. */
  readonly closed: AbortSignal;
}

/** The chat route — present only when a page shows a chat (chat.ts, copied only then). */
export interface ChatRoutes {
  handle(req: ChatRequest, res: ServerResponse): Promise<void>;
  /** Forget this process's own limiter keys (a share's reads and deletes); also on the sweep timer. */
  sweep(): void;
  /** Remove usage rows past their retention, expired shares and spent rate-limit slots; how many went. */
  prune(): Promise<number>;
  /** Share links (chat-block-spec §20.7): POST /chat/share, GET and DELETE /chat/share/<id>. */
  readonly shares?: {
    create(req: ChatRequest, res: ServerResponse): Promise<void>;
    read(id: string, req: ChatRequest, res: ServerResponse): Promise<void>;
    remove(id: string, req: ChatRequest, res: ServerResponse): Promise<void>;
  };
}

/** `/chat/share` and `/chat/share/<id>` (chat-block-spec §20.7); the id's own shape is the share route's check. */
const SHARE_PATH = /^\/chat\/share(?:\/([^/]{1,64}))?$/;

/** `GET /data/<t>/<id>/<field>` and its admin twin: an image, loaded by `<img>`, which sends no Origin. */
const IMAGE_GET = /^\/(?:admin\/)?data\/[^/]+\/[^/]+\/[^/]+$/;

/**
 * data-spec §8: a stored image is inert wherever it is opened. It always
 * varies by Origin: an `<img>` load (no Origin, no CORS headers) cached
 * publicly must never answer a later `fetch()` from the site.
 */
function imageHeaders(file: DataFile): Record<string, string> {
  return {
    vary: 'Origin',
    'content-type': file.type,
    'content-disposition': 'inline',
    'content-security-policy': "default-src 'none'; sandbox",
    'cache-control': file.shared ? 'public, max-age=31536000, immutable' : 'private, no-store',
    'cross-origin-resource-policy': file.shared ? 'cross-origin' : 'same-site',
  };
}

/** The maps' tiles, glyphs and sprites (chat-block-spec §21.4.3), served by chat-tiles.ts under this prefix. */
const TILES_PATH = '/tiles/';

/**
 * The tiles' CORS for one exact allowed origin (§21.4.3): GET and HEAD, the
 * tile reader's `range` and `if-match` allowed, `etag` and `content-range`
 * exposed so it can tell the archive's version and size. No credentials: the
 * tiles are public data, fetched with no cookie.
 */
function tilesCors(origin: string): Record<string, string> {
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'range, if-match',
    'access-control-allow-methods': 'GET, HEAD',
    'access-control-expose-headers': 'etag, content-range',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

/** data-spec §5.4: /data is a fetch route with the wider method set. */
const DATA_METHODS = 'GET, POST, PATCH, PUT, DELETE';

export interface AppDeps {
  readonly config: Config;
  readonly store: Store;
  /**
   * How a server that keeps accounts mails its links, and asks providers.
   * Both are required then (createApp refuses without them); a server
   * without accounts (no `email`, chat-block-spec §19.15) has neither, and
   * its /auth routes answer 404 like any unknown path.
   */
  readonly mailer?: Mailer;
  readonly oidc?: Oidc;
  /** The /data routes (data-spec §5); absent, /data is 404 like any unknown path. */
  readonly data?: DataRoutes;
  /** POST /chat (docs/chat-block-spec.md §4.2); absent, /chat is 404 like any unknown path. */
  readonly chat?: ChatRoutes;
  /** GET /tiles/… (chat-block-spec §21.4.3), only when a chat shows maps; absent, 404 like any unknown path. */
  readonly tiles?: Tiles;
  readonly now?: () => number;
  /** Operational log. Never passed a password, token, secret or address. */
  readonly log?: (line: string) => void;
  /** `az dev` only: cookies go out without Secure, so they cannot carry a prefix. */
  readonly plainCookieNames?: boolean;
}

type Json = Record<string, unknown>;

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : null;

const LOCAL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * A plain address: a dot-atom local part, and a domain of at least two DNS
 * labels. No quoted local parts, comments or display names — the address is
 * handed to a mail library, which would read `x<victim@corp.example>` as a
 * name plus a different recipient. Delivery is still the real check.
 */
export function isEmail(v: string): boolean {
  if (v.length > MAX_EMAIL) return false;
  const at = v.lastIndexOf('@');
  if (at < 1) return false;
  const local = v.slice(0, at);
  const labels = v.slice(at + 1).split('.');
  return local.length <= MAX_LOCAL && LOCAL.test(local) && labels.length >= 2 && labels.every((l) => LABEL.test(l));
}

/**
 * A path on the site, already in its normal form. Resolved the way a
 * browser would resolve it, it must stay on the site and come out unchanged:
 * `/.//host`, `/..//host` and `/%2e//host` all resolve to `//host`, which a
 * browser then reads as another host.
 */
export function isSitePath(v: string): boolean {
  if (v.length > MAX_NEXT || !v.startsWith('/') || v.startsWith('//') || /[\\\s]/.test(v)) return false;
  if (/%2e/i.test(v)) return false;
  try {
    const u = new URL(v, NAV_BASE);
    return u.origin === NAV_BASE && !u.pathname.startsWith('//') && `${u.pathname}${u.search}${u.hash}` === v;
  } catch {
    return false;
  }
}

/** The request's URL, or null when the URL parser rejects it (`//`, `//[`). */
function pathOf(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', 'http://backend.invalid');
  } catch {
    return null;
  }
}

/** An error's class and code — never its message, which can quote an address or a provider's reply. */
const errorClass = (e: unknown) => {
  const err = e as { name?: unknown; code?: unknown };
  return `${typeof err?.name === 'string' ? err.name : 'Error'}${typeof err?.code === 'string' ? ` ${err.code}` : ''}`;
};

/**
 * A provider failure for the log. ProviderError messages are fixed text this
 * server wrote (a host and a status at most); anything else — a JSON parse
 * error quoting the provider's body, a network error — is logged by class.
 */
const providerProblem = (e: unknown) => (e instanceof ProviderError ? e.message : errorClass(e));

const view = (u: User, expiresAt: number) => ({
  user: { id: u.id, email: u.email, name: u.name, ...(u.location ? { location: u.location } : {}) },
  expiresAt,
});

export function createApp(deps: AppDeps) {
  const { config, store } = deps;
  const accounts = keepsAccounts(config.setup);
  if (accounts && (!deps.mailer || !deps.oidc)) throw new Error('createApp: a server that keeps accounts needs its mailer and provider client');
  // Undefined exactly when the server keeps no accounts: its sign-in routes are then never reached.
  const mailer = accounts ? deps.mailer : undefined;
  const oidc = accounts ? deps.oidc : undefined;
  const names = deps.plainCookieNames ? COOKIE_NAMES.plain : COOKIE_NAMES.secure;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const allowed = new Set(config.allowedOrigins);
  const home = config.allowedOrigins[0];

  const limits = {
    signInIp: createLimiter(20, 15 * MINUTE, now),
    signInAccount: createLimiter(10, 15 * MINUTE, now),
    mailIp: createLimiter(10, 15 * MINUTE, now),
    mailAccount: createLimiter(3, 15 * MINUTE, now),
    signUpIp: createLimiter(10, 60 * MINUTE, now),
    passwordIp: createLimiter(20, 15 * MINUTE, now),
    navigationIp: createLimiter(30, 10 * MINUTE, now),
  };
  const sweep = () => {
    for (const l of Object.values(limits)) l.sweep();
    deps.data?.sweep();
    deps.chat?.sweep();
  };

  const sessionCookie = (token: string) =>
    cookie(names.session, token, { sameSite: config.sameSite, maxAgeSeconds: Math.floor(config.sessionMaxMs / 1000) });
  const clearSession = cookie(names.session, '', { sameSite: config.sameSite, maxAgeSeconds: 0 });
  const clearState = cookie(names.state, '', { sameSite: 'Lax', path: '/auth/oauth', maxAgeSeconds: 0 });
  const clearLink = cookie(names.link, '', { sameSite: config.sameSite, path: '/auth/link', maxAgeSeconds: 0 });

  /** A new session for `user`, replacing whatever session the request carried (rotation). */
  async function startSession(req: IncomingMessage, user: User): Promise<{ header: string; body: Json }> {
    const old = readCookies(req).get(names.session);
    if (old) await store.deleteSession(old);
    const s = await store.createSession(user.id);
    return { header: sessionCookie(s.token), body: { session: view(user, s.expiresAt) } };
  }

  function sendMail(mail: Mailer, what: string, message: Parameters<Mailer['send']>[0]): void {
    // Not awaited: a known and an unknown address answer at the same speed.
    mail.send(message).catch((e: unknown) => log(`email (${what}) failed: ${errorClass(e)}`));
  }

  /* ---- fetch routes --------------------------------------------------- */

  async function signIn(req: IncomingMessage, body: Json, ip: string) {
    const email = text(body.email, MAX_EMAIL);
    const password = typeof body.password === 'string' && body.password.length <= MAX_PASSWORD ? body.password : null;
    if (!email || !password) return { status: 400, body: { error: 'invalid_credentials' } };
    if (!limits.signInIp.take(ip) || !limits.signInAccount.take(normaliseEmail(email))) {
      return { status: 429, body: { error: 'rate_limited' } };
    }
    const user = await store.userByEmail(email);
    // Unknown account, or one with no password (provider-only): verify
    // against a decoy so both answers take the same scrypt time.
    const result = await verifyPassword(password, user?.passwordHash ?? await decoyHash());
    if (!user || !user.passwordHash || !result.ok) return { status: 401, body: { error: 'invalid_credentials' } };
    if (result.rehash) await store.setPassword(user.id, await hashPassword(password));
    const s = await startSession(req, user);
    return { status: 200, body: s.body, cookies: [s.header] };
  }

  function passwordProblem(password: unknown, confirm: unknown): Json | null {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
      return { error: 'weak_password', field: 'password' };
    }
    if (typeof confirm !== 'string' || !safeEqual(password, confirm)) {
      return { error: 'password_mismatch', field: 'passwordConfirm' };
    }
    return null;
  }

  async function signUp(req: IncomingMessage, body: Json, ip: string) {
    if (!limits.signUpIp.take(ip)) return { status: 429, body: { error: 'rate_limited' } };
    const name = text(body.name, MAX_NAME);
    if (!name) return { status: 400, body: { error: 'unknown', field: 'name' } };
    const email = text(body.email, MAX_EMAIL);
    if (!email || !isEmail(email)) return { status: 400, body: { error: 'unknown', field: 'email' } };
    // §3.4: the server re-checks the retype — the form's check is a convenience.
    const bad = passwordProblem(body.password, body.passwordConfirm);
    if (bad) return { status: 400, body: bad };
    let location: string | null = null;
    if (body.location !== undefined && body.location !== '') {
      location = text(body.location, MAX_LOCATION);
      if (!location) return { status: 400, body: { error: 'unknown', field: 'location' } };
    }
    const created = await store.createUser({ email, name, passwordHash: await hashPassword(body.password as string), location, verified: false });
    if (created === 'taken') return { status: 409, body: { error: 'email_taken', field: 'email' } };
    const s = await startSession(req, created);
    return { status: 200, body: s.body, cookies: [s.header] };
  }

  /**
   * `/link` and `/reset`: the same answer for every address (§3.4 checklist 5).
   * A link request also binds the link to THIS browser: a random value in a
   * cookie, its digest on the token. The cookie is set whether or not the
   * address has an account, so the answers stay identical.
   */
  async function mailRequest(mail: Mailer, kind: 'link' | 'reset', body: Json, ip: string, site: string) {
    const email = text(body.email, MAX_EMAIL);
    if (!limits.mailIp.take(ip) || (email && !limits.mailAccount.take(`${kind}:${normaliseEmail(email)}`))) {
      return { status: 429, body: { error: 'rate_limited' } };
    }
    const binding = kind === 'link' ? randomToken() : undefined;
    const cookies = binding
      ? [cookie(names.link, binding, { sameSite: config.sameSite, path: '/auth/link', maxAgeSeconds: Math.floor(TOKEN_TTL_MS.link / 1000) })]
      : undefined;
    if (email && isEmail(email)) {
      const user = await store.userByEmail(email);
      if (user) {
        const token = await store.createToken(user.id, kind, site, binding);
        if (kind === 'reset') {
          const url = new URL(config.resetPath, site);
          url.searchParams.set('token', token);
          url.searchParams.set('email', user.email);
          sendMail(mail, 'reset', resetMessage(config.siteName, user.email, url.href));
        } else {
          const url = new URL(`${config.publicUrl}/auth/link/verify`);
          url.searchParams.set('token', token);
          sendMail(mail, 'link', linkMessage(config.siteName, user.email, url.href));
        }
      }
    }
    return { status: 200, body: {}, ...(cookies ? { cookies } : {}) };
  }

  async function setPassword(req: IncomingMessage, body: Json, ip: string) {
    if (!limits.passwordIp.take(ip)) return { status: 429, body: { error: 'rate_limited' } };
    const token = text(body.token, 128);
    if (!token) return { status: 400, body: { error: 'expired_token' } };
    // Checked BEFORE the token is spent, so a mistyped retype does not burn the link.
    const bad = passwordProblem(body.password, body.passwordConfirm);
    if (bad) return { status: 400, body: bad };
    const spent = await store.spendToken(token, 'reset');
    if (spent === 'expired') return { status: 400, body: { error: 'expired_token' } };
    const user = await store.userById(spent.userId);
    if (!user) return { status: 400, body: { error: 'expired_token' } };
    await store.setPassword(user.id, await hashPassword(body.password as string));
    await store.markVerified(user.id);          // the reset link proved the mailbox
    await store.deleteUserSessions(user.id);    // every other session ends
    const s = await startSession(req, { ...user, emailVerified: true });
    return { status: 200, body: s.body, cookies: [s.header] };
  }

  async function sessionRead(req: IncomingMessage) {
    const token = readCookies(req).get(names.session);
    if (!token) return { status: 200, body: { session: null } };
    const found = await store.sessionUser(token);
    if (!found) return { status: 200, body: { session: null }, cookies: [clearSession] };
    return { status: 200, body: { session: view(found.user, found.expiresAt) } };
  }

  async function signOut(req: IncomingMessage) {
    const token = readCookies(req).get(names.session);
    if (token) await store.deleteSession(token);          // ended on the server, not just forgotten
    return { status: 204, body: undefined, cookies: [clearSession] };
  }

  /* ---- navigation routes ---------------------------------------------- */

  const failTo = (site: string, code: string) => `${site}/login?auth_error=${code}`;

  /**
   * The emailed sign-in link. It spends only with the binding cookie of the
   * browser that asked for it — otherwise anyone could mail themselves a
   * link and make a victim open it, signing the victim into the attacker's
   * account (login CSRF).
   */
  async function linkVerify(req: IncomingMessage, res: ServerResponse, url: URL) {
    const token = url.searchParams.get('token') ?? '';
    const binding = readCookies(req).get(names.link);
    const spent = token && binding ? await store.spendToken(token, 'link', binding) : 'expired';
    if (spent === 'expired' || !allowed.has(spent.site)) {
      return redirect(res, failTo(home, 'expired_token'), { 'set-cookie': clearLink });
    }
    const user = await store.userById(spent.userId);
    if (!user) return redirect(res, failTo(spent.site, 'expired_token'), { 'set-cookie': clearLink });
    // The mailbox is proven: an unverified account's password and sessions,
    // which anyone could have set up, are dropped (claimUnverified).
    if (!user.emailVerified) await store.claimUnverified(user.id);
    const s = await startSession(req, { ...user, emailVerified: true });
    return redirect(res, `${spent.site}${config.linkLanding}`, { 'set-cookie': [s.header, clearLink] });
  }

  async function oauthStart(oidc: Oidc, res: ServerResponse, p: Provider, url: URL) {
    const site = url.searchParams.get('site') ?? '';
    const next = url.searchParams.get('next') ?? '/';
    // §3.4: `site` must be an allowed origin and `next` a path on it, or 400.
    if (!allowed.has(site) || !isSitePath(next)) return send(res, 400, { error: 'unknown' });
    let d;
    try {
      d = await oidc.discover(p);
    } catch (e) {
      log(`provider ${p.id} discovery failed: ${providerProblem(e)}`);
      return redirect(res, failTo(site, 'oauth_failed'));
    }
    const state = randomToken();
    const verifier = randomToken();
    const nonce = randomToken();
    await store.putOAuthState(state, { provider: p.id, verifier, nonce, next, site });
    const auth = new URL(d.authorizationEndpoint);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('client_id', p.clientId);
    auth.searchParams.set('redirect_uri', `${config.publicUrl}/auth/oauth/${p.id}/callback`);
    auth.searchParams.set('scope', p.scopes);
    auth.searchParams.set('state', state);
    auth.searchParams.set('code_challenge', pkceChallenge(verifier));
    auth.searchParams.set('code_challenge_method', 'S256');
    if (p.type === 'oidc') auth.searchParams.set('nonce', nonce);
    return redirect(res, auth.href, {
      'set-cookie': cookie(names.state, state, { sameSite: 'Lax', path: '/auth/oauth', maxAgeSeconds: Math.floor(OAUTH_STATE_TTL_MS / 1000) }),
    });
  }

  async function oauthCallback(oidc: Oidc, req: IncomingMessage, res: ServerResponse, p: Provider, url: URL) {
    const state = url.searchParams.get('state') ?? '';
    const bound = readCookies(req).get(names.state) ?? '';
    // The state must be the one THIS browser was given, and unused.
    const trip = state && bound && safeEqual(state, bound) ? await store.takeOAuthState(state) : null;
    const back = (code: string) => redirect(res, failTo(trip?.site ?? home, code), { 'set-cookie': clearState });
    if (!trip || trip.provider !== p.id || url.searchParams.has('error')) return back('oauth_failed');
    const code = url.searchParams.get('code');
    if (!code) return back('oauth_failed');

    let subject: string;
    let email: string;
    let verified: boolean;
    let displayName: string;
    try {
      const d = await oidc.discover(p);
      const tokens = await oidc.exchange(p, d, code, trip.verifier, `${config.publicUrl}/auth/oauth/${p.id}/callback`);
      if (p.type === 'oidc') {
        if (typeof tokens.id_token !== 'string') return back('oauth_failed');
        const claims = await oidc.verifyIdToken(p, d, tokens.id_token, trip.nonce);
        subject = String(claims.sub);
        email = typeof claims.email === 'string' ? claims.email : '';
        verified = claims.email_verified === true;
        displayName = typeof claims.name === 'string' ? claims.name : '';
      } else {
        if (typeof tokens.access_token !== 'string' || !d.userinfoEndpoint) return back('oauth_failed');
        const profile = await oidc.userinfo(d.userinfoEndpoint, tokens.access_token);
        const sub = profile.sub ?? profile.id;
        subject = typeof sub === 'string' || typeof sub === 'number' ? String(sub) : '';
        email = typeof profile[p.emailField] === 'string' ? profile[p.emailField] as string : '';
        verified = profile[p.verifiedField] === true;   // absent = unverified, never links
        displayName = typeof profile.name === 'string' ? profile.name : '';
      }
    } catch (e) {
      log(`provider ${p.id} sign-in failed: ${providerProblem(e)}`);
      return back('oauth_failed');
    }
    // Values the columns cannot hold are a failed sign-in, not a server error.
    if (!subject || subject.length > MAX_SUBJECT || email.length > MAX_EMAIL) return back('oauth_failed');

    let user: User | null = null;
    const linked = await store.oauthAccount(p.id, subject);
    if (linked) user = await store.userById(linked);
    if (!user) {
      // Accounts link by VERIFIED email only (§3.4).
      if (!verified || !email || !isEmail(email)) return back('email_unverified');
      user = await store.userByEmail(email);
      if (!user) {
        if (!config.oauthSignup) return back('oauth_failed');
        const created = await store.createUser({
          email, name: text(displayName, MAX_NAME) ?? email.split('@')[0], passwordHash: null, location: null, verified: true,
        });
        if (created === 'taken') return back('oauth_failed');
        user = created;
      } else if (!user.emailVerified) {
        // The provider vouches for the address; whoever created this
        // unverified account may not own it. Their password and sessions go.
        await store.claimUnverified(user.id);
        user = { ...user, passwordHash: null, emailVerified: true };
      }
      await store.linkOAuth(p.id, subject, user.id);
    }
    const s = await startSession(req, user);
    return redirect(res, `${trip.site}${trip.next}`, { 'set-cookie': [s.header, clearState] });
  }

  /* ---- dispatch ------------------------------------------------------- */

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // `GET //` is a valid request line the URL parser rejects; answered, not thrown.
    const url = pathOf(req);
    if (!url) return send(res, 400, { error: 'unknown' });
    const method = req.method ?? 'GET';
    const ip = rateKey(clientIp(req, config.proxyHops));

    if (method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });

    const nav = /^\/auth\/oauth\/([a-z0-9][a-z0-9-]{0,62})\/(start|callback)$/.exec(url.pathname);
    // A server without accounts has no sign-in at all: every /auth path is unknown to it.
    if (oidc && (nav || url.pathname === '/auth/link/verify')) {
      if (method !== 'GET') return send(res, 405, { error: 'unknown' });
      if (!limits.navigationIp.take(ip)) return redirect(res, failTo(home, 'rate_limited'));
      if (!nav) return linkVerify(req, res, url);
      const provider = config.providers.find((p) => p.id === nav[1]);
      if (!provider) return redirect(res, failTo(home, 'oauth_failed'));
      return nav[2] === 'start' ? oauthStart(oidc, res, provider, url) : oauthCallback(oidc, req, res, provider, url);
    }

    const data = deps.data;
    // The admin routes (data-spec §11) are fetch routes too, with the same edge.
    const dataPath = url.pathname === '/data' || url.pathname.startsWith('/data/')
      || url.pathname === '/admin/data' || url.pathname.startsWith('/admin/data/') || url.pathname === '/admin/audit' || url.pathname === '/admin/chat'
      || url.pathname.startsWith('/admin/chat/shares/');
    if (data && dataPath) {
      // A fetch route like /auth: an allowed origin always, and the CSRF
      // header on EVERY method that can change something (data-spec §5.4).
      // The one exception is an image read: an `<img>` sends no Origin, so
      // its GET is answered by the read rule alone — it changes nothing, and
      // a private image is `same-site` and never cached (data-spec §8).
      const origin = req.headers.origin ?? '';
      const imageRead = method === 'GET' && IMAGE_GET.test(url.pathname);
      if (!allowed.has(origin) && !imageRead) return send(res, 403, { error: 'unknown' });
      const cors = allowed.has(origin) ? corsHeaders(origin, DATA_METHODS) : {};
      if (method === 'OPTIONS') return send(res, 204, undefined, cors);
      if (method !== 'GET' && req.headers['x-az-request'] !== '1') return send(res, 403, { error: 'unknown' }, cors);
      const result = await data.handle({
        method,
        url,
        ip,
        user: async () => {
          const token = readCookies(req).get(names.session);
          return token ? (await store.sessionUser(token))?.user.id ?? null : null;
        },
        account: async () => {
          const token = readCookies(req).get(names.session);
          const u = token ? (await store.sessionUser(token))?.user : undefined;
          return u ? { id: u.id, email: u.email, verified: u.emailVerified } : null;
        },
        body: (limit) => readJson(req, limit),
        upload: (limit, to) => readRaw(req, limit, to),
      });
      if (result.file) return sendFile(res, result.file.path, imageHeaders(result.file), cors);
      // A refused upload is answered before its body is read; closing the
      // connection stops the rest of it arriving instead of reading it all.
      return send(res, result.status, result.body, req.complete ? cors : { ...cors, connection: 'close' });
    }

    const share = deps.chat?.shares ? SHARE_PATH.exec(url.pathname) : null;
    if (deps.chat && (url.pathname === '/chat' || share)) {
      // The /data edge (chat-block-spec §4.2): an allowed origin always, exact
      // CORS, and the CSRF header on every method that changes anything.
      const origin = req.headers.origin ?? '';
      if (!allowed.has(origin)) return send(res, 403, { error: 'unknown' });
      // A share link (§20.7) is read with GET and deleted with DELETE; it is made, like an answer, with POST.
      const methods = !share ? 'POST' : share[1] === undefined ? 'POST' : 'GET, DELETE';
      const cors = corsHeaders(origin, methods);
      if (method === 'OPTIONS') return send(res, 204, undefined, cors);
      if (!methods.split(', ').includes(method)) return send(res, 405, { error: 'unknown' }, cors);
      if (method !== 'GET' && req.headers['x-az-request'] !== '1') return send(res, 403, { error: 'unknown' }, cors);
      // The visitor leaving — the connection closing before the answer is
      // written out — stops the answer and its upstream request.
      const left = new AbortController();
      res.once('close', () => { if (!res.writableFinished) left.abort(); });
      const chatReq: ChatRequest = {
        ip,
        cors,
        // Without accounts there is no session to read: every visitor is nobody.
        user: async () => {
          const token = accounts ? readCookies(req).get(names.session) : undefined;
          return token ? (await store.sessionUser(token))?.user.id ?? null : null;
        },
        body: (limit) => readJson(req, limit),
        closed: left.signal,
      };
      if (share && deps.chat.shares) {
        if (share[1] === undefined) return deps.chat.shares.create(chatReq, res);
        return method === 'GET' ? deps.chat.shares.read(share[1], chatReq, res) : deps.chat.shares.remove(share[1], chatReq, res);
      }
      return deps.chat.handle(chatReq, res);
    }

    if (deps.tiles && url.pathname.startsWith(TILES_PATH)) {
      // A fetch route: an allowed origin always (the map's tile reader, glyphs and sprites are fetches),
      // reads only, and CORS that lets the reader ask for a range and see the archive's version.
      const origin = req.headers.origin ?? '';
      if (!allowed.has(origin)) return send(res, 403, { error: 'unknown' });
      const cors = tilesCors(origin);
      if (method === 'OPTIONS') return send(res, 204, undefined, cors);
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, { error: 'unknown' }, cors);
      const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v.join(',') : v);
      return deps.tiles.handle(method, url.pathname.slice(TILES_PATH.length), {
        range: one(req.headers.range), ifMatch: one(req.headers['if-match']), ifNoneMatch: one(req.headers['if-none-match']),
      }, res, cors);
    }

    if (!mailer || !url.pathname.startsWith('/auth/')) return send(res, 404, { error: 'unknown' });

    // Fetch routes: an allowed origin, always; and the CSRF header on a POST.
    const origin = req.headers.origin ?? '';
    if (!allowed.has(origin)) return send(res, 403, { error: 'unknown' });
    const cors = corsHeaders(origin);
    if (method === 'OPTIONS') return send(res, 204, undefined, cors);
    if (method === 'POST' && req.headers['x-az-request'] !== '1') return send(res, 403, { error: 'unknown' }, cors);

    let body: Json = {};
    if (method === 'POST') {
      try {
        body = await readJson(req);
      } catch (e) {
        if (e instanceof BodyError) return send(res, 400, { error: 'unknown' }, cors);
        throw e;
      }
    }

    let result: { status: number; body: unknown; cookies?: string[] };
    switch (`${method} ${url.pathname}`) {
      case 'GET /auth/session': result = await sessionRead(req); break;
      case 'GET /auth/providers':
        result = { status: 200, body: { providers: config.providers.map(({ id, label }) => ({ id, label })) } };
        break;
      case 'POST /auth/sign-in': result = await signIn(req, body, ip); break;
      case 'POST /auth/sign-up': result = await signUp(req, body, ip); break;
      case 'POST /auth/link': result = await mailRequest(mailer, 'link', body, ip, origin); break;
      case 'POST /auth/reset': result = await mailRequest(mailer, 'reset', body, ip, origin); break;
      case 'POST /auth/password': result = await setPassword(req, body, ip); break;
      case 'POST /auth/sign-out': result = await signOut(req); break;
      default: result = { status: 404, body: { error: 'unknown' } };
    }
    return send(res, result.status, result.body, { ...cors, ...(result.cookies ? { 'set-cookie': result.cookies } : {}) });
  }

  return {
    sweep,
    async handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        await handle(req, res);
      } catch (e) {
        log(`request ${req.method} ${pathOf(req)?.pathname ?? '(unparsable)'} failed: ${errorClass(e)}`);
        if (!res.headersSent) {
          const origin = req.headers.origin ?? '';
          send(res, 500, { error: 'unknown' }, allowed.has(origin) ? corsHeaders(origin) : {});
        } else {
          res.end();
        }
      }
    },
  };
}
