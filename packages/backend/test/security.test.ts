/**
 * Findings of the backend security review, each reproduced and guarded:
 * pre-registration takeover (and the rows a planted account wrote), a one-request crash, login CSRF through the
 * sign-in link, spoofable proxy addresses and IPv6 buckets, unbounded
 * limiter maps, personal data in logs, loose address checks, over-long
 * provider values, cookie prefixes, and idle/absolute session expiry.
 * Every attack has a control that still works.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { client, listen, SECRET, SITE, startBackend, startIdp } from './helpers.ts';
import { dataOf } from './data-fixture.ts';
import { migrate, openSqlite } from '../src/server/db.ts';
import { migrateData } from '../src/server/data-migrate.ts';
import { ownedRowDeletes } from '../src/server/data-values.ts';
import { createStore } from '../src/server/store.ts';
import { clientIp, createBackendServer, createLimiter, rateKey, readCookies, requestListener, SECURITY_HEADERS } from '../src/server/http.ts';
import { isEmail, isSitePath } from '../src/server/app.ts';
import { loadConfig } from '../src/server/env.ts';
import { createOidc, ProviderError } from '../src/server/oidc.ts';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

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

/* ---- 1b. the rows a planted account wrote go with the claim ----------- */

const BOARD = '  data posts\n    title text required\n    allow anyone read\n    allow signedin create\n    allow owner edit delete\n'
  + '  data replies\n    post ref posts required\n    body text required\n    allow anyone read\n    allow signedin create\n'
  + '  data notes\n    about ref posts\n    body text required\n    allow anyone read\n    allow signedin create\n';

const items = async (c: ReturnType<typeof client>, t: string) =>
  ((await (await c.get(`/data/${t}`)).json()) as { items: Record<string, unknown>[] }).items;

test('SECURITY squat: claiming a planted account deletes the rows it wrote; rows pointing at them follow their ref', async () => {
  const h = await startBackend({}, { data: dataOf(BOARD) });
  try {
    const attacker = client(h.url);
    assert.equal((await attacker.post('/auth/sign-up', planted)).status, 200);
    const made = await attacker.post('/data/posts', { title: 'planted under the victim' });
    assert.equal(made.status, 201, 'CONTROL: the planter can write while unverified');
    const planted1 = ((await made.json()) as { item: { id: string } }).item.id;

    const bystander = client(h.url);
    await bystander.post('/auth/sign-up', { name: 'B', email: 'bystander@studio.test', password: GOOD, passwordConfirm: GOOD });
    assert.equal((await bystander.post('/data/posts', { title: 'mine' })).status, 201);
    assert.equal((await bystander.post('/data/replies', { post: planted1, body: 'a reply' })).status, 201);
    assert.equal((await bystander.post('/data/notes', { about: planted1, body: 'a mention' })).status, 201);

    const owner = client(h.url);
    await owner.post('/auth/link', { email: VICTIM });
    await settle();
    assert.equal((await owner.navigate(/https?:\/\/\S+/.exec(h.mail[0].text)![0])).status, 302);
    assert.ok(await sessionOf(owner), 'CONTROL: the mailbox owner is signed in');

    const anyone = client(h.url);
    assert.deepEqual((await items(anyone, 'posts')).map((r) => r.title), ['mine'], 'the planted row is gone; the bystander\'s own row stays');
    assert.deepEqual(await items(anyone, 'replies'), [], 'a required ref to it cascades');
    assert.deepEqual((await items(anyone, 'notes')).map((r) => [r.body, r.about ?? null]), [['a mention', null]], 'an optional ref to it is cleared');

    // CONTROL: what the owner writes after the claim is theirs and stays.
    assert.equal((await owner.post('/data/posts', { title: 'the real one' })).status, 201);
    assert.deepEqual((await items(anyone, 'posts')).map((r) => r.title).sort(), ['mine', 'the real one']);
  } finally { await h.close(); }
});

