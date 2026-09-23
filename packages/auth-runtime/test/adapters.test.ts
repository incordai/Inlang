/**
 * The auth runtime's contract and adapters — auth-block-spec §3, §6.
 * The DOM behaviour (form.ts) is exercised in a browser by scripts/auth-e2e.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_ERROR_CODES, ERROR_COPY, MIN_PASSWORD, safeNext, toErrorCode, validate,
} from '../src/runtime/contract.ts';
import { createHostedAdapter, type HostedEnv } from '../src/runtime/hosted.ts';
import { createSessionAdapter } from '../src/runtime/session.ts';
import {
  BACKEND_AUTH_PATH, CSRF_HEADER, CSRF_VALUE, backendUrlProblem, createBackendAdapter,
} from '../src/runtime/azbackend.ts';

/* ---- contract ------------------------------------------------------------ */

test('every closed error code has copy, and nothing else does', () => {
  assert.deepEqual(Object.keys(ERROR_COPY).sort(), [...AUTH_ERROR_CODES].sort());
  for (const c of AUTH_ERROR_CODES) assert.ok(ERROR_COPY[c].length > 10, c);
});

test('invalid_credentials copy never says which of the two was wrong', () => {
  assert.doesNotMatch(ERROR_COPY.invalid_credentials, /no account|not found|wrong password|unknown email/i);
});

test('a provider string outside the closed set becomes `unknown`', () => {
  assert.equal(toErrorCode('invalid_credentials'), 'invalid_credentials');
  assert.equal(toErrorCode('USER_NOT_FOUND'), 'unknown');
  assert.equal(toErrorCode(undefined), 'unknown');
});

test('§6 validation: email, current vs new password, name, terms', () => {
  assert.deepEqual(validate({ email: '', password: '' }, { password: 'current' }).map((e) => e.field), ['email', 'password']);
  assert.deepEqual(validate({ email: 'a@b' }, {}).map((e) => e.field), ['email']);
  assert.deepEqual(validate({ email: 'a@b.co', password: 'x' }, { password: 'current' }), []);
  assert.deepEqual(validate({ password: 'x'.repeat(MIN_PASSWORD - 1) }, { password: 'new' }).map((e) => e.field), ['password']);
  assert.deepEqual(validate({ password: 'x'.repeat(MIN_PASSWORD) }, { password: 'new' }), []);
  assert.deepEqual(validate({ email: 'a@b.co', name: ' ', terms: false }, { name: true, terms: true }).map((e) => e.field), ['name', 'terms']);
});

test('SECURITY: `next` only ever returns a same-origin path (no open redirect)', () => {
  const o = 'https://site.test';
  assert.equal(safeNext('/account?tab=1#top', o), '/account?tab=1#top');
  for (const bad of ['https://evil.test/x', '//evil.test/x', '/\\evil.test', 'javascript:alert(1)', 'account', '', null]) {
    assert.equal(safeNext(bad as string | null, o), null, String(bad));
  }
});

/* ---- hosted -------------------------------------------------------------- */

interface Sent { url: string; init: RequestInit }

function hostedEnv(reply: (url: string, init: RequestInit) => Response | Promise<Response>, now = 1_000) {
  const sent: Sent[] = [];
  const store = new Map<string, string>();
  const env: HostedEnv = {
    fetch: (async (url: string, init: RequestInit) => { sent.push({ url, init }); return reply(url, init); }) as typeof fetch,
    storage: () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) }),
    now: () => now,
  };
  return { env, sent, store };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const SESSION = { user: { id: 'u1', email: 'ada@studio.test' }, token: 'tok-1', expiresAt: 5_000 };

test('hosted: sign-in posts §3.2 JSON with the PUBLIC key, and keeps the session', async () => {
  const { env, sent, store } = hostedEnv(() => json(200, { session: SESSION }));
  const a = createHostedAdapter({ url: 'https://auth.test/', publicKey: 'pk-public' }, env);
  const r = await a.signIn({ email: 'ada@studio.test', password: 'pw' });
  assert.deepEqual(r, { ok: true, session: { user: SESSION.user, expiresAt: 5_000 } });
  assert.equal(sent[0].url, 'https://auth.test/sign-in');
  assert.equal((sent[0].init.headers as Record<string, string>)['x-public-key'], 'pk-public');
  assert.deepEqual(JSON.parse(String(sent[0].init.body)), { email: 'ada@studio.test', password: 'pw' });
  assert.deepEqual(a.session(), { user: SESSION.user, expiresAt: 5_000 });
  assert.ok(store.has('az.auth.session'));
});

