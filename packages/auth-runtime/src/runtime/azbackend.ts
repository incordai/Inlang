/**
 * The `azbackend` adapter — the site owner's own backend (auth-block-spec §3.4).
 *
 * The same cookie routes as `session` (§3.3), served by a backend on its own
 * origin under `<base>/auth`. Configuration is one PUBLIC value: the
 * backend's base URL. There is no key — the backend authenticates the
 * visitor by its httpOnly cookie, and nothing here ever holds a token.
 *
 * Cross-origin, so every request is credentialed (`include`) and carries the
 * CSRF header §3.4 requires the backend to check. A custom header cannot be
 * sent cross-origin without a CORS preflight the backend must approve, so a
 * forged form post from another site is refused before it reaches a route.
 *
 * Copied into a generated project; imports only its siblings.
 */

import type { AuthAdapter } from './contract.ts';
import { createCookieAdapter, type SessionEnv } from './session.ts';

/** §3.4: the header every request carries; the backend refuses a request without it. */
export const CSRF_HEADER = 'x-az-request';
export const CSRF_VALUE = '1';

/** Where the backend's auth routes live, below its base URL. */
export const BACKEND_AUTH_PATH = '/auth';

export interface BackendConfig {
  /** The backend's public base URL, e.g. `https://api.example.org`. */
  readonly url: string;
}

/**
 * Why a base URL cannot be used, or null when it can.
 *
 * The session cookie crosses the network on every call, so the backend must
 * be reached over https. Plain http is allowed only for a loopback host,
 * where nothing crosses a network (local development).
 */
export function backendUrlProblem(value: string): string | null {
  if (!value) return 'no backend URL is set';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `'${value}' is not a URL`;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return `'${value}' must use https (plain http only for localhost)`;
  }
  if (url.username || url.password) return 'the backend URL must not carry credentials';
  if (url.search || url.hash) return 'the backend URL must be a base, without ? or #';
  return null;
}

export function createBackendAdapter(
  config: BackendConfig, env: SessionEnv = { fetch: (...a) => fetch(...a) },
): AuthAdapter {
  const problem = backendUrlProblem(config.url);
  if (problem) throw new Error(`auth: adapter azbackend — ${problem}`);
  return createCookieAdapter({
    id: 'azbackend',
    base: `${config.url.replace(/\/+$/, '')}${BACKEND_AUTH_PATH}`,
    credentials: 'include',
    headers: { [CSRF_HEADER]: CSRF_VALUE },
  }, env);
}
