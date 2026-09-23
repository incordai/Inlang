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
import type { Config, Provider } from './env.ts';
import { decoyHash, hashPassword, MAX_PASSWORD, MIN_PASSWORD, pkceChallenge, randomToken, safeEqual, verifyPassword } from './crypto.ts';
import { linkMessage, resetMessage, type Mailer } from './email.ts';
import { BodyError, clientIp, cookie, corsHeaders, createLimiter, readCookies, readJson, redirect, send } from './http.ts';
import type { Oidc } from './oidc.ts';
import { normaliseEmail, SESSION_TTL_MS, OAUTH_STATE_TTL_MS, type Store, type User } from './store.ts';

export const SESSION_COOKIE = 'az_session';
export const STATE_COOKIE = 'az_oauth_state';
const MAX_NAME = 200;
const MAX_LOCATION = 200;
const MAX_EMAIL = 254;
const MAX_NEXT = 2048;
const MINUTE = 60 * 1000;

export interface AppDeps {
  readonly config: Config;
  readonly store: Store;
  readonly mailer: Mailer;
  readonly oidc: Oidc;
  readonly now?: () => number;
  /** Operational log. Never passed a password, token or secret. */
  readonly log?: (line: string) => void;
}

type Json = Record<string, unknown>;

const text = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max ? v.trim() : null;

/** A plausible address: one @, something either side, no spaces. Delivery is the real check. */
const isEmail = (v: string) => /^[^\s@]+@[^\s@]+$/.test(v);

/** A path on the site: one leading slash, no scheme or host smuggled in. */
export const isSitePath = (v: string) =>
  v.length <= MAX_NEXT && v.startsWith('/') && !v.startsWith('//') && !/[\\\s]/.test(v);

const view = (u: User, expiresAt: number) => ({
  user: { id: u.id, email: u.email, name: u.name, ...(u.location ? { location: u.location } : {}) },
  expiresAt,
});

