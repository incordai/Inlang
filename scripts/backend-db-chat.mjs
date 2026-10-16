/**
 * The chat's usage table against REAL PostgreSQL and MySQL (the chat block
 * spec §6.5, §12): `az_chat_usage` created by its own migration, once; one
 * upsert statement per answer; two answers counted at once from two
 * connections both land; the UTC day rolls over; old days are swept; and a
 * chat answered through the route on this engine is counted. C2b
 * (§20.5, §20.7): shared answers through their whole lifecycle, and every
 * aggregation form equal to SQLite's, buckets in UTC. C3 (§8.2): the rows a
 * chat knows, read through the anonymous list on this engine — the search,
 * the newest rows, money in major units, no private value — and a table the
 * server would refuse never read. C4 (§11.4): the operator's usage report,
 * its window, its order and its shares by day. Limits two (§19.11): ISO
 * weeks built from day buckets, equal on every engine across a year boundary
 * and week 53; the blocked count; the rate-limit windows shared by two
 * connections and by two server instances on one database. C7 (§21.3): an
 * explore's rows paged through the anonymous list to its 200 — past one page
 * of 100, ties on the sort key broken by the row's id, no row twice or
 * missed, the default newest first. C8 (§21.4.2): a table map's pins through
 * the same list, a `where` on a choice and on a flag, a row without a place
 * no pin. Run by backend-db.mjs inside its containers.
 */

import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { closeWithin } from './lib/bounded.mjs';
import { compile, plan } from '../packages/core/src/index.ts';
import { dataSteps } from '../packages/backend/src/data-ddl.ts';
import { migrateData } from '../packages/backend/src/server/data-migrate.ts';
import { loadTables } from '../packages/backend/src/server/data-values.ts';
import { createQueries, parseFigures, parsePins, parseRows, QUERY_LIMITS } from '../packages/backend/src/server/chat-query.ts';
import { createKnows, knowsProblems, rowsSection } from '../packages/backend/src/server/chat-knows.ts';
import { createShareStore, SHARE_LIMITS } from '../packages/backend/src/server/chat-share.ts';
import { createApp } from '../packages/backend/src/server/app.ts';
import { createFakeAdapter } from '../packages/backend/src/server/chat-adapters.ts';
import { createChat, parseChatContext } from '../packages/backend/src/server/chat.ts';
import { createRateLimits, createWindows } from '../packages/backend/src/server/chat-limits.ts';
import { createUsage, migrateChat, usageReport, USAGE_KEEP_DAYS, utcDay } from '../packages/backend/src/server/chat-usage.ts';
import { loadConfig } from '../packages/backend/src/server/env.ts';
import { createOidc } from '../packages/backend/src/server/oidc.ts';
import { createStore } from '../packages/backend/src/server/store.ts';

const DB_CLOSE_MS = 15_000;
const FETCH_MS = 15_000;
const DAY = 24 * 60 * 60 * 1000;
const SITE = 'http://127.0.0.1:5173';
const WORDS = new URL('../packages/words/', import.meta.url);

/** chat-block-spec §20.7 on this engine: the share lifecycle, concurrent creates, the 48 KB cap's worth of text, expiry, the sweep. */
export async function shareChecks(engine, db, check) {
  const clock = { now: Date.UTC(2026, 9, 15) };
  const shares = createShareStore({ db, days: 30, max: 10_000, now: () => clock.now });
  const events = [{ type: 'text', s: 'Ünïcode, 😀 and a long answer: ' }, { type: 'block', cta: { label: 'Talk to us', to: '/contact' } }];
  const made = await shares.create(JSON.stringify(events), 'How many?');
  const read = await shares.read(made.id);
  check(`${engine} chat shares: create then read gives the events and question back`,
    JSON.stringify(read?.events) === JSON.stringify(events) && read?.question === 'How many?' && read?.expires === clock.now + 30 * DAY);
  // The size cap's worth of multi-byte text round-trips (MEDIUMTEXT on MySQL).
  const big = JSON.stringify([{ type: 'text', s: 'é'.repeat(Math.floor(SHARE_LIMITS.eventsBytes / 2) - 32) }]);
  const bigMade = await shares.create(big, null);
  check(`${engine} chat shares: ${Buffer.byteLength(big)} bytes of events round-trip`, JSON.stringify((await shares.read(bigMade.id))?.events) === big);
  const many = await Promise.all(Array.from({ length: 10 }, () => shares.create('[]', null)));
  const ids = new Set(many.map((m) => m.id));
  const readable = (await Promise.all(many.map((m) => shares.read(m.id)))).every((r) => r !== null);
  check(`${engine} chat shares: ten concurrent creates make ten readable shares`, ids.size === 10 && readable);
  // §19.11: one live share per tag — the proof's unique index refuses a replay on this engine; shares with no proof never collide.
  const proof = 'f'.repeat(64);
  const proved = await shares.createProved('[]', null, proof);
  const replays = await Promise.all([shares.createProved('[]', null, proof), shares.createProved('[]', null, proof)]);
  check(`${engine} chat shares: a tag's proof makes one share; replayed, even at once from two requests, it is refused`,
    typeof proved === 'object' && replays.every((r) => r === 'replayed'), JSON.stringify(replays));
  check(`${engine} chat shares: a wrong token deletes nothing`, (await shares.remove(made.id, 'x'.repeat(43))) === false && (await shares.read(made.id)) !== null);
  check(`${engine} chat shares: the delete token deletes`, (await shares.remove(made.id, made.token)) === true && (await shares.read(made.id)) === null);
  clock.now = bigMade.expires;
  check(`${engine} chat shares: gone at the instant it expires, before any sweep`, (await shares.read(bigMade.id)) === null);
  check(`${engine} chat shares: the sweep removes every expired share`, (await shares.sweep()) === 12
    && Number((await db.get('SELECT COUNT(*) AS n FROM az_chat_shares')).n) === 0);
}

