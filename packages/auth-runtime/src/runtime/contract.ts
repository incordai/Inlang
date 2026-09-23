/**
 * The adapter contract — auth-block-spec §3.
 *
 * The form compiles against THIS and nothing else about any identity
 * system. An adapter maps its own errors into the closed AuthErrorCode set,
 * and the block maps the set to copy, so no generated file contains a
 * provider's string and switching adapters moves nothing in the output.
 *
 * Copied verbatim into a generated project that uses `auth`; imports nothing.
 *
 * What protects the data is NOT here (§4.1): row-level security in the
 * backend is the protection. Everything in this directory runs on the
 * visitor's machine, where anyone can change it.
 */

export type AdapterId = 'hosted' | 'session' | 'azbackend' | 'custom';

/** The closed set of failures an adapter may report (§3). */
export const AUTH_ERROR_CODES = [
  'invalid_credentials', 'email_taken', 'weak_password', 'password_mismatch', 'rate_limited', 'expired_token',
  'oauth_failed', 'email_unverified', 'email_unconfirmed', 'network', 'unknown',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  /** §3.4: the name given at sign-up (or by a provider). */
  readonly name?: string;
  /** §3.4: optional, free text, as the person wrote it. */
  readonly location?: string;
}

/** What the block may read about a session. The token, if any, stays inside the adapter. */
export interface AuthSession {
  readonly user: AuthUser;
  /** Epoch milliseconds, when the adapter knows it. */
  readonly expiresAt?: number;
}

export interface Credentials {
  readonly email: string;
  readonly password: string;
  readonly name?: string;
  /** §3.4: the retyped password — the server checks it again. */
  readonly passwordConfirm?: string;
  readonly location?: string;
}

/** The form fields a failure can point at. */
export type AuthField = 'email' | 'password' | 'passwordConfirm' | 'name' | 'location';

/** Every AuthField, for validating a server's `field`. */
export const AUTH_FIELDS: readonly AuthField[] = ['email', 'password', 'passwordConfirm', 'name', 'location'];

/**
 * A sign-in provider the backend has enabled (§3.4). Only these two public
 * values reach the page; the provider's client id and secret stay in the
 * backend's own environment.
 */
export interface OAuthProvider {
  /** Lower-case letters, digits and `-`: it becomes a URL path segment. */
  readonly id: string;
  /** What the button says after "Continue with". Text only — no mark. */
  readonly label: string;
}

export type AuthResult =
  | { readonly ok: true; readonly session: AuthSession | null }
  | { readonly ok: false; readonly code: AuthErrorCode; readonly field?: AuthField };

/**
 * The interface every adapter implements.
 *
 * §3's six calls, plus three this implementation needed and records in the
 * spec (§3.1): `requestLink` for `methods link`, `signOut` for the signed-in
 * bar, and an optional `ready` for adapters whose first session read is a
 * request (a cookie session asks its server).
 */
export interface AuthAdapter {
  readonly id: AdapterId;
  signIn(input: Credentials): Promise<AuthResult>;
  signUp(input: Credentials): Promise<AuthResult>;
  requestLink(email: string): Promise<AuthResult>;
  requestReset(email: string): Promise<AuthResult>;
  setPassword(token: string, password: string, passwordConfirm?: string): Promise<AuthResult>;
  /** Ends the session; rejects, and stays signed in, when a server-side session was not ended. */
  signOut(): Promise<void>;
  session(): AuthSession | null;
  onChange(fn: (s: AuthSession | null) => void): () => void;
  ready?(): Promise<void>;
  /** §3.4, `methods oauth`: the providers the backend has enabled. */
  providers?(): Promise<readonly OAuthProvider[]>;
  /** §3.4: where a provider button goes; `next` is a same-origin path. */
  oauthStart?(provider: string, next: string, site: string): string;
  /**
   * §3.5: what an email link or a provider round-trip brought back to this
   * page — a sign-in, or a password-recovery session — once the adapter has
   * read it from the address and adopted it. Null when the page was reached
   * normally. Adapters whose links carry a `?token=` do not need it.
   */
  landing?(): Promise<{ readonly kind: 'signin' | 'recovery' } | null>;
}

/** Any string an adapter or provider returns, as one of the closed codes. */
export function toErrorCode(value: unknown): AuthErrorCode {
  return (AUTH_ERROR_CODES as readonly unknown[]).includes(value) ? value as AuthErrorCode : 'unknown';
}

/**
 * §6: the closed set, as copy. Written for the person at the form: what
 * happened, and what to do next. `invalid_credentials` never says which of
 * the two was wrong, and nothing here says whether an address has an account.
 */
