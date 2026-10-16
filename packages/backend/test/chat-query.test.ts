/**
 * Chat's server figures (chat-block-spec §20.5) on SQLite: only tables a
 * signed-out visitor may list, only their public fields, every closed form
 * parsed and every other refused; the figures equal what an anonymous
 * visitor computes by paging `GET /data/<t>`; rows are exactly the
 * anonymous list's; a private value never appears; the database deadline
 * gives "unavailable", never a guess; a total past 2^53 is unavailable;
 * the 60 s cache; and no word the model wrote reaches SQL text.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { client, startBackend, type Harness } from './helpers.ts';
import { dataOf } from './data-fixture.ts';
import { QueryTimeout, type Db } from '../src/server/db.ts';
import { selectAggregate } from '../src/server/data-query.ts';
import {
  QUERY_LIMITS, createQueries, isoWeek, parseCards, parseFigures, parsePins, parseRows, queryable, weekGroups, type QueryRequest, type QueryTable,
} from '../src/server/chat-query.ts';
import { clampText } from '../src/server/chat-rich.ts';

const GOOD = 'a-long-enough-password';
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2025, 11, 30, 23, 0, 0);

const DATA = `  data orders
    item     text     required
    status   choice   paid open cancelled required
    total    money    usd required
    placed   datetime required
    gift     flag
    shipped  date
    note     text     private
    allow anyone read
    allow signedin create
    allow owner edit delete
  data plans
    plan     choice   free team required
    allow owner read
    allow signedin create
  data members
    seats    number   required
    allow signedin read
    allow signedin create
`;

async function shop(): Promise<{ h: Harness; tables: QueryTable[] }> {
  const data = dataOf(DATA);
  const h = await startBackend({}, { data });
  const c = client(h.url);
  const r = await c.post('/auth/sign-up', { name: 'Ana', email: 'ana@studio.test', password: GOOD, passwordConfirm: GOOD });
  assert.equal(r.status, 200);
  const rows: Record<string, unknown>[] = [
    { item: 'Chair', status: 'paid', total: 1999, placed: T0, gift: true, shipped: '2025-12-31', note: 'call Ana at home' },
    { item: 'Desk', status: 'paid', total: 25000, placed: T0 + 2 * DAY, gift: false, shipped: '2026-01-02' },
    { item: 'Lamp', status: 'open', total: 4500, placed: T0 + 40 * DAY, note: 'secret discount' },
    { item: 'Rug', status: 'cancelled', total: 9900, placed: T0 + 70 * DAY },
    { item: 'Stool', status: 'paid', total: 3500, placed: T0 + 71 * DAY, gift: true },
  ];
  for (const body of rows) {
    const res = await c.request('POST', '/data/orders', body);
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
  }
  assert.equal((await c.request('POST', '/data/plans', { plan: 'team' })).status, 201);
  assert.equal((await c.request('POST', '/data/members', { seats: 4 })).status, 201);
  const tables = data.tables.map((table): QueryTable => ({ table, digits: table.name === 'orders' ? { total: 2 } : {} }));
  return { h, tables };
}

/** Every row of `t` as a signed-out visitor pages through it. */
async function anonymousRows(h: Harness, t: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let after: string | null = null;
  do {
    const r = await fetch(`${h.url}/data/${t}?limit=2${after ? `&after=${after}` : ''}`, { headers: { origin: 'http://127.0.0.1:5173' } });
    assert.equal(r.status, 200);
    const body = await r.json() as { items: Record<string, unknown>[]; next: string | null };
    out.push(...body.items);
    after = body.next;
  } while (after);
  return out;
}

const words = (s: string) => s.split(' ');
const must = (r: QueryRequest | null): QueryRequest => {
  assert.ok(r, 'request parses');
  return r;
};

test('queryable: only tables a signed-out visitor may list', async () => {
  const { h, tables } = await shop();
  try {
    assert.deepEqual(queryable(tables).map((t) => t.table.name), ['orders']);
    assert.equal(parseFigures(words('plans count'), tables, 24), null, 'owner-only table');
    assert.equal(parseFigures(words('members count'), tables, 24), null, 'signed-in-only table');
  } finally {
    await h.close();
  }
});

