/**
 * @az module backend
 * Purpose: the `backend` declaration as data: closed choices for database, email and model.
 * Spec: docs/backend-spec.md §2 · docs/chat-block-spec.md §3.1
 * Exports: BACKEND_SETTINGS, BACKEND_REQUIRED, BACKEND_HINTS, BACKEND_DATABASES, BACKEND_EMAIL, BACKEND_MODEL, SpecBackend
 * Edit guide: a new choice needs the server (packages/backend) to support it and a describe.ts row.
 * Tests: packages/core/test/backend-decl.test.ts
 */

/**
 * The optional built-in backend — its declaration, as data (backend-spec §2).
 *
 * `backend` is a site-level structure keyword, not a block: it renders
 * nothing and does not count against the block cap. It names only
 * CHOICES — which database engine, which way email leaves, whether the
 * server talks to a model. Connection strings, passwords, keys and model ids
 * never appear in a `.az` file; they live in the backend's environment
 * (backend-spec §4), which is why a value here is one of a closed set rather
 * than free text.
 */

export const BACKEND_DATABASES = ['sqlite', 'postgres', 'mysql'] as const;
export type BackendDatabase = (typeof BACKEND_DATABASES)[number];

export const BACKEND_EMAIL = ['smtp', 'api'] as const;
export type BackendEmail = (typeof BACKEND_EMAIL)[number];

/**
 * `model default` (chat-block-spec §3.1): the server talks to a model, and
 * the operator picks which one in the server's `.env`. One value on purpose:
 * it makes "this server calls a model" visible in the file and keeps every
 * provider and model id out of it.
 */
export const BACKEND_MODEL = ['default'] as const;
export type BackendModel = (typeof BACKEND_MODEL)[number];

/** The settings a `backend` declaration takes, and the choices each allows. */
export const BACKEND_SETTINGS: Readonly<Record<string, readonly string[]>> = {
  database: BACKEND_DATABASES,
  email: BACKEND_EMAIL,
  model: BACKEND_MODEL,
};

/** The settings every declaration must name; `model` is written only by a site with chat. */
export const BACKEND_REQUIRED: readonly string[] = ['database', 'email'];

/**
 * What a value outside a setting's choices is told, when there is more to
 * say than the list: a model id or an endpoint is the operator's, not the
 * file's (chat-block-spec §3.1).
 */
export const BACKEND_HINTS: Readonly<Record<string, string>> = {
  model: "backend: the model is chosen in the server's .env (AZ_CHAT_API, AZ_CHAT_MODEL) — write: model default",
};

export interface SpecBackend {
  readonly database: BackendDatabase;
  readonly email: BackendEmail;
  /** Present only when the file writes `model default`, so a site without chat serialises as before. */
  readonly model?: BackendModel;
}
