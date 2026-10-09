/**
 * The built-in backend against auth-spec §3.4 and backend-spec §5 — every
 * security property with a failing case and a control. SQLite in memory;
 * PostgreSQL and MySQL run the same store in scripts/backend-db.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, SITE, startBackend, startIdp } from './helpers.ts';
import { hashPassword, verifyPassword, SCRYPT, digest, safeEqual } from '../src/server/crypto.ts';
import { loadConfig, KEYS } from '../src/server/env.ts';
import { migrate, numbered, openSqlite } from '../src/server/db.ts';
import { createMailer } from '../src/server/email.ts';

const GOOD = 'a-long-enough-password';
const ada = { name: 'Ada', email: 'Ada@Studio.test', password: GOOD, passwordConfirm: GOOD, location: 'Lisbon' };

/* ---- configuration --------------------------------------------------- */

test('config: a start with nothing set names every required key, not just the first', () => {
  const r = loadConfig({}, { database: 'postgres', email: 'api' }, 's');
  assert.equal(r.ok, false);
  const text = r.ok ? '' : r.problems.join('\n');
  for (const k of ['AZ_SESSION_SECRET', 'AZ_BACKEND_PUBLIC_URL', 'AZ_ALLOWED_ORIGINS', 'AZ_DATABASE_URL', 'AZ_EMAIL_FROM', 'AZ_EMAIL_API_URL', 'AZ_EMAIL_API_KEY']) {
    assert.match(text, new RegExp(`${k} is missing`), k);
  }
  assert.doesNotMatch(text, /AZ_SMTP_HOST/, 'CONTROL: keys for the other email way are not demanded');
});

test('config: unsafe values are refused — short secret, http origin, credentials in a URL, a path origin', () => {
  const r = loadConfig({
    AZ_SESSION_SECRET: 'short', AZ_BACKEND_PUBLIC_URL: 'http://api.example.org', AZ_ALLOWED_ORIGINS: 'https://u:p@www.example.org,https://www.example.org/app',
    AZ_EMAIL_FROM: 'x', AZ_SMTP_HOST: 'h', AZ_SMTP_PORT: '587',
  }, { database: 'sqlite', email: 'smtp' }, 's');
  const text = r.ok ? '' : r.problems.join('\n');
  assert.match(text, /AZ_SESSION_SECRET must be at least 32/);
  assert.match(text, /AZ_BACKEND_PUBLIC_URL must use https/);
  assert.match(text, /must not carry a user name or password/);
  assert.match(text, /without a path/);
});

test('config: a database CA file needs TLS required; with it, the path is kept for the start-up read', () => {
  const base = {
    AZ_SESSION_SECRET: 'x'.repeat(43), AZ_BACKEND_PUBLIC_URL: 'https://api.example.org', AZ_ALLOWED_ORIGINS: 'https://www.example.org',
    AZ_EMAIL_FROM: 'x', AZ_SMTP_HOST: 'h', AZ_SMTP_PORT: '587', AZ_DATABASE_URL: 'postgres://u@db.example.org/app',
  };
  const setup = { database: 'postgres', email: 'smtp' } as const;
  const bad = loadConfig({ ...base, AZ_DATABASE_CA_FILE: './ca.pem' }, setup, 's');
  assert.match(bad.ok ? '' : bad.problems.join('\n'), /AZ_DATABASE_CA_FILE is only used with AZ_DATABASE_TLS=require/);
  const good = loadConfig({ ...base, AZ_DATABASE_CA_FILE: './ca.pem', AZ_DATABASE_TLS: 'require' }, setup, 's');
  assert.ok(good.ok, good.ok ? '' : good.problems.join('\n'));
  assert.equal(good.ok && good.config.databaseCaFile, './ca.pem');
  assert.equal(good.ok && good.config.databaseTls, true);
});

