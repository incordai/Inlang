/**
 * The hosted adapter's token-endpoint profile — auth-block-spec §3.5.
 * A scripted server stands in here; scripts/cloud-auth-e2e.mjs drives the
 * real server software in a browser.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createTokenEndpointAdapter, mapTokenError, noSuchAccount, parseSettingsProviders, parseTokenResponse,
  type TokenEndpointEnv,
} from '../src/runtime/hosted-token.ts';

const BASE = 'https://id.example.test/api/v1';
const KEY = 'public-anon-key';
const SITE = 'https://site.example.test';

interface Sent { url: string; method: string; headers: Record<string, string>; body: unknown }

const USER = { id: 'u1', email: 'ada@example.test', user_metadata: { name: 'Ada', location: 'Iceland' } };
const tokens = (access = 'access-1', refresh = 'refresh-1', expiresIn = 3600) =>
  ({ access_token: access, refresh_token: refresh, token_type: 'bearer', expires_in: expiresIn, user: USER });

const json = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function harness(reply: (s: Sent) => Response | Promise<Response>, opts: { href?: string; now?: number } = {}) {
  const sent: Sent[] = [];
  const store = new Map<string, string>();
  let href = opts.href ?? `${SITE}/login?next=%2Faccount`;
  const scheduled: { ms: number }[] = [];
  const env: TokenEndpointEnv = {
    fetch: (async (url: string, init: RequestInit) => {
      const s: Sent = {
        url, method: init.method ?? 'GET',
        headers: init.headers as Record<string, string>,
        body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      };
      sent.push(s);
      return reply(s);
    }) as typeof fetch,
    storage: () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) }),
    now: () => opts.now ?? 1_000_000,
    location: () => ({ href, origin: new URL(href).origin }),
    replaceUrl: (url) => { href = new URL(url, href).href; },
    random: (bytes) => bytes.fill(7),
    sha256: async (data) => {
      const d = createHash('sha256').update(data).digest();
      return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
    },
    schedule: (_fn, ms) => { scheduled.push({ ms }); return () => {}; },
  };
  const adapter = createTokenEndpointAdapter({ url: `${BASE}/`, publicKey: KEY, resetPath: '/reset' }, env);
  return { adapter, sent, store, scheduled, href: () => href };
}

/* ---- sign-in and the wire ------------------------------------------------ */

test('sign-in posts the password grant with the public key, and adopts the session', async () => {
  const h = harness(() => json(200, tokens()));
  const r = await h.adapter.signIn({ email: 'ada@example.test', password: 'correct horse battery' });
  assert.equal(r.ok, true);
  assert.equal(h.sent[0].url, `${BASE}/token?grant_type=password`);
  assert.equal(h.sent[0].method, 'POST');
  assert.equal(h.sent[0].headers.apikey, KEY);
  assert.equal(h.sent[0].headers.authorization, `Bearer ${KEY}`);
  assert.deepEqual(h.sent[0].body, { email: 'ada@example.test', password: 'correct horse battery' });
  assert.deepEqual(h.adapter.session()?.user, { id: 'u1', email: 'ada@example.test', name: 'Ada', location: 'Iceland' });
});

test('SECURITY: no token ever leaves the adapter through session()', async () => {
  const h = harness(() => json(200, tokens('secret-access', 'secret-refresh')));
  await h.adapter.signIn({ email: 'a@example.test', password: 'x' });
  assert.doesNotMatch(JSON.stringify(h.adapter.session()), /secret-access|secret-refresh/);
});

test('the access token is refreshed a minute before it expires', async () => {
  const h = harness(() => json(200, tokens('a', 'r', 3600)));
  await h.adapter.signIn({ email: 'a@example.test', password: 'x' });
  assert.deepEqual(h.scheduled.at(-1), { ms: 3600_000 - 60_000 });
});

/* ---- errors -------------------------------------------------------------- */

test('server errors map onto the closed set — new and older response formats', () => {
  assert.deepEqual(mapTokenError(400, { error_code: 'invalid_credentials' }), { code: 'invalid_credentials' });
  assert.deepEqual(mapTokenError(400, { error: 'invalid_grant' }), { code: 'invalid_credentials' });
  assert.deepEqual(mapTokenError(422, { error_code: 'user_already_exists' }), { code: 'email_taken', field: 'email' });
  assert.deepEqual(mapTokenError(422, { error_code: 'weak_password' }), { code: 'weak_password', field: 'password' });
  assert.deepEqual(mapTokenError(429, {}), { code: 'rate_limited' });
  assert.deepEqual(mapTokenError(400, { error_code: 'email_not_confirmed' }), { code: 'email_unconfirmed' });
  assert.deepEqual(mapTokenError(403, { error_code: 'otp_expired' }), { code: 'expired_token' });
  assert.deepEqual(mapTokenError(500, { error_code: 'something_new' }), { code: 'unknown' });
  assert.deepEqual(mapTokenError(500, 'not an object'), { code: 'unknown' });
});

