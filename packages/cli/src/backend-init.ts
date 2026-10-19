/**
 * @az module backend-init
 * Purpose: az backend init: the backend's .env, written once with a fresh secret, mode 0600.
 * Spec: docs/backend-spec.md §4
 * Exports: initBackendEnv
 * Edit guide: never overwrite an existing .env; never return or print the secret.
 * Tests: packages/cli/test/backend.test.ts
 */

/**
 * `az backend init` — the built-in backend's `.env`, written once.
 *
 * Shared by the CLI command and the `az_backend_init` MCP tool, so both apply
 * the same guards: the folder must be a built server/, an existing `.env` is
 * never replaced (a new secret would sign everyone out), and the file is
 * owner read/write only. The result names the file; it never carries the
 * secret.
 */

import { closeSync, existsSync, fchmodSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { envFile } from '../../backend/src/emit.ts';

export type BackendInitResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly kind: 'missing' | 'exists'; readonly message: string };

/** The server's database and email choices, or null when the file is not a valid config. */
function readSetup(file: string): { database: 'sqlite' | 'postgres' | 'mysql'; email?: 'smtp' | 'api'; data?: boolean; chat?: boolean } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const o = parsed as { database?: unknown; email?: unknown; data?: unknown; chat?: unknown } | null;
  const database = o?.database;
  const email = o?.email;
  if (database !== 'sqlite' && database !== 'postgres' && database !== 'mysql') return null;
  // No email: a server without accounts (chat-block-spec §19.15); any other value is not a config az wrote.
  if (email !== undefined && email !== 'smtp' && email !== 'api') return null;
  // A site with data tables lists their keys too (AZ_ADMIN_EMAILS).
  // A site with a chat lists the model keys (AZ_CHAT_…).
  return { database, ...(email !== undefined ? { email } : {}), ...(o?.data === true ? { data: true } : {}), ...(o?.chat === true ? { chat: true } : {}) };
}

export function initBackendEnv(dir: string): BackendInitResult {
  const configFile = join(dir, 'az.config.json');
  if (!existsSync(configFile)) {
    return { ok: false, kind: 'missing', message: `no az.config.json in ${dir} — point at the server/ folder az build wrote` };
  }
  const target = join(dir, '.env');
  const setup = readSetup(configFile);
  if (!setup) {
    return { ok: false, kind: 'missing', message: `${configFile} is not a config az wrote — rebuild the site to regenerate server/` };
  }
  // Created exclusively, in one step: an .env already there — or a link
  // where it would go — is never replaced or written through, and nothing
  // can appear between a check and the write.
  let fd: number;
  try {
    fd = openSync(target, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    return { ok: false, kind: 'exists', message: `${target} already exists — not overwritten (a new secret would sign everyone out)` };
  }
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, envFile(setup), 'utf8');
  } finally {
    closeSync(fd);
  }
  return { ok: true, path: target };
}