const SITE_SOURCE = (data) => `az 1\nsite shop\n  auth\n    adapter azbackend\n  backend\n    database sqlite\n    email smtp\n${data}page /\n  hero center\n    title "Hi"\n`;
const FIGURE_TABLE = `  data chatorders
    status   choice   paid open cancelled required
    total    money    usd required
    placed   datetime required
    shipped  date
    note     text     private
    allow anyone read
    allow signedin create
`;

/**
 * chat-block-spec §20.5 on this engine: every aggregation form gives the
 * figures SQLite gives — the month bucket across a year boundary and on a
 * leap day, in UTC whatever the server's zone — and a private field stays
 * out of reach.
 */
export async function figureChecks(engine, db, check) {
  const words = new Map();
  for (const n of readdirSync(WORDS)) {
    const f = new URL(`${n}/word.json`, WORDS);
    if (existsSync(f)) {
      const m = JSON.parse(readFileSync(f, 'utf8'));
      words.set(m.name, m);
    }
  }
  const r = compile(SITE_SOURCE(FIGURE_TABLE), { manifests: words });
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.diagnostics)}`);
  const ops = plan([], r.spec.site.data, { rename: [], drop: [], unique: [] }).ops;
  // Versions far from the data suite's, which shares this database.
  await migrateData(db, dataSteps([{ version: 900, ops }]), { confirm: Infinity });
  const tables = loadTables(JSON.parse(JSON.stringify({ tables: r.spec.site.data }))).map((table) => ({ table, digits: { total: 2 } }));
  const rows = [
    ['paid', 1000, Date.UTC(2025, 11, 31, 23, 30), '2025-12-31', 'private one'],
    ['paid', 2500, Date.UTC(2026, 0, 1, 0, 30), null, null],
    ['open', 999, Date.UTC(2028, 1, 29, 12, 0), '2028-02-29', 'private two'],
    ['cancelled', 1, Date.UTC(2028, 2, 1, 0, 0), null, null],
  ];
  for (const [status, total, placed, shipped, note] of rows) {
    await db.run('INSERT INTO azd_chatorders (id, owner, created, updated, status, total, placed, shipped, note) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), placed, placed, status, total, placed, shipped, note]);
  }
  const q = createQueries({ db, database: engine, publicBase: 'http://127.0.0.1:9', log: () => {} });
  const run = async (s, cap = 24) => {
    const req = parseFigures(s.split(' '), tables, cap);
    const out = req ? await q.run(req) : { ok: false };
    return out.ok ? out.result : null;
  };
  const expect = [
    ['chatorders count by placed month', [['2025-12', 1], ['2026-01', 1], ['2028-02', 1], ['2028-03', 1]]],
    ['chatorders count by placed day', [['2025-12-31', 1], ['2026-01-01', 1], ['2028-02-29', 1], ['2028-03-01', 1]]],
    ['chatorders count by placed year', [['2025', 1], ['2026', 1], ['2028', 2]]],
    ['chatorders sum total by status', [['paid', 35], ['open', 9.99], ['cancelled', 0.01]]],
    ['chatorders count by shipped month', [['2025-12', 1], ['2028-02', 1]]],
  ];
  for (const [s, groups] of expect) {
    const got = await run(s);
    check(`${engine} chat figures: ${s}`, JSON.stringify(got?.groups) === JSON.stringify(groups), JSON.stringify(got?.groups));
  }
  check(`${engine} chat figures: avg total is 11.25`, (await run('chatorders avg total'))?.value === 11.25);
  check(`${engine} chat figures: count where status paid is 2`, (await run('chatorders count where status paid'))?.value === 2);
  check(`${engine} chat figures: max total by placed month keeps the latest 2 of 4 with more set`,
    JSON.stringify((await run('chatorders max total by placed month', 2))?.groups) === JSON.stringify([['2028-02', 9.99], ['2028-03', 0.01]]));
  check(`${engine} chat figures: a private field cannot be asked for`, parseFigures(['chatorders', 'count', 'by', 'note'], tables, 24) === null);
  const listed = await q.run(parseRows(['chatorders', 'columns', 'status', 'total', 'sort', 'placed'], tables));
  check(`${engine} chat figures: rows through the anonymous list, oldest first, money in major units`,
    listed.ok && JSON.stringify(listed.result.rows) === JSON.stringify([['paid', 10], ['paid', 25], ['open', 9.99], ['cancelled', 0.01]]), JSON.stringify(listed));
}

const KNOWS_TABLES = `  data chatguides
    title    text     required search
    body     longtext required search
    price    money    eur
    secret   text     private
    allow anyone read
  data chatnotes
    body     text     required
    allow owner read
    allow signedin create
