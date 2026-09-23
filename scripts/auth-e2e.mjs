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
import { createServer as createNetServer } from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { ROOT as ROOT_DIR, buildSites } from './visual/pipeline.mjs';

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

/* ---- a mock OpenID Connect provider, on a THIRD origin ---------------- */

/**
 * Test-only. Discovery, authorize and token, with the checks a real provider
 * makes: registered client and redirect URI, PKCE S256, a single-use code.
 * The id_token is HS256-signed with the client secret — valid OIDC for a
 * confidential client, and enough for the backend to verify here. Which
 * user signs in is fixed per client: `work` returns a VERIFIED address that
 * matches the existing account, `guest` an unverified one.
 */
const OIDC_CLIENTS = {
  'work-client': { secret: 'work-test-secret', email: USER.email, verified: true, sub: 'p-ada' },
  'guest-client': { secret: 'guest-test-secret', email: USER.email, verified: false, sub: 'p-guest' },
};
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload, secret) => {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${b64u(createHmac('sha256', secret).update(`${head}.${body}`).digest())}`;
};

function startOidcProvider() {
  const codes = new Map();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const issuer = `http://127.0.0.1:${server.address().port}`;
    const json = (status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` });
    }
    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      const client = OIDC_CLIENTS[q.get('client_id') ?? ''];
      const ok = client && q.get('response_type') === 'code' && q.get('code_challenge_method') === 'S256'
        && q.get('code_challenge') && q.get('state') && q.get('nonce') && (q.get('scope') ?? '').split(' ').includes('openid');
      if (!ok) return json(400, { error: 'invalid_request' });
      const code = b64u(randomBytes(16));
      codes.set(code, { client: q.get('client_id'), redirect: q.get('redirect_uri'), challenge: q.get('code_challenge'), nonce: q.get('nonce') });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { location: back.href }).end();
      return undefined;
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const f = new URLSearchParams(body);
      const grant = codes.get(f.get('code') ?? '');
      codes.delete(f.get('code') ?? '');                        // single use
      const client = OIDC_CLIENTS[f.get('client_id') ?? ''];
      const pkce = grant && b64u(createHash('sha256').update(f.get('code_verifier') ?? '').digest()) === grant.challenge;
      if (!grant || !client || grant.client !== f.get('client_id') || client.secret !== f.get('client_secret')
          || grant.redirect !== f.get('redirect_uri') || !pkce) return json(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      return json(200, { token_type: 'Bearer', id_token: sign({
        iss: issuer, aud: f.get('client_id'), sub: client.sub, email: client.email,
        email_verified: client.verified, nonce: grant.nonce, iat: now, exp: now + 300,
      }, client.secret) });
    }
    return json(404, { error: 'not_found' });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () =>
    done({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

/* ---- the mock backend: §3.4's protocol, on ANOTHER origin -------------- */

/**
 * The owner's backend, as §3.4 requires it to behave: routes under /auth,
 * CORS for the site's exact origin with credentials, the session in an
 * httpOnly cookie, every state-changing request refused unless it carries
 * the CSRF header, sign-up re-checking the retyped password, and the
 * provider round-trip (state + PKCE + nonce, linking by VERIFIED email
 * only). `allowed` and `providers` are filled once the other servers are
 * up. Cookies are SameSite=Lax because loopback ports are one site; a
 * backend on another site needs SameSite=None; Secure (§3.4).
 */
function startBackend() {
  const calls = [];
  const sessions = new Map();
  const accounts = new Map([[USER.email, { id: USER.id, email: USER.email, name: 'Ada', password: USER.password }]]);
  const pending = new Map();                                    // oauth state -> round-trip
  const allowed = { origin: '' };
  const providers = { issuer: '', list: [] };                  // [{ id, label, client }]
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const self = `http://127.0.0.1:${server.address().port}`;
    const origin = req.headers.origin ?? '';
    const cors = origin && origin === allowed.origin ? {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type, x-az-request',
      'access-control-allow-methods': 'GET, POST',
      vary: 'Origin',
    } : {};
    const cookies = Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')));
    const redirect = (to, extra = {}) => { res.writeHead(302, { location: to, ...extra }).end(); };

    /* §3.4 provider round-trip: top-level navigations, so no Origin header —
       protected by the `site` allow-list, a same-origin `next`, and
       state + PKCE + nonce instead of the CSRF header. */
    const start = /^\/auth\/oauth\/([a-z0-9-]+)\/start$/.exec(url.pathname);
    const back = /^\/auth\/oauth\/([a-z0-9-]+)\/callback$/.exec(url.pathname);
    if (start || back) {
      calls.push({ path: url.pathname, method: req.method, origin, query: Object.fromEntries(url.searchParams) });
      const provider = providers.list.find((p) => p.id === (start ?? back)[1]);
      if (!provider) return redirect(`${allowed.origin}/login?auth_error=oauth_failed`);
      if (start) {
        const site = url.searchParams.get('site');
        const next = url.searchParams.get('next') ?? '/';
        if (site !== allowed.origin || !next.startsWith('/') || next.startsWith('//')) {
          res.writeHead(400).end();
          return undefined;
        }
        const discovery = await (await fetch(`${providers.issuer}/.well-known/openid-configuration`)).json();
        const state = b64u(randomBytes(16));
        const verifier = b64u(randomBytes(32));
        const nonce = b64u(randomBytes(16));
        pending.set(state, { provider: provider.id, verifier, nonce, next, site, issuer: discovery.issuer, token: discovery.token_endpoint });
        const auth = new URL(discovery.authorization_endpoint);
        for (const [k, v] of Object.entries({
          response_type: 'code', client_id: provider.client.id, redirect_uri: `${self}/auth/oauth/${provider.id}/callback`,
          scope: 'openid email profile', state, nonce,
          code_challenge: b64u(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
        })) auth.searchParams.set(k, v);
        // The state is also bound to this browser, so a callback started elsewhere fails.
        return redirect(auth.href, { 'set-cookie': `az_oauth_state=${state}; HttpOnly; Path=/auth/oauth; SameSite=Lax; Max-Age=600` });
      }
      const state = url.searchParams.get('state') ?? '';
      const trip = pending.get(state);
      pending.delete(state);
      const fail = (code) => redirect(`${trip?.site ?? allowed.origin}/login?auth_error=${code}`);
      if (!trip || cookies.az_oauth_state !== state || trip.provider !== provider.id) return fail('oauth_failed');
      const token = await (await fetch(trip.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', code: url.searchParams.get('code') ?? '', code_verifier: trip.verifier,
          redirect_uri: `${self}/auth/oauth/${provider.id}/callback`, client_id: provider.client.id, client_secret: provider.client.secret,
        }),
      })).json();
      const [head, body, sig] = String(token.id_token ?? '').split('.');
      const expected = b64u(createHmac('sha256', provider.client.secret).update(`${head}.${body}`).digest());
      if (!sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return fail('oauth_failed');
      const claims = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (claims.iss !== trip.issuer || claims.aud !== provider.client.id || claims.nonce !== trip.nonce
          || claims.exp < Date.now() / 1000) return fail('oauth_failed');
      if (claims.email_verified !== true) return fail('email_unverified');
      const account = accounts.get(claims.email);                 // linked by VERIFIED email only
      if (!account) return fail('oauth_failed');
      const id = `s-${sessions.size + 1}`;
      sessions.set(id, account);
      return redirect(`${trip.site}${trip.next}`, {
        'set-cookie': `az_session=${id}; HttpOnly; Path=/; SameSite=Lax`,
      });
    }

    if (req.method === 'OPTIONS') { res.writeHead(origin === allowed.origin ? 204 : 403, cors).end(); return; }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    const cookie = cookies.az_session ?? null;
    calls.push({ path: url.pathname, method: req.method, origin, csrf: req.headers['x-az-request'], cookie, input });
    const reply = (status, data, extra = {}) => {
      res.writeHead(status, { ...cors, 'content-type': 'application/json', ...extra }).end(JSON.stringify(data));
    };
    // §3.4 CSRF: a foreign origin, or a state change without the header, is refused.
    if (origin !== allowed.origin) return reply(403, { error: 'unknown' });
    if (req.method !== 'GET' && req.headers['x-az-request'] !== '1') return reply(403, { error: 'unknown' });
    const view = (a) => ({ id: a.id, email: a.email, name: a.name, ...(a.location ? { location: a.location } : {}) });
    const signIn = (account) => {
      const id = `s-${sessions.size + 1}`;
      sessions.set(id, account);
      return reply(200, { session: { user: view(account) } }, { 'set-cookie': `az_session=${id}; HttpOnly; Path=/; SameSite=Lax` });
    };
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /auth/session':
        return reply(200, { session: cookie && sessions.has(cookie) ? { user: view(sessions.get(cookie)) } : null });
      case 'GET /auth/providers':
        return reply(200, { providers: providers.list.map(({ id, label }) => ({ id, label })) });
      case 'POST /auth/sign-in': {
        const a = accounts.get(input.email);
        return a && a.password === input.password ? signIn(a) : reply(401, { error: 'invalid_credentials' });
      }
      case 'POST /auth/sign-up':
        // §3.4: the server re-checks what the form already checked.
        if (!input.name) return reply(400, { error: 'unknown', field: 'name' });
        if (input.password !== input.passwordConfirm) return reply(400, { error: 'password_mismatch', field: 'passwordConfirm' });
        if (accounts.has(input.email)) return reply(409, { error: 'email_taken', field: 'email' });
        accounts.set(input.email, { id: `u-${accounts.size + 1}`, email: input.email, name: input.name, password: input.password,
          ...(input.location ? { location: input.location } : {}) });
        return signIn(accounts.get(input.email));
      case 'POST /auth/sign-out':
        if (cookie) sessions.delete(cookie);
        res.writeHead(204, { ...cors, 'set-cookie': 'az_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0' }).end();
        return undefined;
      default:
        return reply(404, { error: 'unknown' });
    }
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () =>
    done({ url: `http://127.0.0.1:${server.address().port}`, calls, allowed, providers, close: () => server.close() })));
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
    protect /account /security

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