test('SECURITY squat: the claim is one transaction — a failing delete leaves the account, its sessions and its rows as they were', async () => {
  const db = await openSqlite(':memory:');
  try {
    await migrate(db);
    const { tables, steps } = dataOf(BOARD);
    await migrateData(db, steps, { confirm: Infinity });
    const secret = Buffer.from(SECRET, 'base64url');
    const hash = 'planted-hash';
    const seed = async (store: ReturnType<typeof createStore>, email: string) => {
      const u = await store.createUser({ email, name: 'P', passwordHash: hash, location: null, verified: false });
      assert.ok(u !== 'taken');
      const s = await store.createSession(u.id);
      await db.run('INSERT INTO "azd_posts" (id, owner, created, updated, title) VALUES (?, ?, ?, ?, ?)', [randomUUID(), u.id, 1, 1, 'planted']);
      return { id: u.id, token: s.token };
    };
    const count = async (owner: string) => Number((await db.get('SELECT COUNT(*) AS n FROM "azd_posts" WHERE owner = ?', [owner]))!.n);

    const broken = createStore(db, secret, Date.now, undefined, [...ownedRowDeletes('sqlite', tables), 'DELETE FROM "azd_missing" WHERE owner = ?']);
    const a = await seed(broken, 'a@studio.test');
    await assert.rejects(broken.claimUnverified(a.id));
    const after = await broken.userById(a.id);
    assert.deepEqual([after?.emailVerified, after?.passwordHash], [false, hash], 'the account is unchanged');
    assert.ok(await broken.sessionUser(a.token), 'its session is unchanged');
    assert.equal(await count(a.id), 1, 'its rows are unchanged');

    // CONTROL: the same claim with the real statements commits all of it.
    const store = createStore(db, secret, Date.now, undefined, ownedRowDeletes('sqlite', tables));
    assert.equal(await store.claimUnverified(a.id), true);
    assert.deepEqual([(await store.userById(a.id))?.emailVerified, (await store.userById(a.id))?.passwordHash], [true, null]);
    assert.equal(await store.sessionUser(a.token), null);
    assert.equal(await count(a.id), 0);
    // A verified account is never claimed: nothing of it is touched.
    assert.equal(await store.claimUnverified(a.id), false);
    await db.run('INSERT INTO "azd_posts" (id, owner, created, updated, title) VALUES (?, ?, ?, ?, ?)', [randomUUID(), a.id, 2, 2, 'after']);
    assert.equal(await store.claimUnverified(a.id), false);
    assert.equal(await count(a.id), 1, 'CONTROL: a verified owner\'s rows stay');
  } finally { await db.close(); }
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

test('SECURITY cookies: a name that is not sent reads as absent, even one Object.prototype carries', () => {
  const sent = (cookie?: string) => readCookies({ headers: cookie === undefined ? {} : { cookie } } as IncomingMessage);
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    assert.equal(sent('az_s=1').get(name), undefined, name);
    assert.equal(sent().get(name), undefined, `${name}, no cookie header`);
  }
  assert.equal(sent('__proto__=planted; az_s=1').get('__proto__'), 'planted', 'a cookie with that name is read like any other');
  assert.equal(sent('a=1; b=x=y').get('b'), 'x=y', 'CONTROL: the value runs to the end, = and all');
  assert.equal(sent('a=1; b=2').get('a'), '1', 'CONTROL: an ordinary cookie');
  assert.equal(sent('a=1; a=2').get('a'), '2', 'CONTROL: a repeated name keeps its last value, as before');
});

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

/* ---- the last-line 500 ------------------------------------------------- */

/** A real server over requestListener, its handler failing as `fail` says; closed by the caller. */
async function failing(fail: (res: ServerResponse) => void) {
  const lines: string[] = [];
  const server = createServer(requestListener(async (_req, res) => { fail(res); throw new TypeError('handler broke'); }, (l) => lines.push(l)));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); });
  return { url, lines, close };
}

