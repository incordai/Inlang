/**
 * @az runtime hosted-token
 * Purpose: the hosted adapter, token-endpoint profile (cloud option) with social sign-in.
 * Spec: docs/auth-block-spec.md §3.5
 * Exports: createTokenEndpointAdapter, mapTokenError, parseTokenResponse
 * Edit guide: strip tokens from the address bar on landing; never map an unknown address to a distinct error.
 * Tests: packages/auth-runtime/test/token-endpoint.test.ts
 */

/**
 * The `hosted` adapter, `token-endpoint` profile — auth-block-spec §3.5.
 *
 * For managed identity servers whose API is built around one token endpoint
 * with grant types (`password`, `refresh_token`, `pkce`), a user resource,
 * and email links that land back on the site with the session in the URL.
 * Provider-neutral: it names no product, and a site reaches its server
 * through the same two PUBLIC variables as the standard profile — the base
 * URL (including the server's API path) and the public (anon) key. A
 * service key never reaches this file (§4; the build refuses one).
 *
 * Tokens live in sessionStorage, as §3.2 says of every hosted session: one
 * tab, cleared when it closes, and readable by any script on the page. That
 * includes the refresh token, so an injected script could keep a session
 * alive past the access token's expiry — row-level security (§4.1) and a
 * page with no third-party script are the protection, not this storage.
 *
 * Copied into a generated project that picks this profile; imports only its
 * sibling.
 */

import {
  type AuthAdapter, type AuthErrorCode, type AuthField, type AuthResult, type AuthSession, type Credentials,
  type OAuthProvider, PROVIDER_ID, PROVIDER_LABEL_MAX,
} from './contract.ts';

export interface TokenEndpointConfig {
  /** AZ_PUBLIC_AUTH_URL — the server's base URL, API path included. */
  readonly url: string;
  /** AZ_PUBLIC_AUTH_KEY — the PUBLIC key. Never a service key. */
  readonly publicKey: string;
  /** The site path a reset email should land on (the `auth reset` page), if any. */
  readonly resetPath: string | null;
}

/** What the adapter keeps; tokens never leave this module. */
interface Stored {
  readonly session: AuthSession;
  readonly access: string;
  readonly refresh: string;
}

/** What an email or provider round-trip brought back to this page. */
export type Landing = { readonly kind: 'signin' | 'recovery' } | null;

const SESSION_KEY = 'az.auth.session';
const VERIFIER_KEY = 'az.auth.pkce';
/** Refresh this long before the access token expires. */
const REFRESH_EARLY_MS = 60_000;
/** PKCE verifier length (RFC 7636 allows 43–128). */
const VERIFIER_BYTES = 48;
/** Ids in the server's settings that are not sign-in providers. */
const NOT_PROVIDERS = new Set(['email', 'phone', 'anonymous_users', 'saml']);

/** Everything the adapter touches outside itself — injected by tests. */
export interface TokenEndpointEnv {
  readonly fetch: typeof fetch;
  readonly storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  readonly now: () => number;
  /** The page address, and a way to drop the tokens from it once read. */
  readonly location: () => { href: string; origin: string } | null;
  readonly replaceUrl: (url: string) => void;
  readonly random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>;
  readonly sha256: (data: Uint8Array<ArrayBuffer>) => Promise<ArrayBuffer>;
  readonly schedule: (fn: () => void, ms: number) => () => void;
}

/** The two browser objects this module reads — structural, so it needs no DOM types. */
interface Page {
  readonly location?: { readonly href: string; readonly origin: string };
  readonly history?: { readonly state: unknown; replaceState(state: unknown, unused: string, url: string): void };
}
const page = globalThis as Page;

const browserEnv = (): TokenEndpointEnv => ({
  fetch: (...args) => fetch(...args),
  // Read lazily: nothing here may touch the page while it renders on a server.
  storage: () => (typeof sessionStorage === 'undefined' ? null : sessionStorage),
  now: () => Date.now(),
  location: () => (page.location ? { href: page.location.href, origin: page.location.origin } : null),
  replaceUrl: (url) => page.history?.replaceState(page.history.state, '', url),
  random: (bytes) => crypto.getRandomValues(bytes),
  sha256: (data) => crypto.subtle.digest('SHA-256', data),
  schedule: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return () => clearTimeout(id);
  },
});

/**
 * The server's error, as the closed set. Newer servers send `error_code`;
 * older ones an OAuth-style `error`. Anything unrecognised is `unknown`.
 */