test('parse: the closed forms parse; private fields, owner, free text, bad buckets, unknown choices and extra words do not', async () => {
  const { h, tables } = await shop();
  try {
    for (const ok of [
      'orders count', 'orders count by status', 'orders sum total by placed month', 'orders avg total',
      'orders min total by gift', 'orders max total by shipped year', 'orders count where status paid',
      'orders count by placed day where gift yes', 'orders count by placed week', 'orders avg total by shipped week',
    ]) assert.ok(parseFigures(words(ok), tables, 24), ok);
    for (const bad of [
      'orders count by note', 'orders sum note', 'orders count by owner', 'orders count by item', 'orders count by status month',
      'orders count by placed', 'orders count by status week', 'orders count by placed fortnight', 'orders sum status', 'orders count where status refunded',
      'orders count where note x', 'orders count where gift maybe', 'orders count by status by status', 'orders count extra',
      'orders; DROP TABLE x', 'orders count by "status"', 'Orders count', '', 'orders', 'orders total',
    ]) assert.equal(parseFigures(bad === '' ? [] : words(bad), tables, 24), null, bad);
    assert.ok(parseRows(words('orders columns item total status sort placed desc'), tables));
    for (const bad of ['orders columns note', 'orders columns item item', 'orders columns', 'orders columns item sort note',
      'orders columns item sort gift', 'orders columns a b c d e f g', 'plans columns plan']) {
      assert.equal(parseRows(words(bad), tables), null, bad);
    }
    assert.ok(parseCards(words('orders title item'), tables));
    assert.equal(parseCards(words('orders title note'), tables), null, 'a private title');
    assert.equal(parseCards(words('orders title total'), tables), null, 'a number is not a title');
  } finally {
    await h.close();
  }
});

