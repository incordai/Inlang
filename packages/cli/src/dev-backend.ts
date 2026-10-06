/**
 * @az module dev-backend
 * Purpose: the real backend run locally with a dev profile: SQLite, dev secret, local mailbox.
 * Spec: docs/backend-spec.md §2a
 * Exports: startDevBackend, startMailbox, devBackendEnv, assertLoopback
 * Edit guide: loopback only; dev settings never reach a production build.
 * Tests: packages/cli/test/dev-serve.test.ts, packages/cli/test/dev-mailbox-security.test.ts
 */

/**
 * The backend for `az dev` — the real server, run with a development profile.
 *
 * `az build` + `az backend init` is the production path and is untouched.
 * For local work the same server modules the generated `server/` runs
 * (backend-spec §8) are composed here with settings derived for this machine,
 * so a site that declares `backend` works with no `.env` at all:
 *
 *   - SQLite in `<project>/.az-dev/dev.db`, whatever database the site
 *     declares — nothing to install or run
 *   - a per-project session secret generated once into `.az-dev/` (0600)
 *   - every URL on 127.0.0.1, the only interface anything here listens on
 *   - email delivered to a DEV MAILBOX instead of the world: the real `api`
 *     mailer posts to a loopback endpoint that prints each message to the
 *     terminal and lists it on a local page
 *
 * None of this ships. It lives in the CLI, which a build never copies — the
 * generated server has no mailbox, no dev profile and no loopback override.
 * Optional extra keys (a provider for social sign-in, say) go in
 * `.az-dev/backend.env`; they apply to this dev server only.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp, type DataRoutes } from '../../backend/src/server/app.ts';
import { migrate, openSqlite } from '../../backend/src/server/db.ts';
import { createData, parseAdminEmails } from '../../backend/src/server/data-api.ts';
import { migrateData, type DataStep } from '../../backend/src/server/data-migrate.ts';
import { loadTables, ownedRowDeletes } from '../../backend/src/server/data-values.ts';
import { createMailer } from '../../backend/src/server/email.ts';
import { loadConfig } from '../../backend/src/server/env.ts';
import { createOidc } from '../../backend/src/server/oidc.ts';
import { createStore } from '../../backend/src/server/store.ts';

/** Development state beside the project; ignores itself so it is never committed. */
export const DEV_DIR = '.az-dev';
/** The one interface every dev server binds. */
export const LOOPBACK = '127.0.0.1';
/** Largest message body the mailbox accepts — a reset email is a few hundred bytes. */
const MAILBOX_MAX_BYTES = 64 * 1024;
/** Messages kept for the mailbox page; older ones drop off. */
const MAILBOX_KEEP = 100;

/** Refuse anything but the loopback interface — a dev server must never face a network. */
export function assertLoopback(host: string): void {
  if (host !== LOOPBACK) throw new Error(`dev servers bind ${LOOPBACK} only, not '${host}'`);
}

/** `.az-dev/`, created on first use with a `.gitignore` that ignores everything in it. */
export function devDir(projectDir: string): string {
  const dir = join(projectDir, DEV_DIR);
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# az dev state — never commit\n*\n', 'utf8');
  return dir;
}

/** The project's dev session secret: generated once, readable by its owner only. */
export function devSecret(dir: string): string {
  const file = join(dir, 'secret');
  if (!existsSync(file)) writeFileSync(file, `${randomBytes(32).toString('base64url')}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(file, 0o600);
  return readFileSync(file, 'utf8').trim();
}

/** `KEY=value` lines of an optional env file; comments and blanks ignored. */
export function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

export interface DevPorts {
  readonly site: number;
  readonly backend: number;
  readonly mailbox: number;
}

/**
 * The server's environment for local development. The wired keys always win
 * over `.az-dev/backend.env`: a stray production URL or database there must
 * not turn the dev server into a client of something real.
 */
export function devBackendEnv(
  ports: DevPorts, secret: string, sqlitePath: string, mailboxKey: string, extra: Record<string, string> = {},
): Record<string, string> {
  return {
    ...extra,
    AZ_SESSION_SECRET: secret,
    AZ_BACKEND_PUBLIC_URL: `http://${LOOPBACK}:${ports.backend}`,
    AZ_ALLOWED_ORIGINS: `http://${LOOPBACK}:${ports.site}`,
    AZ_HOST: LOOPBACK,
    AZ_PORT: String(ports.backend),
    AZ_TRUST_PROXY: 'false',
    AZ_COOKIE_SAMESITE: 'lax',
    AZ_SQLITE_PATH: sqlitePath,
    AZ_EMAIL_FROM: extra.AZ_EMAIL_FROM || 'Local dev <dev@localhost>',
    AZ_EMAIL_API_URL: `http://${LOOPBACK}:${ports.mailbox}/send`,
    AZ_EMAIL_API_KEY: mailboxKey,
  };
}