`;

/**
 * chat-block-spec §8.2 on this engine: the rows a chat knows are the
 * anonymous list's — searched in the `search` fields (case-insensitively,
 * LIKE's wildcards literal), else the newest — public fields only, money in
 * major units; a private value never; an owner-only table never read.
 */
export async function knowsChecks(engine, db, check) {
  const words = new Map();
  for (const n of readdirSync(WORDS)) {
    const f = new URL(`${n}/word.json`, WORDS);
    if (existsSync(f)) {
      const m = JSON.parse(readFileSync(f, 'utf8'));
      words.set(m.name, m);
    }
  }
  const r = compile(SITE_SOURCE(KNOWS_TABLES), { manifests: words });
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.diagnostics)}`);
  const ops = plan([], r.spec.site.data, { rename: [], drop: [], unique: [] }).ops;
  // Versions far from the data and figure suites', which share this database.
  await migrateData(db, dataSteps([{ version: 950, ops }]), { confirm: Infinity });
  const tables = loadTables(JSON.parse(JSON.stringify({ tables: r.spec.site.data })));
  const rows = [
    ['Warranty', 'Every lamp has a LIFETIME warranty.', 4900, 'secret-one'],
    ['Bulbs', 'Any E27 bulb, 100% fits.', null, 'secret-two'],
    ['Shipping', 'Ships in a week.', 1250, null],
  ];
  for (const [i, [title, body, price, secret]] of rows.entries()) {
    await db.run('INSERT INTO azd_chatguides (id, owner, created, updated, title, body, price, secret) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), i + 1, i + 1, title, body, price, secret]);
  }
  await db.run('INSERT INTO azd_chatnotes (id, owner, created, updated, body) VALUES (?, NULL, 1, 1, ?)', [randomUUID(), 'owner-only-note']);
  const known = [{ name: 'chatguides', fields: [
    { name: 'title', type: 'text', search: true }, { name: 'body', type: 'longtext', search: true }, { name: 'price', type: 'money', currency: 'eur', digits: 2 },
  ] }];
  check(`${engine} chat knows: the start-up check passes the build's table`, knowsProblems(known, tables).length === 0);
  const knows = createKnows({ db, database: engine, tables, known });
  const line = (title, body, price) => JSON.stringify({ title, body, price });
  check(`${engine} chat knows: the search finds a row whatever its case`,
    (await knows(['chatguides'], 'lifetime')) === rowsSection('chatguides', [line('Warranty', 'Every lamp has a LIFETIME warranty.', '49.00 EUR')]));
  const newest = await knows(['chatguides'], 'nothing holds these words');
  check(`${engine} chat knows: words no row holds give the newest rows, newest first`,
    newest === rowsSection('chatguides', [line('Shipping', 'Ships in a week.', '12.50 EUR'), line('Bulbs', 'Any E27 bulb, 100% fits.', null), line('Warranty', 'Every lamp has a LIFETIME warranty.', '49.00 EUR')]), newest);
  // As a wildcard, 'E%7' would match 'E27'; as the literal it is, no row holds it, so the newest rows come.
  check(`${engine} chat knows: a % in the words is a literal %, not a wildcard`, (await knows(['chatguides'], 'E%7')) === newest);
  check(`${engine} chat knows: no private value is ever read into a section`, !newest.includes('secret-'));
  const forged = [{ name: 'chatnotes', fields: [{ name: 'body', type: 'text' }] }];
  check(`${engine} chat knows: an owner-only table is refused at start and never read`,
    knowsProblems(forged, tables).length > 0 && (await createKnows({ db, database: engine, tables, known: forged })(['chatnotes'], 'note')) === '');
}

/**
 * chat-block-spec §11.4 on this engine: the operator's usage report — the
 * 30-day window, newest first, shares counted by the UTC day they were made
 * (whole-number division of a BIGINT on each engine), expired ones not, and
 * never a share's text. In a window of its own, far from the other checks' days.
 */
