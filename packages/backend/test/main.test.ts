/**
 * The generated server's entry point (main.ts), started for real: a data
 * migration that fails in a way no guard foresaw stops the server with one
 * named line and a non-zero exit — never an unhandled rejection, whose stack
 * and driver message can quote a row's value (data-spec §18); and a request
 * Node cannot parse, sent over raw TCP to the started server, is answered
 * with every security header (backend-spec §5).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { SECURITY_HEADERS } from '../src/server/http.ts';

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

/** One raw exchange, or the server's stop after SIGTERM, may take this long before it is given up. */
const RAW_MS = 5_000;
const STOP_MS = 5_000;

/** A port free on the loopback right now, for the server to listen on. */
const freePort = () => new Promise<number>((ok, fail) => {
  const probe = createServer();
  probe.once('error', fail);
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address() as AddressInfo; probe.close(() => ok(port)); });
});

/** Sends `bytes` over a bare TCP connection; what came back, and whether the server closed it in time. */
function rawExchange(port: number, bytes: string): Promise<{ answer: string; closed: boolean }> {
  return new Promise((done, fail) => {
    const s = connect(port, '127.0.0.1', () => s.write(bytes));
    let answer = '';
    const timer = setTimeout(() => { s.destroy(); done({ answer, closed: false }); }, RAW_MS);
    s.on('data', (c) => { answer += c; });
    s.on('close', () => { clearTimeout(timer); done({ answer, closed: true }); });
    s.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'ECONNRESET') { clearTimeout(timer); fail(e); } });
  });
}

/** The header block of a raw answer, by lower-cased name. */
const headersOf = (answer: string) => new Map(answer.split('\r\n\r\n')[0]!.split('\r\n').slice(1)
  .map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()] as const));

const MARKER = 'probe-marker-5c1e';

test('SECURITY the started server: a request Node cannot parse, over raw TCP, is answered with every security header', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'az-main-raw-'));
  cpSync(SERVER_SRC, join(dir, 'src'), { recursive: true });
  // The email API way: the server then needs no package beyond Node's own.
  writeFileSync(join(dir, 'az.config.json'), JSON.stringify({ siteName: 'Shop', database: 'sqlite', email: 'api' }));
  const port = await freePort();
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH,
      AZ_SESSION_SECRET: randomBytes(32).toString('base64url'),
      AZ_BACKEND_PUBLIC_URL: `http://127.0.0.1:${port}`, AZ_ALLOWED_ORIGINS: 'http://localhost:5173', AZ_PORT: String(port),
      AZ_SQLITE_PATH: join(dir, 'data/app.db'),
      AZ_EMAIL_FROM: 'Shop <no-reply@shop.test>', AZ_EMAIL_API_URL: 'https://mail.invalid/send', AZ_EMAIL_API_KEY: '<PLACEHOLDER>',
    },
  });
  let log = '';
  const exited = new Promise<void>((ok) => child.once('exit', () => ok()));
  try {
    const listening = await new Promise<boolean>((ok) => {
      const timer = setTimeout(() => ok(false), START_MS);
      const read = (c: Buffer) => {
        log += c;
        if (log.includes('backend: listening on')) { clearTimeout(timer); ok(true); }
      };
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.once('exit', () => { clearTimeout(timer); ok(false); });
    });
    assert.ok(listening, `the server started: ${log}`);

    const cases = [
      { what: 'a malformed request line', bytes: `GET /${MARKER} NOT-HTTP\r\nHost: ${MARKER}\r\n\r\n`, status: /^HTTP\/1\.1 400 Bad Request\r\n/ },
      // Past Node's default 16 KiB header limit.
      { what: 'an oversized header', bytes: `GET / HTTP/1.1\r\nHost: localhost\r\nX-Big: ${MARKER}${'a'.repeat(20 * 1024)}\r\n\r\n`, status: /^HTTP\/1\.1 431 Request Header Fields Too Large\r\n/ },
    ];
    for (const c of cases) {
      const { answer, closed } = await rawExchange(port, c.bytes);
      assert.match(answer, c.status, `${c.what}: ${answer.split('\r\n')[0]}`);
      const h = headersOf(answer);
      for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(h.get(k), v, `${c.what}: ${k}`);
      assert.equal(h.get('connection'), 'close', c.what);
      assert.equal(answer.split('\r\n\r\n')[1], '', `${c.what}: no body`);
      assert.ok(!answer.includes(MARKER), `${c.what}: nothing the client sent comes back`);
      assert.ok(closed, `${c.what}: the server closed the connection`);
    }
    // CONTROL: the same server answers a well-formed request from its routes.
    const { answer } = await rawExchange(port, 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.match(answer, /^HTTP\/1\.1 200 OK\r\n/, answer.split('\r\n')[0]);
  } finally {
    child.kill('SIGTERM');
    const stopped = await Promise.race([exited.then(() => true), new Promise<boolean>((ok) => setTimeout(() => ok(false), STOP_MS).unref())]);
    if (!stopped) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
