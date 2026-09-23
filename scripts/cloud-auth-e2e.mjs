/**
 * The hosted adapter's token-endpoint profile against the REAL server
 * software — auth-block-spec §3.5, ROADMAP M4.
 *
 * No account is needed: the open-source identity server that a managed
 * cloud runs is published as a container image, so this starts it in
 * Docker with its own Postgres, points its SMTP at a local capture server
 * (so reset and sign-in emails are real messages), compiles a site that
 * uses `adapter hosted` + `profile token-endpoint`, and drives that site in
 * a browser: sign-up, sign-in, the session on a protected page, sign-out,
 * the wrong-password copy, reset through the captured email, and a
 * sign-in link.
 *
 * Every secret is generated for this run and discarded. Containers are
 * removed on exit, pass or fail.
 *
 *     node scripts/cloud-auth-e2e.mjs        (pnpm test:cloud-auth)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { existsSync, mkdtempSync, readFile as readFileCb, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const readFile = promisify(readFileCb);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(ROOT, 'packages/cli/bin/az.js');

/**
 * The server's image, database setup and settings are DATA, kept in docs/
 * (the reference configuration for docs/cloud-setup.md), so this code names
 * no product. Image tags there are exact pins.
 */
const SERVER = JSON.parse(readFileSync(join(ROOT, 'docs/reference/token-endpoint-server.json'), 'utf8'));
/** Fill {{NAME}} placeholders; an unknown one is an error, never left in. */
const fill = (text, values) => text.replace(/\{\{([A-Z_]+)\}\}/g, (_, k) => {
  if (!(k in values)) throw new Error(`reference config: no value for {{${k}}}`);
  return values[k];
});
const READY_TIMEOUT_MS = 120_000;
const START_ATTEMPTS = 3;
const MAIL_TIMEOUT_MS = 20_000;
const PASSWORD = 'a-long-enough-password';

const DOCKER = ['docker', '/Applications/Docker.app/Contents/Resources/bin/docker', '/usr/local/bin/docker']
  .find((d) => spawnSync(d, ['info'], { stdio: 'ignore' }).status === 0);
if (!DOCKER) {
  console.error('cloud-auth: Docker is not available — start it, or run this where it is');
  process.exit(2);
}
const docker = (...args) => execFileSync(DOCKER, args, { encoding: 'utf8' }).trim();

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? `   ${detail}` : ''}`);
};

async function until(fn, what, timeout = READY_TIMEOUT_MS) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try { return await fn(); } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} not ready: ${last?.message}`);
}

/** `docker run`, retried with a short backoff — the daemon has been flaky here. */
async function run(...args) {
  for (let attempt = 1; ; attempt++) {
    try {
      return docker('run', '-d', '--rm', ...args);
    } catch (e) {
      if (attempt >= START_ATTEMPTS) throw e;
      await new Promise((r) => setTimeout(r, attempt * 2000));
    }
  }
}

const freePort = () => new Promise((done) => {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); });
});

/** An HS256 token — the public (anon) key is one, signed with this run's secret. */
const b64u = (v) => Buffer.from(v).toString('base64url');
function sign(payload, secret) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')}`;
}

/** Test-only SMTP listener: keeps each message it is handed. */
function startSmtpCapture() {
  const messages = [];
  const server = createNetServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    let data = false;
    let body = '';
    socket.write('220 capture ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; messages.push(decodeMessage(body)); body = ''; socket.write('250 queued\r\n'); }
          else body += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250 capture\r\n');
        else if (verb === 'DATA') { data = true; socket.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 ok\r\n');
      }
    });
  });
  // All interfaces: the server in its container reaches it through the host gateway.
  return new Promise((done) => server.listen(0, '0.0.0.0', () =>
    done({ port: server.address().port, messages, close: () => server.close() })));
}

function decodeMessage(raw) {
  const text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  const decoded = /quoted-printable/i.test(raw)
    ? text.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    : text;
  return decoded.replace(/&amp;/g, '&');
}