test('figures equal what a signed-out visitor computes from GET /data pages', async () => {
  const { h, tables } = await shop();
  try {
    const rows = await anonymousRows(h, 'orders');
    const q = createQueries({ db: h.db, database: 'sqlite', publicBase: h.url });
    const run = async (s: string, cap = 24) => {
      const r = await q.run(must(parseFigures(words(s), tables, cap)));
      assert.ok(r.ok && r.result.kind === 'figures', s);
      return r.result;
    };
    assert.equal((await run('orders count')).value, rows.length);
    const byStatus = await run('orders count by status');
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(String(r.status), (counts.get(String(r.status)) ?? 0) + 1);
    assert.deepEqual(byStatus.groups, [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
    const month = (ms: number) => new Date(ms).toISOString().slice(0, 7);
    const sums = new Map<string, number>();
    for (const r of rows) sums.set(month(Number(r.placed)), (sums.get(month(Number(r.placed))) ?? 0) + Number(r.total) / 100);
    const byMonth = await run('orders sum total by placed month');
    assert.deepEqual(byMonth.groups, [...sums].sort((a, b) => a[0].localeCompare(b[0])), 'oldest first, money in major units');
    assert.equal(byMonth.unit, 'usd');
    assert.equal(byMonth.dated, true);
    // The year boundary: 23:00 UTC on 30 Dec stays in December whatever the server's zone.
    assert.equal(byMonth.groups?.[0][0], '2025-12');
    const paid = rows.filter((r) => r.status === 'paid');
    assert.equal((await run('orders avg total where status paid')).value, Number((paid.reduce((a, r) => a + Number(r.total), 0) / paid.length / 100).toPrecision(15)));
    assert.equal((await run('orders min total')).value, Math.min(...rows.map((r) => Number(r.total))) / 100);
    assert.deepEqual((await run('orders count by gift')).groups, [['No', 3], ['Yes', 2]]);
    assert.deepEqual((await run('orders count by shipped day')).groups, [['2025-12-31', 1], ['2026-01-02', 1]], 'NULL dates left out');
    // A pie keeps 6 slices at most; with a cap of 2, the third group sets `more`.
    const capped = await run('orders count by status', 2);
    assert.equal(capped.groups?.length, 2);
    assert.equal(capped.more, true);
  } finally {
    await h.close();
  }
});

test('isoWeek: Monday weeks, numbered by the year their Thursday is in — across year boundaries and week 53', () => {
  // Each checked against an independent ISO calendar (the reference values in chat-block-spec §19.11).
  const want: [string, string][] = [
    ['2020-12-31', '2020-W53'], ['2021-01-03', '2020-W53'], ['2021-01-04', '2021-W01'],
    ['2024-12-30', '2025-W01'], ['2025-12-28', '2025-W52'], ['2025-12-29', '2026-W01'], ['2026-01-01', '2026-W01'],
    ['2026-12-27', '2026-W52'], ['2026-12-28', '2026-W53'], ['2026-12-31', '2026-W53'], ['2027-01-01', '2026-W53'],
    ['2027-01-03', '2026-W53'], ['2027-01-04', '2027-W01'], ['2028-02-29', '2028-W09'],
  ];
  assert.deepEqual(want.map(([d]) => [d, isoWeek(d)]), want);
});

test('weekGroups: days into weeks — sums, extremes and an average of the days\' values, newest first, more past the cap', () => {
  const days = [
    { g: '2027-01-04', v: 5, n: 1 }, { g: '2027-01-01', v: 30, n: 2 }, { g: '2026-12-28', v: 10, n: 2 }, { g: '2026-12-27', v: 7, n: 1 },
  ];
  assert.deepEqual(weekGroups(days, 'sum', 24), { groups: [['2027-W01', 5], ['2026-W53', 40], ['2026-W52', 7]], more: false });
  assert.deepEqual(weekGroups(days, 'min', 24)?.groups, [['2027-W01', 5], ['2026-W53', 10], ['2026-W52', 7]]);
  assert.deepEqual(weekGroups(days, 'max', 24)?.groups, [['2027-W01', 5], ['2026-W53', 30], ['2026-W52', 7]]);
  // An average is the week's values over their count, never an average of the days' averages.
  assert.deepEqual(weekGroups(days, 'avg', 24)?.groups, [['2027-W01', 5], ['2026-W53', 10], ['2026-W52', 7]]);
  assert.deepEqual(weekGroups(days, 'sum', 2), { groups: [['2027-W01', 5], ['2026-W53', 40]], more: true });
  assert.equal(weekGroups([{ g: '2026-12-28', v: Number.MAX_SAFE_INTEGER, n: 1 }, { g: '2026-12-29', v: 2, n: 1 }], 'sum', 24), null, 'a total no double holds exactly');
  // A day with no value of the measure (SQL's NULL) adds nothing: never a 0 in a minimum, never a week of its own.
  const gaps = [{ g: '2026-12-29', v: null, n: 0 }, { g: '2026-12-28', v: 4, n: 1 }, { g: '2026-12-21', v: null, n: 0 }];
  assert.deepEqual(weekGroups(gaps, 'min', 24)?.groups, [['2026-W53', 4]]);
  assert.deepEqual(weekGroups(gaps, 'avg', 24)?.groups, [['2026-W53', 4]]);
});

test('figures by ISO week: what a signed-out visitor counts by week from GET /data pages — the year boundary, week 53, both date types', async () => {
  const { h, tables } = await shop();
  try {
    const c = client(h.url);
    await c.post('/auth/sign-up', { name: 'Bo', email: 'bo@studio.test', password: GOOD, passwordConfirm: GOOD });
    // Around the turn of 2026 (a 53-week year): Sunday of W52, three days of W53 in two years, Monday of 2027-W01.
    for (const [day, total] of [['2026-12-27', 100], ['2026-12-28', 300], ['2026-12-31', 500], ['2027-01-01', 700], ['2027-01-03', 900], ['2027-01-04', 50]] as const) {
      const placed = Date.parse(`${day}T23:59:00Z`);
      const r = await c.request('POST', '/data/orders', { item: 'Turn', status: 'open', total, placed, shipped: day });
      assert.equal(r.status, 201);
    }
    const rows = await anonymousRows(h, 'orders');
    const q = createQueries({ db: h.db, database: 'sqlite', publicBase: h.url });
    const run = async (s: string, cap = 24) => {
      const r = await q.run(must(parseFigures(words(s), tables, cap)));
      assert.ok(r.ok && r.result.kind === 'figures', s);
      return r.result;
    };
    const byWeek = (key: (r: Record<string, unknown>) => string | null, value: (r: Record<string, unknown>) => number) => {
      const m = new Map<string, number>();
      for (const r of rows) {
        const k = key(r);
        if (k !== null) m.set(isoWeek(k), (m.get(isoWeek(k)) ?? 0) + value(r));
      }
      return [...m].sort((a, b) => a[0].localeCompare(b[0]));
    };
    const placedDay = (r: Record<string, unknown>) => new Date(Number(r.placed)).toISOString().slice(0, 10);
    const counted = await run('orders count by placed week');
    assert.deepEqual(counted.groups, byWeek(placedDay, () => 1), 'oldest first');
    assert.equal(counted.dated, true);
    assert.deepEqual(counted.groups?.filter(([w]) => w >= '2026-W52'), [['2026-W52', 1], ['2026-W53', 4], ['2027-W01', 1]], 'week 53 holds days of two calendar years');
    assert.deepEqual((await run('orders sum total by placed week')).groups, byWeek(placedDay, (r) => Number(r.total) / 100), 'money in major units');
    // A date column, NULLs left out.
    assert.deepEqual((await run('orders count by shipped week')).groups, byWeek((r) => (typeof r.shipped === 'string' ? r.shipped : null), () => 1));
    const avg = await run('orders avg total by shipped week');
    assert.deepEqual(avg.groups?.find(([w]) => w === '2026-W53'), ['2026-W53', (3 + 5 + 7 + 9) / 4]);
    // The latest weeks are the ones kept, with `more` set.
    const latest = await run('orders count by placed week', 2);
    assert.deepEqual([latest.groups, latest.more], [[['2026-W53', 4], ['2027-W01', 1]], true]);
  } finally {
    await h.close();
  }
});

test('rows and cards are the anonymous list exactly; a private value never appears', async () => {
  const { h, tables } = await shop();
  try {
    const q = createQueries({ db: h.db, database: 'sqlite', publicBase: h.url });
    const r = await q.run(must(parseRows(words('orders columns item total status sort placed desc'), tables)));
    assert.ok(r.ok && r.result.kind === 'rows');
    const anon = (await anonymousRows(h, 'orders')).sort((a, b) => Number(b.placed) - Number(a.placed));
    assert.deepEqual(r.result.rows, anon.map((x) => [x.item, Number(x.total) / 100, x.status]));
    assert.deepEqual(r.result.columns.map((c) => [c.label, c.type, c.unit]), [['item', 'text', null], ['total', 'number', 'usd'], ['status', 'text', null]]);
    const cards = await q.run(must(parseCards(words('orders title item sort placed'), tables)));
    assert.ok(cards.ok && cards.result.kind === 'cards');
    assert.equal(cards.result.items.length, QUERY_LIMITS.cards);
    for (const out of [r, cards]) {
      const text = JSON.stringify(out);
      assert.ok(!text.includes('call Ana') && !text.includes('secret discount'), 'no private value');
    }
  } finally {
    await h.close();
  }
});

test('an explore\'s rows (§21.3): up to 200, page after page of the anonymous list; days typed as days; the limit in the cache key', async () => {
  const { h, tables } = await shop();
  try {
    // 130 more orders, written as the table's own rows are: past one page of the list route (100), short of the explore's 200.
    for (let i = 0; i < 130; i++) {
      const id = `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      await h.db.run('INSERT INTO azd_orders (id, owner, created, updated, item, status, total, placed) VALUES (?, NULL, ?, ?, ?, ?, ?, ?)',
        [id, T0 + i, T0 + i, `Item ${i}`, 'open', 100 + i, T0 + (i + 100) * DAY]);
    }
    const q = createQueries({ db: h.db, database: 'sqlite', publicBase: h.url });
    const all = must(parseRows(words('orders columns item placed shipped sort placed'), tables, QUERY_LIMITS.exploreRows));
    const r = await q.run(all);
    assert.ok(r.ok && r.result.kind === 'rows');
    const anon = (await anonymousRows(h, 'orders')).sort((a, b) => Number(a.placed) - Number(b.placed));
    assert.equal(r.result.rows.length, 135);
    assert.deepEqual(r.result.rows, anon.map((x) => [x.item, new Date(Number(x.placed)).toISOString().slice(0, 10), x.shipped ?? null]));
    assert.deepEqual(r.result.columns.map((col) => col.type), ['text', 'date', 'date'], 'a datetime and a date are days');
    // A table's 20 is its own request: the same words with another limit are another cache entry.
    const twenty = must(parseRows(words('orders columns item placed shipped sort placed'), tables));
    assert.notEqual(twenty.key, all.key);
    const t = await q.run(twenty);
    assert.ok(t.ok && t.result.kind === 'rows' && t.result.rows.length === QUERY_LIMITS.rows);
    for (const bad of [0, 201, 1.5]) assert.equal(parseRows(words('orders columns item'), tables, bad), null, String(bad));
    assert.ok(!JSON.stringify(r).includes('call Ana'), 'no private value');
  } finally {
    await h.close();
  }
});

/** C8 (§21.4.2): a public table of places — numbers for coordinates, a choice and a flag to filter by, a private note. */
const PLACES = `  data places
    name      text     required
    latitude  number
    longitude number
    kind      choice   shop hall
    open      flag
    price     money    usd
    note      text     private
    allow anyone read
  data hidden
    name      text     required
    latitude  number
    longitude number
    allow signedin read
`;

test('a map\'s pins (§21.4.2): label, lat and lon by name — numbers only, never money or private; a `where` a choice or a flag; the anonymous list\'s rows, each with a place', async () => {
  const data = dataOf(PLACES);
  const h = await startBackend({}, { data });
  try {
    // Coordinates in millionths of a degree: a `number` is whole (data-spec §3).
    const rows: [string, number | null, number | null, string, number, string][] = [
      ['North store', 52_530_000, 13_410_000, 'shop', 1, 'private north'],
      ['Precise store', 52_520_008, 13_404_954, 'shop', 1, ''],
      ['Closed hall', 52_500_000, 13_400_000, 'hall', 0, ''],
      ['Placeless', null, null, 'shop', 1, ''],
      ['Off the globe', 95_000_000, 13_000_000, 'shop', 1, ''],
      ['South pole', -90_000_000, 0, 'hall', 1, ''],
    ];
    for (const [i, [name, lat, lon, kind, open, note]] of rows.entries()) {
      await h.db.run('INSERT INTO azd_places (id, owner, created, updated, name, latitude, longitude, kind, open, note) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)',
        [`00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, i + 1, i + 1, name, lat, lon, kind, open, note]);
    }
    const tables = data.tables.map((table): QueryTable => ({ table, digits: {} }));
    const q = createQueries({ db: h.db, database: 'sqlite', publicBase: h.url });
    const all = await q.run(must(parsePins(words('places label name lat latitude lon longitude'), tables)));
    assert.ok(all.ok && all.result.kind === 'pins');
    assert.deepEqual(all.result.pins, [
      { label: 'South pole', lat: -90, lon: 0 },
      { label: 'Closed hall', lat: 52.5, lon: 13.4 },
      { label: 'Precise store', lat: 52.520008, lon: 13.404954 },
      { label: 'North store', lat: 52.53, lon: 13.41 },
    ], 'newest first, as the list gives them; no place, or off the globe, is no pin; millionths of a degree read as degrees');
    const shops = await q.run(must(parsePins(words('places label name lat latitude lon longitude where kind shop'), tables)));
    assert.ok(shops.ok && shops.result.kind === 'pins');
    assert.deepEqual(shops.result.pins.map((p) => p.label), ['Precise store', 'North store']);
    const open = await q.run(must(parsePins(words('places label name lat latitude lon longitude where open no'), tables)));
    assert.ok(open.ok && open.result.kind === 'pins');
    assert.deepEqual(open.result.pins.map((p) => p.label), ['Closed hall']);
    assert.deepEqual(shops.result.pins.length, 2);
    assert.ok(!JSON.stringify([all, shops, open]).includes('private north'), 'no private value');
    for (const w of [
      'places label note lat latitude lon longitude', 'places label name lat price lon longitude', 'places label name lat latitude lon latitude',
      'places label latitude lat latitude lon longitude', 'places label name lat latitude lon longitude where kind cafe',
      'places label name lat latitude lon longitude where name North', 'places label name lat latitude lon longitude where open maybe',
      'hidden label name lat latitude lon longitude', 'nowhere label name lat latitude lon longitude', 'places label name lat latitude',
    ]) assert.equal(parsePins(words(w), tables), null, w);
    // The `where` is a list parameter, so it is in the cache key.
    assert.notEqual(must(parsePins(words('places label name lat latitude lon longitude where kind shop'), tables)).key,
      must(parsePins(words('places label name lat latitude lon longitude where kind hall'), tables)).key);
  } finally {
    await h.close();
  }
});