test('an unreachable server is `network`', async () => {
  const h = harness(() => { throw new TypeError('offline'); });
  assert.deepEqual(await h.adapter.signIn({ email: 'a@example.test', password: 'x' }), { ok: false, code: 'network' });
});

/* ---- sign-up ------------------------------------------------------------- */

test('sign-up sends name and location as profile data, and is signed in when the server confirms at once', async () => {
  const h = harness(() => json(200, tokens()));
  const r = await h.adapter.signUp({ email: 'a@example.test', password: 'p'.repeat(12), passwordConfirm: 'p'.repeat(12), name: 'Ada', location: 'Iceland' });
  assert.equal(r.ok && r.session?.user.name, 'Ada');
  assert.equal(h.sent[0].url, `${BASE}/signup?redirect_to=${encodeURIComponent(`${SITE}/login?next=%2Faccount`)}`);
  assert.deepEqual(h.sent[0].body, { email: 'a@example.test', password: 'p'.repeat(12), data: { name: 'Ada', location: 'Iceland' } });
});

test('sign-up that needs email confirmation answers ok with no session', async () => {
  const h = harness(() => json(200, USER));
  assert.deepEqual(await h.adapter.signUp({ email: 'a@example.test', password: 'x'.repeat(12) }), { ok: true, session: null });
  assert.equal(h.adapter.session(), null);
});

test('a mismatched retyped password is refused before anything is sent', async () => {
  const h = harness(() => json(200, tokens()));
  const r = await h.adapter.signUp({ email: 'a@example.test', password: 'a'.repeat(12), passwordConfirm: 'b'.repeat(12) });
  assert.deepEqual(r, { ok: false, code: 'password_mismatch', field: 'passwordConfirm' });
  assert.equal(h.sent.length, 0);
});

/* ---- links, reset: no enumeration, no swallowed misconfiguration --------- */

test('reset asks for a link back to the site reset page, and answers alike for unknown addresses', async () => {
  const h = harness((s) => (s.url.includes('/recover') ? json(200, {}) : json(500, {})));
  assert.deepEqual(await h.adapter.requestReset('a@example.test'), { ok: true, session: null });
  assert.equal(h.sent[0].url, `${BASE}/recover?redirect_to=${encodeURIComponent(`${SITE}/reset`)}`);
  const unknown = harness(() => json(422, { error_code: 'user_not_found' }));
  assert.deepEqual(await unknown.adapter.requestReset('nobody@example.test'), { ok: true, session: null });
});

test('CONTROL: a real error (a refused redirect) is reported, not mistaken for a sent email', async () => {
  const h = harness(() => json(400, { error_code: 'validation_failed' }));
  assert.equal((await h.adapter.requestReset('a@example.test')).ok, false);
  assert.equal(noSuchAccount({ error_code: 'validation_failed' }), false);
  assert.equal(noSuchAccount({ error_code: 'otp_disabled' }), true);
});

test('a sign-in link never creates an account', async () => {
  const h = harness(() => json(200, {}));
  await h.adapter.requestLink('a@example.test');
  assert.match(h.sent[0].url, /\/otp\?redirect_to=/);
  assert.deepEqual(h.sent[0].body, { email: 'a@example.test', create_user: false });
});

/* ---- landing: what an email link brings back ----------------------------- */

test('a recovery link lands with tokens in the fragment: adopted, and dropped from the address', async () => {
  const href = `${SITE}/reset#access_token=acc&refresh_token=ref&expires_in=3600&token_type=bearer&type=recovery`;
  const h = harness((s) => (s.url.endsWith('/user') && s.method === 'GET' ? json(200, USER) : json(200, USER)), { href });
  assert.deepEqual(await h.adapter.landing(), { kind: 'recovery' });
  assert.equal(h.href(), `${SITE}/reset`, 'the tokens are removed from the URL');
  assert.equal(h.sent[0].headers.authorization, 'Bearer acc');
  assert.equal(h.adapter.session()?.user.email, 'ada@example.test');
  // …and the new password is set on that recovery session's user.
  const r = await h.adapter.setPassword('', 'n'.repeat(12), 'n'.repeat(12));
  assert.equal(r.ok, true);
  const put = h.sent.find((s) => s.method === 'PUT')!;
  assert.equal(put.url, `${BASE}/user`);
  assert.equal(put.headers.authorization, 'Bearer acc');
  assert.deepEqual(put.body, { password: 'n'.repeat(12) });
});

test('CONTROL: a page reached normally lands nothing, and setting a password without a session is expired', async () => {
  const h = harness(() => json(200, USER), { href: `${SITE}/reset` });
  assert.equal(await h.adapter.landing(), null);
  assert.deepEqual(await h.adapter.setPassword('', 'n'.repeat(12)), { ok: false, code: 'expired_token' });
  assert.equal(h.sent.length, 0);
});