page /security
  auth reset
    title "Change your password"
    alt   "Back to your orders" /account

page /terms
  text
    title "Terms"
    body  "Plain terms, in plain words."
`;

const work = mkdtempSync(join(tmpdir(), 'az-auth-e2e-'));
const provider = await startProvider();
const backend = await startBackend();
const oidc = await startOidcProvider();
backend.providers.issuer = oidc.url;
backend.providers.list = [
  { id: 'work', label: 'Work account', client: { id: 'work-client', secret: OIDC_CLIENTS['work-client'].secret } },
  { id: 'guest', label: 'Guest account', client: { id: 'guest-client', secret: OIDC_CLIENTS['guest-client'].secret } },
];
process.env.AZ_PUBLIC_AUTH_URL = provider.url;
process.env.AZ_PUBLIC_AUTH_KEY = PUBLIC_KEY;
process.env.AZ_PUBLIC_BACKEND_URL = backend.url;
// The same site with `adapter azbackend`, and provider sign-in on its login.
const BACKEND_SITE = SITE.replace('adapter hosted', 'adapter azbackend')
  .replace('    title    "Welcome back"\n', '    title    "Welcome back"\n    methods  password oauth\n');
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

  /* 5b. a form on a protected page renders after the session check — it is
         still wired: an empty submit shows the summary instead of the
         browser's own required-field bubble. */
  await page.goto(at('/security'));
  await form('reset').waitFor({ state: 'visible' });
  await form('reset').locator('button[type="submit"]').first().click();
  const lateSummary = form('reset').locator('.az-auth-summary');
  check('a protected page\'s auth form, rendered late, is wired like any other',
    await lateSummary.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false));
  await page.goto(at('/account'));
  await bar.waitFor({ state: 'visible' });

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
  await form('signup').locator('input[name="passwordConfirm"]').fill('a-different-password');
  await form('signup').locator('input[name="terms"]').check();
  await form('signup').getByRole('button', { name: 'Create account' }).click();
  await page.waitForFunction(() => /don't match/.test(document.querySelector('#az-auth-passwordConfirm-error')?.textContent ?? ''));
  check('§3.4 signup: a retype that differs is caught on the retype field before any request', true);
  await form('signup').locator('input[name="passwordConfirm"]').fill('a-long-enough-password');
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
  await setForm.locator('input[name="passwordConfirm"]').fill('short');
  await setForm.getByRole('button', { name: 'Save new password' }).click();
  await page.waitForFunction(() => /at least 12/.test(document.querySelector('#az-auth-set-password-error')?.textContent ?? ''));
  check('§7: the stated minimum is enforced on the new password', true);
  await setForm.locator('input[name="password"]').fill('a-long-enough-password');
  await setForm.locator('input[name="passwordConfirm"]').fill('a-long-enough-password');
  await setForm.getByRole('button', { name: 'Save new password' }).click();
  await page.waitForFunction(() => /expired/.test(document.querySelector('form[data-flow="reset-set"] .az-auth-summary')?.textContent ?? ''));
  check('reset: an expired link shows expired_token copy', true);
  await page.goto(at(`/reset?token=${RESET_TOKEN}`));
  await form('reset-set').locator('input[name="password"]').fill('a-long-enough-password');
  await form('reset-set').locator('input[name="passwordConfirm"]').fill('a-long-enough-password');
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
      // §3.4 rule 14: a sign-out the server does not confirm leaves the
      // visitor signed in — and the page must say so, not throw or pretend.
      {
        const errors = [];
        const onError = (e) => errors.push(e.message);
        p.on('pageerror', onError);
        await p.route(`${backend.url}/auth/sign-out`, (route) => route.fulfill({ status: 503, body: '{"error":"unknown"}',
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': backendHost.url, 'access-control-allow-credentials': 'true' } }), { times: 1 });
        await p.locator('.az-session').getByRole('button', { name: 'Sign out' }).click();
        const told = await p.waitForFunction(() => /still signed in/.test(document.querySelector('.az-session-error')?.textContent ?? ''),
          undefined, { timeout: 5000 }).then(() => true, () => false);
        await p.waitForTimeout(200);
        p.off('pageerror', onError);
        check(`${name}: a sign-out the server did not confirm keeps the page signed in and says so`,
          told && /\/account$/.test(p.url()) && await p.locator('.az-session').isVisible() && errors.length === 0,
          errors.join('; ') || p.url());
      }
      await p.locator('.az-session').getByRole('button', { name: 'Sign out' }).click();
      await p.waitForURL(/\/login$/);
      await p.goto(on('/account'));
      await p.waitForURL(/\/login\?next=/);
      check(`${name} azbackend: sign-out ends the backend session`, true);

      /* §3.4 provider sign-in: buttons from the backend's list, the round-trip
         through a mock OIDC provider, linking by VERIFIED email only. */
      const providerLinks = p.locator('[data-az-oauth="providers"] a');
      await providerLinks.first().waitFor({ state: 'visible' });
      const labels = await providerLinks.allTextContents();
      check(`${name} oauth: one "Continue with …" button per provider the backend lists`,
        labels.join('|') === 'Continue with Work account|Continue with Guest account', labels.join('|'));
      check(`${name} oauth: the provider buttons are secondary actions, the form's submit stays primary`,
        /az-action--secondary/.test(await providerLinks.first().getAttribute('class') ?? ''));
      await p.goto(on('/login?next=%2Faccount'));
      await providerLinks.first().waitFor({ state: 'visible' });
      await p.getByRole('link', { name: 'Continue with Work account' }).click();
      await p.waitForURL(/\/account$/);
      await p.locator('.az-session').waitFor({ state: 'visible' });
      const trip = backend.calls.filter((c) => /\/auth\/oauth\/work\//.test(c.path));
      check(`${name} oauth: a verified provider email signs in to the existing account and lands on ?next`,
        trip.some((c) => c.path.endsWith('/start') && c.query.next === '/account' && c.query.site === backendHost.url)
        && trip.some((c) => c.path.endsWith('/callback')));
      await p.locator('.az-session').getByRole('button', { name: 'Sign out' }).click();
      await p.waitForURL(/\/login$/);
      await providerLinks.first().waitFor({ state: 'visible' });
      await p.getByRole('link', { name: 'Continue with Guest account' }).click();
      await p.waitForURL(/\/login/);
      await p.waitForFunction(() => /hasn't verified your email/.test(document.querySelector('.az-auth-summary')?.textContent ?? ''));
      check(`${name} oauth: an UNVERIFIED provider email never links — email_unverified copy is shown`, true);
      check(`${name} oauth: the error code is dropped from the address after showing`, !p.url().includes('auth_error'));
      await p.goto(on('/account'));
      await p.waitForURL(/\/login\?next=/);
      check(`${name} oauth: the refused sign-in created no session`, true);

      /* §3.4 sign-up: the profile the server stores and returns. */
      await p.goto(on('/signup'));
      const su = p.locator('form[data-flow="signup"]');
      await su.locator('input[name="name"]').fill('Bea');
      await su.locator('input[name="email"]').fill(`bea-${name}@studio.test`);
      await su.locator('input[name="password"]').fill('a-long-enough-password');
      await su.locator('input[name="passwordConfirm"]').fill('a-long-enough-password');
      await su.locator('input[name="location"]').fill('Lisbon');
      await su.locator('input[name="terms"]').check();
      await su.getByRole('button', { name: 'Create account' }).click();
      await p.waitForURL((u) => !u.pathname.startsWith('/signup'));
      const profile = await p.evaluate(async (url) => (await fetch(`${url}/auth/session`, { credentials: 'include' })).json(), backend.url);
      check(`${name} §3.4 signup: the session read returns name, email and location`,
        profile.session?.user?.name === 'Bea' && profile.session.user.location === 'Lisbon'
        && profile.session.user.email === `bea-${name}@studio.test`, JSON.stringify(profile.session?.user));
      const mismatch = await p.evaluate(async (url) => (await fetch(`${url}/auth/sign-up`, {
        method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-az-request': '1' },
        body: JSON.stringify({ name: 'X', email: 'x@studio.test', password: 'a-long-enough-password', passwordConfirm: 'nope' }),
      })).json(), backend.url);
      check(`${name} CONTROL §3.4: the server re-checks the retype itself (password_mismatch)`,
        mismatch.error === 'password_mismatch' && mismatch.field === 'passwordConfirm');
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
  oidc.close();
}

/* ---- 12. the REAL built-in backend (backend-spec) --------------------- */

/**
 * Not the mock: a site that declares `backend`, and the server `az build`
 * generated for it, started as its own process over SQLite. Its email goes
 * to a local SMTP listener, so the reset flow is followed from the message
 * a person would receive. Provider sign-in uses the mock OpenID provider
 * above. Chromium.
 */

/** Test-only SMTP listener: accepts one conversation at a time, keeps each message. */
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
        else if (verb === 'QUIT') { socket.end('221 bye\r\n'); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () =>
    done({ port: server.address().port, messages, close: () => server.close() })));
}

