/**
 * M4 in a real browser: a compiled site's auth forms against a LOCAL mock
 * provider that speaks the hosted adapter's protocol (auth-block-spec §3.2).
 *
 * ROADMAP M4's exit criterion is a login against a REAL hosted-provider
 * project; that needs an account this repository does not have, so it stays
 * open. This proves everything up to the provider: the forms, the adapter's
 * requests, the closed error set and its copy, the session, <Protected>, the
 * reset flow's two states, and that `next` cannot redirect off-site.
 *
 *     node scripts/auth-e2e.mjs
 *
 * The mock is test-only. Its "passwords" and tokens are fixed strings.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { buildSites } from './visual/pipeline.mjs';

const PUBLIC_KEY = 'pk-probe-public';
const USER = { id: 'u-ada', email: 'ada@studio.test', password: 'correct-horse-battery' };
const RESET_TOKEN = 'reset-probe-ok';
const EXPIRED_TOKEN = 'reset-probe-expired';

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? '   ' + detail : ''}`);
};

/* ---- the mock provider: §3.2's protocol, nothing more --------------------- */

function startProvider() {
  const calls = [];
  const server = createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-public-key, authorization',
      'access-control-allow-methods': 'POST',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    calls.push({ path: req.url, key: req.headers['x-public-key'], input });
    const reply = (status, data) => {
      res.writeHead(status, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(data));
    };
    if (req.headers['x-public-key'] !== PUBLIC_KEY) return reply(401, { error: 'unknown' });
    const session = () => ({ session: { user: { id: USER.id, email: USER.email }, token: 'session-probe', expiresAt: Date.now() + 3_600_000 } });
    switch (req.url) {
      case '/sign-in':
        return input.email === USER.email && input.password === USER.password
          ? reply(200, session()) : reply(401, { error: 'invalid_credentials' });
      case '/sign-up':
        return input.email === USER.email ? reply(409, { error: 'email_taken', field: 'email' }) : reply(200, session());
      case '/link':
      case '/reset':
        // Never says whether the address has an account.
        return reply(200, {});
      case '/password':
        if (input.token === EXPIRED_TOKEN) return reply(400, { error: 'expired_token' });
        return input.token === RESET_TOKEN ? reply(200, session()) : reply(400, { error: 'unknown' });
      case '/sign-out':
        res.writeHead(204, cors).end();
        return undefined;
      default:
        return reply(404, { error: 'unknown' });
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () =>
    done({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}

/* ---- the mock backend: §3.4's protocol, on ANOTHER origin -------------- */

/**
 * The owner's backend, as §3.4 requires it to behave: routes under /auth,
 * CORS for the site's exact origin with credentials, the session in an
 * httpOnly cookie, and every state-changing request refused unless it
 * carries the CSRF header. `allowed` is filled once the site's origin is
 * known. Cookies are SameSite=Lax here because loopback ports are one site;
 * a backend on another site needs SameSite=None; Secure (§3.4).
 */
function startBackend() {
  const calls = [];
  const sessions = new Map();
  const allowed = { origin: '' };
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin ?? '';
    const cors = origin && origin === allowed.origin ? {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type, x-az-request',
      'access-control-allow-methods': 'GET, POST',
      vary: 'Origin',
    } : {};
    if (req.method === 'OPTIONS') { res.writeHead(origin === allowed.origin ? 204 : 403, cors).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = body ? JSON.parse(body) : {};
    const cookie = /(?:^|;\s*)az_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
    calls.push({ path: req.url, method: req.method, origin, csrf: req.headers['x-az-request'], cookie, input });
    const reply = (status, data, extra = {}) => {
      res.writeHead(status, { ...cors, 'content-type': 'application/json', ...extra }).end(JSON.stringify(data));
    };
    // §3.4 CSRF: a foreign origin, or a state change without the header, is refused.
    if (origin !== allowed.origin) return reply(403, { error: 'unknown' });
    if (req.method !== 'GET' && req.headers['x-az-request'] !== '1') return reply(403, { error: 'unknown' });
    const user = { id: USER.id, email: USER.email };
    const signIn = () => {
      const id = `s-${sessions.size + 1}`;
      sessions.set(id, user);
      return reply(200, { session: { user } }, { 'set-cookie': `az_session=${id}; HttpOnly; Path=/; SameSite=Lax` });
    };
    switch (`${req.method} ${req.url}`) {
      case 'GET /auth/session':
        return reply(200, { session: cookie && sessions.has(cookie) ? { user: sessions.get(cookie) } : null });
      case 'POST /auth/sign-in':
        return input.email === USER.email && input.password === USER.password ? signIn() : reply(401, { error: 'invalid_credentials' });
      case 'POST /auth/sign-out':
        if (cookie) sessions.delete(cookie);
        res.writeHead(204, { ...cors, 'set-cookie': 'az_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' }).end();
        return undefined;
      default:
        return reply(404, { error: 'unknown' });
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () =>
    done({ url: `http://127.0.0.1:${server.address().port}`, calls, allowed, close: () => server.close() })));
}

/** A static host: `/login` and `/login/` serve login/index.html, as real hosts do. */
function startSite(root) {
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
  return new Promise((done) => server.listen(0, '127.0.0.1', () =>
    done({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

const SITE = `az 1

site studio
  auth
    adapter hosted
    protect /account

page /
  hero center
    title "The studio"

page /login
  auth login
    title    "Welcome back"
    redirect /account
    alt      "Create an account" /signup
    alt      "Forgot your password" /reset

page /signup
  auth signup
    terms /terms
    alt   "Sign in instead" /login

page /reset
  auth reset
    alt "Back to sign in" /login

page /account
  hero center
    title "Your orders"

page /terms
  text
    title "Terms"
    body  "Plain terms, in plain words."
`;

const work = mkdtempSync(join(tmpdir(), 'az-auth-e2e-'));
const provider = await startProvider();
const backend = await startBackend();
process.env.AZ_PUBLIC_AUTH_URL = provider.url;
process.env.AZ_PUBLIC_AUTH_KEY = PUBLIC_KEY;
process.env.AZ_PUBLIC_BACKEND_URL = backend.url;
// The same site with `adapter azbackend`: sign-in and <Protected> only.
const BACKEND_SITE = SITE.replace('adapter hosted', 'adapter azbackend');
const sites = [
  { dir: join(work, 'studio'), source: SITE },
  { dir: join(work, 'backend'), source: BACKEND_SITE },
];
await buildSites(sites, work);
for (const s of sites) {
  if (!s.compiled || !s.dist) {
    console.error(`site did not build: ${s.error ?? 'no dist'}`);
    process.exit(1);
  }
}
const [site, backendSite] = sites;
const host = await startSite(normalize(site.dist));
const backendHost = await startSite(normalize(backendSite.dist));
backend.allowed.origin = backendHost.url;
const browser = await chromium.launch();
const errors = [];

try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  // The browser logs every non-2xx response; the mock's deliberate 400/401/409
  // replies (wrong password, taken email, expired link) are the cases under
  // test, not faults. Anything else is.
  const expected = /^Failed to load resource: the server responded with a status of (400|401|409) /;
  page.on('console', (m) => { if (m.type() === 'error' && !expected.test(m.text())) errors.push(m.text()); });
  const at = (p) => `${host.url}${p}`;
  const form = (flow) => page.locator(`form[data-flow="${flow}"]`);

  /* 1. signed out: <Protected> sends you to login, remembering where. */
  await page.goto(at('/account'));
  await page.waitForURL(/\/login\?next=%2Faccount/);
  check('<Protected> redirects a signed-out visitor to login with ?next', true, page.url().replace(host.url, ''));

  /* 2. §6: empty submit — summary, focused, one link per field, fields tied to errors. */
  await form('login').getByRole('button', { name: 'Sign in' }).click();
  const summary = form('login').locator('.az-auth-summary');
  await summary.waitFor({ state: 'visible' });
  check('§6: an empty submit shows the summary with one entry per field',
    (await summary.locator('li a').count()) === 2);
  check('§6: focus moves to the summary, not the first field',
    await summary.evaluate((el) => document.activeElement === el));
  const email = form('login').locator('input[name="email"]');
  check('§6: the field is aria-invalid and names its error in aria-describedby',
    (await email.getAttribute('aria-invalid')) === 'true'
    && (await email.getAttribute('aria-describedby') ?? '').includes('az-auth-email-error'));
  check('§6: the submit is never disabled', !(await form('login').getByRole('button', { name: 'Sign in' }).isDisabled()));

  /* 3. wrong password — the closed code's copy, not the provider's words. */
  await email.fill(USER.email);
  await form('login').locator('input[name="password"]').fill('wrong-password');
  await form('login').getByRole('button', { name: 'Sign in' }).click();
  await page.waitForFunction(() => /don't match/.test(document.querySelector('.az-auth-summary')?.textContent ?? ''));
  check('§3: a wrong password shows invalid_credentials copy', true);
  check('§3.2: every request carried the PUBLIC key header',
    provider.calls.length > 0 && provider.calls.every((c) => c.key === PUBLIC_KEY));

  /* 4. right password — session, then ?next. */
  await form('login').locator('input[name="password"]').fill(USER.password);
  await form('login').getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/account$/);
  const bar = page.locator('.az-session');
  await bar.waitFor({ state: 'visible' });
  check('sign-in lands on ?next and <Protected> shows the page with the signed-in bar',
    (await bar.textContent())?.includes(USER.email) && (await page.locator('h1').textContent()) === 'Your orders');

  /* 5. the session survives a page load (each page is its own HTML file). */
  await page.goto(at('/account'));
  await bar.waitFor({ state: 'visible' });
  check('the session persists across page loads in the tab', page.url().endsWith('/account'));

  /* 6. sign out — back to login, and the protected page is closed again. */
  await bar.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login$/);
  check('sign-out tells the provider and returns to login', provider.calls.some((c) => c.path === '/sign-out'));
  await page.goto(at('/account'));
  await page.waitForURL(/\/login\?next=/);
  check('after sign-out, the protected page redirects again', true);

  /* 7. SECURITY: ?next pointing off-site is ignored. */
  await page.goto(at('/login?next=https%3A%2F%2Fevil.test%2Fphish'));
  await form('login').locator('input[name="email"]').fill(USER.email);
  await form('login').locator('input[name="password"]').fill(USER.password);
  await form('login').getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(/\/account$/);
  check('SECURITY: an off-site ?next is never followed (lands on the form\'s redirect)', page.url().startsWith(host.url));
  await page.locator('.az-session').getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/login$/);

  /* 8. signup: the provider's email_taken, on the email field. */
  await page.goto(at('/signup'));
  await form('signup').locator('input[name="name"]').fill('Ada');
  await form('signup').locator('input[name="email"]').fill(USER.email);
  await form('signup').locator('input[name="password"]').fill('a-long-enough-password');
  await form('signup').locator('input[name="terms"]').check();
  await form('signup').getByRole('button', { name: 'Create account' }).click();
  await page.waitForFunction(() => /already uses this email/.test(document.querySelector('#az-auth-email-error')?.textContent ?? ''));
  check('signup: email_taken is shown inline on the email field', true);

  /* 9. reset, state one: request a link — the same answer for any address. */
  await page.goto(at('/reset'));
  check('reset: without a token only the request form shows',
    await form('reset').isVisible() && !(await form('reset-set').isVisible()));
  await form('reset').locator('input[name="email"]').fill('nobody@studio.test');
  await form('reset').getByRole('button', { name: 'Email me a link' }).click();
  await page.waitForFunction(() => /If an account exists/.test(document.querySelector('form[data-flow="reset"] .az-auth-status')?.textContent ?? ''));
  check('reset: requesting a link never says whether the address has an account', true);

  /* 10. reset, state two: a token shows set-new-password, address prefilled read-only. */
  await page.goto(at(`/reset?token=${EXPIRED_TOKEN}&email=${encodeURIComponent(USER.email)}`));
  const setForm = form('reset-set');
  check('reset: a token shows the set-new-password form instead',
    await setForm.isVisible() && !(await form('reset').isVisible()));
  check('§7: the address is prefilled and read-only, for the password manager',
    (await setForm.locator('input[name="email"]').inputValue()) === USER.email
    && (await setForm.locator('input[name="email"]').getAttribute('readonly')) !== null);
  await setForm.locator('input[name="password"]').fill('short');
  await setForm.getByRole('button', { name: 'Save new password' }).click();
  await page.waitForFunction(() => /at least 12/.test(document.querySelector('#az-auth-set-password-error')?.textContent ?? ''));
  check('§7: the stated minimum is enforced on the new password', true);
  await setForm.locator('input[name="password"]').fill('a-long-enough-password');
  await setForm.getByRole('button', { name: 'Save new password' }).click();
  await page.waitForFunction(() => /expired/.test(document.querySelector('form[data-flow="reset-set"] .az-auth-summary')?.textContent ?? ''));
  check('reset: an expired link shows expired_token copy', true);
  await page.goto(at(`/reset?token=${RESET_TOKEN}`));
  await form('reset-set').locator('input[name="password"]').fill('a-long-enough-password');
  await form('reset-set').getByRole('button', { name: 'Save new password' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/reset'));
  check('reset: a valid link sets the password and signs in', provider.calls.some((c) => c.path === '/password' && c.input.token === RESET_TOKEN));

  check('no page error or console error in any flow', errors.length === 0, errors.slice(0, 2).join(' | '));

  /* 11. azbackend (§3.4): the same forms against the owner's backend on
         another origin, in every engine — cookie session, CORS, CSRF header. */
  for (const [name, engine] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
    const b = name === 'chromium' ? browser : await engine.launch();
    const ctx = await b.newContext();
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    const on = (path) => `${backendHost.url}${path}`;
    const login = p.locator('form[data-flow="login"]');
    try {
      await p.goto(on('/account'));
      await p.waitForURL(/\/login\?next=%2Faccount/);
      check(`${name} azbackend: signed out, <Protected> sends you to login`, new URL(backend.url).origin !== new URL(p.url()).origin,
        'site and backend are different origins');
      await login.locator('input[name="email"]').fill(USER.email);
      await login.locator('input[name="password"]').fill('wrong-password');
      await login.getByRole('button', { name: 'Sign in' }).click();
      await p.waitForFunction(() => /don't match/.test(document.querySelector('.az-auth-summary')?.textContent ?? ''));
      check(`${name} azbackend: a wrong password shows invalid_credentials copy`, true);
      await login.locator('input[name="password"]').fill(USER.password);
      await login.getByRole('button', { name: 'Sign in' }).click();
      await p.waitForURL(/\/account$/);
      await p.locator('.az-session').waitFor({ state: 'visible' });
      const cookies = await ctx.cookies(backend.url);
      const session = cookies.find((c) => c.name === 'az_session');
      check(`${name} azbackend: sign-in stores the backend's httpOnly cookie, never a token in the page`,
        !!session?.httpOnly && !(await p.evaluate(() => JSON.stringify({ ...sessionStorage, ...localStorage }))).includes('s-'));
      await p.goto(on('/account'));
      await p.locator('.az-session').waitFor({ state: 'visible' });
      const reads = backend.calls.filter((c) => c.path === '/auth/session' && c.cookie);
      check(`${name} azbackend: the session survives a page load — GET /auth/session sends the cookie cross-origin`, reads.length > 0);
      const posts = backend.calls.filter((c) => c.method === 'POST');
      check(`${name} azbackend: every state-changing request carried the CSRF header from the site's origin`,
        posts.length > 0 && posts.every((c) => c.csrf === '1' && c.origin === backendHost.url));
      const forged = await p.evaluate(async (url) => (await fetch(`${url}/auth/sign-out`, { method: 'POST', credentials: 'include' })).status, backend.url);
      check(`${name} CONTROL: a request without the CSRF header is refused by the backend`, forged === 403, `status ${forged}`);
      await p.locator('.az-session').getByRole('button', { name: 'Sign out' }).click();
      await p.waitForURL(/\/login$/);
      await p.goto(on('/account'));
      await p.waitForURL(/\/login\?next=/);
      check(`${name} azbackend: sign-out ends the backend session`, true);
      check(`${name} azbackend: no page errors`, errs.length === 0, errs.slice(0, 2).join(' | '));
      backend.calls.length = 0;
    } finally {
      await ctx.close();
      if (b !== browser) await b.close();
    }
  }
} finally {
  await browser.close();
  host.close();
  backendHost.close();
  provider.close();
  backend.close();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED — work dir kept: ${work}`);
if (failures === 0) rmSync(work, { recursive: true, force: true });
process.exitCode = failures === 0 ? 0 : 1;