test('an error fragment is cleared and lands nothing', async () => {
  const h = harness(() => json(200, USER), { href: `${SITE}/login#error=access_denied&error_code=otp_expired` });
  assert.equal(await h.adapter.landing(), null);
  assert.equal(h.href(), `${SITE}/login`);
});

/* ---- providers and PKCE -------------------------------------------------- */

test('providers come from the public settings — enabled sign-in providers only', () => {
  assert.deepEqual(parseSettingsProviders({ external: { email: true, phone: true, zeta: true, alpha: true, off: false, 'Bad Id': true } }),
    [{ id: 'alpha', label: 'Alpha' }, { id: 'zeta', label: 'Zeta' }]);
  assert.deepEqual(parseSettingsProviders(null), []);
});

test('a provider round-trip uses PKCE S256 and returns to this page, then exchanges the code', async () => {
  const h = harness((s) => (s.url.endsWith('/settings') ? json(200, { external: { alpha: true } }) : json(200, tokens())));
  const list = await h.adapter.providers!();
  assert.deepEqual(list, [{ id: 'alpha', label: 'Alpha' }]);
  const start = new URL(h.adapter.oauthStart!('alpha', '/account', SITE));
  const verifier = h.store.get('az.auth.pkce')!;
  const expected = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(start.origin + start.pathname, `${BASE}/authorize`);
  assert.equal(start.searchParams.get('code_challenge'), expected);
  assert.equal(start.searchParams.get('code_challenge_method'), 's256');
  assert.equal(start.searchParams.get('redirect_to'), `${SITE}/login?next=%2Faccount`);

  // Back from the provider with a code, on the same tab (verifier still stored).
  const back = harness((s) => (s.url.includes('grant_type=pkce') ? json(200, tokens()) : json(404, {})),
    { href: `${SITE}/login?next=%2Faccount&code=the-code` });
  back.store.set('az.auth.pkce', verifier);
  assert.deepEqual(await back.adapter.landing(), { kind: 'signin' });
  assert.deepEqual(back.sent[0].body, { auth_code: 'the-code', code_verifier: verifier });
  assert.equal(back.href(), `${SITE}/login?next=%2Faccount`, 'the code is removed from the URL');
  assert.equal(back.store.has('az.auth.pkce'), false, 'the verifier is single-use');
});

test('CONTROL: a `code` with no stored verifier is not exchanged', async () => {
  const h = harness(() => json(200, tokens()), { href: `${SITE}/login?code=stolen` });
  assert.equal(await h.adapter.landing(), null);
  assert.equal(h.sent.length, 0);
});

/* ---- refresh and sign-out ------------------------------------------------ */

test('ready() renews an expired session with the refresh token', async () => {
  const h = harness((s) => (s.url.includes('refresh_token') ? json(200, tokens('access-2', 'refresh-2')) : json(404, {})), { now: 5_000_000 });
  h.store.set('az.auth.session', JSON.stringify({ access: 'old', refresh: 'refresh-1', session: { user: { id: 'u1', email: 'a@example.test' }, expiresAt: 1 } }));
  await h.adapter.ready!();
  assert.deepEqual(h.sent[0].body, { refresh_token: 'refresh-1' });
  assert.equal(h.adapter.session()?.user.id, 'u1');
  assert.match(h.store.get('az.auth.session')!, /refresh-2/, 'the rotated refresh token is kept');
});

test('a refused refresh ends the session', async () => {
  const h = harness(() => json(400, { error_code: 'refresh_token_not_found' }), { now: 5_000_000 });
  h.store.set('az.auth.session', JSON.stringify({ access: 'old', refresh: 'gone', session: { user: { id: 'u1', email: 'a@example.test' }, expiresAt: 1 } }));
  await h.adapter.ready!();
  assert.equal(h.adapter.session(), null);
  assert.equal(h.store.has('az.auth.session'), false);
});

test('sign-out clears the session first, then tells the server with the access token', async () => {
  const h = harness((s) => (s.url.endsWith('/logout') ? new Response(null, { status: 204 }) : json(200, tokens('acc'))));
  await h.adapter.signIn({ email: 'a@example.test', password: 'x' });
  await h.adapter.signOut();
  assert.equal(h.adapter.session(), null);
  const out = h.sent.find((s) => s.url.endsWith('/logout'))!;
  assert.equal(out.headers.authorization, 'Bearer acc');
});

test('SECURITY: tampered storage is re-checked, not trusted', () => {
  const h = harness(() => json(200, {}));
  h.store.set('az.auth.session', JSON.stringify({ access: 1, refresh: 'r', session: { user: { id: 'u' } } }));
  assert.equal(h.adapter.session(), null);
  h.store.set('az.auth.session', '{not json');
  assert.equal(h.adapter.session(), null);
});

test('a token response without a user or tokens is rejected', () => {
  assert.equal(parseTokenResponse({ access_token: 'a', refresh_token: 'r' }, 0), null);
  assert.equal(parseTokenResponse({ user: USER }, 0), null);
  assert.equal(parseTokenResponse('x', 0), null);
});