test('SECURITY fallback 500: a handler that throws past its own catch is answered with the full security set', async () => {
  const s = await failing(() => {});
  try {
    const r = await fetch(`${s.url}/auth/session`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(r.status, 500);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(r.headers.get(k), v, k);
    assert.deepEqual(await r.json(), { error: 'unknown' });
    assert.deepEqual(s.lines, ['request failed: TypeError'], 'the error class is logged, never its message');
  } finally { await s.close(); }
});

test('CONTROL fallback: headers already sent are not rewritten — the response is ended', async () => {
  const s = await failing((res) => { res.writeHead(200, { ...SECURITY_HEADERS }); res.write('partial'); });
  try {
    const r = await fetch(s.url, { signal: AbortSignal.timeout(5_000) });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'partial');
  } finally { await s.close(); }
});

/* ---- a request Node cannot parse ---------------------------------------- */

/** How long one raw exchange may take before the probe gives up. */
const RAW_MS = 5_000;

/** Sends `bytes` over a bare TCP connection; resolves with what came back, and whether the server closed it in time. */
function rawExchange(url: string, bytes: string): Promise<{ answer: string; closed: boolean }> {
  const { hostname, port } = new URL(url);
  return new Promise((done, fail) => {
    const s = connect(Number(port), hostname, () => s.write(bytes));
    let answer = '';
    const timer = setTimeout(() => { s.destroy(); done({ answer, closed: false }); }, RAW_MS);
    s.on('data', (c) => { answer += c; });
    s.on('close', () => { clearTimeout(timer); done({ answer, closed: true }); });
    s.on('error', (e: NodeJS.ErrnoException) => { if (e.code !== 'ECONNRESET') { clearTimeout(timer); fail(e); } });
  });
}

/** A real server from createBackendServer, answering every parsed request 204; closed by the caller. */
async function parsing() {
  const server = createBackendServer(async (_req, res) => { res.writeHead(204, { ...SECURITY_HEADERS }).end(); }, () => {});
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const close = () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); });
  return { url, close };
}

/** The header block of a raw answer, by lower-cased name. */
const headersOf = (answer: string) => new Map(answer.split('\r\n\r\n')[0]!.split('\r\n').slice(1)
  .map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()] as const));

const MARKER = 'probe-marker-7f3a';

test('SECURITY malformed request: a bad request line is answered 400 with the full security set, nothing echoed, the socket closed', async () => {
  const s = await parsing();
  try {
    const { answer, closed } = await rawExchange(s.url, `GET /${MARKER} NOT-HTTP\r\nHost: ${MARKER}\r\n\r\n`);
    assert.match(answer, /^HTTP\/1\.1 400 Bad Request\r\n/, answer.split('\r\n')[0]);
    const h = headersOf(answer);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(h.get(k), v, k);
    assert.equal(h.get('connection'), 'close');
    assert.equal(answer.split('\r\n\r\n')[1], '', 'no body');
    assert.ok(!answer.includes(MARKER), 'nothing the client sent comes back');
    assert.ok(closed, 'the server closed the connection');
  } finally { await s.close(); }
});

test('SECURITY oversized header: answered 431 with the full security set, the socket closed', async () => {
  const s = await parsing();
  try {
    // Past Node's default 16 KiB header limit.
    const { answer, closed } = await rawExchange(s.url, `GET / HTTP/1.1\r\nHost: localhost\r\nX-Big: ${MARKER}${'a'.repeat(20 * 1024)}\r\n\r\n`);
    assert.match(answer, /^HTTP\/1\.1 431 Request Header Fields Too Large\r\n/, answer.split('\r\n')[0]);
    const h = headersOf(answer);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(h.get(k), v, k);
    assert.ok(!answer.includes(MARKER), 'nothing the client sent comes back');
    assert.ok(closed, 'the server closed the connection');
  } finally { await s.close(); }
});

