/**
 * @az server crypto
 * Purpose: passwords (scrypt), tokens, digests, constant-time compare, PKCE — Node crypto only.
 * Spec: docs/backend-spec.md §5
 * Exports: hashPassword, verifyPassword, randomToken, digest, safeEqual, pkceChallenge
 * Edit guide: raising the scrypt cost upgrades hashes on next sign-in.
 * Tests: packages/backend/test/backend.test.ts
 */

/**
 * Passwords, tokens and digests — Node's own crypto, no library (backend-spec §5).
 *
 * Passwords: scrypt with N=2^15, r=8, p=3 — one of the OWASP Password
 * Storage Cheat Sheet's listed scrypt settings (32 MiB per hash). The
 * parameters are stored with each hash, so raising them later rehashes a
 * password the next time its owner signs in, with no migration.
 *
 * Tokens (sessions, reset and sign-in links, provider round-trips) are 32
 * random bytes. The database keeps only an HMAC-SHA-256 digest keyed by
 * AZ_SESSION_SECRET: a copy of the database alone cannot be used to sign in,
 * and a digest cannot be turned back into its token.
 *
 * Copied into a generated server; imports only node built-ins.
 */

import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export const SCRYPT = { N: 2 ** 15, r: 8, p: 3 } as const;
const KEY_LEN = 32;
const SALT_LEN = 16;
/** A password longer than this is refused before hashing — scrypt's cost is per byte. */
export const MAX_PASSWORD = 1024;
export const MIN_PASSWORD = 12;

const scrypt = (password: string, salt: Buffer, opts: ScryptOptions) =>
  new Promise<Buffer>((done, fail) => scryptCb(password, salt, KEY_LEN, {
    ...opts, maxmem: 256 * (opts.N ?? 1) * (opts.r ?? 8) * 2,
  }, (e, key) => (e ? fail(e) : done(key))));

export const b64url = (b: Buffer) => b.toString('base64url');

/** `scrypt$N$r$p$salt$hash` — self-describing, so parameters can change. */
export async function hashPassword(password: string, params: { N: number; r: number; p: number } = SCRYPT): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, params);
  return `scrypt$${params.N}$${params.r}$${params.p}$${b64url(salt)}$${b64url(key)}`;
}

export interface Verified { readonly ok: boolean; readonly rehash: boolean }

/** Constant-time compare; `rehash` when the stored parameters are older than SCRYPT. */
export async function verifyPassword(password: string, stored: string): Promise<Verified> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return { ok: false, rehash: false };
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  const key = await scrypt(password, salt, { N, r, p });
  const ok = key.length === expected.length && timingSafeEqual(key, expected);
  return { ok, rehash: ok && (N !== SCRYPT.N || r !== SCRYPT.r || p !== SCRYPT.p) };
}

/**
 * A hash to verify against when the account does not exist, so a sign-in
 * for an unknown address costs the same scrypt work as for a known one and
 * its timing does not reveal which (backend-spec §5, no enumeration).
 */
let decoy: Promise<string> | null = null;
export const decoyHash = () => (decoy ??= hashPassword(b64url(randomBytes(24))));

/** 32 random bytes, URL-safe. */
export const randomToken = () => b64url(randomBytes(32));

/** What the database stores for a token: HMAC-SHA-256 under the server secret. */
export const digest = (secret: Buffer, token: string) => createHmac('sha256', secret).update(token).digest('hex');

/** Equal-length, constant-time string compare. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** RFC 7636 S256: the challenge for a verifier. */
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier).digest());
