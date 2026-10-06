/**
 * @az server store
 * Purpose: accounts, sessions and single-use tokens over the database.
 * Spec: docs/backend-spec.md §3, §5 · docs/data-spec.md §18.7 (pre-claim rows)
 * Exports: createStore, normaliseEmail, DEFAULT_SESSION_POLICY
 * Edit guide: single use by one conditional UPDATE; tokens stored as digests only.
 * Tests: packages/backend/test/backend.test.ts
 */

/**
 * Accounts, sessions and single-use tokens (backend-spec §3, §5).
 *
 * Tokens are never stored — only their keyed digest (crypto.ts). "Single
 * use" is enforced by the database, not by a read-then-write: a token is
 * spent by one conditional UPDATE that only matches while it is unused and
 * unexpired, so two concurrent requests with the same token cannot both
 * succeed.
 *
 * Copied into a generated server; imports only its siblings and node built-ins.
 */

import { randomUUID } from 'node:crypto';
import { isUniqueViolation, type Db, type Row } from './db.ts';
import { digest, randomToken } from './crypto.ts';

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string | null;
  readonly location: string | null;
  readonly emailVerified: boolean;
}

export type TokenKind = 'reset' | 'link';

/** A session's limits (AZ_SESSION_IDLE_MINUTES, AZ_SESSION_MAX_HOURS). */
export interface SessionPolicy {
  readonly idleMs: number;
  readonly maxMs: number;
}
export const DEFAULT_SESSION_POLICY: SessionPolicy = { idleMs: 24 * 60 * 60 * 1000, maxMs: 14 * 24 * 60 * 60 * 1000 };
/** Last use is recorded at most this often, so reading a session is not a write every time. */
const TOUCH_MS = 60 * 1000;
export const TOKEN_TTL_MS: Readonly<Record<TokenKind, number>> = { reset: 30 * 60 * 1000, link: 15 * 60 * 1000 };
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** Addresses compare case-insensitively everywhere, so they are stored lower-cased. */
export const normaliseEmail = (e: string) => e.trim().toLowerCase();

const toUser = (r: Row): User => ({
  id: String(r.id),
  email: String(r.email),
  name: String(r.name),
  passwordHash: r.password_hash == null ? null : String(r.password_hash),
  location: r.location == null ? null : String(r.location),
  emailVerified: Number(r.email_verified) === 1,
});

export interface OAuthState {
  readonly provider: string;
  readonly verifier: string;
  readonly nonce: string;
  readonly next: string;
  readonly site: string;
}

/**
 * `ownedRows`: one `DELETE … WHERE owner = ?` per data table (data-values.ts
 * ownedRowDeletes) — what an account's own rows are, which only the data
 * tables know. Empty for a site without data.
 */
