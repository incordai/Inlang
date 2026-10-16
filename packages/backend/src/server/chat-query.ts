/**
 * @az server chat-query
 * Purpose: the figures an answer's chart, table, stat or cards ask for — a closed set of requests over public tables, run as an anonymous read.
 * Spec: docs/chat-block-spec.md §20.5, §20.6
 * Exports: QueryTable, QueryRequest, QueryResult, Figures, RowsResult, CardsResult, CardImage, QUERY_LIMITS, queryable,
 *   parseFigures, parseRows, parseCards, createQueries, Queries, QueriesOptions, figuresRun
 * Edit guide: the model's words only ever SELECT from closed lists and exact schema names — nothing it writes reaches SQL text.
 *   Every read is the anonymous one (`grant(read, null)`, user null); a private field is not in the schema the words are matched to.
 * Tests: packages/backend/test/chat-query.test.ts
 */

/**
 * A chart's numbers either come from here or carry the "AI-generated
 * figures" label (chat-block-spec §20.2). Here means: the model wrote
 * `from orders count by placed month`, and the server — not the model —
 * counted. The words are matched against the PUBLIC schema of the tables a
 * signed-out visitor could list: a private field, `owner`, a table only its
 * owners or signed-in visitors may read, are simply not names this file
 * knows, so asking for one is a request that does not parse.
 *
 * Rows and cards go through the list route's own code (parseQuery,
 * selectList, outRow with no user), so they are exactly what `GET
 * /data/<t>` gives a signed-out visitor. Aggregations are one SELECT from
 * data-query.ts selectAggregate. Every read is cancelled by the database
 * past the public list's deadline; a cancelled read, or a total past what a
 * double holds exactly, is "unavailable" — never a guess.
 *
 * Copied into a generated server only when the site has chat and data.
 */

import { grant, LIST_DEADLINE_MS } from './data-api.ts';
import { AGGREGATE_FILTER, AGGREGATE_GROUP, AGGREGATE_MEASURE, LIMIT_MAX, parseQuery, selectAggregate, selectList, SORTABLE, type Aggregate } from './data-query.ts';
import { outRow, type Field, type Table } from './data-values.ts';
import { QueryTimeout, type Db, type Value } from './db.ts';
import type { Database } from './env.ts';
import { clampText, type FiguresRun } from './chat-rich.ts';
import type { ContextTable } from './chat.ts';

/** chat-block-spec §20.2 / §20.5. */
export const QUERY_LIMITS = {
  /** Groups a bar, line or area chart shows. */
  groups: 24,
  /** Slices a pie or donut shows. */
  slices: 6,
  rows: 20,
  columns: 6,
  cards: 4,
  label: 24,
  cell: 120,
  cardTitle: 80,
  cardText: 300,
  /** Queries one answer may run. */
  perAnswer: 6,
  cacheMs: 60_000,
  cacheEntries: 500,
} as const;

/** A table as chat may query it: the server's model, and each money field's minor-unit digits (from the build). */
export interface QueryTable {
  readonly table: Table;
  readonly digits: Readonly<Record<string, number>>;
}

export type QueryRequest =
  | { readonly kind: 'figures'; readonly table: QueryTable; readonly agg: Aggregate; readonly key: string }
  | { readonly kind: 'rows'; readonly table: QueryTable; readonly columns: readonly Field[]; readonly sort: string; readonly key: string }
  | { readonly kind: 'cards'; readonly table: QueryTable; readonly title: Field; readonly text: Field | null; readonly image: Field | null; readonly sort: string; readonly key: string };

/** One number, or groups in display order, with the unit the measure carries. */
export interface Figures {
  readonly kind: 'figures';
  readonly unit: string | null;
  readonly value: number | null;
  readonly groups: readonly (readonly [string, number])[] | null;
  /** More groups existed than were read. */
  readonly more: boolean;
  /** The grouping was by date: groups run oldest to newest. */
  readonly dated: boolean;
}

export interface RowsResult {
  readonly kind: 'rows';
  readonly columns: readonly { readonly label: string; readonly type: 'text' | 'number'; readonly unit: string | null }[];
  readonly rows: readonly (readonly (string | number | null)[])[];
}

export interface CardImage { readonly url: string; readonly width: number; readonly height: number; readonly variants: readonly { readonly url: string; readonly width: number }[] }

export interface CardsResult {
  readonly kind: 'cards';
  readonly items: readonly { readonly title: string; readonly text: string | null; readonly image: CardImage | null; readonly row: { readonly table: string; readonly id: string; readonly field: string } | null }[];
}