export async function usageReportChecks(engine, db, check) {
  const now = Date.UTC(2031, 0, 20, 12);
  const usage = createUsage(db);
  await usage.add('2031-01-20', 900, 90, 1, 0);
  await usage.add('2031-01-20', 100, 10, 0, 0);
  await usage.block('2031-01-20');
  await usage.add('2030-12-22', 5, 5, 0, 0);
  await usage.add('2030-12-21', 7, 7, 0, 0);
  const words = 'shared-words-the-report-never-reads';
  await createShareStore({ db, days: 30, max: 10_000, now: () => now }).create(JSON.stringify([{ type: 'text', s: words }]), words);
  await createShareStore({ db, days: 30, max: 10_000, now: () => Date.UTC(2031, 0, 18, 23, 59, 59, 999) }).create('[]', null);
  await createShareStore({ db, days: 30, max: 10_000, now: () => Date.UTC(2031, 0, 19) }).create('[]', null);
  await createShareStore({ db, days: 1, max: 10_000, now: () => Date.UTC(2031, 0, 2) }).create('[]', null);
  const r = await usageReport(db, { dailyTokens: 1_500, sharesEnabled: true }, now);
  const want = {
    today: '2031-01-20',
    budget: { daily: 1_500, spent: 1_100, left: 400 },
    days: [
      { day: '2031-01-20', input: 1000, cached: 0, output: 100, messages: 2, dropped: 1, blocked: 1, shares: 1 },
      { day: '2031-01-19', input: 0, cached: 0, output: 0, messages: 0, dropped: 0, blocked: 0, shares: 1 },
      { day: '2031-01-18', input: 0, cached: 0, output: 0, messages: 0, dropped: 0, blocked: 0, shares: 1 },
      { day: '2030-12-22', input: 5, cached: 0, output: 5, messages: 1, dropped: 0, blocked: 0, shares: 0 },
    ],
  };
  const { shares, ...rest } = r;
  check(`${engine} chat usage report: the 30-day window newest first, today against the budget, shares by the UTC day made`,
    JSON.stringify(rest) === JSON.stringify(want), JSON.stringify(r));
  // The other checks' shares are long expired by 2031; only these three are kept.
  check(`${engine} chat usage report: the shares kept now, and never a share's text`, shares.kept === 3 && shares.enabled === true && !JSON.stringify(r).includes(words), JSON.stringify(shares));
}

const WEEK_TABLE = `  data chatweeks
    placed   datetime required
    shipped  date
    amount   money    usd required
    allow anyone read
`;

/**
 * chat-block-spec §19.11 on this engine: `by … week` is the ISO week, built
 * from the engine's day buckets by the server's own code — so every engine
 * gives the same weeks: the last instant of a Sunday and the first of a
 * Monday on either side of a week's edge, week 53 of 2026 holding days of
 * two calendar years, 2020-12-31 in 2020-W53, money in major units.
 */