export const ERROR_COPY: Readonly<Record<AuthErrorCode, string>> = {
  invalid_credentials: "That email and password don't match. Check both and try again.",
  email_taken: 'An account already uses this email. Sign in instead, or reset your password.',
  weak_password: 'Choose a stronger password — at least 12 characters.',
  password_mismatch: "The two passwords don't match. Type the same password in both.",
  rate_limited: 'Too many attempts. Wait a minute, then try again.',
  expired_token: 'This link has expired, or was opened in a different browser. Request a new one here.',
  oauth_failed: "Signing in with that provider didn't finish. Try again, or use your email.",
  email_unverified: "That provider hasn't verified your email address, so it can't sign you in here. Use your email instead.",
  email_unconfirmed: 'Confirm your email address first — open the link we sent you, then sign in.',
  network: "We couldn't reach the sign-in service. Check your connection and try again.",
  unknown: 'Something went wrong. Try again in a moment.',
};

/** The field a code is about, when the adapter does not say. */
export function fieldOf(code: AuthErrorCode): AuthField | undefined {
  if (code === 'email_taken') return 'email';
  if (code === 'weak_password') return 'password';
  if (code === 'password_mismatch') return 'passwordConfirm';
  return undefined;
}

/** §7: stated up front, next to the field, so nobody discovers it by failing. */
export const MIN_PASSWORD = 12;

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

/**
 * A plain address — the same rule the built-in backend applies: a dot-atom
 * local part and a domain of at least two DNS labels. No quotes, commas,
 * angle brackets or display names.
 */
const EMAIL = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * §6: validate on submit. `kind` says what a password field is for — a
 * login checks presence only (the rule is the provider's), a new password
 * checks the stated minimum.
 */
export function validate(values: Readonly<Record<string, string | boolean | undefined>>, kind: {
  readonly password?: 'current' | 'new';
  readonly name?: boolean;
  readonly terms?: boolean;
  /** A retyped password must equal the password (§3.4). */
  readonly confirm?: boolean;
}): FieldError[] {
  const errors: FieldError[] = [];
  const email = String(values.email ?? '').trim();
  if (values.email !== undefined) {
    if (!email) errors.push({ field: 'email', message: 'Enter your email address.' });
    else if (!EMAIL.test(email)) errors.push({ field: 'email', message: 'Enter an email address in the format name@domain.' });
  }
  if (kind.name && !String(values.name ?? '').trim()) errors.push({ field: 'name', message: 'Enter your name.' });
  const password = String(values.password ?? '');
  if (kind.password === 'current' && !password) errors.push({ field: 'password', message: 'Enter your password.' });
  if (kind.password === 'new' && password.length < MIN_PASSWORD) {
    errors.push({ field: 'password', message: `Use at least ${MIN_PASSWORD} characters.` });
  }
  if (kind.confirm && String(values.passwordConfirm ?? '') !== password) {
    errors.push({ field: 'passwordConfirm', message: ERROR_COPY.password_mismatch });
  }
  if (kind.terms && values.terms !== true) errors.push({ field: 'terms', message: 'Agree to the terms to continue.' });
  return errors;
}

/**
 * Where to go after signing in, only if it stays on this site.
 *
 * `next` arrives in the URL, so it is attacker-controlled: an open redirect
 * from a trusted login page is a phishing tool. Only a same-origin path is
 * returned — never a scheme, a host, `//host` or `/\host`. The check runs on
 * the RESOLVED path too: `/.//host`, `/..//host` and `/%2e//host` start with
 * a single slash but resolve to `//host`, which `location.assign` would read
 * as another host.
 */
export function safeNext(value: string | null | undefined, origin: string): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || /%2e/i.test(value)) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.pathname.startsWith('//') || url.pathname.startsWith('/\\')) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}

/** A provider id that is safe as a URL path segment (§3.4). */
export const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** The longest provider label a button will show. */
export const PROVIDER_LABEL_MAX = 40;

/**
 * The backend's provider list, validated: it is input like any other, and
 * its labels become button text. Anything malformed is dropped, not shown.
 */
export function parseProviders(value: unknown): OAuthProvider[] {
  const list = value !== null && typeof value === 'object' ? (value as { providers?: unknown }).providers : undefined;
  if (!Array.isArray(list)) return [];
  const out: OAuthProvider[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    if (p === null || typeof p !== 'object') continue;
    const { id, label } = p as { id?: unknown; label?: unknown };
    if (typeof id !== 'string' || !PROVIDER_ID.test(id) || seen.has(id)) continue;
    if (typeof label !== 'string') continue;
    const text = label.trim();
    if (!text || text.length > PROVIDER_LABEL_MAX) continue;
    seen.add(id);
    out.push({ id, label: text });
  }
  return out;
}
