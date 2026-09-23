/**
 * Findings of the backend security review, each reproduced and guarded:
 * pre-registration takeover, a one-request crash, login CSRF through the
 * sign-in link, spoofable proxy addresses and IPv6 buckets, unbounded
 * limiter maps, personal data in logs, loose address checks, over-long
 * provider values, cookie prefixes, and idle/absolute session expiry.
 * Every attack has a control that still works.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { client, SITE, startBackend, startIdp } from './helpers.ts';
import { clientIp, createLimiter, rateKey } from '../src/server/http.ts';
import { isEmail, isSitePath } from '../src/server/app.ts';
import { loadConfig } from '../src/server/env.ts';
import type { IncomingMessage } from 'node:http';

const GOOD = 'a-long-enough-password';
const VICTIM = 'victim@studio.test';
const ATTACKER_PASSWORD = 'attacker-knows-this-one';
const planted = { name: 'Victim', email: VICTIM, password: ATTACKER_PASSWORD, passwordConfirm: ATTACKER_PASSWORD };

const sessionOf = async (c: ReturnType<typeof client>) =>
  (await (await c.get('/auth/session')).json() as { session: unknown }).session;

async function withProvider(idp: Awaited<ReturnType<typeof startIdp>>, extra: Record<string, string> = {}) {
  return startBackend({
    AZ_OAUTH_PROVIDERS: 'work', AZ_OAUTH_WORK_TYPE: 'oidc', AZ_OAUTH_WORK_LABEL: 'Work account', AZ_OAUTH_WORK_ISSUER: idp.url,
    AZ_OAUTH_WORK_CLIENT_ID: 'idp-client', AZ_OAUTH_WORK_CLIENT_SECRET: 'idp-secret', ...extra,
  });
}

/** start → provider → callback, in one cookie jar. */
async function roundTrip(h: Awaited<ReturnType<typeof startBackend>>, b: ReturnType<typeof client>) {
  const start = await b.navigate(`${h.url}/auth/oauth/work/start?next=%2Faccount&site=${encodeURIComponent(SITE)}`);
  const atIdp = await fetch(start.headers.get('location')!, { redirect: 'manual' });
  const callback = await b.navigate(atIdp.headers.get('location')!);
  return { status: callback.status, location: callback.headers.get('location') };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

/* ---- 1. an account planted before its owner arrives ------------------- */

test('SECURITY takeover: a provider claiming an unverified planted account clears the planter\'s password and sessions', async () => {
  const idp = await startIdp({ email: VICTIM, verified: true });
  const h = await withProvider(idp);
  try {
    const attacker = client(h.url);
    assert.equal((await attacker.post('/auth/sign-up', planted)).status, 200);
    assert.ok(await sessionOf(attacker), 'CONTROL: the planter holds a session before the owner arrives');
    const owner = client(h.url);
    assert.equal((await roundTrip(h, owner)).location, `${SITE}/account`, 'the owner signs in with the provider');
    assert.equal(await sessionOf(attacker), null, 'the planter\'s session ended');
    const replay = await client(h.url).post('/auth/sign-in', { email: VICTIM, password: ATTACKER_PASSWORD });
    assert.equal(replay.status, 401, 'the planter\'s password no longer works');
    assert.ok(await sessionOf(owner), 'CONTROL: the owner stays signed in');
  } finally { await h.close(); idp.close(); }
});

test('SECURITY takeover: a sign-in link claiming an unverified planted account clears the planter\'s password and sessions', async () => {
  const h = await startBackend();
  try {
    const attacker = client(h.url);
    await attacker.post('/auth/sign-up', planted);
    const owner = client(h.url);
    await owner.post('/auth/link', { email: VICTIM });
    await settle();
    const href = /https?:\/\/\S+/.exec(h.mail[0].text)![0];
    assert.equal((await owner.navigate(href)).status, 302);
    assert.ok(await sessionOf(owner), 'CONTROL: the mailbox owner is signed in');
    assert.equal(await sessionOf(attacker), null, 'the planter\'s session ended');
    assert.equal((await client(h.url).post('/auth/sign-in', { email: VICTIM, password: ATTACKER_PASSWORD })).status, 401);
  } finally { await h.close(); }
});

test('CONTROL takeover: a VERIFIED account keeps its password when a provider links to it', async () => {
  const idp = await startIdp({ email: VICTIM, verified: true });
  const h = await withProvider(idp);
  try {
    const owner = client(h.url);
    await owner.post('/auth/sign-up', { ...planted, password: GOOD, passwordConfirm: GOOD });
    // Verify the address the ordinary way: a reset proves the mailbox.
    await client(h.url).post('/auth/reset', { email: VICTIM });
    await settle();
    const token = new URL(/https?:\/\/\S+/.exec(h.mail[0].text)![0]).searchParams.get('token')!;
    await client(h.url).post('/auth/password', { token, password: GOOD, passwordConfirm: GOOD });
    await roundTrip(h, client(h.url));
    assert.equal((await client(h.url).post('/auth/sign-in', { email: VICTIM, password: GOOD })).status, 200);
  } finally { await h.close(); idp.close(); }
});

/* ---- 2. one request must never stop the server ------------------------ */

/** A raw request line — `//` cannot be sent through fetch. */
function raw(url: string, target: string): Promise<string> {
  const { hostname, port } = new URL(url);
  return new Promise((done, fail) => {
    const s = connect(Number(port), hostname, () => s.end(`GET ${target} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`));
    let out = '';
    s.on('data', (c) => { out += c; });
    s.on('end', () => done(out));
    s.on('error', fail);
  });
}

test('SECURITY crash: request targets the URL parser rejects are answered 400, and the server keeps serving', async () => {
  const h = await startBackend();
  try {
    for (const target of ['//', '//?', '//%', '//[']) {
      const answer = await raw(h.url, target);
      assert.match(answer, /^HTTP\/1\.1 400 /, `${target} → 400`);
    }
    assert.equal((await fetch(`${h.url}/health`)).status, 200, 'CONTROL: still up');
  } finally { await h.close(); }
});

/* ---- 3. a path on the site, and only that ----------------------------- */

test('SECURITY redirect: dot segments and encoded dots cannot turn a path into //host', () => {
  for (const bad of ['/.//evil.com', '/..//evil.com', '/%2e//evil.com', '/%2E%2E//evil.com', '//evil.com', '/\\evil.com']) {
    assert.equal(isSitePath(bad), false, bad);
  }
  for (const good of ['/', '/account', '/account?tab=1#x', '/a/b-c_d']) assert.equal(isSitePath(good), true, good);
});

/* ---- 4. the address a limit is counted against ------------------------ */

const req = (remote: string, xff?: string) =>
  ({ socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } }) as unknown as IncomingMessage;

