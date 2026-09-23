/**
 * `az backend init` — the built-in backend's `.env`, written once.
 *
 * Shared by the CLI command and the `az_backend_init` MCP tool, so both apply
 * the same guards: the folder must be a built server/, an existing `.env` is
 * never replaced (a new secret would sign everyone out), and the file is
 * owner read/write only. The result names the file; it never carries the
 * secret.
 */

import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { envFile } from '../../backend/src/emit.ts';

export type BackendInitResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly kind: 'missing' | 'exists'; readonly message: string };

export function initBackendEnv(dir: string): BackendInitResult {
  const configFile = join(dir, 'az.config.json');
  if (!existsSync(configFile)) {
    return { ok: false, kind: 'missing', message: `no az.config.json in ${dir} — point at the server/ folder az build wrote` };
  }
  const target = join(dir, '.env');
  if (existsSync(target)) {
    return { ok: false, kind: 'exists', message: `${target} already exists — not overwritten (a new secret would sign everyone out)` };
  }
  const setup = JSON.parse(readFileSync(configFile, 'utf8')) as { database: 'sqlite' | 'postgres' | 'mysql'; email: 'smtp' | 'api' };
  writeFileSync(target, envFile({ database: setup.database, email: setup.email }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(target, 0o600);
  return { ok: true, path: target };
}