export interface MailboxMessage {
  readonly at: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A message's text as HTML: escaped, with http(s) links made clickable. */
function messageHtml(text: string): string {
  return escapeHtml(text).replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}">${url}</a>`);
}

function mailboxPage(messages: readonly MailboxMessage[]): string {
  const items = messages.length === 0
    ? '<p>No email yet. Request a password reset or a sign-in link and it appears here.</p>'
    : messages.map((m) => `<article><h2>${escapeHtml(m.subject)}</h2>`
      + `<p class="meta">To ${escapeHtml(m.to)} · ${escapeHtml(m.at)}</p><pre>${messageHtml(m.text)}</pre></article>`).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>az dev mailbox</title>
<meta name="color-scheme" content="light dark"><meta http-equiv="refresh" content="5">
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem}
article{border-top:1px solid;padding:1rem 0}.meta{opacity:.7;margin:0}pre{white-space:pre-wrap}</style></head>
<body><h1>az dev mailbox</h1><p>Email the local backend sent. Nothing here left this machine.</p>
${items}</body></html>`;
}

export interface Mailbox {
  readonly url: string;
  readonly key: string;
  readonly messages: MailboxMessage[];
  close(): Promise<void>;
}

/**
 * The dev mailbox: an email API on loopback (backend-spec §7's `api` shape,
 * POST { from, to, subject, text } with a bearer key) that keeps messages
 * instead of delivering them, prints each to the terminal, and lists them at
 * `/` for a browser. The key is per run, so nothing else on the machine can
 * post into it.
 */
export function startMailbox(port: number, print: (line: string) => void, host = LOOPBACK): Promise<Mailbox> {
  assertLoopback(host);
  const key = randomBytes(24).toString('base64url');
  const messages: MailboxMessage[] = [];
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // `GET //` is a request line the URL parser rejects; answered, never thrown.
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://x').pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    // Reads are for a browser on THIS machine at THIS address. A page on
    // another site that rebinds its own host name to 127.0.0.1 sends its
    // own name as Host, so anything but the loopback address is refused —
    // otherwise it could read the reset and sign-in links listed here.
    if (req.method === 'GET' && req.headers.host !== `${host}:${port}`) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(mailboxPage(messages));
      return;
    }
    if (req.method === 'GET' && path === '/messages.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(messages));
      return;
    }
    if (req.method !== 'POST' || path !== '/send') {
      res.writeHead(404).end();
      return;
    }
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401).end();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAILBOX_MAX_BYTES) { res.writeHead(413).end(); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      let body: Record<string, unknown>;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>; } catch { res.writeHead(400).end(); return; }
      const field = (k: string) => (typeof body[k] === 'string' ? body[k] as string : '');
      const message = { at: new Date().toISOString(), to: field('to'), subject: field('subject'), text: field('text') };
      messages.unshift(message);
      messages.length = Math.min(messages.length, MAILBOX_KEEP);
      const link = /https?:\/\/\S+/.exec(message.text)?.[0];
      print(`az dev: email to ${message.to} — ${message.subject}${link ? `\n        ${link}` : ''}`);
      res.writeHead(202, { 'content-type': 'application/json' }).end('{}');
    });
  });
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => done({
      url: `http://${host}:${port}/`,
      key,
      messages,
      close: () => new Promise<void>((closed) => server.close(() => closed())),
    }));
  });
}

/** A Set-Cookie value (or values) without the `Secure` attribute. */
export function withoutSecure(value: string | string[]): string | string[] {
  const strip = (v: string) => v.replace(/;\s*Secure(?=;|$)/gi, '');
  return Array.isArray(value) ? value.map(strip) : strip(value);
}

