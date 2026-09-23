/**
 * The `hosted` adapter — a managed identity provider, reached over HTTPS.
 *
 * Provider-neutral: it speaks the request/response shapes auth-block-spec
 * §3.2 defines, and a site points it at a provider through two PUBLIC
 * variables — the base URL and the public (anon) key. The public key is
 * designed to be readable by anyone; a service key never reaches this file
 * (§4, and the build fails if one would be inlined).
 *
 * The session lives in sessionStorage: one tab, cleared when it closes, and
 * readable by any script on the page — which is why §4.1's row-level security
 * is the protection and this storage is not. Copied into a generated project;
 * imports only its sibling.
 */

import {
  toErrorCode, type AuthAdapter, type AuthResult, type AuthSession, type Credentials, type AuthField,
} from './contract.ts';

export interface HostedConfig {
  /** AZ_PUBLIC_AUTH_URL — the provider's base URL. */
  readonly url: string;
  /** AZ_PUBLIC_AUTH_KEY — the PUBLIC key. Never a service key. */
  readonly publicKey: string;
}

/** What the adapter keeps; the token never leaves this module. */
interface Stored {
  readonly session: AuthSession;
  readonly token: string;
}

const STORAGE_KEY = 'az.auth.session';

/** The fetch and storage in use — injected by tests, the browser's otherwise. */
export interface HostedEnv {
  readonly fetch: typeof fetch;
  readonly storage: () => Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  readonly now: () => number;
}

const browserEnv = (): HostedEnv => ({
  fetch: (...args) => fetch(...args),
  // Read lazily: nothing here may touch `window` while a page renders on a server.
  storage: () => (typeof sessionStorage === 'undefined' ? null : sessionStorage),
  now: () => Date.now(),
});

const FIELDS: readonly string[] = ['email', 'password', 'name'];

/** A provider's JSON session, checked for shape — a response is input like any other. */
function parseSession(value: unknown): Stored | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as { user?: { id?: unknown; email?: unknown }; token?: unknown; expiresAt?: unknown };
  if (typeof v.token !== 'string' || typeof v.user?.id !== 'string' || typeof v.user.email !== 'string') return null;
  const expiresAt = typeof v.expiresAt === 'number' ? v.expiresAt : undefined;
  return { token: v.token, session: { user: { id: v.user.id, email: v.user.email }, ...(expiresAt !== undefined ? { expiresAt } : {}) } };
}

export function createHostedAdapter(config: HostedConfig, env: HostedEnv = browserEnv()): AuthAdapter {
  const listeners = new Set<(s: AuthSession | null) => void>();
  const base = config.url.replace(/\/+$/, '');

  const read = (): Stored | null => {
    const raw = env.storage()?.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      const stored = parseSession(JSON.parse(raw));
      if (!stored) return null;
      if (stored.session.expiresAt !== undefined && stored.session.expiresAt <= env.now()) return null;
      return stored;
    } catch {
      return null;
    }
  };

  const write = (stored: Stored | null) => {
    const store = env.storage();
    if (stored) store?.setItem(STORAGE_KEY, JSON.stringify({ ...stored.session, token: stored.token }));
    else store?.removeItem(STORAGE_KEY);
    for (const fn of listeners) fn(stored?.session ?? null);
  };

  /** One call of §3.2's protocol. */
  async function call(path: string, body: Record<string, string>, token?: string): Promise<AuthResult & { stored?: Stored | null }> {
    let response: Response;
    try {
      response = await env.fetch(`${base}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-public-key': config.publicKey,
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
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
    const stored = data.session === undefined || data.session === null ? null : parseSession(data.session);
    if (data.session && !stored) return { ok: false, code: 'unknown' };
    return { ok: true, session: stored?.session ?? null, stored };
  }

  const withSession = async (path: string, body: Record<string, string>): Promise<AuthResult> => {
    const r = await call(path, body);
    if (r.ok && r.stored) write(r.stored);
    return r.ok ? { ok: true, session: r.session } : r;
  };
  const without = async (path: string, body: Record<string, string>): Promise<AuthResult> => {
    const r = await call(path, body);
    return r.ok ? { ok: true, session: null } : r;
  };

  return {
    id: 'hosted',
    signIn: (c: Credentials) => withSession('/sign-in', { email: c.email, password: c.password }),
    signUp: (c: Credentials) => withSession('/sign-up', { email: c.email, password: c.password, ...(c.name ? { name: c.name } : {}) }),
    requestLink: (email) => without('/link', { email }),
    requestReset: (email) => without('/reset', { email }),
    setPassword: (token, password) => withSession('/password', { token, password }),
    async signOut() {
      const stored = read();
      write(null);
      // The local session is gone either way; the provider is told when it can be.
      if (stored) await call('/sign-out', {}, stored.token);
    },
    session: () => read()?.session ?? null,
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