test('the database deadline gives unavailable, never a guess', async () => {
  const { h, tables } = await shop();
  try {
    const slow: Db = { ...h.db, allWithin: async () => { throw new QueryTimeout('read cancelled after 2000 ms'); } };
    const lines: string[] = [];
    const q = createQueries({ db: slow, database: 'sqlite', publicBase: h.url, log: (l) => lines.push(l) });
    assert.deepEqual(await q.run(must(parseFigures(words('orders count by status'), tables, 24))), { ok: false });
    assert.deepEqual(await q.run(must(parseRows(words('orders columns item'), tables))), { ok: false });
    assert.match(lines[0], /ran past 2000 ms/);
    assert.doesNotMatch(lines.join('\n'), /orders|status/, 'the log names no table or field');
  } finally {
    await h.close();
  }
});

test('a total past what a double holds exactly is unavailable', async () => {
  const { h, tables } = await shop();
  try {
    const c = client(h.url);
    await c.post('/auth/sign-up', { name: 'Bo', email: 'bo@studio.test', password: GOOD, passwordConfirm: GOOD });
    for (let i = 0; i < 2; i++) {
      const r = await c.request('POST', '/data/orders', { item: 'Yacht', status: 'open', total: Number.MAX_SAFE_INTEGER - 1, placed: T0 });
      assert.equal(r.status, 201);
    }
    const q = createQueries({ db: h.db, database: 'sqlite', publicBase: h.url });
    assert.deepEqual(await q.run(must(parseFigures(words('orders sum total'), tables, 24))), { ok: false });
    assert.ok((await q.run(must(parseFigures(words('orders max total'), tables, 24)))).ok, 'one large value is still exact');
  } finally {
    await h.close();
  }
});