/**
 * Dev-only: send this response's cookies without `Secure`.
 *
 * The production server always marks its cookies Secure (backend-spec §5),
 * and it stays that way. On http://127.0.0.1 Chromium and Firefox keep a
 * Secure cookie — loopback counts as a secure context — but WebKit drops it,
 * so signing in would silently fail there. The dev server listens on loopback
 * only (assertLoopback) and exists only inside `az dev`, so the attribute is
 * lifted here and nowhere else.
 */
function loopbackCookies(res: ServerResponse): void {
  const writeHead = res.writeHead.bind(res) as (...a: unknown[]) => ServerResponse;
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    const headers = rest.find((r) => r && typeof r === 'object') as Record<string, string | string[]> | undefined;
    if (headers) {
      for (const key of Object.keys(headers)) {
        if (key.toLowerCase() === 'set-cookie') headers[key] = withoutSecure(headers[key]);
      }
    }
    return writeHead(status, ...rest);
  }) as ServerResponse['writeHead'];
}

export interface DevBackend {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Start the site's backend for local development: the real app, store,
 * migrations and mailer, over SQLite in `.az-dev/`, mailing into the mailbox.
 * Refuses to start — naming each problem — exactly as the production server
 * would, if `.az-dev/backend.env` holds something invalid.
 */
export async function startDevBackend(
  projectDir: string, siteName: string, ports: DevPorts, mailbox: Mailbox, print: (line: string) => void,
  /** The build's `server/data.json`, when the site declares tables. */
  dataJson?: string,
): Promise<DevBackend> {
  const dir = devDir(projectDir);
  const env = devBackendEnv(ports, devSecret(dir), join(dir, 'dev.db'), mailbox.key, readEnvFile(join(dir, 'backend.env')));
  // The dev profile always runs SQLite and the mailbox, whatever the site
  // declares for production — so its checks are the ones for that setup.
  const loaded = loadConfig(env, { database: 'sqlite', email: 'api' }, siteName);
  if (!loaded.ok) {
    throw new Error(`the dev backend cannot start — fix these in ${DEV_DIR}/backend.env:\n${loaded.problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  const { config } = loaded;
  assertLoopback(config.host);
  const db = await openSqlite(config.sqlitePath);
  await migrate(db);
  let data: DataRoutes | undefined;
  let ownedRows: string[] = [];
  if (dataJson !== undefined) {
    // AZ_ADMIN_EMAILS in backend.env names the dev admins (data-spec §11).
    const admins = parseAdminEmails(env.AZ_ADMIN_EMAILS);
    if (!admins.ok) throw new Error(`the dev backend cannot start — fix this in ${DEV_DIR}/backend.env:\n  - ${admins.problem}`);
    // The dev database is disposable (data-spec §6.3): every step applies,
    // the destructive ones too — and what they did is said, not hidden.
    const model = JSON.parse(dataJson) as { steps: DataStep[] };
    const applied = await migrateData(db, model.steps, { confirm: Infinity });
    for (const step of model.steps.filter((s) => applied.includes(s.version))) {
      print(`az dev: applied data step ${step.version} to ${DEV_DIR}/dev.db: ${step.summary.join('; ')}${step.destructive ? ' (data dropped or changed)' : ''}`);
    }
    const tables = loadTables(model);
    ownedRows = ownedRowDeletes(db.dialect, tables);
    data = createData({ db, tables, admins: admins.emails });
  }
  const store = createStore(db, config.secret, Date.now, { idleMs: config.sessionIdleMs, maxMs: config.sessionMaxMs }, ownedRows);
  const app = createApp({
    config, store,
    ...(data ? { data } : {}),
    mailer: await createMailer(config),
    oidc: createOidc((...a) => fetch(...a)),
    log: (line) => print(`backend: ${line}`),
    // Cookies here go out without Secure (loopbackCookies), and the __Host- /
    // __Secure- prefixes require it — so dev uses the bare names.
    plainCookieNames: true,
  });
  const server = createServer((req, res) => {
    loopbackCookies(res);
    void app.handler(req, res);
  });
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(config.port, config.host, () => done());
  });
  return {
    url: config.publicUrl,
    close: () => new Promise<void>((closed) => server.close(() => { void db.close().then(() => closed()); })),
  };
}