test('CONTROL malformed request: a well-formed request on the same server is answered by the handler', async () => {
  const s = await parsing();
  try {
    const { answer } = await rawExchange(s.url, 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.match(answer, /^HTTP\/1\.1 204 No Content\r\n/, answer.split('\r\n')[0]);
  } finally { await s.close(); }
});

test('CONTROL malformed request: a connection the client reset gets no answer and the server keeps serving', async () => {
  const s = await parsing();
  try {
    const { hostname, port } = new URL(s.url);
    await new Promise<void>((ok) => {
      const c = connect(Number(port), hostname, () => { c.write('GET / HTTP/1.1\r\nX-Bad\r\n'); c.resetAndDestroy(); });
      c.on('close', () => ok());
      c.on('error', () => {});
    });
    const { answer } = await rawExchange(s.url, 'GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.match(answer, /^HTTP\/1\.1 204 /, 'still serving');
  } finally { await s.close(); }
});

/* ---- an identity provider that answers with megabytes --------------- */

/**
 * A discovery document of about `bytes`, streamed in chunks as the reader
 * takes them, under `status`; `sent` counts what got out.
 */
async function bigDiscovery(bytes: number, status = 200) {
  const CHUNK = 64 * 1024;
  const state = { sent: 0, closed: false };
  const server = createServer(async (_req, res) => {
    const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const head = JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, padding: '' }).slice(0, -2);
    res.on('close', () => { state.closed = true; });
    res.writeHead(status, { 'content-type': 'application/json' });
    const write = (s: string) => {
      state.sent += Buffer.byteLength(s);
      if (res.write(s)) return Promise.resolve();
      return new Promise<void>((ok) => {
        const done = () => { res.off('drain', done); res.off('close', done); ok(); };
        res.once('drain', done);
        res.once('close', done);
      });
    };
    await write(head);
    while (state.sent + CHUNK < bytes && !state.closed) await write('a'.repeat(CHUNK));
    if (!state.closed) res.end('"}');
  });
  const url = await listen(server);
  const provider = {
    id: 'big', label: 'Big', type: 'oidc' as const, issuer: url, clientId: 'c', clientSecret: 's',
    scopes: 'openid email', emailField: 'email', verifiedField: 'email_verified',
  };
  return { state, provider, close: () => { server.closeAllConnections(); server.close(); } };
}

test('SECURITY provider body: a 10 MB discovery document fails the sign-in fast, read no further than the cap', async () => {
  const TEN_MB = 10 * 1024 * 1024;
  const idp = await bigDiscovery(TEN_MB);
  try {
    const started = Date.now();
    await assert.rejects(createOidc((...a) => fetch(...a)).discover(idp.provider),
      (e: unknown) => e instanceof ProviderError && /answered more than 262144 bytes/.test(e.message));
    const took = Date.now() - started;
    assert.ok(took < 2_000, `failed after ${took} ms`);
    for (let waited = 0; !idp.state.closed && waited < 1_000; waited += 10) await new Promise((ok) => setTimeout(ok, 10));
    assert.ok(idp.state.closed, 'the read was cut, not drained: the provider\'s connection is closed');
    assert.ok(idp.state.sent < TEN_MB / 2, `the provider got ${idp.state.sent} bytes out of ${TEN_MB} before the read stopped`);
  } finally { idp.close(); }
});

test('SECURITY provider body: an error status with a 10 MB body fails at the status, and the body is cancelled, not left open', async () => {
  const TEN_MB = 10 * 1024 * 1024;
  for (const status of [404, 500, 503]) {
    const idp = await bigDiscovery(TEN_MB, status);
    try {
      await assert.rejects(createOidc((...a) => fetch(...a)).discover(idp.provider),
        (e: unknown) => e instanceof ProviderError && e.message.endsWith(`answered ${status}`), String(status));
      // Left unread, the body held the provider's connection open until the
      // response was collected; cancelled, the connection closes at once.
      for (let waited = 0; !idp.state.closed && waited < 1_000; waited += 10) await new Promise((ok) => setTimeout(ok, 10));
      assert.ok(idp.state.closed, `${status}: the provider's connection is closed`);
      assert.ok(idp.state.sent < TEN_MB / 2, `${status}: the provider got ${idp.state.sent} bytes out of ${TEN_MB} before the read stopped`);
    } finally { idp.close(); }
  }
});

test('CONTROL provider body: a discovery document of normal size is read', async () => {
  const idp = await bigDiscovery(4 * 1024);
  try {
    const found = await createOidc((...a) => fetch(...a)).discover(idp.provider);
    assert.equal(found.issuer, idp.provider.issuer);
    assert.equal(found.tokenEndpoint, `${idp.provider.issuer}/token`);
  } finally { idp.close(); }
});