test('hosted: errors map into the closed set, with the field when given', async () => {
  const cases: [Response, unknown][] = [
    [json(401, { error: 'invalid_credentials' }), { ok: false, code: 'invalid_credentials' }],
    [json(409, { error: 'email_taken', field: 'email' }), { ok: false, code: 'email_taken', field: 'email' }],
    [json(400, { error: 'PROVIDER_SPECIFIC' }), { ok: false, code: 'unknown' }],
    [json(400, { error: 'weak_password', field: '<script>' }), { ok: false, code: 'weak_password' }],
    [new Response('slow down', { status: 429 }), { ok: false, code: 'rate_limited' }],
    [json(200, { session: { user: { id: 1 } } }), { ok: false, code: 'unknown' }],
  ];
  for (const [response, expected] of cases) {
    const { env } = hostedEnv(() => response);
    assert.deepEqual(await createHostedAdapter({ url: 'https://auth.test', publicKey: 'k' }, env).signIn({ email: 'a@b.co', password: 'p' }), expected);
  }
  const offline = hostedEnv(() => { throw new TypeError('fetch failed'); });
  assert.deepEqual(await createHostedAdapter({ url: 'https://auth.test', publicKey: 'k' }, offline.env).signIn({ email: 'a@b.co', password: 'p' }),
    { ok: false, code: 'network' });
});

test('hosted: an expired session reads as signed out', async () => {
  const { env } = hostedEnv(() => json(200, { session: SESSION }), 9_999);
  const a = createHostedAdapter({ url: 'https://auth.test', publicKey: 'k' }, env);
  await a.signIn({ email: 'a@b.co', password: 'p' });
  assert.equal(a.session(), null);
});

test('hosted: link and reset requests never create a session', async () => {
  const { env } = hostedEnv(() => json(200, {}));
  const a = createHostedAdapter({ url: 'https://auth.test', publicKey: 'k' }, env);
  assert.deepEqual(await a.requestReset('a@b.co'), { ok: true, session: null });
  assert.deepEqual(await a.requestLink('a@b.co'), { ok: true, session: null });
  assert.equal(a.session(), null);
});

test('hosted: sign-out clears locally, tells the provider with the token, and notifies', async () => {
  const { env, sent } = hostedEnv((url) => (url.endsWith('/sign-out') ? new Response(null, { status: 204 }) : json(200, { session: SESSION })));
  const a = createHostedAdapter({ url: 'https://auth.test', publicKey: 'k' }, env);
  const seen: unknown[] = [];
  a.onChange((s) => seen.push(s));
  await a.signIn({ email: 'a@b.co', password: 'p' });
  await a.signOut();
  assert.equal(a.session(), null);
  const out = sent.find((s) => s.url.endsWith('/sign-out'));
  assert.equal((out?.init.headers as Record<string, string>).authorization, 'Bearer tok-1');
  assert.equal(seen.length, 2);
  assert.equal(seen[1], null);
});

/* ---- session (cookie) ---------------------------------------------------- */

test('session: same-origin requests with the cookie, first read via GET /session', async () => {
  const sent: Sent[] = [];
  const env = {
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, init });
      return url.endsWith('/session') ? json(200, { session: { user: { id: 'u2', email: 'b@c.co' } } }) : json(200, {});
    }) as typeof fetch,
  };
  const a = createSessionAdapter({ base: '/api/auth' }, env);
  assert.equal(a.session(), null, 'nothing known before ready()');
  await a.ready?.();
  assert.deepEqual(a.session(), { user: { id: 'u2', email: 'b@c.co' } });
  assert.equal(sent[0].url, '/api/auth/session');
  assert.equal(sent[0].init.credentials, 'same-origin');
  await a.signOut();
  assert.equal(a.session(), null);
});

/* ---- azbackend: the owner's backend on its own origin (§3.4) ------------- */