export function createStore(
  db: Db, secret: Buffer, now: () => number = Date.now, policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  ownedRows: readonly string[] = [],
) {
  const d = (token: string) => digest(secret, token);

  return {
    async createUser(u: { email: string; name: string; passwordHash: string | null; location: string | null; verified: boolean }):
      Promise<User | 'taken'> {
      const id = randomUUID();
      const t = now();
      try {
        await db.run(
          'INSERT INTO az_users (id, email, name, password_hash, location, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [id, normaliseEmail(u.email), u.name, u.passwordHash, u.location, u.verified ? 1 : 0, t, t]);
      } catch (e) {
        if (isUniqueViolation(e)) return 'taken';
        throw e;
      }
      return { id, email: normaliseEmail(u.email), name: u.name, passwordHash: u.passwordHash, location: u.location, emailVerified: u.verified };
    },

    async userByEmail(email: string): Promise<User | null> {
      const r = await db.get('SELECT * FROM az_users WHERE email = ?', [normaliseEmail(email)]);
      return r ? toUser(r) : null;
    },

    async userById(id: string): Promise<User | null> {
      const r = await db.get('SELECT * FROM az_users WHERE id = ?', [id]);
      return r ? toUser(r) : null;
    },

    async setPassword(userId: string, hash: string): Promise<void> {
      await db.run('UPDATE az_users SET password_hash = ?, updated_at = ? WHERE id = ?', [hash, now(), userId]);
    },

    async markVerified(userId: string): Promise<void> {
      await db.run('UPDATE az_users SET email_verified = 1, updated_at = ? WHERE id = ?', [now(), userId]);
    },

    /**
     * An UNVERIFIED account is being claimed by whoever just proved the
     * mailbox (a sign-in link) or a provider that vouches for the address.
     * Anyone could have created it: its password, every session and every
     * data row it wrote are the creator's, not necessarily the owner's. All
     * go — a squatter must leave nothing under someone else's address — and
     * the account becomes verified. One transaction, guarded by a
     * conditional UPDATE: only an unverified row changes, and either all of
     * it happens or none (image files of deleted rows go in the orphan sweep).
     */
    async claimUnverified(userId: string): Promise<boolean> {
      return db.guarded(
        { sql: 'UPDATE az_users SET password_hash = NULL, email_verified = 1, updated_at = ? WHERE id = ? AND email_verified = 0', params: [now(), userId] },
        [
          { sql: 'DELETE FROM az_sessions WHERE user_id = ?', params: [userId] },
          ...ownedRows.map((sql) => ({ sql, params: [userId] })),
        ]);
    },

    /** A new session. The token is returned once, for the cookie; only its digest is kept. */
    async createSession(userId: string): Promise<{ token: string; expiresAt: number }> {
      const token = randomToken();
      const t = now();
      const expiresAt = t + policy.maxMs;
      await db.run('INSERT INTO az_sessions (digest, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
        [d(token), userId, t, expiresAt, t]);
      return { token, expiresAt };
    },

    /** The session's user, if the session is within both its absolute cap and its idle limit. */
    async sessionUser(token: string): Promise<{ user: User; expiresAt: number } | null> {
      const t = now();
      const r = await db.get(
        'SELECT u.*, s.expires_at AS session_expires, COALESCE(s.last_seen_at, s.created_at) AS session_seen'
        + ' FROM az_sessions s JOIN az_users u ON u.id = s.user_id'
        + ' WHERE s.digest = ? AND s.expires_at > ? AND COALESCE(s.last_seen_at, s.created_at) > ?',
        [d(token), t, t - policy.idleMs]);
      if (!r) return null;
      if (t - Number(r.session_seen) >= TOUCH_MS) {
        await db.run('UPDATE az_sessions SET last_seen_at = ? WHERE digest = ?', [t, d(token)]);
      }
      return { user: toUser(r), expiresAt: Number(r.session_expires) };
    },

    async deleteSession(token: string): Promise<void> {
      await db.run('DELETE FROM az_sessions WHERE digest = ?', [d(token)]);
    },

    /** After a password change every other session ends (backend-spec §5). */
    async deleteUserSessions(userId: string): Promise<void> {
      await db.run('DELETE FROM az_sessions WHERE user_id = ?', [userId]);
    },

    /**
     * A single-use token. A sign-in link also takes `binding`: a value the
     * requesting browser holds in a cookie, stored as its keyed digest, so
     * the link works only in that browser (login CSRF, auth-spec §3.4).
     */
    async createToken(userId: string, kind: TokenKind, site: string, binding?: string): Promise<string> {
      const token = randomToken();
      const t = now();
      await db.run(
        'INSERT INTO az_tokens (digest, user_id, kind, site, created_at, expires_at, used_at, binding) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)',
        [d(token), userId, kind, site, t, t + TOKEN_TTL_MS[kind], binding ? d(binding) : null]);
      return token;
    },

    /**
     * Spend a token: one conditional UPDATE, so it succeeds at most once.
     * `expired` covers used, expired, unknown and — for a link — the wrong
     * browser alike; the caller answers all of them the same way
     * (auth-spec §3.4: `expired_token`). A link without its binding never
     * spends, so a stranger's click cannot burn the owner's link either.
     */
    async spendToken(token: string, kind: TokenKind, binding?: string): Promise<{ userId: string; site: string } | 'expired'> {
      const t = now();
      if (kind === 'link' && !binding) return 'expired';
      const changed = kind === 'link'
        ? await db.run(
          'UPDATE az_tokens SET used_at = ? WHERE digest = ? AND kind = ? AND used_at IS NULL AND expires_at > ? AND binding = ?',
          [t, d(token), kind, t, d(binding as string)])
        : await db.run(
          'UPDATE az_tokens SET used_at = ? WHERE digest = ? AND kind = ? AND used_at IS NULL AND expires_at > ?',
          [t, d(token), kind, t]);
      if (changed !== 1) return 'expired';
      const r = await db.get('SELECT user_id, site FROM az_tokens WHERE digest = ?', [d(token)]);
      return r ? { userId: String(r.user_id), site: String(r.site) } : 'expired';
    },

    async oauthAccount(provider: string, subject: string): Promise<string | null> {
      const r = await db.get('SELECT user_id FROM az_oauth_accounts WHERE provider = ? AND subject = ?', [provider, subject]);
      return r ? String(r.user_id) : null;
    },

    async linkOAuth(provider: string, subject: string, userId: string): Promise<void> {
      try {
        await db.run('INSERT INTO az_oauth_accounts (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)', [provider, subject, userId, now()]);
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    },

    async putOAuthState(state: string, s: OAuthState): Promise<void> {
      await db.run(
        'INSERT INTO az_oauth_states (digest, provider, verifier, nonce, next_path, site, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [d(state), s.provider, s.verifier, s.nonce, s.next, s.site, now() + OAUTH_STATE_TTL_MS]);
    },

    /** Read AND delete: a state works once, and only before it expires. */
    async takeOAuthState(state: string): Promise<OAuthState | null> {
      const r = await db.get('SELECT * FROM az_oauth_states WHERE digest = ?', [d(state)]);
      if (!r) return null;
      const deleted = await db.run('DELETE FROM az_oauth_states WHERE digest = ?', [d(state)]);
      if (deleted !== 1 || Number(r.expires_at) <= now()) return null;
      return { provider: String(r.provider), verifier: String(r.verifier), nonce: String(r.nonce), next: String(r.next_path), site: String(r.site) };
    },

    /** Drop what can never be used again. Called on a timer. */
    async prune(): Promise<void> {
      const t = now();
      await db.run('DELETE FROM az_sessions WHERE expires_at <= ? OR COALESCE(last_seen_at, created_at) <= ?', [t, t - policy.idleMs]);
      await db.run('DELETE FROM az_tokens WHERE expires_at <= ? OR used_at IS NOT NULL', [t]);
      await db.run('DELETE FROM az_oauth_states WHERE expires_at <= ?', [t]);
    },
  };
}

export type Store = ReturnType<typeof createStore>;