test('the cache: 60 s per request, then read again', async () => {
  const { h, tables } = await shop();
  try {
    let reads = 0;
    const counting: Db = { ...h.db, allWithin: (sql, p, ms) => { reads++; return h.db.allWithin(sql, p, ms); } };
    let now = 1_000_000;
    const q = createQueries({ db: counting, database: 'sqlite', publicBase: h.url, now: () => now });
    const req = must(parseFigures(words('orders count by status'), tables, 24));
    await q.run(req);
    await q.run(must(parseFigures(words('orders count by status'), tables, 24)));
    assert.equal(reads, 1);
    now += QUERY_LIMITS.cacheMs;
    await q.run(req);
    assert.equal(reads, 2);
  } finally {
    await h.close();
  }
});

test('no word the model wrote reaches SQL text: values are parameters, names come from the schema', async () => {
  const { h, tables } = await shop();
  try {
    const req = must(parseFigures(words('orders count by placed month where status cancelled'), tables, 24));
    assert.equal(req.kind, 'figures');
    if (req.kind !== 'figures') return;
    const s = selectAggregate('sqlite', req.table.table, req.agg);
    assert.ok(!s.sql.includes('cancelled'));
    assert.deepEqual(s.params, ['cancelled']);
    for (const d of ['postgres', 'mysql'] as const) {
      const other = selectAggregate(d, req.table.table, req.agg);
      assert.doesNotMatch(other.sql, /cancelled|time_zone|AT TIME ZONE|CONVERT_TZ/);
    }
    const note = req.table.table.fields.find((f) => f.name === 'note');
    assert.ok(note);
    assert.throws(() => selectAggregate('sqlite', req.table.table, { ...req.agg, by: note, bucket: null }), /public schema/);
  } finally {
    await h.close();
  }
});

test('clampText: within its cap in code points — what the page counts — cut at a grapheme boundary, ending in an ellipsis', () => {
  assert.equal(clampText('short', 24), 'short');
  assert.equal(clampText('abcdefghij', 5), 'abcd…');
  // Flags are two code points each: 24 of them are 48, so a 24-label keeps 11 and the ellipsis — the page's own count passes it.
  const kept = clampText('\u{1F1EF}\u{1F1F5}'.repeat(24), 24);
  assert.equal(kept, `${'\u{1F1EF}\u{1F1F5}'.repeat(11)}…`);
  assert.ok([...kept].length <= 24);
  // A combining mark stays on its letter.
  assert.equal(clampText('é'.repeat(20), 24), `${'é'.repeat(11)}…`);
  const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
  // A family is one grapheme of five code points: kept whole, or not at all.
  assert.equal(clampText(`${family}${family}${family}`, 12), `${family}${family}…`);
  assert.equal(clampText(`${family}${family}`, 2), '…');
  // A decomposed é is two code points: a cap of 3 keeps one and the ellipsis.
  assert.equal(clampText('ééé', 3), 'é…');
});