test('config: the upload cap is 1–20 MB, default 5; the files folder defaults outside anything served (data-spec §8)', () => {
  const base = {
    AZ_SESSION_SECRET: 'x'.repeat(43), AZ_BACKEND_PUBLIC_URL: 'https://api.example.org', AZ_ALLOWED_ORIGINS: 'https://www.example.org',
    AZ_EMAIL_FROM: 'x', AZ_SMTP_HOST: 'h', AZ_SMTP_PORT: '587',
  };
  const images = { database: 'sqlite', email: 'smtp', data: true, images: true } as const;
  for (const v of ['0', '21', '2.5', 'lots']) {
    const r = loadConfig({ ...base, AZ_UPLOAD_MAX_MB: v }, images, 's');
    assert.match(r.ok ? '' : r.problems.join('\n'), /AZ_UPLOAD_MAX_MB must be a whole number of MB, 1–20/, v);
  }
  const d = loadConfig(base, images, 's');
  assert.deepEqual(d.ok && [d.config.uploadLimit, d.config.filesDir], [5 * 1024 * 1024, './data/files']);
  const set = loadConfig({ ...base, AZ_UPLOAD_MAX_MB: '20', AZ_FILES_DIR: '/srv/files' }, images, 's');
  assert.deepEqual(set.ok && [set.config.uploadLimit, set.config.filesDir], [20 * 1024 * 1024, '/srv/files']);
  assert.ok(loadConfig({ ...base, AZ_UPLOAD_MAX_MB: 'lots' }, { database: 'sqlite', email: 'smtp' }, 's').ok, 'CONTROL: a site without images ignores the key');
});

test('config: every provider key is checked, and an oauth2 provider without a verified field is still valid', () => {
  const base = { AZ_SESSION_SECRET: 'x'.repeat(43), AZ_BACKEND_PUBLIC_URL: 'https://api.example.org', AZ_ALLOWED_ORIGINS: 'https://www.example.org', AZ_EMAIL_FROM: 'x', AZ_SMTP_HOST: 'h', AZ_SMTP_PORT: '587' };
  const bad = loadConfig({ ...base, AZ_OAUTH_PROVIDERS: 'work,Bad_Id', AZ_OAUTH_WORK_TYPE: 'oidc' }, { database: 'sqlite', email: 'smtp' }, 's');
  const text = bad.ok ? '' : bad.problems.join('\n');
  assert.match(text, /AZ_OAUTH_WORK_LABEL is missing/);
  assert.match(text, /AZ_OAUTH_WORK_ISSUER is missing/);
  assert.match(text, /AZ_OAUTH_WORK_CLIENT_SECRET is missing/);
  assert.match(text, /'Bad_Id' is not a provider id/);
  const good = loadConfig({ ...base, AZ_OAUTH_PROVIDERS: 'forge', AZ_OAUTH_FORGE_TYPE: 'oauth2', AZ_OAUTH_FORGE_LABEL: 'Forge',
    AZ_OAUTH_FORGE_AUTHORIZE_URL: 'https://f.example/a', AZ_OAUTH_FORGE_TOKEN_URL: 'https://f.example/t', AZ_OAUTH_FORGE_USERINFO_URL: 'https://f.example/u',
    AZ_OAUTH_FORGE_CLIENT_ID: 'c', AZ_OAUTH_FORGE_CLIENT_SECRET: 's', AZ_OAUTH_FORGE_SCOPES: 'read:user' }, { database: 'sqlite', email: 'smtp' }, 's');
  assert.equal(good.ok, true, good.ok ? '' : good.problems.join('\n'));
});

test('config: no key the server reads is public — none would ever be inlined into a site', () => {
  assert.ok(KEYS.every((k) => !k.name.startsWith('AZ_PUBLIC_')));
});

/* ---- passwords and digests ------------------------------------------ */