export type QueryResult = { readonly ok: true; readonly result: Figures | RowsResult | CardsResult } | { readonly ok: false };

/** The tables a signed-out visitor may list (data-api grant with no user, and not owner-only). */
export function queryable(tables: readonly QueryTable[]): QueryTable[] {
  return tables.filter((t) => {
    const g = grant(t.table.rules.read, null);
    return g.ok && !g.ownerOnly;
  });
}

const NAME = /^[a-z][a-z0-9]*$/;
const BUCKETS: ReadonlySet<string> = new Set(['day', 'month', 'year']);
const FNS: ReadonlySet<string> = new Set(['count', 'sum', 'avg', 'min', 'max']);

/** A public field of `t` by its exact name, or null — private fields are not names here. */
function publicField(t: Table, name: string | undefined): Field | null {
  if (name === undefined || !NAME.test(name)) return null;
  return t.fields.find((f) => f.name === name && !f.private) ?? null;
}

function tableOf(tables: readonly QueryTable[], name: string | undefined): QueryTable | null {
  if (name === undefined || !NAME.test(name)) return null;
  return queryable(tables).find((t) => t.table.name === name) ?? null;
}

/**
 * `<table> count|sum f|avg f|min f|max f [by f [day|month|year]] [where f v]`
 * — the words after `from`, already lexed — or null. `cap` is the groups
 * the component shows (QUERY_LIMITS.slices for a pie, .groups otherwise).
 */
export function parseFigures(words: readonly string[], tables: readonly QueryTable[], cap: number): QueryRequest | null {
  const w = [...words];
  const qt = tableOf(tables, w.shift());
  if (!qt) return null;
  const t = qt.table;
  const fn = w.shift();
  if (fn === undefined || !FNS.has(fn)) return null;
  let field: Field | null = null;
  if (fn !== 'count') {
    field = publicField(t, w.shift());
    if (!field || !AGGREGATE_MEASURE.has(field.type)) return null;
  }
  let by: Field | null = null;
  let bucket: Aggregate['bucket'] = null;
  if (w[0] === 'by') {
    w.shift();
    by = publicField(t, w.shift());
    if (!by || !AGGREGATE_GROUP.has(by.type)) return null;
    const dated = by.type === 'date' || by.type === 'datetime';
    if (dated) {
      const b = w.shift();
      if (b === undefined || !BUCKETS.has(b)) return null;
      bucket = b as Aggregate['bucket'];
    } else if (w[0] !== undefined && BUCKETS.has(w[0])) {
      return null;
    }
  }
  let where: Aggregate['where'] = null;
  if (w[0] === 'where') {
    w.shift();
    const f = publicField(t, w.shift());
    const raw = w.shift();
    if (!f || raw === undefined || !AGGREGATE_FILTER.has(f.type)) return null;
    let value: Value;
    if (f.type === 'flag') {
      if (raw !== 'yes' && raw !== 'no') return null;
      value = raw === 'yes' ? 1 : 0;
    } else {
      if (!(f.choices ?? []).includes(raw)) return null;
      value = raw;
    }
    where = { field: f, value };
  }
  if (w.length > 0) return null;
  const limit = Math.min(cap, QUERY_LIMITS.groups) + 1;
  const agg: Aggregate = { fn: fn as Aggregate['fn'], field, by, bucket, where, limit };
  const key = JSON.stringify(['figures', t.name, fn, field?.name ?? null, by?.name ?? null, bucket, where?.field.name ?? null, where?.value ?? null, limit]);
  return { kind: 'figures', table: qt, agg, key };
}

/** `sort f [desc]` at the end of `w`, as the list route's `sort` parameter, or null when malformed. */
function sortOf(t: Table, w: string[]): string | null {
  if (w.length === 0) return '-created';
  if (w.shift() !== 'sort') return null;
  const name = w.shift();
  const desc = w.length > 0 && w[0] === 'desc';
  if (desc) w.shift();
  if (name === 'created' || name === 'updated') return `${desc ? '-' : ''}${name}`;
  const f = publicField(t, name);
  // The list route's own rule: a sort key is a required, sortable field.
  if (!f || !f.required || !SORTABLE.has(f.type)) return null;
  return `${desc ? '-' : ''}${f.name}`;
}

