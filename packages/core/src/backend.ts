/**
 * @az module backend
 * Purpose: the `backend` declaration as data: closed choices for database and email.
 * Spec: docs/backend-spec.md §2
 * Exports: BACKEND_SETTINGS, BACKEND_DATABASES, BACKEND_EMAIL, SpecBackend
 * Edit guide: a new choice needs the server (packages/backend) to support it and a describe.ts row.
 * Tests: packages/core/test/backend-decl.test.ts
 */

/**
 * The optional built-in backend — its declaration, as data (backend-spec §2).
 *
 * `backend` is a site-level structure keyword, not a block: it renders
 * nothing and does not count against the eleven-block cap. It names only
 * CHOICES — which database engine, which way email leaves. Connection
 * strings, passwords and keys never appear in a `.az` file; they live in the
 * backend's environment (backend-spec §4), which is why a value here is one
 * of a closed set rather than free text.
 */

export const BACKEND_DATABASES = ['sqlite', 'postgres', 'mysql'] as const;
export type BackendDatabase = (typeof BACKEND_DATABASES)[number];

export const BACKEND_EMAIL = ['smtp', 'api'] as const;
export type BackendEmail = (typeof BACKEND_EMAIL)[number];

/** The settings a `backend` declaration takes, and the choices each allows. */
export const BACKEND_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  database: BACKEND_DATABASES,
  email: BACKEND_EMAIL,
};

export interface SpecBackend {
  readonly database: BackendDatabase;
  readonly email: BackendEmail;
}