/** A built site, served statically at a fixed port the server allows redirects to. */
function startSite(root, port) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const candidates = extname(path) ? [path] : [join(path, 'index.html')];
    for (const rel of candidates) {
      const file = normalize(join(root, rel));
      if (!file.startsWith(root + sep)) break;
      try {
        const body = await readFile(file);
        const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'application/octet-stream';
        res.writeHead(200, { 'content-type': type }).end(body);
        return;
      } catch { /* next candidate */ }
    }
    res.writeHead(404).end();
  });
  return new Promise((done) => server.listen(port, '127.0.0.1', () => done({ url: `http://127.0.0.1:${port}`, close: () => server.close() })));
}

const SITE = `az 1

site studio
  auth
    adapter hosted
    profile token-endpoint
    protect /account

page /
  hero center
    title "The studio"

page /login
  auth login
    title    "Welcome back"
    methods  password link
    redirect /account
    alt      "Create an account" /signup
    alt      "Forgot your password" /reset

page /signup
  auth signup
    redirect /account
    terms    /terms
    alt      "Sign in instead" /login

page /reset
  auth reset
    alt "Back to sign in" /login

page /terms
  text
    title "Terms"
    body  "Be kind."

page /account
  hero center
    title "Your orders"
`;

/* ---- the run ------------------------------------------------------------- */

const secret = randomBytes(32).toString('hex');
const dbPassword = randomBytes(12).toString('hex');
const network = `az-cloud-auth-${randomBytes(4).toString('hex')}`;
const containers = [];
const cleanups = [];
const work = mkdtempSync(join(tmpdir(), 'az-cloud-auth-'));