test('passwords: scrypt at the stated cost, salted, verified in constant time', async () => {
  const a = await hashPassword(GOOD);
  const b = await hashPassword(GOOD);
  assert.match(a, new RegExp(`^scrypt\\$${SCRYPT.N}\\$${SCRYPT.r}\\$${SCRYPT.p}\\$`));
  assert.notEqual(a, b, 'a fresh salt per hash');
  assert.deepEqual(await verifyPassword(GOOD, a), { ok: true, rehash: false });
  assert.equal((await verifyPassword('wrong-password-here', a)).ok, false, 'CONTROL');
  const old = await hashPassword(GOOD, { N: 2 ** 14, r: 8, p: 1 });
  assert.deepEqual(await verifyPassword(GOOD, old), { ok: true, rehash: true }, 'older parameters are upgraded on next sign-in');
});

test('digests: keyed by the secret, so the same token under another secret does not match', () => {
  const s1 = Buffer.alloc(32, 1);
  const s2 = Buffer.alloc(32, 2);
  assert.notEqual(digest(s1, 'tok'), digest(s2, 'tok'));
  assert.ok(safeEqual('abc', 'abc') && !safeEqual('abc', 'abd') && !safeEqual('abc', 'abcd'));
});

/* ---- schema --------------------------------------------------------- */