/** A fetch that records each call and answers from a table keyed by path. */
function backendFetch(answers: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const a = answers[path] ?? { status: 404, body: { error: 'unknown' } };
    return new Response(a.status === 204 ? null : JSON.stringify(a.body ?? {}), { status: a.status });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const USER = { user: { id: 'u1', email: 'ada@studio.test' } };

test('§3.4: every call is credentialed, carries the CSRF header, and hits <base>/auth', async () => {
  const f = backendFetch({ '/auth/sign-in': { status: 200, body: { session: USER } } });
  const a = createBackendAdapter({ url: 'https://api.studio.test/' }, { fetch: f.fetch });
  const r = await a.signIn({ email: 'ada@studio.test', password: 'pw' });
  assert.deepEqual(r, { ok: true, session: { user: { id: 'u1', email: 'ada@studio.test' } } });
  assert.equal(f.calls[0].url, `https://api.studio.test${BACKEND_AUTH_PATH}/sign-in`);
  assert.equal(f.calls[0].init.credentials, 'include', 'the browser must send and store the cookie cross-origin');
  const headers = f.calls[0].init.headers as Record<string, string>;
  assert.equal(headers[CSRF_HEADER], CSRF_VALUE);
  assert.equal(headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { email: 'ada@studio.test', password: 'pw' });
  assert.equal(a.id, 'azbackend');
  assert.equal(a.session()?.user.email, 'ada@studio.test');
});

test('§3.4: errors map onto the closed set; 429 is rate_limited whatever the body', async () => {
  const f = backendFetch({
    '/auth/sign-in': { status: 401, body: { error: 'invalid_credentials' } },
    '/auth/sign-up': { status: 409, body: { error: 'email_taken', field: 'email' } },
    '/auth/link': { status: 429, body: { error: 'invalid_credentials' } },
    '/auth/password': { status: 400, body: { error: 'USER_BANNED', field: 'nonsense' } },
  });
  const a = createBackendAdapter({ url: 'https://api.studio.test' }, { fetch: f.fetch });
  assert.deepEqual(await a.signIn({ email: 'a@b.co', password: 'x' }), { ok: false, code: 'invalid_credentials' });
  assert.deepEqual(await a.signUp({ email: 'a@b.co', password: 'x' }), { ok: false, code: 'email_taken', field: 'email' });
  assert.deepEqual(await a.requestLink('a@b.co'), { ok: false, code: 'rate_limited' });
  assert.deepEqual(await a.setPassword('t', 'x'), { ok: false, code: 'unknown' },
    'a code outside the set is unknown, and an unknown field is dropped');
});

test('§3.4: an unreachable backend is `network`; a malformed session is no session', async () => {
  const down = createBackendAdapter({ url: 'https://api.studio.test' }, {
    fetch: (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch,
  });
  assert.deepEqual(await down.signIn({ email: 'a@b.co', password: 'x' }), { ok: false, code: 'network' });
  const f = backendFetch({ '/auth/session': { status: 200, body: { session: { user: { id: 7 } } } } });
  const a = createBackendAdapter({ url: 'https://api.studio.test' }, { fetch: f.fetch });
  await a.ready?.();
  assert.equal(a.session(), null, 'a response is input: an id that is not a string is refused');
  assert.equal(f.calls[0].init.method, 'GET');
});

test('SECURITY §3.4: the base URL must be https (http only for loopback), with no credentials', () => {
  assert.equal(backendUrlProblem('https://api.studio.test'), null);
  assert.equal(backendUrlProblem('http://localhost:8000'), null);
  assert.equal(backendUrlProblem('http://127.0.0.1:8000'), null);
  assert.match(backendUrlProblem('http://api.studio.test') ?? '', /must use https/);
  assert.match(backendUrlProblem('') ?? '', /no backend URL/);
  assert.match(backendUrlProblem('api.studio.test') ?? '', /not a URL/);
  assert.match(backendUrlProblem('https://user:pw@api.studio.test') ?? '', /must not carry credentials/);
  assert.match(backendUrlProblem('https://api.studio.test/?next=x') ?? '', /without \? or #/);
  assert.throws(() => createBackendAdapter({ url: 'http://api.studio.test' }), /azbackend — .*must use https/);
});

test('CONTROL: the same-origin `session` adapter is unchanged — no CSRF header, same-origin cookies', async () => {
  const f = backendFetch({ '/api/auth/sign-in': { status: 200, body: { session: USER } } });
  const a = createSessionAdapter({ base: 'https://site.test/api/auth' }, { fetch: f.fetch });
  await a.signIn({ email: 'a@b.co', password: 'x' });
  assert.equal(f.calls[0].init.credentials, 'same-origin');
  assert.equal((f.calls[0].init.headers as Record<string, string>)[CSRF_HEADER], undefined);
  assert.equal(a.id, 'session');
});