try {
  const smtp = await startSmtpCapture();
  cleanups.push(() => smtp.close());
  const sitePort = await freePort();
  const siteUrl = `http://127.0.0.1:${sitePort}`;
  // The server's public address is fixed before it starts: its emailed links
  // point at it, so the browser must be able to follow them.
  const authPort = await freePort();
  const authUrl = `http://127.0.0.1:${authPort}`;

  docker('network', 'create', network);

  const values = {
    DB_USER: SERVER.database.user, DB_SCHEMA: SERVER.database.schema, DB_PASSWORD: dbPassword,
    DB_HOST: `${network}-db`, SITE_URL: siteUrl, JWT_SECRET: secret,
    SMTP_HOST: 'host.docker.internal', SMTP_PORT: String(smtp.port), EXTERNAL_URL: authUrl,
  };
  // Postgres with the schema and role the server's own development setup
  // prepares; the server runs its migrations on start.
  writeFileSync(join(work, 'init.sql'), SERVER.initSql.map((line) => fill(line, values)).join('\n'));
  const db = await run('--network', network, '--name', `${network}-db`, '-e', `POSTGRES_PASSWORD=${dbPassword}`,
    '-v', `${join(work, 'init.sql')}:/docker-entrypoint-initdb.d/init.sql:ro`, SERVER.database.image);
  containers.push(db);
  await until(async () => {
    const r = spawnSync(DOCKER, ['exec', db, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' });
    if (r.status !== 0) throw new Error('pg_isready');
  }, 'postgres');

  const serverEnv = Object.entries(SERVER.env).flatMap(([k, v]) => ['-e', `${k}=${fill(v, values)}`]);
  const auth = await run('--network', network, '-p', `127.0.0.1:${authPort}:${SERVER.port}`,
    '--add-host', 'host.docker.internal:host-gateway', ...serverEnv, SERVER.image);
  containers.push(auth);
  cleanups.unshift(() => { if (failures > 0) { try { console.log(docker('logs', '--tail', '40', auth)); } catch { /* gone */ } } });
  await until(async () => {
    const r = await fetch(`${authUrl}/health`);
    if (!r.ok) throw new Error(String(r.status));
  }, 'the identity server');
  console.log(`identity server ${SERVER.image} at ${authUrl}; site at ${siteUrl}\n`);

  // The public key: a token with the anonymous role, as a managed project issues.
  const anon = sign({ role: 'anon', iss: 'az-test', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }, secret);

  // Compile and build the site with the PUBLIC values only.
  writeFileSync(join(work, 'site.az'), SITE);
  const env = { ...process.env, AZ_WORDS: join(ROOT, 'packages/words'), AZ_PUBLIC_AUTH_URL: authUrl, AZ_PUBLIC_AUTH_KEY: anon };
  execFileSync(process.execPath, [CLI, 'build', join(work, 'site.az'), '--out', join(work, 'proj')], { env, stdio: 'pipe' });
  const npmCli = [join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), join(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')]
    .find((c) => existsSync(c));
  execFileSync(process.execPath, [npmCli, 'install', '--no-audit', '--no-fund'], { cwd: join(work, 'proj'), env, stdio: 'pipe' });
  execFileSync(process.execPath, [join(work, 'proj/node_modules/vite/bin/vite.js'), 'build', '--logLevel', 'error'], { cwd: join(work, 'proj'), env, stdio: 'pipe' });
  const site = await startSite(join(work, 'proj/dist'), sitePort);
  cleanups.push(() => site.close());

  const mailAfter = async (n) => {
    const stop = Date.now() + MAIL_TIMEOUT_MS;
    while (smtp.messages.length < n && Date.now() < stop) await new Promise((r) => setTimeout(r, 200));
    return smtp.messages[n - 1] ?? '';
  };
  const linkIn = (text) => (/(https?:\/\/[^\s"'<>]+\/verify\?[^\s"'<>]+)/.exec(text) ?? [])[1] ?? null;

  // The browser's cross-origin preflight must allow the two headers the
  // adapter sends (see corsNote in the reference config).
  {
    const r = await fetch(`${authUrl}/token`, { method: 'OPTIONS', headers: {
      origin: siteUrl, 'access-control-request-method': 'POST', 'access-control-request-headers': 'apikey,authorization,content-type' } });
    check('the server allows the adapter\'s headers from the site\'s origin (CORS preflight)',
      r.headers.get('access-control-allow-origin') !== null, `allow-headers: ${r.headers.get('access-control-allow-headers')}`);
  }

  const browser = await chromium.launch();
  cleanups.unshift(() => browser.close());
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Sign-up: the retyped password and the profile reach the server.
  await page.goto(`${siteUrl}/signup/`);
  await page.fill('input[name="name"]', 'Ada');
  await page.fill('input[name="email"]', 'ada@studio.test');
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="passwordConfirm"]', PASSWORD);
  await page.check('input[name="terms"]');
  await page.click('form[data-flow="signup"] button[type="submit"]');
  const onAccount = () => new URL(page.url()).pathname.replace(/\/$/, '') === '/account';
  await page.waitForURL((u) => u.pathname.replace(/\/$/, '') === '/account', { timeout: 15_000 }).catch(() => {});
  check('sign-up creates the account on the real server and signs in', onAccount(), page.url());
  check('the protected page shows the signed-in address', await page.getByText('Signed in as ada@studio.test').isVisible().catch(() => false));

  // Sign-out ends it, locally and on the server.
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(`${siteUrl}/login/`, { timeout: 15_000 }).catch(() => {});
  check('sign-out returns to the login page', page.url().startsWith(`${siteUrl}/login`), page.url());

  // A wrong password shows the closed set's copy, not the server's words.
  await page.fill('form[data-flow="login"] input[name="email"]', 'ada@studio.test');
  await page.fill('form[data-flow="login"] input[name="password"]', 'not the password at all');
  await page.click('form[data-flow="login"] button[type="submit"]');
  const summary = page.locator('form[data-flow="login"] [role="alert"], form[data-flow="login"] .az-auth-summary').first();
  await summary.waitFor({ timeout: 10_000 }).catch(() => {});
  check('a wrong password shows the closed-set copy', /don't match/.test(await summary.innerText().catch(() => '')));

  // Sign-in with the right password.
  await page.fill('form[data-flow="login"] input[name="password"]', PASSWORD);
  await page.click('form[data-flow="login"] button[type="submit"]');
  await page.waitForURL((u) => u.pathname.replace(/\/$/, '') === '/account', { timeout: 15_000 }).catch(() => {});
  check('sign-in with the password grant reaches the protected page', onAccount(), page.url());
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(`${siteUrl}/login/`, { timeout: 15_000 }).catch(() => {});

  // Reset through a real email: request, open the link, set a new password.
  const before = smtp.messages.length;
  await page.goto(`${siteUrl}/reset/`);
  await page.fill('form[data-flow="reset"] input[name="email"]', 'ada@studio.test');
  await page.click('form[data-flow="reset"] button[type="submit"]');
  const resetMail = await mailAfter(before + 1);
  const resetLink = linkIn(resetMail);
  check('the reset email arrives over SMTP with a verification link', Boolean(resetLink), resetLink ?? 'no link');
  if (resetLink) {
    await page.goto(resetLink);
    await page.locator('form[data-flow="reset-set"]').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {});
    check('the link lands on the reset page in its set-new-password state',
      await page.locator('form[data-flow="reset-set"]').isVisible().catch(() => false), page.url());
    check('the tokens are removed from the address', !/access_token|refresh_token/.test(page.url()), page.url());
    const next = `${PASSWORD}-2`;
    await page.fill('form[data-flow="reset-set"] input[name="password"]', next);
    await page.fill('form[data-flow="reset-set"] input[name="passwordConfirm"]', next);
    await page.click('form[data-flow="reset-set"] button[type="submit"]');
    await page.waitForURL((u) => !u.pathname.startsWith('/reset'), { timeout: 15_000 }).catch(() => {});
    const token = await fetch(`${authUrl}/token?grant_type=password`, {
      method: 'POST', headers: { 'content-type': 'application/json', apikey: anon },
      body: JSON.stringify({ email: 'ada@studio.test', password: next }),
    });
    check('the new password is the one the server accepts', token.ok, String(token.status));
  }

  // A sign-in link (no account creation), followed from the email.
  const context = await browser.newContext();
  const fresh = await context.newPage();
  await fresh.goto(`${siteUrl}/login/?next=%2Faccount`);
  const beforeLink = smtp.messages.length;
  await fresh.fill('form[data-flow="login"] input[name="email"]', 'ada@studio.test');
  await fresh.getByRole('button', { name: 'Email me a link instead' }).click();
  const linkMail = await mailAfter(beforeLink + 1);
  const signInLink = linkIn(linkMail);
  check('the sign-in link email arrives', Boolean(signInLink), signInLink ?? 'no link');
  if (signInLink) {
    await fresh.goto(signInLink);
    await fresh.waitForURL(`${siteUrl}/account`, { timeout: 15_000 }).catch(() => {});
    check('following the link signs in and continues to `next`', fresh.url().startsWith(`${siteUrl}/account`), fresh.url());
  }
  const unknownBefore = smtp.messages.length;
  await fresh.goto(`${siteUrl}/reset/`);
  await fresh.fill('form[data-flow="reset"] input[name="email"]', 'nobody@studio.test');
  await fresh.click('form[data-flow="reset"] button[type="submit"]');
  const sameAnswer = await fresh.locator('form[data-flow="reset"]').getByText(/If an account exists/)
    .waitFor({ timeout: 10_000 }).then(() => true, () => false);
  check('an unknown address gets the same answer (no enumeration)', sameAnswer);
  check('…and no email is sent to it', smtp.messages.length === unknownBefore);

  check('no page errors in the browser', errors.length === 0, errors.join(' | '));
} catch (e) {
  failures++;
  console.log(`FAIL  run aborted: ${e.message}`);
} finally {
  for (const fn of cleanups) { try { await fn(); } catch { /* keep cleaning */ } }
  for (const id of containers.reverse()) { try { docker('rm', '-f', id); } catch { /* already gone */ } }
  // The network last: it cannot be removed while a container is attached.
  try { docker('network', 'rm', network); } catch { /* never created */ }
  rmSync(work, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