test('SECURITY proxy: the address a trusted proxy appended is used, never the client-chosen first entry', () => {
  assert.equal(clientIp(req('10.0.0.1', '6.6.6.6, 203.0.113.9'), 1), '203.0.113.9', 'one proxy: the right-most entry');
  assert.equal(clientIp(req('10.0.0.1', '6.6.6.6, 203.0.113.9, 10.0.0.7'), 2), '203.0.113.9', 'two proxies: second from the right');
  assert.equal(clientIp(req('10.0.0.1', 'not-an-address'), 1), '10.0.0.1', 'garbage falls back to the socket');
  assert.equal(clientIp(req('10.0.0.1', '6.6.6.6'), 0), '10.0.0.1', 'CONTROL: untrusted, the header is ignored');
});

test('SECURITY proxy: AZ_TRUST_PROXY takes false, true (one hop) or a hop count', () => {
  const base = {
    AZ_SESSION_SECRET: 'a'.repeat(43), AZ_BACKEND_PUBLIC_URL: 'https://api.example.org', AZ_ALLOWED_ORIGINS: 'https://www.example.org',
    AZ_EMAIL_FROM: 'x@example.org', AZ_SMTP_HOST: 'smtp.example.org', AZ_SMTP_PORT: '587',
  };
  const hops = (v: string) => {
    const r = loadConfig({ ...base, AZ_TRUST_PROXY: v }, { database: 'sqlite', email: 'smtp' }, 's');
    return r.ok ? r.config.proxyHops : `refused: ${r.problems.join('; ')}`;
  };
  assert.equal(hops('false'), 0);
  assert.equal(hops('true'), 1);
  assert.equal(hops('2'), 2);
  assert.match(String(hops('lots')), /^refused/);
});