export function mapTokenError(status: number, body: unknown): { code: AuthErrorCode; field?: AuthField } {
  if (status === 429) return { code: 'rate_limited' };
  const b = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
  const raw = typeof b.error_code === 'string' ? b.error_code : typeof b.error === 'string' ? b.error : '';
  switch (raw) {
    case 'invalid_credentials':
    case 'invalid_grant':
      return { code: 'invalid_credentials' };
    case 'user_already_exists':
    case 'email_exists':
      return { code: 'email_taken', field: 'email' };
    case 'weak_password':
      return { code: 'weak_password', field: 'password' };
    case 'over_request_rate_limit':
    case 'over_email_send_rate_limit':
      return { code: 'rate_limited' };
    case 'otp_expired':
    case 'flow_state_expired':
    case 'flow_state_not_found':
    case 'bad_code_verifier':
      return { code: 'expired_token' };
    case 'email_not_confirmed':
      return { code: 'email_unconfirmed' };
    default:
      return { code: 'unknown' };
  }
}

/** A token response, checked for shape — a response is input like any other. */
export function parseTokenResponse(value: unknown, now: number): Stored | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const user = parseUser(v.user);
  if (typeof v.access_token !== 'string' || typeof v.refresh_token !== 'string' || !user) return null;
  const expiresAt = typeof v.expires_at === 'number' ? v.expires_at * 1000
    : typeof v.expires_in === 'number' ? now + v.expires_in * 1000 : undefined;
  return {
    access: v.access_token,
    refresh: v.refresh_token,
    session: { user, ...(expiresAt !== undefined ? { expiresAt } : {}) },
  };
}

/** The user resource, reduced to what the block may read (§3.1). */
export function parseUser(value: unknown): AuthSession['user'] | null {
  if (value === null || typeof value !== 'object') return null;
  const u = value as { id?: unknown; email?: unknown; user_metadata?: unknown };
  if (typeof u.id !== 'string' || typeof u.email !== 'string') return null;
  const meta = u.user_metadata !== null && typeof u.user_metadata === 'object'
    ? u.user_metadata as Record<string, unknown> : {};
  return {
    id: u.id,
    email: u.email,
    ...(typeof meta.name === 'string' && meta.name ? { name: meta.name } : {}),
    ...(typeof meta.location === 'string' && meta.location ? { location: meta.location } : {}),
  };
}

/** A user as this adapter stored it — storage is readable by page scripts, so it is re-checked. */
function storedUser(value: unknown): AuthSession['user'] | null {
  if (value === null || typeof value !== 'object') return null;
  const u = value as Record<string, unknown>;
  if (typeof u.id !== 'string' || typeof u.email !== 'string') return null;
  return {
    id: u.id,
    email: u.email,
    ...(typeof u.name === 'string' && u.name ? { name: u.name } : {}),
    ...(typeof u.location === 'string' && u.location ? { location: u.location } : {}),
  };
}