export async function weekChecks(engine, db, check) {
  const words = new Map();
  for (const n of readdirSync(WORDS)) {
    const f = new URL(`${n}/word.json`, WORDS);
    if (existsSync(f)) {
      const m = JSON.parse(readFileSync(f, 'utf8'));
      words.set(m.name, m);
    }
  }
  const r = compile(SITE_SOURCE(WEEK_TABLE), { manifests: words });
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.diagnostics)}`);
  const ops = plan([], r.spec.site.data, { rename: [], drop: [], unique: [] }).ops;
  // A version far from the other suites', which share this database.
  await migrateData(db, dataSteps([{ version: 960, ops }]), { confirm: Infinity });
  const tables = loadTables(JSON.parse(JSON.stringify({ tables: r.spec.site.data }))).map((table) => ({ table, digits: { amount: 2 } }));
  const rows = [
    ['2026-12-27T23:59:59.999Z', '2026-12-27', 100],
    ['2026-12-28T00:00:00.000Z', '2026-12-28', 300],
    ['2026-12-31T23:59:59.999Z', '2026-12-31', 500],
    ['2027-01-01T00:00:00.000Z', '2027-01-01', 700],
    ['2027-01-03T23:59:59.999Z', '2027-01-03', 900],
    ['2027-01-04T00:00:00.000Z', '2027-01-04', 50],
    ['2020-12-31T12:00:00.000Z', null, 1],
  ];
  for (const [placed, shipped, amount] of rows) {
    const at = Date.parse(placed);
    await db.run('INSERT INTO azd_chatweeks (id, owner, created, updated, placed, shipped, amount) VALUES (?, NULL, ?, ?, ?, ?, ?)',
      [randomUUID(), at, at, at, shipped, amount]);
  }
  const q = createQueries({ db, database: engine, publicBase: 'http://127.0.0.1:9', log: () => {} });
  const run = async (s, cap = 24) => {
    const req = parseFigures(s.split(' '), tables, cap);
    const out = req ? await q.run(req) : { ok: false };
    return out.ok ? out.result : null;
  };
  const expect = [
    ['chatweeks count by placed week', [['2020-W53', 1], ['2026-W52', 1], ['2026-W53', 4], ['2027-W01', 1]]],
    ['chatweeks sum amount by placed week', [['2020-W53', 0.01], ['2026-W52', 1], ['2026-W53', 24], ['2027-W01', 0.5]]],
    ['chatweeks avg amount by shipped week', [['2026-W52', 1], ['2026-W53', 6], ['2027-W01', 0.5]]],
    ['chatweeks min amount by placed week', [['2020-W53', 0.01], ['2026-W52', 1], ['2026-W53', 3], ['2027-W01', 0.5]]],
  ];
  for (const [s, groups] of expect) {
    const got = await run(s);
    check(`${engine} chat figures by ISO week: ${s}`, JSON.stringify(got?.groups) === JSON.stringify(groups) && got?.dated === true, JSON.stringify(got?.groups));
  }
  const latest = await run('chatweeks max amount by placed week', 2);
  check(`${engine} chat figures by ISO week: the latest 2 weeks kept, oldest first, with more set`,
    JSON.stringify(latest?.groups) === JSON.stringify([['2026-W53', 9], ['2027-W01', 0.5]]) && latest?.more === true, JSON.stringify(latest));
}

/**
 * chat-block-spec §19.11 on this engine: the rate-limit windows are the
 * database's, so two connections — two server instances — share one
 * allowance: thirty attempts at once over both let exactly the limit
 * through (the conditional UPDATE is atomic here too), and no row holds an
 * address in the clear.
 */
export async function windowChecks(engine, db, other, check) {
  const secret = randomBytes(32);
  const clock = () => Date.UTC(2031, 5, 1, 12);
  const one = createRateLimits(createWindows(db, secret, { now: clock }), 'chat', { hour: 10 }, {});
  const two = createRateLimits(createWindows(other, secret, { now: clock }), 'chat', { hour: 10 }, {});
  const results = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? one : two).take('198.51.100.23', null)));
  check(`${engine} chat limits: 30 attempts at once over two connections let exactly the 10 an hour allows through`,
    results.filter(Boolean).length === 10, `${results.filter(Boolean).length}`);
  const rows = await db.all('SELECT id, n FROM az_chat_limits');
  check(`${engine} chat limits: one counter at 10, every row named by a keyed hash — no address in the table`,
    rows.filter((r) => Number(r.n) === 10).length === 1 && rows.every((r) => /^[A-Za-z0-9_-]{43}$/.test(String(r.id).trim()))
      && !JSON.stringify(rows).includes('198.51.100') && !JSON.stringify(rows).includes('127.0.0.1'), JSON.stringify(rows));
}

/**
 * chat-block-spec §19.11 on this engine: two server instances (two
 * createChat on two connections, behind one address) — a visitor's
 * messages are counted once across both: the fourth of three an hour is
 * refused whichever instance it reaches. Then a question the moderation
 * hook blocks is counted in the day's `blocked`.
 */
export async function twoInstanceChecks(engine, db, other, check, url) {
  const loaded = loadConfig({
    AZ_SESSION_SECRET: randomBytes(32).toString('base64url'), AZ_BACKEND_PUBLIC_URL: 'http://127.0.0.1:9', AZ_ALLOWED_ORIGINS: SITE,
    AZ_EMAIL_FROM: 'x <x@studio.test>', AZ_DATABASE_URL: url, AZ_EMAIL_API_URL: 'http://127.0.0.1:9/send', AZ_EMAIL_API_KEY: 'k',
    AZ_CHAT_API: 'fake', AZ_CHAT_FAKE_FILE: '/in-process.json', AZ_CHAT_PER_ADDRESS: '3/hour',
  }, { database: engine, email: 'api', chat: true }, 'Studio');
  if (!loaded.ok) throw new Error(loaded.problems.join('\n'));
  const context = parseChatContext(JSON.stringify({ site: { name: 'Studio' }, pages: [], chats: { '/': { allow: 'anyone', limit: 5, prompt: 'prompt-1.txt' } }, routes: ['/'] }));
  const serve = async (conn) => {
    const chat = createChat({
      config: loaded.config.chat, secret: loaded.config.secret, db: conn, prompts: { 'prompt-1.txt': 'Answer.' }, context,
      adapter: createFakeAdapter({ answers: [{ chunks: ['Hello.'] }] }), log: () => {},
    });
    const app = createApp({ config: loaded.config, store: createStore(conn, loaded.config.secret), mailer: { send: async () => {} }, oidc: createOidc(fetch), log: () => {}, chat });
    const server = createServer((q, r) => { void app.handler(q, r); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return server;
  };
  const a = await serve(db);
  const b = await serve(other);
  try {
    const ask = async (server) => {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
        method: 'POST', signal: AbortSignal.timeout(FETCH_MS),
        headers: { origin: SITE, 'x-az-request': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ page: '/', messages: [{ role: 'visitor', text: 'hi' }] }),
      });
      await r.text();
      return r.status;
    };
    const statuses = [await ask(a), await ask(b), await ask(a), await ask(b), await ask(a)];
    check(`${engine} chat limits: two server instances on one database — 3 an hour across both, the 4th and 5th refused on either`,
      JSON.stringify(statuses) === JSON.stringify([200, 200, 200, 429, 429]), JSON.stringify(statuses));
  } finally {
    await closeWithin(a, DB_CLOSE_MS, `${engine} instance one close`);
    await closeWithin(b, DB_CLOSE_MS, `${engine} instance two close`);
  }
}

export async function chatSuite(engine, db, openAgain, check, url) {
  check(`${engine} chat: the usage, share, blocked, limits, share-proof and cached-input migrations apply`, (await migrateChat(db)).join() === '1,2,3,4,5,6');
  check(`${engine} chat: …and is a no-op the second time`, (await migrateChat(db)).length === 0);

  const usage = createUsage(db);
  const day = utcDay(Date.UTC(2026, 9, 15, 23, 59, 59));
  await usage.add(day, 100, 20, 0, 0);
  await usage.add(day, 50, 5, 1, 30);
  const row = await usage.row(day);
  check(`${engine} chat: one row per day, added to by one statement — the cached input too`, JSON.stringify(row) === JSON.stringify({ input: 150, cached: 30, output: 25, messages: 2, dropped: 1, blocked: 0 }), JSON.stringify(row));
  await usage.block(day);
  await usage.block(utcDay(Date.UTC(2026, 9, 13)));
  check(`${engine} chat: a blocked question adds to the day's blocked count, spending nothing; a day that starts with one has its own row`,
    JSON.stringify(await usage.row(day)) === JSON.stringify({ input: 150, cached: 30, output: 25, messages: 2, dropped: 1, blocked: 1 })
      && JSON.stringify(await usage.row(utcDay(Date.UTC(2026, 9, 13)))) === JSON.stringify({ input: 0, cached: 0, output: 0, messages: 0, dropped: 0, blocked: 1 }));

  // Two answers finishing at once, from two connections: both counted.
  const other = await openAgain();
  try {
    const fresh = utcDay(Date.UTC(2026, 9, 14));
    const second = createUsage(other);
    await Promise.all([
      ...Array.from({ length: 10 }, () => usage.add(fresh, 7, 3, 0, 0)),
      ...Array.from({ length: 10 }, () => second.add(fresh, 7, 3, 0, 0)),
    ]);
    const both = await usage.row(fresh);
    check(`${engine} chat: twenty concurrent answers over two connections are all counted (first row raced too)`,
      both?.messages === 20 && both.input === 140 && both.output === 60, JSON.stringify(both));
  } finally {
    await closeWithin(other, DB_CLOSE_MS, `${engine} second connection close`);
  }

  const next = utcDay(Date.UTC(2026, 9, 16, 0, 0, 0));
  await usage.add(next, 1, 1, 0, 0);
  check(`${engine} chat: the day rolls over at 00:00 UTC into its own row`, (await usage.spent(next)) === 2 && (await usage.spent(day)) === 175);

  const now = Date.UTC(2026, 9, 16);
  await usage.add(utcDay(now - (USAGE_KEEP_DAYS + 3) * DAY), 9, 9, 0, 0);
  check(`${engine} chat: the sweep removes only days past ${USAGE_KEEP_DAYS}`, (await usage.sweep(now)) === 1 && (await usage.spent(next)) === 2);

  await shareChecks(engine, db, check);
  await figureChecks(engine, db, check);
  await weekChecks(engine, db, check);
  await knowsChecks(engine, db, check);
  await usageReportChecks(engine, db, check);
  await exploreChecks(engine, db, check);
  await mapChecks(engine, db, check);

  // Through the route on this engine: an answer is counted in today's row.
  const loaded = loadConfig({
    AZ_SESSION_SECRET: randomBytes(32).toString('base64url'), AZ_BACKEND_PUBLIC_URL: 'http://127.0.0.1:9', AZ_ALLOWED_ORIGINS: SITE,
    AZ_EMAIL_FROM: 'x <x@studio.test>', AZ_DATABASE_URL: url, AZ_EMAIL_API_URL: 'http://127.0.0.1:9/send', AZ_EMAIL_API_KEY: 'k',
    AZ_CHAT_API: 'fake', AZ_CHAT_FAKE_FILE: '/in-process.json',
  }, { database: engine, email: 'api', chat: true }, 'Studio');
  if (!loaded.ok) throw new Error(loaded.problems.join('\n'));
  // C2: the answer also holds a call to action off the allow-list, which the parser drops and the row counts.
  const context = parseChatContext(JSON.stringify({
    site: { name: 'Studio' }, pages: [], chats: { '/': { allow: 'anyone', limit: 5, show: ['cta'], prompt: 'prompt-1.txt' } }, routes: ['/'],
    answer: { quotes: [], destinations: ['/'] },
  }));
  const chat = createChat({
    config: loaded.config.chat, secret: loaded.config.secret, db, prompts: { 'prompt-1.txt': 'Answer.' }, context,
    adapter: createFakeAdapter({ answers: [{ chunks: ['Hello.\ncta "Claim" https://evil.example/\n'], usage: { input: 40, cached: 0, output: 2 } }] }), log: () => {},
  });
  const app = createApp({ config: loaded.config, store: createStore(db, loaded.config.secret), mailer: { send: async () => {} }, oidc: createOidc(fetch), log: () => {}, chat });
  const server = createServer((q, r) => { void app.handler(q, r); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const before = await usage.spent(utcDay(Date.now()));
    const droppedBefore = (await usage.row(utcDay(Date.now())))?.dropped ?? 0;
    const r = await fetch(`http://127.0.0.1:${server.address().port}/chat`, {
      method: 'POST', signal: AbortSignal.timeout(FETCH_MS),
      headers: { origin: SITE, 'x-az-request': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ page: '/', messages: [{ role: 'visitor', text: 'hi' }] }),
    });
    const body = await r.text();
    // The count is written just after the stream ends: wait for it, bounded.
    let after = before;
    for (const until = Date.now() + 5_000; after === before && Date.now() < until;) {
      after = await usage.spent(utcDay(Date.now()));
      if (after === before) await new Promise((res) => setTimeout(res, 50));
    }
    check(`${engine} chat: an answer through the route streams and is counted (42 tokens)`, r.status === 200 && /event: done/.test(body) && after - before === 42, `${r.status} ${after - before}`);
    const droppedAfter = (await usage.row(utcDay(Date.now())))?.dropped ?? 0;
    check(`${engine} chat: the component the parser dropped is counted in the day's row, and never sent`,
      droppedAfter - droppedBefore === 1 && !body.includes('evil.example') && !/event: block/.test(body), `${droppedAfter - droppedBefore}`);
  } finally {
    await closeWithin(server, DB_CLOSE_MS, `${engine} chat server close`);
  }

  // Last: they answer through the route today, so they come after every check of today's and tomorrow's rows.
  const second = await openAgain();
  try {
    await windowChecks(engine, db, second, check);
    await twoInstanceChecks(engine, db, second, check, url);
  } finally {
    await closeWithin(second, DB_CLOSE_MS, `${engine} limits connection close`);
  }
}

