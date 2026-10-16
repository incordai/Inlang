/**
 * The operator's geocoder (chat-block-spec §21.4.2, Q19g), against a local
 * server: GET <url>?q=<address> — the operator's own query kept — read only
 * from a 200 JSON reply within 2 s and 16 KB, the first result's numbers and
 * nothing else; a timeout, a body past the cap, a redirect, a wrong type or
 * shape each fail closed. The runner: a day's cache per address (normalised),
 * a call counted against the visitor's address in the shared windows, a log
 * of outcomes and times — never the address.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { callGeocoder, createGeocoder, GEOCODE_LIMITS, geocodeKey, readGeocode } from '../src/server/chat-geocode.ts';
import { createWindows } from '../src/server/chat-limits.ts';
import { migrateChat } from '../src/server/chat-usage.ts';
import { openSqlite } from '../src/server/db.ts';
import { loadConfig } from '../src/server/env.ts';

const never = new AbortController().signal;

/** A local endpoint answering with `handler`; `seen` holds each request's URL. */
async function endpoint(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ base: string; seen: string[]; close: () => void }> {
  const seen: string[] = [];
  const server = createServer((req, res) => { seen.push(req.url ?? ''); handler(req, res); });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => { server.closeAllConnections(); server.close(); } };
}
const json = (body: unknown, type = 'application/json') => (_req: IncomingMessage, res: ServerResponse) =>
  res.writeHead(200, { 'content-type': type }).end(typeof body === 'string' ? body : JSON.stringify(body));

test('readGeocode: a list or { results }; the first result\'s lat and lon (or lng) as numbers or decimal strings; nothing found is null', () => {
  assert.deepEqual(readGeocode([{ lat: '52.521918', lon: '13.413215', display_name: 'ignored' }, { lat: 1, lon: 1 }]), { lat: 52.521918, lon: 13.413215 });
  assert.deepEqual(readGeocode({ results: [{ lat: 52.5219187, lng: 13.4132156 }] }), { lat: 52.521919, lon: 13.413216 }, 'held to six decimals');
  assert.equal(readGeocode([]), null);
  assert.equal(readGeocode({ results: [] }), null);
  for (const v of [{}, 'x', null, [null], [{ lat: 91, lon: 0 }], [{ lat: 0, lon: 181 }], [{ lat: '1e1', lon: '0' }], [{ lat: 'NaN', lon: 0 }], [{ lat: 1 }], [{ lat: ' 1', lon: '2x' }], { results: {} }]) {
    assert.equal(readGeocode(v), 'shape', JSON.stringify(v));
  }
});

test('callGeocoder: GET with the address as q, the operator\'s own parameters kept; JSON, no cookie, no body', async () => {
  let req: IncomingMessage | null = null;
  const e = await endpoint((r, res) => { req = r; json([{ lat: 1.5, lon: 2.5 }])(r, res); });
  try {
    const r = await callGeocoder(`${e.base}/search?format=json&limit=1`, 'Alexanderplatz, Berlin & more', never);
    assert.deepEqual(r, { ok: true, at: { lat: 1.5, lon: 2.5 } });
    const u = new URL(e.seen[0], 'http://x');
    assert.equal(u.pathname, '/search');
    assert.deepEqual([...u.searchParams], [['format', 'json'], ['limit', '1'], ['q', 'Alexanderplatz, Berlin & more']]);
    assert.equal(req!.method, 'GET');
    assert.equal(req!.headers.cookie, undefined);
    assert.equal(req!.headers.accept, 'application/json');
  } finally {
    e.close();
  }
});

test('callGeocoder fails closed: a status, a type, a body past 16 KB, a shape, a redirect, malformed JSON — and a late reply at its 2 s bound', async () => {
  const cases: [string, (req: IncomingMessage, res: ServerResponse) => void, string][] = [
    ['500', (_q, s) => s.writeHead(500).end(), 'status 500'],
    ['html', json('<html></html>', 'text/html'), 'type'],
    ['big', json(`[{"lat":1,"lon":1,"pad":"${'x'.repeat(GEOCODE_LIMITS.bytes)}"}]`), 'too_large'],
    ['shape', json({ lat: 1, lon: 1 }), 'shape'],
    ['redirect', (_q, s) => s.writeHead(302, { location: 'http://127.0.0.1:9/elsewhere' }).end(), 'redirect'],
    ['malformed', json('[{"lat":1,'), 'malformed'],
  ];
  for (const [name, handler, why] of cases) {
    const e = await endpoint(handler);
    try {
      assert.deepEqual(await callGeocoder(`${e.base}/g`, 'a', never), { ok: false, why }, name);
    } finally {
      e.close();
    }
  }
  const slow = await endpoint(() => undefined);
  try {
    const started = Date.now();
    assert.deepEqual(await callGeocoder(`${slow.base}/g`, 'a', never), { ok: false, why: 'timeout' });
    const took = Date.now() - started;
    assert.ok(took >= GEOCODE_LIMITS.timeoutMs - 50 && took < GEOCODE_LIMITS.timeoutMs + 1_500, `bounded at its 2 s: ${took}ms`);
    // The visitor leaving aborts it at once.
    const ac = new AbortController();
    const pending = callGeocoder(`${slow.base}/g`, 'a', ac.signal);
    ac.abort();
    assert.deepEqual(await pending, { ok: false, why: 'aborted' });
  } finally {
    slow.close();
  }
});

