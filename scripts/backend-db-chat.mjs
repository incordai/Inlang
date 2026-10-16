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
 * its window, its order and its shares by day. Run by backend-db.mjs inside
 * its containers.
 */

import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { closeWithin } from './lib/bounded.mjs';
import { compile, plan } from '../packages/core/src/index.ts';
import { dataSteps } from '../packages/backend/src/data-ddl.ts';
import { migrateData } from '../packages/backend/src/server/data-migrate.ts';
import { loadTables } from '../packages/backend/src/server/data-values.ts';
import { createQueries, parseFigures, parseRows } from '../packages/backend/src/server/chat-query.ts';
import { createKnows, knowsProblems, rowsSection } from '../packages/backend/src/server/chat-knows.ts';
import { createShareStore, SHARE_LIMITS } from '../packages/backend/src/server/chat-share.ts';
import { createApp } from '../packages/backend/src/server/app.ts';
import { createFakeAdapter } from '../packages/backend/src/server/chat-adapters.ts';
import { createChat, parseChatContext } from '../packages/backend/src/server/chat.ts';
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
  check(`${engine} chat shares: a wrong token deletes nothing`, (await shares.remove(made.id, 'x'.repeat(43))) === false && (await shares.read(made.id)) !== null);
  check(`${engine} chat shares: the delete token deletes`, (await shares.remove(made.id, made.token)) === true && (await shares.read(made.id)) === null);
  clock.now = bigMade.expires;
  check(`${engine} chat shares: gone at the instant it expires, before any sweep`, (await shares.read(bigMade.id)) === null);
  check(`${engine} chat shares: the sweep removes every expired share`, (await shares.sweep()) === 11
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
  await usage.add('2031-01-20', 900, 90, 1);
  await usage.add('2031-01-20', 100, 10, 0);
  await usage.add('2030-12-22', 5, 5, 0);
  await usage.add('2030-12-21', 7, 7, 0);
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
      { day: '2031-01-20', input: 1000, output: 100, messages: 2, dropped: 1, shares: 1 },
      { day: '2031-01-19', input: 0, output: 0, messages: 0, dropped: 0, shares: 1 },
      { day: '2031-01-18', input: 0, output: 0, messages: 0, dropped: 0, shares: 1 },
      { day: '2030-12-22', input: 5, output: 5, messages: 1, dropped: 0, shares: 0 },
    ],
  };
  const { shares, ...rest } = r;
  check(`${engine} chat usage report: the 30-day window newest first, today against the budget, shares by the UTC day made`,
    JSON.stringify(rest) === JSON.stringify(want), JSON.stringify(r));
  // The other checks' shares are long expired by 2031; only these three are kept.
  check(`${engine} chat usage report: the shares kept now, and never a share's text`, shares.kept === 3 && shares.enabled === true && !JSON.stringify(r).includes(words), JSON.stringify(shares));
}

export async function chatSuite(engine, db, openAgain, check, url) {
  check(`${engine} chat: the usage and share migrations apply`, (await migrateChat(db)).join() === '1,2');
  check(`${engine} chat: …and is a no-op the second time`, (await migrateChat(db)).length === 0);

  const usage = createUsage(db);
  const day = utcDay(Date.UTC(2026, 9, 15, 23, 59, 59));
  await usage.add(day, 100, 20, 0);
  await usage.add(day, 50, 5, 1);
  const row = await usage.row(day);
  check(`${engine} chat: one row per day, added to by one statement`, JSON.stringify(row) === JSON.stringify({ input: 150, output: 25, messages: 2, dropped: 1 }), JSON.stringify(row));

  // Two answers finishing at once, from two connections: both counted.
  const other = await openAgain();
  try {
    const fresh = utcDay(Date.UTC(2026, 9, 14));
    const second = createUsage(other);
    await Promise.all([
      ...Array.from({ length: 10 }, () => usage.add(fresh, 7, 3, 0)),
      ...Array.from({ length: 10 }, () => second.add(fresh, 7, 3, 0)),
    ]);
    const both = await usage.row(fresh);
    check(`${engine} chat: twenty concurrent answers over two connections are all counted (first row raced too)`,
      both?.messages === 20 && both.input === 140 && both.output === 60, JSON.stringify(both));
  } finally {
    await closeWithin(other, DB_CLOSE_MS, `${engine} second connection close`);
  }

  const next = utcDay(Date.UTC(2026, 9, 16, 0, 0, 0));
  await usage.add(next, 1, 1, 0);
  check(`${engine} chat: the day rolls over at 00:00 UTC into its own row`, (await usage.spent(next)) === 2 && (await usage.spent(day)) === 175);

  const now = Date.UTC(2026, 9, 16);
  await usage.add(utcDay(now - (USAGE_KEEP_DAYS + 3) * DAY), 9, 9, 0);
  check(`${engine} chat: the sweep removes only days past ${USAGE_KEEP_DAYS}`, (await usage.sweep(now)) === 1 && (await usage.spent(next)) === 2);

  await shareChecks(engine, db, check);
  await figureChecks(engine, db, check);
  await knowsChecks(engine, db, check);
  await usageReportChecks(engine, db, check);

  // Through the route on this engine: an answer is counted in today's row.
  const loaded = loadConfig({
    AZ_SESSION_SECRET: randomBytes(32).toString('base64url'), AZ_BACKEND_PUBLIC_URL: 'http://127.0.0.1:9', AZ_ALLOWED_ORIGINS: SITE,
    AZ_EMAIL_FROM: 'x <x@studio.test>', AZ_DATABASE_URL: url, AZ_EMAIL_API_URL: 'http://127.0.0.1:9/send', AZ_EMAIL_API_KEY: 'k',
    AZ_CHAT_API: 'fake', AZ_CHAT_FAKE_FILE: '/in-process.json',
  }, { database: engine, email: 'api', chat: true }, 'Studio');
  if (!loaded.ok) throw new Error(loaded.problems.join('\n'));
  // C2: the answer also holds a call to action off the allow-list, which the parser drops and the row counts.
  const context = parseChatContext(JSON.stringify({
    site: { name: 'Studio' }, pages: [], chats: { '/': { allow: 'anyone', limit: 5, show: ['cta'] } }, routes: ['/'],
    answer: { quotes: [], destinations: ['/'] },
  }));
  const chat = createChat({
    config: loaded.config.chat, secret: loaded.config.secret, db, prompt: 'Answer.', context,
    adapter: createFakeAdapter({ answers: [{ chunks: ['Hello.\ncta "Claim" https://evil.example/\n'], usage: { input: 40, output: 2 } }] }), log: () => {},
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
}