/** Enabled sign-in providers from the server's public settings. */
export function parseSettingsProviders(value: unknown): OAuthProvider[] {
  const external = value !== null && typeof value === 'object'
    ? (value as { external?: unknown }).external : undefined;
  if (external === null || typeof external !== 'object') return [];
  const out: OAuthProvider[] = [];
  for (const [id, enabled] of Object.entries(external as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (enabled !== true || NOT_PROVIDERS.has(id) || !PROVIDER_ID.test(id)) continue;
    // The server's id is the label's only source: shown with a capital first
    // letter, and never a name this code knows.
    const label = (id.charAt(0).toUpperCase() + id.slice(1)).slice(0, PROVIDER_LABEL_MAX);
    out.push({ id, label });
  }
  return out;
}

/**
 * Errors that only say the address has no account (or may not sign up by
 * link). §3.2 answers these exactly like success, so the form never tells
 * anyone whether an address is registered. Every other error — a refused
 * redirect, a rate limit — is reported, so a misconfiguration is not
 * mistaken for a sent email.
 */
const NO_SUCH_ACCOUNT = new Set(['otp_disabled', 'signup_disabled', 'user_not_found']);
export function noSuchAccount(body: unknown): boolean {
  const b = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
  return typeof b.error_code === 'string' && NO_SUCH_ACCOUNT.has(b.error_code);
}

const base64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export function createTokenEndpointAdapter(config: TokenEndpointConfig, env: TokenEndpointEnv = browserEnv()): AuthAdapter & {
  landing(): Promise<Landing>;
} {
  const listeners = new Set<(s: AuthSession | null) => void>();
  const base = config.url.replace(/\/+$/, '');
  let cancelRefresh: (() => void) | null = null;
  let landed: Promise<Landing> | null = null;
  /** The PKCE challenge prepared for the next provider round-trip. */
  let challenge: string | null = null;

  const readStored = (): Stored | null => {
    const raw = env.storage()?.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { access?: unknown; refresh?: unknown; session?: { user?: unknown; expiresAt?: unknown } };
      const user = storedUser(v.session?.user);
      if (typeof v.access !== 'string' || typeof v.refresh !== 'string' || !user) return null;
      const expiresAt = typeof v.session?.expiresAt === 'number' ? v.session.expiresAt : undefined;
      return { access: v.access, refresh: v.refresh, session: { user, ...(expiresAt !== undefined ? { expiresAt } : {}) } };
    } catch {
      return null;
    }
  };
  const live = (s: Stored | null): Stored | null =>
    s && (s.session.expiresAt === undefined || s.session.expiresAt > env.now()) ? s : null;

  const write = (stored: Stored | null) => {
    const store = env.storage();
    if (stored) store?.setItem(SESSION_KEY, JSON.stringify(stored));
    else store?.removeItem(SESSION_KEY);
    cancelRefresh?.();
    cancelRefresh = null;
    if (stored?.session.expiresAt !== undefined) {
      const wait = Math.max(0, stored.session.expiresAt - REFRESH_EARLY_MS - env.now());
      cancelRefresh = env.schedule(() => { void refresh(); }, wait);
    }
    for (const fn of listeners) fn(stored?.session ?? null);
  };

  /** One request. `auth` is a user's access token; the public key otherwise. */
  async function request(method: string, path: string, body?: unknown, auth?: string): Promise<{ ok: boolean; status: number; data: unknown }> {
    let response: Response;
    try {
      response = await env.fetch(`${base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          apikey: config.publicKey,
          authorization: `Bearer ${auth ?? config.publicKey}`,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return { ok: false, status: 0, data: null };
    }
    let data: unknown = null;
    try {
      data = response.status === 204 ? null : await response.json();
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  }

  const failure = (r: { status: number; data: unknown }): AuthResult => {
    if (r.status === 0) return { ok: false, code: 'network' };
    const e = mapTokenError(r.status, r.data);
    return { ok: false, code: e.code, ...(e.field ? { field: e.field } : {}) };
  };

  /** Establish a session from a token response, or fail. */
  const adopt = (r: { ok: boolean; status: number; data: unknown }): AuthResult => {
    if (!r.ok) return failure(r);
    const stored = parseTokenResponse(r.data, env.now());
    if (!stored) return { ok: false, code: 'unknown' };
    write(stored);
    return { ok: true, session: stored.session };
  };

  async function refresh(): Promise<boolean> {
    const current = readStored();
    if (!current) return false;
    const r = await request('POST', '/token?grant_type=refresh_token', { refresh_token: current.refresh });
    if (!r.ok) {
      // A refused refresh means the session is over (revoked, or rotated elsewhere).
      if (r.status !== 0) write(null);
      return false;
    }
    const stored = parseTokenResponse(r.data, env.now());
    if (!stored) return false;
    write(stored);
    return true;
  }

  /** Where an email link should bring the visitor back to, on this site. */
  const back = (path: string | null): string | null => {
    const loc = env.location();
    if (!loc) return null;
    return path ? loc.origin + path : loc.href.split('#')[0];
  };
  const withRedirect = (path: string, to: string | null) =>
    to ? `${path}?redirect_to=${encodeURIComponent(to)}` : path;

  /**
   * Read what an email link or a provider brought back — tokens in the
   * fragment, or a PKCE `code` in the query — then drop them from the
   * address so they are not left in history or a copied link.
   */
  async function readLanding(): Promise<Landing> {
    const loc = env.location();
    if (!loc) return null;
    const url = new URL(loc.href);
    const fragment = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : '');
    const code = url.searchParams.get('code');
    const verifier = env.storage()?.getItem(VERIFIER_KEY) ?? null;

    if (fragment.get('access_token') && fragment.get('refresh_token')) {
      const kind = fragment.get('type') === 'recovery' ? 'recovery' : 'signin';
      const expiresIn = Number(fragment.get('expires_in'));
      const token = fragment.get('access_token')!;
      const refreshToken = fragment.get('refresh_token')!;
      url.hash = '';
      env.replaceUrl(url.pathname + url.search);
      const me = await request('GET', '/user', undefined, token);
      const user = me.ok ? parseUser(me.data) : null;
      if (!user) return null;
      write({
        access: token,
        refresh: refreshToken,
        session: { user, ...(Number.isFinite(expiresIn) && expiresIn > 0 ? { expiresAt: env.now() + expiresIn * 1000 } : {}) },
      });
      return { kind };
    }
    if (fragment.get('error') || fragment.get('error_code')) {
      url.hash = '';
      env.replaceUrl(url.pathname + url.search);
      return null;
    }
    if (code && verifier) {
      url.searchParams.delete('code');
      env.replaceUrl(url.pathname + (url.search || ''));
      env.storage()?.removeItem(VERIFIER_KEY);
      const r = await request('POST', '/token?grant_type=pkce', { auth_code: code, code_verifier: verifier });
      return adopt(r).ok ? { kind: 'signin' } : null;
    }
    return null;
  }

  const landing = (): Promise<Landing> => (landed ??= readLanding());

  return {
    id: 'hosted',
    landing,
    async ready() {
      await landing();
      const stored = readStored();
      // An expired access token with a refresh token is renewed before the
      // page decides whether anyone is signed in.
      if (stored && !live(stored)) await refresh();
      else if (stored) write(stored);
    },
    signIn: async (c: Credentials) =>
      adopt(await request('POST', '/token?grant_type=password', { email: c.email, password: c.password })),
    async signUp(c: Credentials) {
      if (c.passwordConfirm !== undefined && c.passwordConfirm !== c.password) {
        return { ok: false, code: 'password_mismatch', field: 'passwordConfirm' };
      }
      const data = { ...(c.name ? { name: c.name } : {}), ...(c.location ? { location: c.location } : {}) };
      const r = await request('POST', withRedirect('/signup', back(null)), { email: c.email, password: c.password, data });
      if (!r.ok) return failure(r);
      // A session when the server confirms at once; a user alone when the
      // address must be confirmed by email first (§3.2's `200 {}`).
      const stored = parseTokenResponse(r.data, env.now());
      if (stored) {
        write(stored);
        return { ok: true, session: stored.session };
      }
      return { ok: true, session: null };
    },
    async requestLink(email: string) {
      const r = await request('POST', withRedirect('/otp', back(null)), { email, create_user: false });
      // §3.2: the same answer whether or not the address has an account.
      return r.ok || noSuchAccount(r.data) ? { ok: true, session: null } : failure(r);
    },
    async requestReset(email: string) {
      const r = await request('POST', withRedirect('/recover', back(config.resetPath)), { email });
      return r.ok || noSuchAccount(r.data) ? { ok: true, session: null } : failure(r);
    },
    async setPassword(_token: string, password: string, passwordConfirm?: string) {
      if (passwordConfirm !== undefined && passwordConfirm !== password) {
        return { ok: false, code: 'password_mismatch', field: 'passwordConfirm' };
      }
      // The reset link signed the visitor in (a recovery session); the new
      // password is set on that session's user.
      const stored = live(readStored());
      if (!stored) return { ok: false, code: 'expired_token' };
      const r = await request('PUT', '/user', { password }, stored.access);
      if (!r.ok) return failure(r);
      return { ok: true, session: stored.session };
    },
    async signOut() {
      const stored = readStored();
      write(null);
      // The local session is gone either way; the server is told when it can be.
      if (stored) await request('POST', '/logout', {}, stored.access);
    },
    session: () => live(readStored())?.session ?? null,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async providers() {
      const r = await request('GET', '/settings');
      const list = r.ok ? parseSettingsProviders(r.data) : [];
      if (list.length > 0) {
        // One PKCE pair for this page's provider buttons (RFC 7636, S256).
        const verifier = base64url(env.random(new Uint8Array(VERIFIER_BYTES)));
        env.storage()?.setItem(VERIFIER_KEY, verifier);
        challenge = base64url(new Uint8Array(await env.sha256(new TextEncoder().encode(verifier))));
      }
      return list;
    },
    oauthStart(provider: string, next: string, site: string) {
      // Back to THIS page (the login or sign-up form, `?next` included): its
      // form reads the returned code and then continues to `next` (§3.5),
      // whatever kind of page `next` is.
      const to = back(null) ?? `${site}${next}`;
      const q = new URLSearchParams({ provider, redirect_to: to });
      if (challenge) {
        q.set('code_challenge', challenge);
        q.set('code_challenge_method', 's256');
      }
      return `${base}/authorize?${q.toString()}`;
    },
  };
}