/** The words the fixture sites are compiled with. */
function wordManifests() {
  const words = new Map();
  for (const n of readdirSync(WORDS)) {
    const f = new URL(`${n}/word.json`, WORDS);
    if (existsSync(f)) {
      const m = JSON.parse(readFileSync(f, 'utf8'));
      words.set(m.name, m);
    }
  }
  return words;
}

/** A fixture table on this engine, by a data step far from every other suite's: its server model, for chat-query. */
async function fixtureTables(db, source, version) {
  const r = compile(SITE_SOURCE(source), { manifests: wordManifests() });
  if (!r.ok) throw new Error(`fixture: ${JSON.stringify(r.diagnostics)}`);
  const ops = plan([], r.spec.site.data, { rename: [], drop: [], unique: [] }).ops;
  await migrateData(db, dataSteps([{ version, ops }]), { confirm: Infinity });
  return loadTables(JSON.parse(JSON.stringify({ tables: r.spec.site.data }))).map((table) => ({ table, digits: {} }));
}

const EXPLORE_TABLE = `  data chatexplore
    name     text     required
    n        number   required
    placed   datetime required
    allow anyone read
`;

/**
 * chat-block-spec §21.3 on this engine (C7 tested it on SQLite only): an
 * explore's rows are the anonymous list's, page after page of at most 100 by
 * the list's own keyset cursor, to 200 — 230 rows, the sort key shared by
 * threes so a page ends inside a tie, each row once, in the list's order.
 */