/** `<table> columns f … [sort f [desc]]` — the words after `from` — or null. */
export function parseRows(words: readonly string[], tables: readonly QueryTable[]): QueryRequest | null {
  const w = [...words];
  const qt = tableOf(tables, w.shift());
  if (!qt || w.shift() !== 'columns') return null;
  const columns: Field[] = [];
  while (w.length > 0 && w[0] !== 'sort') {
    const f = publicField(qt.table, w.shift());
    if (!f || f.type === 'image' || columns.includes(f)) return null;
    columns.push(f);
  }
  if (columns.length < 1 || columns.length > QUERY_LIMITS.columns) return null;
  const sort = sortOf(qt.table, w);
  if (sort === null || w.length > 0) return null;
  const key = JSON.stringify(['rows', qt.table.name, columns.map((c) => c.name), sort]);
  return { kind: 'rows', table: qt, columns, sort, key };
}

/** `<table> title f [text f] [image f] [sort f [desc]]` — the words after `from` — or null. */
export function parseCards(words: readonly string[], tables: readonly QueryTable[]): QueryRequest | null {
  const w = [...words];
  const qt = tableOf(tables, w.shift());
  if (!qt || w.shift() !== 'title') return null;
  const t = qt.table;
  const isText = (f: Field | null): f is Field => f !== null && (f.type === 'text' || f.type === 'longtext');
  const title = publicField(t, w.shift());
  if (!isText(title)) return null;
  let text: Field | null = null;
  let image: Field | null = null;
  if (w[0] === 'text') {
    w.shift();
    text = publicField(t, w.shift());
    if (!isText(text)) return null;
  }
  if (w[0] === 'image') {
    w.shift();
    image = publicField(t, w.shift());
    if (!image || image.type !== 'image') return null;
  }
  const sort = sortOf(t, w);
  if (sort === null || w.length > 0) return null;
  const key = JSON.stringify(['cards', t.name, title.name, text?.name ?? null, image?.name ?? null, sort]);
  return { kind: 'cards', table: qt, title, text, image, sort, key };
}

/** A figure as a double that is exact, or null: a total past 2^53 is not shown at all. */
function exact(raw: unknown, digits: number | null): number | null {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) return null;
  const major = digits === null ? n : n / 10 ** digits;
  return Number(major.toPrecision(15));
}

const groupLabel = (f: Field, v: unknown): string =>
  f.type === 'flag' ? (Number(v) === 1 ? 'Yes' : 'No') : clampText(String(v), QUERY_LIMITS.label);

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A cell as the table shows it: numbers as numbers (money in major units), everything else as clamped text. */
function cell(f: Field, v: unknown, digits: Readonly<Record<string, number>>): string | number | null {
  if (v === null || v === undefined) return null;
  switch (f.type) {
    case 'number': return exact(v, null);
    case 'money': return exact(v, digits[f.name] ?? null);
    case 'flag': return v === true ? 'Yes' : 'No';
    case 'datetime': return day(Number(v));
    default: return clampText(String(v), QUERY_LIMITS.cell);
  }
}

export interface Queries {
  run(req: QueryRequest): Promise<QueryResult>;
}