export function createApp(deps: AppDeps) {
  const { config, store, mailer, oidc } = deps;
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
  const sweep = () => { for (const l of Object.values(limits)) l.sweep(); };

  const sessionCookie = (token: string) =>
    cookie(SESSION_COOKIE, token, { sameSite: config.sameSite, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) });
  const clearSession = cookie(SESSION_COOKIE, '', { sameSite: config.sameSite, maxAgeSeconds: 0 });
  const clearState = cookie(STATE_COOKIE, '', { sameSite: 'Lax', path: '/auth/oauth', maxAgeSeconds: 0 });

  /** A new session for `user`, replacing whatever session the request carried (rotation). */
  async function startSession(req: IncomingMessage, user: User): Promise<{ header: string; body: Json }> {
    const old = readCookies(req)[SESSION_COOKIE];
    if (old) await store.deleteSession(old);
    const s = await store.createSession(user.id);
    return { header: sessionCookie(s.token), body: { session: view(user, s.expiresAt) } };
  }

  function sendMail(what: string, message: Parameters<Mailer['send']>[0]): void {
    // Not awaited: a known and an unknown address answer at the same speed.
    mailer.send(message).catch((e: unknown) => log(`email (${what}) failed: ${(e as Error).message}`));
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

  /** `/link` and `/reset`: the same answer for every address (§3.4 checklist 5). */
  async function mailRequest(kind: 'link' | 'reset', body: Json, ip: string, site: string) {
    const email = text(body.email, MAX_EMAIL);
    if (!limits.mailIp.take(ip) || (email && !limits.mailAccount.take(`${kind}:${normaliseEmail(email)}`))) {
      return { status: 429, body: { error: 'rate_limited' } };
    }
    if (email && isEmail(email)) {
      const user = await store.userByEmail(email);
      if (user) {
        const token = await store.createToken(user.id, kind, site);
        if (kind === 'reset') {
          const url = new URL(config.resetPath, site);
          url.searchParams.set('token', token);
          url.searchParams.set('email', user.email);
          sendMail('reset', resetMessage(config.siteName, user.email, url.href));
        } else {
          const url = new URL(`${config.publicUrl}/auth/link/verify`);
          url.searchParams.set('token', token);
          sendMail('link', linkMessage(config.siteName, user.email, url.href));
        }
      }
    }
    return { status: 200, body: {} };
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
    const token = readCookies(req)[SESSION_COOKIE];
    if (!token) return { status: 200, body: { session: null } };
    const found = await store.sessionUser(token);
    if (!found) return { status: 200, body: { session: null }, cookies: [clearSession] };
    return { status: 200, body: { session: view(found.user, found.expiresAt) } };
  }

  async function signOut(req: IncomingMessage) {
    const token = readCookies(req)[SESSION_COOKIE];
    if (token) await store.deleteSession(token);          // ended on the server, not just forgotten
    return { status: 204, body: undefined, cookies: [clearSession] };
  }

  /* ---- navigation routes ---------------------------------------------- */

  const failTo = (site: string, code: string) => `${site}/login?auth_error=${code}`;

  async function linkVerify(req: IncomingMessage, res: ServerResponse, url: URL) {
    const token = url.searchParams.get('token') ?? '';
    const spent = token ? await store.spendToken(token, 'link') : 'expired';
    if (spent === 'expired' || !allowed.has(spent.site)) return redirect(res, failTo(home, 'expired_token'));
    const user = await store.userById(spent.userId);
    if (!user) return redirect(res, failTo(spent.site, 'expired_token'));
    await store.markVerified(user.id);
    const s = await startSession(req, user);
    return redirect(res, `${spent.site}${config.linkLanding}`, { 'set-cookie': s.header });
  }

  async function oauthStart(res: ServerResponse, p: Provider, url: URL) {
    const site = url.searchParams.get('site') ?? '';
    const next = url.searchParams.get('next') ?? '/';
    // §3.4: `site` must be an allowed origin and `next` a path on it, or 400.
    if (!allowed.has(site) || !isSitePath(next)) return send(res, 400, { error: 'unknown' });
    let d;
    try {
      d = await oidc.discover(p);
    } catch (e) {
      log(`provider ${p.id} discovery failed: ${(e as Error).message}`);
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
      'set-cookie': cookie(STATE_COOKIE, state, { sameSite: 'Lax', path: '/auth/oauth', maxAgeSeconds: Math.floor(OAUTH_STATE_TTL_MS / 1000) }),
    });
  }

  async function oauthCallback(req: IncomingMessage, res: ServerResponse, p: Provider, url: URL) {
    const state = url.searchParams.get('state') ?? '';
    const bound = readCookies(req)[STATE_COOKIE] ?? '';
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
      log(`provider ${p.id} sign-in failed: ${(e as Error).message}`);
      return back('oauth_failed');
    }
    if (!subject) return back('oauth_failed');

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
        await store.markVerified(user.id);
      }
      await store.linkOAuth(p.id, subject, user.id);
    }
    const s = await startSession(req, user);
    return redirect(res, `${trip.site}${trip.next}`, { 'set-cookie': [s.header, clearState] });
  }

  /* ---- dispatch ------------------------------------------------------- */

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://backend.invalid');
    const method = req.method ?? 'GET';
    const ip = clientIp(req, config.trustProxy);

    if (method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true });

    const nav = /^\/auth\/oauth\/([a-z0-9][a-z0-9-]{0,62})\/(start|callback)$/.exec(url.pathname);
    if (nav || url.pathname === '/auth/link/verify') {
      if (method !== 'GET') return send(res, 405, { error: 'unknown' });
      if (!limits.navigationIp.take(ip)) return redirect(res, failTo(home, 'rate_limited'));
      if (!nav) return linkVerify(req, res, url);
      const provider = config.providers.find((p) => p.id === nav[1]);
      if (!provider) return redirect(res, failTo(home, 'oauth_failed'));
      return nav[2] === 'start' ? oauthStart(res, provider, url) : oauthCallback(req, res, provider, url);
    }

    if (!url.pathname.startsWith('/auth/')) return send(res, 404, { error: 'unknown' });

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
      case 'POST /auth/link': result = await mailRequest('link', body, ip, origin); break;
      case 'POST /auth/reset': result = await mailRequest('reset', body, ip, origin); break;
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
        const err = e as { name?: string; code?: string; message?: string };
        log(`request ${req.method} ${new URL(req.url ?? '/', 'http://x').pathname} failed: ${err.name ?? 'Error'} ${err.code ?? ''}`.trim());
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
