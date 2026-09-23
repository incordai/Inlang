/**
 * Cookie-session adapters — `session` (auth-block-spec §3.3) and, through
 * the same routes at another origin, `azbackend` (§3.4).
 *
 * The server owns everything: it verifies credentials, sets an httpOnly
 * session cookie, and answers the routes. This file never sees a token — the
 * browser sends the cookie with each request. Only a public URL, if any, is
 * configuration here (§3's table).
 *
 * Copied into a generated project; imports only its sibling.
 */

import {
  toErrorCode, type AdapterId, type AuthAdapter, type AuthField, type AuthResult, type AuthSession, type Credentials,
} from './contract.ts';

export interface SessionConfig {
  /** Where the server's routes live. Same-origin, so the cookie is sent. */
  readonly base: string;
}

/** How a cookie adapter reaches its server. */
export interface CookieConfig {
  readonly id: Extract<AdapterId, 'session' | 'azbackend'>;
  /** The routes' base: same-origin for `session`, the backend's URL for `azbackend`. */
  readonly base: string;
  /**
   * `same-origin` for the site's own server; `include` for a backend on
   * another origin, so the browser sends and stores its cookie (§3.4).
   */
  readonly credentials: 'same-origin' | 'include';
  /** Sent on every request — §3.4's CSRF header for a cross-origin backend. */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface SessionEnv {
  readonly fetch: typeof fetch;
}

const FIELDS: readonly string[] = ['email', 'password', 'name'];

function parseUser(value: unknown): AuthSession | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { user?: { id?: unknown; email?: unknown }; expiresAt?: unknown };
  if (typeof v.user?.id !== 'string' || typeof v.user.email !== 'string') return null;
  return {
    user: { id: v.user.id, email: v.user.email },
    ...(typeof v.expiresAt === 'number' ? { expiresAt: v.expiresAt } : {}),
  };
}

export function createSessionAdapter(config: SessionConfig, env: SessionEnv = { fetch: (...a) => fetch(...a) }): AuthAdapter {
  return createCookieAdapter({ id: 'session', base: config.base, credentials: 'same-origin' }, env);
}

export function createCookieAdapter(config: CookieConfig, env: SessionEnv = { fetch: (...a) => fetch(...a) }): AuthAdapter {
  const listeners = new Set<(s: AuthSession | null) => void>();
  const base = config.base.replace(/\/+$/, '');
  let current: AuthSession | null = null;
  let loaded: Promise<void> | null = null;

  const set = (s: AuthSession | null) => {
    current = s;
    for (const fn of listeners) fn(s);
  };

  async function request(method: 'GET' | 'POST', path: string, body?: Record<string, string>): Promise<AuthResult> {
    let response: Response;
    try {
      response = await env.fetch(`${base}${path}`, {
        method,
        credentials: config.credentials,
        headers: { ...config.headers, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      return { ok: false, code: 'network' };
    }
    if (response.status === 429) return { ok: false, code: 'rate_limited' };
    let data: { session?: unknown; error?: unknown; field?: unknown } = {};
    try {
      const parsed: unknown = response.status === 204 ? {} : await response.json();
      // A response is input like any other: only an object is read.
      data = parsed !== null && typeof parsed === 'object' ? parsed as typeof data : {};
    } catch {
      data = {};
    }
    if (!response.ok) {
      const field = typeof data.field === 'string' && FIELDS.includes(data.field) ? data.field as AuthField : undefined;
      return { ok: false, code: toErrorCode(data.error), ...(field ? { field } : {}) };
    }
    return { ok: true, session: data.session ? parseUser(data.session) : null };
  }

  const signing = async (path: string, body: Record<string, string>) => {
    const r = await request('POST', path, body);
    if (r.ok && r.session) set(r.session);
    return r;
  };

  return {
    id: config.id,
    signIn: (c: Credentials) => signing('/sign-in', { email: c.email, password: c.password }),
    signUp: (c: Credentials) => signing('/sign-up', { email: c.email, password: c.password, ...(c.name ? { name: c.name } : {}) }),
    requestLink: (email) => request('POST', '/link', { email }),
    requestReset: (email) => request('POST', '/reset', { email }),
    setPassword: (token, password) => signing('/password', { token, password }),
    async signOut() {
      await request('POST', '/sign-out', {});
      set(null);
    },
    session: () => current,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** The first read is a request: GET /session, once. */
    ready() {
      loaded ??= request('GET', '/session').then((r) => set(r.ok ? r.session : null));
      return loaded;
    },
  };
}