test('SECURITY buckets: an IPv6 /64 is one bucket, and an IPv4-mapped address is its IPv4', () => {
  assert.equal(rateKey('2001:db8:1:2:aaaa::1'), rateKey('2001:db8:1:2:ffff:ffff:ffff:ffff'));
  assert.notEqual(rateKey('2001:db8:1:2::1'), rateKey('2001:db8:1:3::1'), 'CONTROL: another /64 is another bucket');
  assert.equal(rateKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(rateKey('203.0.113.9'), '203.0.113.9');
  assert.equal(rateKey('2001:db8::'), rateKey('2001:0db8:0000:0000:1::'), 'compressed and expanded agree');
});

test('SECURITY memory: a limiter keeps at most its key budget, however many addresses arrive', () => {
  let t = 0;
  const l = createLimiter(5, 60_000, () => t, 100);
  for (let i = 0; i < 10_000; i++) { t++; l.take(`k${i}`); }
  assert.ok(l.size() <= 100, `size ${l.size()}`);
  assert.equal(l.take('k9999'), true, 'CONTROL: a recent key is still counted, not forgotten');
});

test('SECURITY proxy: through one trusted proxy, a spoofed first entry cannot escape the sign-in limit', async () => {
  const h = await startBackend({ AZ_TRUST_PROXY: 'true' });
  try {
    let status = 0;
    for (let i = 0; i < 21; i++) {
      const r = await client(h.url).post('/auth/sign-in', { email: `u${i}@studio.test`, password: 'wrong-password-here' },
        { 'x-forwarded-for': `198.51.100.${i}, 203.0.113.9` });
      status = r.status;
    }
    assert.equal(status, 429, 'the 21st attempt from the same real address is limited');
  } finally { await h.close(); }
});

/* ---- 5. a sign-in link works only in the browser that asked for it ---- */

test('SECURITY login CSRF: a sign-in link opened in another browser does not sign that browser in', async () => {
  const h = await startBackend();
  try {
    await client(h.url).post('/auth/sign-up', { name: 'Mallory', email: 'mallory@studio.test', password: GOOD, passwordConfirm: GOOD });
    const attacker = client(h.url);
    await attacker.post('/auth/link', { email: 'mallory@studio.test' });
    await settle();
    const href = /https?:\/\/\S+/.exec(h.mail[0].text)![0];
    const victim = client(h.url);
    const r = await victim.navigate(href);
    assert.equal(r.headers.get('location'), `${SITE}/login?auth_error=expired_token`);
    assert.equal(victim.jar.size, 0, 'no session was planted in the victim\'s browser');
    // CONTROL: the browser that asked can still use a fresh link.
    await attacker.post('/auth/link', { email: 'mallory@studio.test' });
    await settle();
    const ok = await attacker.navigate(/https?:\/\/\S+/.exec(h.mail[1].text)![0]);
    assert.equal(ok.headers.get('location'), `${SITE}/`);
  } finally { await h.close(); }
});

/* ---- 7. no personal data in the operational log ------------------------ */

test('SECURITY logs: a mail failure logs the error class, never the recipient or the server\'s reply', async () => {
  const lines: string[] = [];
  const h = await startBackend({}, {
    log: (l) => lines.push(l),
    mailer: { send: async () => { throw Object.assign(new Error(`550 <${VICTIM}>: Recipient address rejected`), { code: 'EENVELOPE' }); } },
  });
  try {
    await client(h.url).post('/auth/sign-up', { ...planted, password: GOOD, passwordConfirm: GOOD });
    await client(h.url).post('/auth/reset', { email: VICTIM });
    await settle();
    assert.equal(lines.length, 1, 'CONTROL: the failure is logged');
    assert.doesNotMatch(lines[0], /@|Recipient|550/);
    assert.match(lines[0], /EENVELOPE/);
  } finally { await h.close(); }
});

/* ---- tightened checks -------------------------------------------------- */

test('SECURITY addresses: only a plain addr-spec is an email; header and list syntax is refused', async () => {
  for (const bad of ['x<victim@corp.example>', 'a,b@corp.example', 'a;b@corp.example', '"q"@corp.example', 'a@b', 'a@@b.example', 'a@b..example', 'a@-b.example']) {
    assert.equal(isEmail(bad), false, bad);
  }
  for (const good of ['ada@studio.test', 'first.last+tag@sub.example.org', "o'brien@example.co.uk", 'x@xn--bcher-kva.example']) {
    assert.equal(isEmail(good), true, good);
  }
  const h = await startBackend();
  try {
    const r = await client(h.url).post('/auth/sign-up', { ...planted, email: 'x<victim@corp.example>' });
    assert.deepEqual(await r.json(), { error: 'unknown', field: 'email' });
  } finally { await h.close(); }
});

test('SECURITY provider values: an over-long subject is a failed sign-in, not a server error', async () => {
  const idp = await startIdp({ email: 'long@studio.test', verified: true, sub: 's'.repeat(300) });
  const h = await withProvider(idp, { AZ_OAUTH_SIGNUP: 'allow' });
  try {
    assert.equal((await roundTrip(h, client(h.url))).location, `${SITE}/login?auth_error=oauth_failed`);
  } finally { await h.close(); idp.close(); }
});

test('SECURITY cookies: the session cookie is __Host- prefixed; the path-scoped ones __Secure-', async () => {
  const idp = await startIdp({ email: VICTIM, verified: true });
  const h = await withProvider(idp);
  try {
    const r = await client(h.url).post('/auth/sign-up', { ...planted, password: GOOD, passwordConfirm: GOOD });
    const set = r.headers.getSetCookie();
    assert.ok(set.some((c) => /^__Host-az_session=[^;]+; HttpOnly; Secure; Path=\/;/.test(c)), set.join(' | '));
    assert.ok(set.every((c) => !/Domain=/i.test(c)), '__Host- forbids Domain');
    const start = await client(h.url).navigate(`${h.url}/auth/oauth/work/start?next=%2F&site=${encodeURIComponent(SITE)}`);
    assert.match(start.headers.getSetCookie().join(' | '), /^__Secure-az_oauth_state=[^;]+; HttpOnly; Secure; Path=\/auth\/oauth;/);
    const link = await client(h.url).post('/auth/link', { email: VICTIM });
    assert.match(link.headers.getSetCookie().join(' | '), /^__Secure-az_link=[^;]+; HttpOnly; Secure; Path=\/auth\/link;/);
  } finally { await h.close(); idp.close(); }
});

test('SECURITY sessions: an idle session expires, activity keeps it, and the absolute cap still ends it', async () => {
  const h = await startBackend({ AZ_SESSION_IDLE_MINUTES: '60', AZ_SESSION_MAX_HOURS: '5' });
  try {
    const idle = client(h.url);
    await idle.post('/auth/sign-up', { ...planted, password: GOOD, passwordConfirm: GOOD });
    const active = client(h.url);
    await active.post('/auth/sign-in', { email: VICTIM, password: GOOD });
    for (let i = 0; i < 4; i++) {
      h.clock.now += 50 * 60 * 1000;
      assert.ok(await sessionOf(active), `CONTROL: activity every 50 minutes keeps it (${i})`);
    }
    assert.equal(await sessionOf(idle), null, 'unused for 200 minutes: idle-expired');
    h.clock.now += 50 * 60 * 1000;
    assert.ok(await sessionOf(active), 'CONTROL: 250 minutes, still under the 5-hour cap');
    h.clock.now += 55 * 60 * 1000;
    assert.equal(await sessionOf(active), null, 'past 5 hours: ended however active');
  } finally { await h.close(); }
});
