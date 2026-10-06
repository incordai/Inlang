/**
 * The generated server's entry point (main.ts), started for real: a data
 * migration that fails in a way no guard foresaw stops the server with one
 * named line and a non-zero exit — never an unhandled rejection, whose stack
 * and driver message can quote a row's value (data-spec §18).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const SERVER_SRC = fileURLToPath(new URL('../src/server/', import.meta.url));
/** A start that hangs is a failure, not a wait. */
const START_MS = 20_000;

/** A server folder whose data step fails on its second statement. */
function brokenServer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'az-main-'));
  cpSync(SERVER_SRC, join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'az.config.json'), JSON.stringify({ siteName: 'Shop', database: 'sqlite', email: 'smtp', data: true }));
  const units = [
    { sql: 'CREATE TABLE azd_probe (v TEXT UNIQUE)' },
    { sql: "INSERT INTO azd_probe (v) VALUES ('KEEP-OUT-OF-LOGS'), ('KEEP-OUT-OF-LOGS')" },
  ];
  writeFileSync(join(dir, 'data.json'), JSON.stringify({
    tables: [],
    steps: [{ version: 1, destructive: false, summary: ['probe'], units: { sqlite: units, postgres: units, mysql: units } }],
  }));
  return dir;
}

test('a data migration failure no guard foresaw: one named line, exit 1, no stack (review #2)', () => {
  const dir = brokenServer();
  const r = spawnSync(process.execPath, ['src/main.ts'], {
    cwd: dir,
    encoding: 'utf8',
    timeout: START_MS,
    killSignal: 'SIGKILL',
    env: {
      PATH: process.env.PATH,
      AZ_SESSION_SECRET: randomBytes(32).toString('base64url'),
      AZ_BACKEND_PUBLIC_URL: 'http://localhost:8787', AZ_ALLOWED_ORIGINS: 'http://localhost:5173', AZ_PORT: '18787',
      AZ_SQLITE_PATH: join(dir, 'data/app.db'),
      AZ_EMAIL_FROM: 'Shop <no-reply@shop.test>', AZ_SMTP_HOST: '127.0.0.1', AZ_SMTP_PORT: '2525',
    },
  });
  assert.equal(r.signal, null, `it stopped by itself: ${r.stderr}`);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^backend: cannot start — the data migration failed \(Error[^)]*\) — fix the database, then start again\n$/m);
  assert.doesNotMatch(r.stderr, /\n\s+at /, 'no stack');
  assert.doesNotMatch(r.stderr, /KEEP-OUT-OF-LOGS|UNIQUE constraint/, 'no driver message');
});