/** The text of a captured message: headers dropped, quoted-printable undone. */
function decodeMessage(raw) {
  const text = raw.slice(raw.indexOf('\r\n\r\n') + 4);
  return /quoted-printable/i.test(raw)
    ? text.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    : text;
}

const freePort = () => new Promise((done) => {
  const probe = createNetServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); });
});

{
  const smtp = await startSmtpCapture();
  const oidc2 = await startOidcProvider();
  const serverPort = await freePort();
  const serverUrl = `http://127.0.0.1:${serverPort}`;
  process.env.AZ_PUBLIC_BACKEND_URL = serverUrl;
  // `backend` after the site-level `auth` block (whose `protect` is its own child).
  const REAL_SITE = BACKEND_SITE.replace('\npage /\n', '  backend\n    database sqlite\n    email smtp\n\npage /\n');
  const real = { dir: join(work, 'real'), source: REAL_SITE };
  await buildSites([real], work);
  check('backend: the site that declares it compiles and builds', Boolean(real.compiled && real.dist), real.error ?? '');
  const serverDir = join(real.proj, 'server');
  // The server's only package for SQLite + SMTP; zero dependencies of its own.
  mkdirSync(join(serverDir, 'node_modules'), { recursive: true });
  symlinkSync(realpathSync(join(ROOT_DIR, 'node_modules/nodemailer')), join(serverDir, 'node_modules/nodemailer'), 'dir');
  const realHost = await startSite(normalize(real.dist));
  const child = spawn(process.execPath, ['src/main.ts'], {
    cwd: serverDir,
    env: {
      PATH: process.env.PATH,
      AZ_SESSION_SECRET: randomBytes(32).toString('base64url'),
      AZ_BACKEND_PUBLIC_URL: serverUrl, AZ_PORT: String(serverPort), AZ_ALLOWED_ORIGINS: realHost.url,
      AZ_SQLITE_PATH: join(serverDir, 'data/test.db'),
      AZ_EMAIL_FROM: 'Studio <no-reply@studio.test>', AZ_SMTP_HOST: '127.0.0.1', AZ_SMTP_PORT: String(smtp.port),
      AZ_OAUTH_PROVIDERS: 'work,guest',
      AZ_OAUTH_WORK_TYPE: 'oidc', AZ_OAUTH_WORK_LABEL: 'Work account', AZ_OAUTH_WORK_ISSUER: oidc2.url,
      AZ_OAUTH_WORK_CLIENT_ID: 'work-client', AZ_OAUTH_WORK_CLIENT_SECRET: OIDC_CLIENTS['work-client'].secret,
      AZ_OAUTH_GUEST_TYPE: 'oidc', AZ_OAUTH_GUEST_LABEL: 'Guest account', AZ_OAUTH_GUEST_ISSUER: oidc2.url,
      AZ_OAUTH_GUEST_CLIENT_ID: 'guest-client', AZ_OAUTH_GUEST_CLIENT_SECRET: OIDC_CLIENTS['guest-client'].secret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  child.stdout.on('data', (c) => { serverLog += c; });
  child.stderr.on('data', (c) => { serverLog += c; });
  const up = await new Promise((done) => {
    const until = Date.now() + 15_000;
    const poll = () => fetch(`${serverUrl}/health`).then((r) => done(r.ok), () => (Date.now() > until ? done(false) : setTimeout(poll, 200)));
    poll();
  });
  check('backend: the generated server starts from its own folder', up, up ? '' : serverLog.slice(0, 300));
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  const on = (path) => `${realHost.url}${path}`;
  const mailTo = async (n) => {
    const until = Date.now() + 10_000;
    while (smtp.messages.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
    return smtp.messages[n - 1] ?? '';
  };
  try {
    /* sign up — with the retype and a location suggested from the list */
    await p.goto(on('/signup'));
    const su = p.locator('form[data-flow="signup"]');
    const listId = await su.locator('input[name="location"]').getAttribute('list');
    check('backend: the location field offers type-ahead suggestions (native datalist)',
      !!listId && (await p.locator(`datalist#${listId} option`).count()) > 200);
    await su.locator('input[name="name"]').fill('Ada');
    await su.locator('input[name="email"]').fill(USER.email);
    await su.locator('input[name="password"]').fill(USER.password);
    await su.locator('input[name="passwordConfirm"]').fill(USER.password);
    await su.locator('input[name="location"]').fill('Portugal');
    await su.locator('input[name="terms"]').check();
    await su.getByRole('button', { name: 'Create account' }).click();
    await p.waitForURL((u) => !u.pathname.startsWith('/signup'));
    // All cookies, not cookies(url): for a plain-http URL Playwright leaves Secure ones out.
    const cookies = await ctx.cookies();
    const session = cookies.find((c) => c.name === '__Host-az_session' && c.domain === '127.0.0.1');
    check('backend: sign-up sets an httpOnly, Secure session cookie from the real server',
      !!session?.httpOnly && !!session?.secure, JSON.stringify(session && { httpOnly: session.httpOnly, secure: session.secure, sameSite: session.sameSite }));
    const profile = await p.evaluate(async (url) => (await fetch(`${url}/auth/session`, { credentials: 'include', headers: { 'x-az-request': '1' } })).json(), serverUrl);
    check('backend: the server stored name, email and location', profile.session?.user?.name === 'Ada'
      && profile.session.user.location === 'Portugal' && profile.session.user.email === USER.email, JSON.stringify(profile.session?.user));

    /* sign out, then sign in with the wrong password and the right one */
    await p.goto(on('/account'));
    await p.locator('.az-session').getByRole('button', { name: 'Sign out' }).click();
    await p.waitForURL(/\/login$/);
    const login = p.locator('form[data-flow="login"]');
    await login.locator('input[name="email"]').fill(USER.email);
    await login.locator('input[name="password"]').fill('wrong-password-here');
    await login.getByRole('button', { name: 'Sign in' }).click();
    await p.waitForFunction(() => /don't match/.test(document.querySelector('.az-auth-summary')?.textContent ?? ''));
    check('backend: a wrong password shows invalid_credentials copy', true);
    await login.locator('input[name="password"]').fill(USER.password);
    await login.getByRole('button', { name: 'Sign in' }).click();
    await p.waitForURL(/\/account$/);
    check('backend: the right password signs in', true);
    await p.locator('.az-session').getByRole('button', { name: 'Sign out' }).click();
    await p.waitForURL(/\/login$/);

    /* forgot password → the email → the link → a new password */
    await p.goto(on('/reset'));
    await p.locator('form[data-flow="reset"] input[name="email"]').fill(USER.email);
    await p.locator('form[data-flow="reset"]').getByRole('button', { name: 'Email me a link' }).click();
    const message = await mailTo(1);
    const link = /https?:\/\/\S+/.exec(message)?.[0] ?? '';
    check('backend: the reset email arrives over SMTP with a link to the site\'s reset page',
      link.startsWith(`${realHost.url}/reset?token=`), link.slice(0, 80));
    await p.goto(link);
    const set = p.locator('form[data-flow="reset-set"]');
    await set.locator('input[name="password"]').fill('a-brand-new-password');
    await set.locator('input[name="passwordConfirm"]').fill('a-brand-new-password');
    await set.getByRole('button', { name: 'Save new password' }).click();
    await p.waitForURL((u) => !u.pathname.startsWith('/reset'));
    check('backend: the emailed link sets a new password and signs in', true);
    await p.goto(link);
    await set.locator('input[name="password"]').fill('yet-another-password');
    await set.locator('input[name="passwordConfirm"]').fill('yet-another-password');
    await set.getByRole('button', { name: 'Save new password' }).click();
    await p.waitForFunction(() => /expired/.test(document.querySelector('form[data-flow="reset-set"] .az-auth-summary')?.textContent ?? ''));
    check('backend: the same link a second time is expired', true);
    await p.goto(on('/account'));
    await p.locator('.az-session').getByRole('button', { name: 'Sign out' }).click();
    await p.waitForURL(/\/login$/);

    /* provider sign-in through the real server */
    await p.goto(on('/login?next=%2Faccount'));
    const providerLinks = p.locator('[data-az-oauth="providers"] a');
    await providerLinks.first().waitFor({ state: 'visible' });
    check('backend: the provider buttons come from the server\'s own configuration',
      (await providerLinks.allTextContents()).join('|') === 'Continue with Work account|Continue with Guest account');
    await p.getByRole('link', { name: 'Continue with Work account' }).click();
    await p.waitForURL(/\/account$/);
    await p.locator('.az-session').waitFor({ state: 'visible' });
    check('backend: a verified provider email signs in to the existing account (OIDC, PKCE, nonce, signed id_token)', true);
    await p.locator('.az-session').getByRole('button', { name: 'Sign out' }).click();
    await p.waitForURL(/\/login$/);
    await providerLinks.first().waitFor({ state: 'visible' });
    await p.getByRole('link', { name: 'Continue with Guest account' }).click();
    await p.waitForFunction(() => /hasn't verified your email/.test(document.querySelector('.az-auth-summary')?.textContent ?? ''));
    check('backend: an unverified provider email never links (email_unverified)', true);
    check('backend: no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
    check('backend: the server logged no password or token',
      !serverLog.includes(USER.password) && !serverLog.includes('a-brand-new-password') && !/token=/.test(serverLog), serverLog.slice(0, 200));
  } finally {
    await b.close();
    child.kill('SIGTERM');
    realHost.close();
    smtp.close();
    oidc2.close();
  }
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED — work dir kept: ${work}`);
if (failures === 0) rmSync(work, { recursive: true, force: true });
process.exitCode = failures === 0 ? 0 : 1;
