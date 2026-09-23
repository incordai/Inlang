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
  'invalid_credentials', 'email_taken', 'weak_password', 'rate_limited', 'expired_token', 'network', 'unknown',
] as const;
export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

export interface AuthUser {
  readonly id: string;
  readonly email: string;
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
}

/** The form fields a failure can point at. */
export type AuthField = 'email' | 'password' | 'name';

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
  setPassword(token: string, password: string): Promise<AuthResult>;
  signOut(): Promise<void>;
  session(): AuthSession | null;
  onChange(fn: (s: AuthSession | null) => void): () => void;
  ready?(): Promise<void>;
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
  rate_limited: 'Too many attempts. Wait a minute, then try again.',
  expired_token: 'This link has expired. Request a new one.',
  network: "We couldn't reach the sign-in service. Check your connection and try again.",
  unknown: 'Something went wrong. Try again in a moment.',
};

/** The field a code is about, when the adapter does not say. */
export function fieldOf(code: AuthErrorCode): AuthField | undefined {
  if (code === 'email_taken') return 'email';
  if (code === 'weak_password') return 'password';
  return undefined;
}

/** §7: stated up front, next to the field, so nobody discovers it by failing. */
export const MIN_PASSWORD = 12;

export interface FieldError {
  readonly field: string;
  readonly message: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * §6: validate on submit. `kind` says what a password field is for — a
 * login checks presence only (the rule is the provider's), a new password
 * checks the stated minimum.
 */
export function validate(values: Readonly<Record<string, string | boolean | undefined>>, kind: {
  readonly password?: 'current' | 'new';
  readonly name?: boolean;
  readonly terms?: boolean;
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
  if (kind.terms && values.terms !== true) errors.push({ field: 'terms', message: 'Agree to the terms to continue.' });
  return errors;
}

/**
 * Where to go after signing in, only if it stays on this site.
 *
 * `next` arrives in the URL, so it is attacker-controlled: an open redirect
 * from a trusted login page is a phishing tool. Only a same-origin path is
 * returned — never a scheme, a host, `//host` or `/\host`.
 */
export function safeNext(value: string | null | undefined, origin: string): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\')) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin) return null;
    return url.pathname + url.search + url.hash;
  } catch {
    return null;
  }
}