export interface QueriesOptions {
  readonly db: Db;
  readonly database: Database;
  /** The server's public base URL, so an image's url works from the site (data-api publicUrl). */
  readonly publicBase: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export function createQueries(o: QueriesOptions): Queries {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  /** 60 s per normalised request, least recently used out past 500 (§20.5). */
  const cache = new Map<string, { at: number; result: Figures | RowsResult | CardsResult }>();

  async function read(sql: string, params: readonly Value[]): Promise<Record<string, unknown>[] | null> {
    try {
      return await o.db.allWithin(sql, params, LIST_DEADLINE_MS);
    } catch (e) {
      if (e instanceof QueryTimeout) {
        log(`chat: a figures read ran past ${LIST_DEADLINE_MS} ms and was cancelled`);
        return null;
      }
      // SQLite's driver refuses to hand back an integer a double cannot hold
      // (a SUM past 2^53) rather than round it: a total that is not exact.
      if (e instanceof RangeError) return null;
      throw e;
    }
  }

  async function figures(req: Extract<QueryRequest, { kind: 'figures' }>): Promise<Figures | null> {
    const { agg, table } = req;
    const s = selectAggregate(o.database, table.table, agg);
    const rows = await read(s.sql, s.params);
    if (rows === null) return null;
    const digits = agg.field?.type === 'money' ? table.digits[agg.field.name] ?? null : null;
    const unit = agg.field?.type === 'money' ? agg.field.currency ?? null : null;
    if (agg.by === null) {
      const value = exact(rows[0]?.v ?? 0, digits);
      if (value === null && rows[0]?.v !== null && rows[0]?.v !== undefined) return null;
      return { kind: 'figures', unit, value, groups: null, more: false, dated: false };
    }
    const shown = rows.slice(0, agg.limit - 1);
    const groups: [string, number][] = [];
    for (const r of shown) {
      const v = exact(r.v, digits);
      if (v === null) return null;
      groups.push([groupLabel(agg.by, r.g), v]);
    }
    const dated = agg.bucket !== null;
    // A date grouping was read newest first, so the latest buckets are the ones kept; shown oldest first.
    if (dated) groups.reverse();
    return { kind: 'figures', unit, value: null, groups, more: rows.length > shown.length, dated };
  }

  async function list(table: QueryTable, sort: string, limit: number): Promise<Record<string, unknown>[] | null> {
    const lq = parseQuery(table.table, new URLSearchParams({ sort, limit: String(Math.min(limit, LIMIT_MAX)) }), false);
    const s = selectList(o.database, table.table, lq, null, false);
    const rows = await read(s.sql, s.params);
    return rows === null ? null : rows.slice(0, lq.limit).map((r) => outRow(table.table, r, null, o.publicBase));
  }

  async function rows(req: Extract<QueryRequest, { kind: 'rows' }>): Promise<RowsResult | null> {
    const items = await list(req.table, req.sort, QUERY_LIMITS.rows);
    if (items === null) return null;
    return {
      kind: 'rows',
      columns: req.columns.map((f) => ({
        label: f.name,
        type: f.type === 'number' || f.type === 'money' ? 'number' as const : 'text' as const,
        unit: f.type === 'money' ? f.currency ?? null : null,
      })),
      rows: items.map((r) => req.columns.map((f) => cell(f, r[f.name], req.table.digits))),
    };
  }

  async function cards(req: Extract<QueryRequest, { kind: 'cards' }>): Promise<CardsResult | null> {
    const items = await list(req.table, req.sort, QUERY_LIMITS.cards);
    if (items === null) return null;
    return {
      kind: 'cards',
      items: items.map((r) => {
        const img = req.image ? r[req.image.name] as CardImage | null : null;
        return {
          title: clampText(String(r[req.title.name] ?? ''), QUERY_LIMITS.cardTitle),
          text: req.text && typeof r[req.text.name] === 'string' ? clampText(r[req.text.name] as string, QUERY_LIMITS.cardText) : null,
          image: img,
          row: img && req.image ? { table: req.table.table.name, id: String(r.id), field: req.image.name } : null,
        };
      }).filter((c) => c.title.trim() !== ''),
    };
  }

  return {
    async run(req) {
      const hit = cache.get(req.key);
      if (hit && now() - hit.at < QUERY_LIMITS.cacheMs) {
        cache.delete(req.key);
        cache.set(req.key, hit);
        return { ok: true, result: hit.result };
      }
      const result = req.kind === 'figures' ? await figures(req) : req.kind === 'rows' ? await rows(req) : await cards(req);
      if (result === null) return { ok: false };
      cache.delete(req.key);
      cache.set(req.key, { at: now(), result });
      while (cache.size > QUERY_LIMITS.cacheEntries) cache.delete(cache.keys().next().value as string);
      return { ok: true, result };
    },
  };
}

/**
 * The route's `figures` (chat.ts): a rich component's `from` words parsed
 * against the queryable tables and run. Null when the words are not a
 * request this file knows; `unavailable` when the read ran out of time or
 * overflowed. Each money field's minor-unit digits come from the build
 * (context.json), which has the currency table; the server does not.
 */
export function figuresRun(queries: Queries, tables: readonly Table[], context: readonly ContextTable[]): FiguresRun {
  const digits = (t: Table): Record<string, number> => {
    const c = context.find((x) => x.name === t.name);
    const out: Record<string, number> = {};
    for (const f of c?.fields ?? []) if (f.digits !== undefined) out[f.name] = f.digits;
    return out;
  };
  const known = tables.map((table): QueryTable => ({ table, digits: digits(table) }));
  return async (kind, words, cap) => {
    const req = kind === 'figures' ? parseFigures(words, known, cap) : kind === 'rows' ? parseRows(words, known) : parseCards(words, known);
    if (!req) return null;
    const r = await queries.run(req);
    return r.ok ? r.result : 'unavailable';
  };
}