export async function exploreChecks(engine, db, check) {
  const tables = await fixtureTables(db, EXPLORE_TABLE, 970);
  const T0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 230; i++) {
    await db.run('INSERT INTO azd_chatexplore (id, owner, created, updated, name, n, placed) VALUES (?, NULL, ?, ?, ?, ?, ?)',
      [randomUUID(), T0 + i * 1000, T0 + i * 1000, `Row ${String(i).padStart(3, '0')}`, i, T0 + Math.floor(i / 3) * DAY]);
  }
  const q = createQueries({ db, database: engine, publicBase: 'http://127.0.0.1:9', log: () => {} });
  const byPlaced = await q.run(parseRows(['chatexplore', 'columns', 'name', 'n', 'placed', 'sort', 'placed'], tables, QUERY_LIMITS.exploreRows));
  const rows = byPlaced.ok ? byPlaced.result.rows : [];
  const ns = rows.map((r) => r[1]);
  const days = rows.map((r) => r[2]);
  check(`${engine} explore rows: 200 of 230 through the anonymous list's pages, each row once`,
    rows.length === QUERY_LIMITS.exploreRows && new Set(rows.map((r) => r[0])).size === rows.length, `${rows.length} rows, ${new Set(rows.map((r) => r[0])).size} distinct`);
  check(`${engine} explore rows: in the list's order by the sort key — the first 200 by day, a tie across the page boundary kept whole and never repeated`,
    // Days in order; within a day the list breaks the tie by the row's id (random here), so the last day's three give two.
    days.every((d, i) => i === 0 || d >= days[i - 1]) && ns.slice().sort((a, b) => a - b).slice(0, 198).every((n, i) => n === i)
      && ns.filter((n) => n >= 198).length === 2 && ns.filter((n) => n >= 198).every((n) => n <= 200),
    JSON.stringify(ns.slice(95, 105)));
  check(`${engine} explore rows: a datetime is a UTC day`, days[0] === '2026-01-01' && days.at(-1) === new Date(T0 + 66 * DAY).toISOString().slice(0, 10), `${days[0]} … ${days.at(-1)}`);
  const newest = await q.run(parseRows(['chatexplore', 'columns', 'name', 'n'], tables, QUERY_LIMITS.exploreRows));
  const nn = newest.ok ? newest.result.rows.map((r) => r[1]) : [];
  check(`${engine} explore rows: without a sort, the newest 200 first — rows 229 down to 30`,
    nn.length === 200 && nn[0] === 229 && nn.at(-1) === 30 && nn.every((n, i) => i === 0 || n === nn[i - 1] - 1), `${nn[0]} … ${nn.at(-1)} (${nn.length})`);
}