test('the runner: a day\'s cache per address, normalised; a call counted per address in the shared windows; logged with no address', async () => {
  const e = await endpoint((req, res) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q');
    json(q === 'Alexanderplatz, Berlin' ? [{ lat: 52.521918, lon: 13.413215 }] : [])(req, res);
  });
  let clock = Date.UTC(2026, 9, 16, 12);
  const log: string[] = [];
  const db = await openSqlite(':memory:');
  await migrateChat(db);
  try {
    const secret = randomBytes(32);
    const windows = createWindows(db, secret, { now: () => clock });
    const g = createGeocoder({ url: `${e.base}/g`, perAddress: { hour: 2 }, windows, now: () => clock, log: (l) => log.push(l) });
    const run = g.forAnswer('192.0.2.7', never);
    assert.deepEqual(await run('Alexanderplatz, Berlin'), { lat: 52.521918, lon: 13.413215 });
    // The same address, spaced and cased otherwise: the cache, no call.
    assert.deepEqual(await run('  alexanderplatz,   BERLIN '), { lat: 52.521918, lon: 13.413215 });
    assert.equal(e.seen.length, 1);
    assert.equal(await run('No such street'), null, 'nothing found');
    assert.equal(await run('no such street'), null, 'nothing found is remembered too');
    assert.equal(e.seen.length, 2);
    // A third call in the hour is past the address's allowance: unavailable, and no call made.
    assert.equal(await run('Third place'), 'unavailable');
    assert.equal(e.seen.length, 2);
    // Another address still has its own; and on another instance sharing the database (and the secret), the first is still spent.
    assert.equal(await g.forAnswer('192.0.2.8', never)('Third place'), null);
    assert.equal(e.seen.length, 3);
    const other = createGeocoder({ url: `${e.base}/g`, perAddress: { hour: 2 }, windows: createWindows(db, secret, { now: () => clock }), now: () => clock, log: () => {} });
    assert.equal(await other.forAnswer('192.0.2.7', never)('Fourth place'), 'unavailable');
    assert.equal(e.seen.length, 3);
    // A day later the cache has let it go: a new call.
    clock += GEOCODE_LIMITS.cacheMs + 1;
    assert.deepEqual(await run('Alexanderplatz, Berlin'), { lat: 52.521918, lon: 13.413215 });
    assert.equal(e.seen.length, 4);
    assert.ok(log.length > 0 && log.every((l) => /^chat: geocode (found|none|limited) \d+ms$/.test(l)), log.join(' | '));
    assert.ok(!log.join('\n').toLowerCase().includes('alexanderplatz'), 'no address in the log');
  } finally {
    e.close();
    await db.close();
  }
});

test('geocodeKey: NFC, spaces collapsed, trimmed, folded', () => {
  assert.equal(geocodeKey('  Café   de  Flore '), 'café de flore');
});

test('env: AZ_GEOCODER_URL is https or loopback http, no user, no #, no q of its own; read only when a chat shows maps', () => {
  const base = {
    AZ_SESSION_SECRET: randomBytes(32).toString('base64url'), AZ_BACKEND_PUBLIC_URL: 'http://localhost:8787', AZ_ALLOWED_ORIGINS: 'http://localhost:5173',
    AZ_EMAIL_FROM: 'A <a@a.test>', AZ_SMTP_HOST: '127.0.0.1', AZ_SMTP_PORT: '2525', AZ_CHAT_API: 'fake', AZ_CHAT_FAKE_FILE: 'f.json',
  };
  const setup = { database: 'sqlite' as const, email: 'smtp' as const, chat: true, map: true };
  const ok = loadConfig({ ...base, AZ_GEOCODER_URL: 'https://geo.example/search?format=json' }, setup, 's');
  assert.ok(ok.ok && ok.config.chat?.geocoder);
  assert.deepEqual(ok.ok && ok.config.chat?.geocoder, { url: 'https://geo.example/search?format=json', perAddress: { hour: 60 } });
  for (const [url, why] of [
    ['http://geo.example/search', /must use https/], ['https://u:p@geo.example/', /user name or password/], ['https://geo.example/#x', /must not have a #/],
    ['https://geo.example/?q=fixed', /must not set q/], ['not a url', /is not a URL/],
  ] as const) {
    const r = loadConfig({ ...base, AZ_GEOCODER_URL: url }, setup, 's');
    assert.ok(!r.ok && r.problems.some((p) => p.startsWith('AZ_GEOCODER_URL') && why.test(p)), `${url}: ${r.ok ? 'accepted' : r.problems.join(' | ')}`);
  }
  assert.ok(loadConfig({ ...base, AZ_GEOCODER_URL: 'http://127.0.0.1:9/g' }, setup, 's').ok, 'loopback http');
  const rate = loadConfig({ ...base, AZ_GEOCODER_URL: 'https://geo.example/', AZ_GEOCODER_PER_ADDRESS: '5/hour,20/day' }, setup, 's');
  assert.deepEqual(rate.ok && rate.config.chat?.geocoder?.perAddress, { hour: 5, day: 20 });
  // A chat that shows no maps reads none of it.
  const plain = loadConfig({ ...base, AZ_GEOCODER_URL: 'http://geo.example/' }, { ...setup, map: false }, 's');
  assert.ok(plain.ok && plain.config.chat?.geocoder === null && plain.config.map === null);
});
