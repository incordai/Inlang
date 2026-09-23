/**
 * The schema, as versioned steps per engine (backend-spec §3).
 *
 * A step is never edited once shipped — a change is a new step. Types are
 * chosen so the three engines hold the same values: times are epoch
 * milliseconds in a 64-bit integer, flags are 0/1, identifiers and digests
 * are bounded text (MySQL needs a length on anything indexed).
 *
 * Copied into a generated server; imports nothing.
 */

type PerEngine<T> = { readonly sqlite: T; readonly postgres: T; readonly mysql: T };

const MYSQL = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin';

export const MIGRATIONS: {
  readonly table: PerEngine<string>;
  readonly steps: readonly { version: number; sql: PerEngine<readonly string[]> }[];
} = {
  table: {
    sqlite: 'CREATE TABLE IF NOT EXISTS az_schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
    postgres: 'CREATE TABLE IF NOT EXISTS az_schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)',
    mysql: `CREATE TABLE IF NOT EXISTS az_schema_migrations (version INT PRIMARY KEY, applied_at BIGINT NOT NULL) ${MYSQL}`,
  },
  steps: [
    {
      version: 1,
      sql: {
        sqlite: [
          `CREATE TABLE az_users (
            id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
            password_hash TEXT, location TEXT, email_verified INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
          `CREATE TABLE az_sessions (
            digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES az_users(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
          'CREATE INDEX az_sessions_user ON az_sessions (user_id)',
          `CREATE TABLE az_tokens (
            digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES az_users(id) ON DELETE CASCADE,
            kind TEXT NOT NULL, site TEXT NOT NULL, created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL, used_at INTEGER)`,
          `CREATE TABLE az_oauth_accounts (
            provider TEXT NOT NULL, subject TEXT NOT NULL,
            user_id TEXT NOT NULL REFERENCES az_users(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL, PRIMARY KEY (provider, subject))`,
          `CREATE TABLE az_oauth_states (
            digest TEXT PRIMARY KEY, provider TEXT NOT NULL, verifier TEXT NOT NULL, nonce TEXT NOT NULL,
            next_path TEXT NOT NULL, site TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
        ],
        postgres: [
          `CREATE TABLE az_users (
            id VARCHAR(36) PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE, name VARCHAR(200) NOT NULL,
            password_hash VARCHAR(255), location VARCHAR(200), email_verified SMALLINT NOT NULL DEFAULT 0,
            created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)`,
          `CREATE TABLE az_sessions (
            digest CHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL REFERENCES az_users(id) ON DELETE CASCADE,
            created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)`,
          'CREATE INDEX az_sessions_user ON az_sessions (user_id)',
          `CREATE TABLE az_tokens (
            digest CHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL REFERENCES az_users(id) ON DELETE CASCADE,
            kind VARCHAR(16) NOT NULL, site VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL,
            expires_at BIGINT NOT NULL, used_at BIGINT)`,
          `CREATE TABLE az_oauth_accounts (
            provider VARCHAR(63) NOT NULL, subject VARCHAR(255) NOT NULL,
            user_id VARCHAR(36) NOT NULL REFERENCES az_users(id) ON DELETE CASCADE,
            created_at BIGINT NOT NULL, PRIMARY KEY (provider, subject))`,
          `CREATE TABLE az_oauth_states (
            digest CHAR(64) PRIMARY KEY, provider VARCHAR(63) NOT NULL, verifier VARCHAR(128) NOT NULL,
            nonce VARCHAR(128) NOT NULL, next_path VARCHAR(2048) NOT NULL, site VARCHAR(255) NOT NULL,
            expires_at BIGINT NOT NULL)`,
        ],
        mysql: [
          `CREATE TABLE az_users (
            id VARCHAR(36) PRIMARY KEY, email VARCHAR(254) NOT NULL UNIQUE, name VARCHAR(200) NOT NULL,
            password_hash VARCHAR(255), location VARCHAR(200), email_verified TINYINT NOT NULL DEFAULT 0,
            created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL) ${MYSQL}`,
          `CREATE TABLE az_sessions (
            digest CHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL,
            created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL,
            INDEX az_sessions_user (user_id),
            FOREIGN KEY (user_id) REFERENCES az_users(id) ON DELETE CASCADE) ${MYSQL}`,
          `CREATE TABLE az_tokens (
            digest CHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL,
            kind VARCHAR(16) NOT NULL, site VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL,
            expires_at BIGINT NOT NULL, used_at BIGINT,
            FOREIGN KEY (user_id) REFERENCES az_users(id) ON DELETE CASCADE) ${MYSQL}`,
          `CREATE TABLE az_oauth_accounts (
            provider VARCHAR(63) NOT NULL, subject VARCHAR(255) NOT NULL, user_id VARCHAR(36) NOT NULL,
            created_at BIGINT NOT NULL, PRIMARY KEY (provider, subject),
            FOREIGN KEY (user_id) REFERENCES az_users(id) ON DELETE CASCADE) ${MYSQL}`,
          `CREATE TABLE az_oauth_states (
            digest CHAR(64) PRIMARY KEY, provider VARCHAR(63) NOT NULL, verifier VARCHAR(128) NOT NULL,
            nonce VARCHAR(128) NOT NULL, next_path VARCHAR(2048) NOT NULL, site VARCHAR(255) NOT NULL,
            expires_at BIGINT NOT NULL) ${MYSQL}`,
        ],
      },
    },
  ],
};