const MAP_TABLE = `  data chatplaces
    name      text     required
    latitude  number
    longitude number
    kind      choice   shop hall
    open      flag
    note      text     private
    allow anyone read
`;

/** chat-block-spec §21.4.2 on this engine: a table map's pins — the list's rows, a `where` by choice and by flag, a row with no place no pin, six decimals. */
export async function mapChecks(engine, db, check) {
  const tables = await fixtureTables(db, MAP_TABLE, 980);
  // Millionths of a degree: a `number` is whole on every engine (BIGINT).
  const rows = [
    ['North store', 52_530_000, 13_410_000, 'shop', 1, 'private north'],
    ['Precise store', 52_520_008, 13_404_954, 'shop', 1, null],
    ['Closed hall', 52_500_000, 13_400_000, 'hall', 0, null],
    ['Placeless', null, null, 'shop', 1, null],
  ];
  for (const [i, [name, lat, lon, kind, open, note]] of rows.entries()) {
    await db.run('INSERT INTO azd_chatplaces (id, owner, created, updated, name, latitude, longitude, kind, open, note) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), i + 1, i + 1, name, lat, lon, kind, open, note]);
  }
  const q = createQueries({ db, database: engine, publicBase: 'http://127.0.0.1:9', log: () => {} });
  const pins = async (w) => {
    const r = await q.run(parsePins(w.split(' '), tables));
    return r.ok ? r.result.pins : null;
  };
  const all = await pins('chatplaces label name lat latitude lon longitude');
  check(`${engine} map pins: the list's rows newest first, a row with no place no pin, millionths of a degree read as degrees`,
    JSON.stringify(all) === JSON.stringify([{ label: 'Closed hall', lat: 52.5, lon: 13.4 }, { label: 'Precise store', lat: 52.520008, lon: 13.404954 }, { label: 'North store', lat: 52.53, lon: 13.41 }]),
    JSON.stringify(all));
  check(`${engine} map pins: where a choice equals one value`,
    JSON.stringify((await pins('chatplaces label name lat latitude lon longitude where kind shop'))?.map((p) => p.label)) === JSON.stringify(['Precise store', 'North store']));
  check(`${engine} map pins: where a flag is no`,
    JSON.stringify((await pins('chatplaces label name lat latitude lon longitude where open no'))?.map((p) => p.label)) === JSON.stringify(['Closed hall']));
  check(`${engine} map pins: a private field is no label`, parsePins('chatplaces label note lat latitude lon longitude'.split(' '), tables) === null
    && !JSON.stringify(all).includes('private north'));
}