test('migrations: apply once, and are a no-op on the next start', async () => {
  const db = await openSqlite(':memory:');
  assert.deepEqual(await migrate(db), [1, 2]);
  assert.deepEqual(await migrate(db), [], 'CONTROL: nothing re-applied');
  const tables = (await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'az_%' ORDER BY name")).map((r) => r.name);
  assert.deepEqual(tables, ['az_oauth_accounts', 'az_oauth_states', 'az_schema_migrations', 'az_sessions', 'az_tokens', 'az_users']);
  await db.close();
});

test('placeholders: PostgreSQL numbering is mechanical', () => {
  assert.equal(numbered('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
});

/* ---- CSRF, CORS, headers -------------------------------------------- */

test('CSRF/CORS: a foreign origin and a POST without the header are refused; the site is allowed exactly', async () => {
  const h = await startBackend();
  try {
    const evil = client(h.url, 'https://evil.test');
    assert.equal((await evil.post('/auth/sign-in', { email: 'a@b.c', password: GOOD })).status, 403);
    assert.equal((await evil.get('/auth/session')).status, 403, 'a foreign origin cannot even read the session');
    const site = client(h.url);
    const noHeader = await fetch(`${h.url}/auth/sign-out`, { method: 'POST', headers: { origin: SITE, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(noHeader.status, 403, 'POST without x-az-request is refused');
    const pre = await fetch(`${h.url}/auth/sign-in`, { method: 'OPTIONS', headers: { origin: SITE } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), SITE, 'exact origin, never *');
    assert.equal(pre.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(pre.headers.get('vary'), 'Origin');
    const ok = await site.get('/auth/session');
    assert.equal(ok.status, 200, 'CONTROL: the allowed site reads its session');
    for (const [k, v] of Object.entries({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' })) {
      assert.equal(ok.headers.get(k), v, k);
    }
    assert.match(ok.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  } finally { await h.close(); }
});

test('bodies: over 16 KB, not JSON, or not an object is refused', async () => {
  const h = await startBackend();
  try {
    const c = client(h.url);
    assert.equal((await c.post('/auth/sign-in', { email: 'a'.repeat(20_000), password: 'x' })).status, 400);
    assert.equal((await c.post('/auth/sign-in', [1, 2])).status, 400);
    const text = await fetch(`${h.url}/auth/sign-in`, { method: 'POST', headers: { origin: SITE, 'x-az-request': '1', 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(text.status, 400);
  } finally { await h.close(); }
});

/* ---- sign-up, sign-in, session -------------------------------------- */

test('sign-up: the server re-checks the retype, the minimum, the name — and stores the profile', async () => {
  const h = await startBackend();
  try {
    const c = client(h.url);
    const mism = await c.post('/auth/sign-up', { ...ada, passwordConfirm: 'a-different-password' });
    assert.deepEqual([mism.status, await mism.json()], [400, { error: 'password_mismatch', field: 'passwordConfirm' }]);
    const weak = await c.post('/auth/sign-up', { ...ada, password: 'short', passwordConfirm: 'short' });
    assert.deepEqual(await weak.json(), { error: 'weak_password', field: 'password' });
    assert.deepEqual(await (await c.post('/auth/sign-up', { ...ada, name: '  ' })).json(), { error: 'unknown', field: 'name' });
    const ok = await c.post('/auth/sign-up', ada);
    assert.equal(ok.status, 200);
    const set = ok.headers.getSetCookie().find((x) => x.startsWith('__Host-az_session='))!;
    assert.match(set, /HttpOnly/);
    assert.match(set, /Secure/);
    assert.match(set, /SameSite=Lax/);
    const body = await ok.json() as { session: { user: Record<string, string> } };
    assert.equal(JSON.stringify(body).includes(c.jar.get('__Host-az_session')!), false, 'no token in any body — the cookie is the credential');
    assert.deepEqual(body.session.user, { id: body.session.user.id, email: 'ada@studio.test', name: 'Ada', location: 'Lisbon' });
    const read = await (await c.get('/auth/session')).json() as { session: { user: { name: string } } };
    assert.equal(read.session.user.name, 'Ada');
    const again = await client(h.url).post('/auth/sign-up', { ...ada, email: 'ADA@studio.test' });
    assert.deepEqual([again.status, await again.json()], [409, { error: 'email_taken', field: 'email' }], 'addresses compare case-insensitively');
  } finally { await h.close(); }
});

test('SECURITY: SQL in any field is data, never a query', async () => {
  const h = await startBackend();
  try {
    const c = client(h.url);
    await c.post('/auth/sign-up', ada);
    for (const email of ["' OR '1'='1", "ada@studio.test' --", "x'); DROP TABLE az_users; --"]) {
      const r = await client(h.url).post('/auth/sign-in', { email, password: "' OR '1'='1" });
      assert.equal(r.status, 401, email);
    }
    const hostile = await client(h.url).post('/auth/sign-up', { ...ada, email: 'bob@studio.test', name: "Robert'); DROP TABLE az_users;--", location: "x' OR 1=1 --" });
    const s = await hostile.json() as { session: { user: { name: string; location: string } } };
    assert.equal(s.session.user.name, "Robert'); DROP TABLE az_users;--", 'stored literally');
    assert.equal((await client(h.url).post('/auth/sign-in', { email: 'ada@studio.test', password: GOOD })).status, 200, 'CONTROL: the table is intact');
  } finally { await h.close(); }
});

test('sign-in: one answer for "no such account" and "wrong password", with the same scrypt work', async () => {
  const h = await startBackend();
  try {
    await client(h.url).post('/auth/sign-up', ada);
    // The work is timed by this process's CPU (the backend runs in it, its
    // scrypt on the thread pool), not the wall clock, which also counts
    // whatever else the machine is running.
    const time = async (email: string) => {
      const t = process.cpuUsage();
      const r = await client(h.url).post('/auth/sign-in', { email, password: 'not-the-password' });
      const used = process.cpuUsage(t);
      return { ms: (used.user + used.system) / 1000, status: r.status, body: await r.json() };
    };
    await time('warmup@studio.test');
    const known = await time('ada@studio.test');
    const unknown = await time('nobody@studio.test');
    assert.deepEqual([known.status, known.body], [401, { error: 'invalid_credentials' }]);
    assert.deepEqual([unknown.status, unknown.body], [401, { error: 'invalid_credentials' }], 'no field, no hint');
    assert.ok(unknown.ms > known.ms * 0.4, `an unknown account still pays for scrypt (${unknown.ms.toFixed(0)}ms vs ${known.ms.toFixed(0)}ms)`);
  } finally { await h.close(); }
});

test('sign-in: rate-limited per account (and per address), answered 429', async () => {
  const h = await startBackend();
  try {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await client(h.url).post('/auth/sign-in', { email: 'ada@studio.test', password: 'wrong-wrong-wrong' })).status;
    assert.equal(last, 429);
    const other = await client(h.url).post('/auth/sign-in', { email: 'someone@studio.test', password: 'wrong-wrong-wrong' });
    assert.equal(other.status, 401, 'CONTROL: another account is not locked by it');
  } finally { await h.close(); }
});

test('sessions: rotated at sign-in, ended on the server at sign-out', async () => {
  const h = await startBackend();
  try {
    const c = client(h.url);
    await c.post('/auth/sign-up', ada);
    const first = c.jar.get('__Host-az_session')!;
    await c.post('/auth/sign-in', { email: ada.email, password: GOOD });
    const second = c.jar.get('__Host-az_session')!;
    assert.notEqual(first, second, 'a new session id at sign-in');
    const stale = await fetch(`${h.url}/auth/session`, { headers: { origin: SITE, cookie: `__Host-az_session=${first}` } });
    assert.equal((await stale.json() as { session: unknown }).session, null, 'the replaced session no longer works');
    assert.equal((await c.post('/auth/sign-out', {})).status, 204);
    const replay = await fetch(`${h.url}/auth/session`, { headers: { origin: SITE, cookie: `__Host-az_session=${second}` } });
    assert.equal((await replay.json() as { session: unknown }).session, null, 'a copied cookie is dead after sign-out');
  } finally { await h.close(); }
});

/* ---- reset and sign-in links ----------------------------------------- */

const tokenIn = (text: string) => new URL(/https?:\/\/\S+/.exec(text)![0]).searchParams.get('token')!;

test('reset: same answer for any address; emailed single-use, expiring link; retype re-checked first', async () => {
  const h = await startBackend();
  try {
    await client(h.url).post('/auth/sign-up', ada);
    const none = await client(h.url).post('/auth/reset', { email: 'nobody@studio.test' });
    assert.deepEqual([none.status, await none.json()], [200, {}]);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.mail.length, 0, 'no email for an address without an account');
    assert.deepEqual(await (await client(h.url).post('/auth/reset', { email: 'ada@studio.test' })).json(), {});
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(h.mail.length, 1);
    const link = /https?:\/\/\S+/.exec(h.mail[0].text)![0];
    assert.ok(link.startsWith(`${SITE}/reset?token=`), 'to the site\'s reset page');
    const token = tokenIn(h.mail[0].text);
    const c = client(h.url);
    const mism = await c.post('/auth/password', { token, password: 'a-new-long-password', passwordConfirm: 'different' });
    assert.deepEqual(await mism.json(), { error: 'password_mismatch', field: 'passwordConfirm' });
    const ok = await c.post('/auth/password', { token, password: 'a-new-long-password', passwordConfirm: 'a-new-long-password' });
    assert.equal(ok.status, 200, 'a mistyped retype did not burn the link');
    const reuse = await client(h.url).post('/auth/password', { token, password: 'another-long-password', passwordConfirm: 'another-long-password' });
    assert.deepEqual(await reuse.json(), { error: 'expired_token' }, 'single use');
    assert.equal((await client(h.url).post('/auth/sign-in', { email: ada.email, password: GOOD })).status, 401, 'the old password is gone');
    // Expiry: a fresh link, the clock moved past 30 minutes.
    await client(h.url).post('/auth/reset', { email: 'ada@studio.test' });
    await new Promise((r) => setTimeout(r, 20));
    h.clock.now += 31 * 60 * 1000;
    const late = await client(h.url).post('/auth/password', { token: tokenIn(h.mail[1].text), password: 'another-long-password', passwordConfirm: 'another-long-password' });
    assert.deepEqual(await late.json(), { error: 'expired_token' }, 'expired');
  } finally { await h.close(); }
});

test('reset: a password change ends every other session', async () => {
  const h = await startBackend();
  try {
    const other = client(h.url);
    await other.post('/auth/sign-up', ada);
    await client(h.url).post('/auth/reset', { email: ada.email });
    await new Promise((r) => setTimeout(r, 20));
    await client(h.url).post('/auth/password', { token: tokenIn(h.mail[0].text), password: 'a-new-long-password', passwordConfirm: 'a-new-long-password' });
    assert.equal((await (await other.get('/auth/session')).json() as { session: unknown }).session, null);
  } finally { await h.close(); }
});

test('sign-in link: emailed, signs in once, lands on the site; a second use fails', async () => {
  const h = await startBackend({ AZ_LINK_LANDING: '/account' });
  try {
    await client(h.url).post('/auth/sign-up', ada);
    // The link is bound to the browser that asked for it (login CSRF).
    const browser = client(h.url);
    await browser.post('/auth/link', { email: ada.email });
    await new Promise((r) => setTimeout(r, 20));
    const href = /https?:\/\/\S+/.exec(h.mail[0].text)![0];
    assert.ok(href.startsWith(`${h.url}/auth/link/verify?token=`));
    const r = await browser.navigate(href);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get('location'), `${SITE}/account`);
    assert.ok(browser.jar.get('__Host-az_session'), 'signed in');
    const again = await client(h.url).navigate(href);
    assert.equal(again.headers.get('location'), `${SITE}/login?auth_error=expired_token`);
  } finally { await h.close(); }
});

test('link/reset: rate-limited per address', async () => {
  const h = await startBackend();
  try {
    let status = 0;
    for (let i = 0; i < 4; i++) status = (await client(h.url).post('/auth/link', { email: 'ada@studio.test' })).status;
    assert.equal(status, 429);
  } finally { await h.close(); }
});

/* ---- provider sign-in ------------------------------------------------ */

async function withProvider(idp: Awaited<ReturnType<typeof startIdp>>, extra: Record<string, string> = {}) {
  return startBackend({
    AZ_OAUTH_PROVIDERS: 'work', AZ_OAUTH_WORK_TYPE: 'oidc', AZ_OAUTH_WORK_LABEL: 'Work account', AZ_OAUTH_WORK_ISSUER: idp.url,
    AZ_OAUTH_WORK_CLIENT_ID: 'idp-client', AZ_OAUTH_WORK_CLIENT_SECRET: 'idp-secret', ...extra,
  });
}

/** Follow start → provider → callback like a browser; returns the final redirect. */
async function roundTrip(h: { url: string }, browser: ReturnType<typeof client>, next = '/account') {
  const start = await browser.navigate(`${h.url}/auth/oauth/work/start?next=${encodeURIComponent(next)}&site=${encodeURIComponent(SITE)}`);
  assert.equal(start.status, 302, `start: ${start.status}`);
  const authorize = new URL(start.headers.get('location')!);
  const atProvider = await browser.navigate(authorize.href);
  const callback = atProvider.headers.get('location')!;
  const done = await browser.navigate(callback);
  return { authorize, done, location: done.headers.get('location') ?? '' };
}

test('oauth: providers list is only { id, label }', async () => {
  const idp = await startIdp({ email: 'ada@studio.test', verified: true });
  const h = await withProvider(idp);
  try {
    assert.deepEqual(await (await client(h.url).get('/auth/providers')).json(), { providers: [{ id: 'work', label: 'Work account' }] });
  } finally { await h.close(); idp.close(); }
});

test('oauth: start refuses an unlisted site or an off-site next; sends PKCE S256, nonce and a bound state', async () => {
  const idp = await startIdp({ email: 'ada@studio.test', verified: true });
  const h = await withProvider(idp);
  try {
    const b = client(h.url);
    assert.equal((await b.navigate(`${h.url}/auth/oauth/work/start?next=/&site=https%3A%2F%2Fevil.test`)).status, 400);
    assert.equal((await b.navigate(`${h.url}/auth/oauth/work/start?next=%2F%2Fevil.test&site=${encodeURIComponent(SITE)}`)).status, 400);
    const start = await b.navigate(`${h.url}/auth/oauth/work/start?next=/account&site=${encodeURIComponent(SITE)}`);
    const q = new URL(start.headers.get('location')!).searchParams;
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.ok(q.get('code_challenge') && q.get('nonce') && q.get('state'));
    assert.equal(q.get('redirect_uri'), `${h.url}/auth/oauth/work/callback`);
    const stateCookie = start.headers.getSetCookie().find((c) => c.startsWith('__Secure-az_oauth_state='))!;
    assert.match(stateCookie, /HttpOnly/);
    assert.match(stateCookie, /Path=\/auth\/oauth/);
  } finally { await h.close(); idp.close(); }
});

test('oauth: a verified email links to the existing account and signs in (RS256 id_token via JWKS)', async () => {
  const idp = await startIdp({ email: 'ada@studio.test', verified: true });
  const h = await withProvider(idp);
  try {
    await client(h.url).post('/auth/sign-up', ada);
    const b = client(h.url);
    const r = await roundTrip(h, b);
    assert.equal(r.location, `${SITE}/account`);
    assert.ok(b.jar.get('__Host-az_session'));
    const s = await (await b.get('/auth/session')).json() as { session: { user: { email: string } } };
    assert.equal(s.session.user.email, 'ada@studio.test');
  } finally { await h.close(); idp.close(); }
});

test('oauth: an UNVERIFIED email never links (email_unverified); no account without AZ_OAUTH_SIGNUP=allow', async () => {
  const idp = await startIdp({ email: 'ada@studio.test', verified: false });
  const h = await withProvider(idp);
  try {
    await client(h.url).post('/auth/sign-up', ada);
    const r = await roundTrip(h, client(h.url));
    assert.equal(r.location, `${SITE}/login?auth_error=email_unverified`);
    idp.user.verified = true;
    idp.user.email = 'newcomer@studio.test';
    const r2 = await roundTrip(h, client(h.url));
    assert.equal(r2.location, `${SITE}/login?auth_error=oauth_failed`, 'deny by default: no new account');
  } finally { await h.close(); idp.close(); }
});

test('oauth: AZ_OAUTH_SIGNUP=allow creates a verified account for a new verified address', async () => {
  const idp = await startIdp({ email: 'newcomer@studio.test', verified: true });
  const h = await withProvider(idp, { AZ_OAUTH_SIGNUP: 'allow' });
  try {
    const b = client(h.url);
    assert.equal((await roundTrip(h, b)).location, `${SITE}/account`);
    const s = await (await b.get('/auth/session')).json() as { session: { user: { name: string } } };
    assert.equal(s.session.user.name, 'Provider Person');
  } finally { await h.close(); idp.close(); }
});

test('SECURITY oauth: forged, wrong-audience, expired, wrong-nonce and alg-confusion tokens are all refused', async () => {
  const idp = await startIdp({ email: 'ada@studio.test', verified: true });
  const h = await withProvider(idp);
  try {
    await client(h.url).post('/auth/sign-up', ada);
    const cases: [string, Partial<typeof idp.tamper>][] = [
      ['alg none', { alg: 'none' }],
      ['HS256 signed with an RSA key (algorithm confusion)', { alg: 'HS256' }],
      ['another audience', { aud: 'someone-else' }],
      ['another issuer', { iss: 'http://127.0.0.1:1' }],
      ['expired', { exp: Math.floor(Date.now() / 1000) - 3600 }],
      ['wrong nonce', { nonce: 'replayed' }],
    ];
    for (const [name, t] of cases) {
      Object.assign(idp.tamper, { alg: undefined, aud: undefined, iss: undefined, exp: undefined, nonce: undefined }, t);
      const b = client(h.url);
      assert.equal((await roundTrip(h, b)).location, `${SITE}/login?auth_error=oauth_failed`, name);
      assert.equal(b.jar.get('__Host-az_session'), undefined, `${name}: no session`);
    }
    Object.assign(idp.tamper, { alg: undefined, aud: undefined, iss: undefined, exp: undefined, nonce: undefined });
    assert.equal((await roundTrip(h, client(h.url))).location, `${SITE}/account`, 'CONTROL: the honest token signs in');
  } finally { await h.close(); idp.close(); }
});

test('SECURITY oauth: a callback without this browser\'s state cookie, or replayed, fails', async () => {
  const idp = await startIdp({ email: 'ada@studio.test', verified: true });
  const h = await withProvider(idp);
  try {
    await client(h.url).post('/auth/sign-up', ada);
    const victim = client(h.url);
    const start = await victim.navigate(`${h.url}/auth/oauth/work/start?next=/&site=${encodeURIComponent(SITE)}`);
    const atProvider = await victim.navigate(start.headers.get('location')!);
    const callback = atProvider.headers.get('location')!;
    const attacker = client(h.url);                    // no state cookie
    assert.equal((await attacker.navigate(callback)).headers.get('location'), `${SITE}/login?auth_error=oauth_failed`);
    // The attacker's refused attempt did not burn the victim's state …
    assert.equal((await victim.navigate(callback)).headers.get('location'), `${SITE}/`, 'CONTROL: the victim signs in');
    // … and a callback that did succeed cannot be replayed.
    victim.jar.set('__Secure-az_oauth_state', new URL(callback).searchParams.get('state')!);
    assert.equal((await victim.navigate(callback)).headers.get('location'), `${SITE}/login?auth_error=oauth_failed`,
      'single use: a replayed callback fails even with the state cookie restored');
  } finally { await h.close(); idp.close(); }
});

test('oauth: key rotation — a new kid is fetched from the JWKS', async () => {
  const idp = await startIdp({ email: 'ada@studio.test', verified: true });
  const h = await withProvider(idp);
  try {
    await client(h.url).post('/auth/sign-up', ada);
    assert.equal((await roundTrip(h, client(h.url))).location, `${SITE}/account`);
    idp.rotate();
    h.clock.now += 2 * 60 * 1000;                      // past the refresh floor
    assert.equal((await roundTrip(h, client(h.url))).location, `${SITE}/account`, 'signed with the rotated key');
  } finally { await h.close(); idp.close(); }
});

/* ---- email ----------------------------------------------------------- */

test('email api: posts { from, to, subject, text } with the bearer key, and fails loudly on an error status', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const loaded = loadConfig({
    AZ_SESSION_SECRET: 'x'.repeat(43), AZ_BACKEND_PUBLIC_URL: 'https://api.example.org', AZ_ALLOWED_ORIGINS: 'https://www.example.org',
    AZ_EMAIL_FROM: 'Studio <no-reply@example.org>', AZ_EMAIL_API_URL: 'https://mail.example.org/send', AZ_EMAIL_API_KEY: 'k-123',
  }, { database: 'sqlite', email: 'api' }, 'Studio');
  assert.ok(loaded.ok);
  let status = 202;
  const mailer = await createMailer(loaded.config, { fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(null, { status }); }) as typeof fetch });
  await mailer.send({ to: 'a@b.c', subject: 'S', text: 'T' });
  assert.equal(calls[0].url, 'https://mail.example.org/send');
  assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer k-123');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { from: 'Studio <no-reply@example.org>', to: 'a@b.c', subject: 'S', text: 'T' });
  status = 500;
  await assert.rejects(mailer.send({ to: 'a@b.c', subject: 'S', text: 'T' }), /500/);
});
