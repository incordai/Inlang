/**
 * @az server data-query
 * Purpose: a list request's query string, allow-listed, as one parameterised SELECT with keyset paging and escaped search.
 * Spec: docs/data-spec.md §5.1, §4.7 · docs/chat-block-spec.md §20.5 (aggregations)
 * Exports: parseQuery, ListQuery, QueryError, SORTABLE, selectList, selectOne, readable, cursorOf, adminSelectList, adminSelectOne, adminCount, LIMIT_DEFAULT, LIMIT_MAX,
 *   Aggregate, AGGREGATE_MEASURE, AGGREGATE_GROUP, AGGREGATE_FILTER, AGGREGATE_LIMIT_MAX, selectAggregate
 * Edit guide: an unknown or malformed parameter is a 400 naming it, never ignored; values only as parameters.
 * Tests: packages/backend/test/data-api.test.ts
 */

/**
 * Every parameter is on a closed list per table; anything else is
 * `400 bad_query` naming it — a misspelt filter silently ignored would
 * return the wrong rows and look like it worked. Paging is keyset only
 * (`after` is the last row's sort value and id), at most 100 rows, never a
 * count or an offset. Every sort key is indexed (core storageOf: a
 * sortable field is indexed automatically), so a sort never sorts the
 * table. A filter on a column with no index, and `q` (a LIKE that no index
 * serves), can still read every row to fill a page: their cost is bounded
 * by time instead — the database cancels a public list past
 * LIST_DEADLINE_MS (data-api.ts, Db.allWithin).
 *
 * Copied into a generated server only when the site declares data; imports
 * only its siblings and node built-ins.
 */

import type { Value } from './db.ts';
import type { Database } from './env.ts';
import { chars, checkValue, fieldColumns, isDate, isUuid, physical, q, TEXT_LIMITS, type Field, type FieldType, type Table } from './data-values.ts';

export const LIMIT_DEFAULT = 20;
export const LIMIT_MAX = 100;
const IN_MAX = 20;
const Q_MIN = 2;
const Q_MAX = 100;
/** The longest value a sort can carry: a text field (choices are shorter). */
const SORT_TEXT_MAX = TEXT_LIMITS.text;
/**
 * The longest cursor this server writes, derived rather than guessed: a
 * text sort value at its cap in the costliest JSON spelling (a lone
 * surrogate, `\udXXX`, six bytes — more than any UTF-8 character), and an
 * id, as base64url. Anything longer is not one of ours.
 */
const CURSOR_MAX = Math.ceil(Buffer.byteLength(JSON.stringify(['\ud800'.repeat(SORT_TEXT_MAX), '00000000-0000-4000-8000-000000000000'])) * 4 / 3);

const EQUALITY: ReadonlySet<FieldType> = new Set(['number', 'money', 'flag', 'date', 'datetime', 'choice', 'ref', 'email']);
const RANGE: ReadonlySet<FieldType> = new Set(['number', 'money', 'date', 'datetime']);
const IN: ReadonlySet<FieldType> = new Set(['choice', 'ref']);
/** Equal to core's SORT_TYPES, whose required fields are indexed (a test keeps them equal). */
export const SORTABLE: ReadonlySet<FieldType> = new Set(['text', 'number', 'money', 'date', 'datetime', 'choice']);
const OPS = { lt: '<', lte: '<=', gt: '>', gte: '>=' } as const;

export class QueryError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`bad_query: ${field}`);
    this.field = field;
  }
}

interface Sort { readonly key: string; readonly kind: 'number' | 'date' | 'text'; readonly desc: boolean }
interface Filter { readonly sql: (d: Database) => string; readonly params: Value[] }

export interface ListQuery {
  readonly limit: number;
  readonly sort: Sort;
  readonly after: readonly [Value, string] | null;
  readonly filters: readonly Filter[];
  readonly mine: boolean;
}

/** A filter value in the field's own spelling: `on`/`off` for a flag, digits for numbers. */
function filterValue(f: Field, raw: string, param: string): Value {
  if (f.type === 'flag') {
    if (raw === 'on' || raw === 'off') return raw === 'on' ? 1 : 0;
    throw new QueryError(param);
  }
  if (f.type === 'number' || f.type === 'money' || f.type === 'datetime') {
    if (!/^-?\d{1,16}$/.test(raw)) throw new QueryError(param);
    const r = checkValue(f, Number(raw));
    if (!r.ok || r.value === null) throw new QueryError(param);
    return r.value;
  }
  const r = checkValue(f, raw);
  if (!r.ok || r.value === null) throw new QueryError(param);
  return r.value;
}

/**
 * Parse a list request's query string for this table. `ownerOnly` is
 * whether every row the caller can see is theirs anyway (read = owner only),
 * which, like `mine=1`, opens private fields to filters, sort and search.
 */
export function parseQuery(t: Table, params: URLSearchParams, ownerOnly: boolean): ListQuery {
  const seen = new Set<string>();
  for (const k of params.keys()) {
    if (seen.has(k)) throw new QueryError(k);
    seen.add(k);
  }
  const mineRaw = params.get('mine');
  if (mineRaw !== null && mineRaw !== '1') throw new QueryError('mine');
  const mine = mineRaw === '1';
  const own = mine || ownerOnly;
  const field = (name: string, param: string): Field => {
    const f = t.fields.find((x) => x.name === name);
    if (!f || (f.private && !own)) throw new QueryError(param);
    return f;
  };

  let limit = LIMIT_DEFAULT;
  let sort: Sort = { key: 'created', kind: 'number', desc: true };
  let afterRaw: string | null = null;
  const filters: Filter[] = [];

  for (const [k, v] of params) {
    if (k === 'mine') continue;
    if (k === 'limit') {
      if (!/^\d{1,3}$/.test(v) || Number(v) < 1 || Number(v) > LIMIT_MAX) throw new QueryError(k);
      limit = Number(v);
    } else if (k === 'after') {
      afterRaw = v;
    } else if (k === 'sort') {
      const m = /^(-?)([a-z][a-z0-9]*)$/.exec(v);
      if (!m) throw new QueryError(k);
      if (m[2] === 'created' || m[2] === 'updated') {
        sort = { key: m[2], kind: 'number', desc: m[1] === '-' };
      } else {
        const f = field(m[2], k);
        // Required only: the engines order NULLs differently, which would break keyset paging.
        if (!f.required || !SORTABLE.has(f.type)) throw new QueryError(k);
        const kind = f.type === 'number' || f.type === 'money' || f.type === 'datetime' ? 'number' : f.type === 'date' ? 'date' : 'text';
        sort = { key: f.name, kind, desc: m[1] === '-' };
      }
    } else if (k === 'q') {
      const n = chars(v);
      if (n < Q_MIN || n > Q_MAX || /[\u0000-\u001f\u007f]/.test(v)) throw new QueryError(k);
      const cols = t.fields.filter((f) => f.search && (!f.private || own)).map((f) => f.name);
      if (cols.length === 0) throw new QueryError(k);
      // `!` escapes LIKE's wildcards: a literal `%` matches only `%`.
      const pattern = `%${v.replace(/[!%_]/g, (c) => `!${c}`)}%`;
      filters.push({
        sql: (d) => `(${cols.map((c) => `LOWER(${q(d, c)}) LIKE LOWER(?) ESCAPE '!'`).join(' OR ')})`,
        params: cols.map(() => pattern),
      });
    } else {
      const m = /^([a-z][a-z0-9]*)(?:\.(lt|lte|gt|gte|in))?$/.exec(k);
      if (!m) throw new QueryError(k);
      const f = field(m[1], k);
      const op = m[2];
      if (op === undefined) {
        if (!EQUALITY.has(f.type)) throw new QueryError(k);
        const value = filterValue(f, v, k);
        filters.push({ sql: (d) => `${q(d, f.name)} = ?`, params: [value] });
      } else if (op === 'in') {
        if (!IN.has(f.type)) throw new QueryError(k);
        const values = [...new Set(v.split(','))];
        if (values.length === 0 || values.length > IN_MAX) throw new QueryError(k);
        const parsed = values.map((x) => filterValue(f, x, k));
        filters.push({ sql: (d) => `${q(d, f.name)} IN (${parsed.map(() => '?').join(', ')})`, params: parsed });
      } else {
        if (!RANGE.has(f.type)) throw new QueryError(k);
        const value = filterValue(f, v, k);
        filters.push({ sql: (d) => `${q(d, f.name)} ${OPS[op as keyof typeof OPS]} ?`, params: [value] });
      }
    }
  }

  let after: readonly [Value, string] | null = null;
  if (afterRaw !== null) {
    if (afterRaw.length > CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(afterRaw)) throw new QueryError('after');
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(afterRaw, 'base64url').toString('utf8'));
    } catch {
      throw new QueryError('after');
    }
    if (!Array.isArray(decoded) || decoded.length !== 2 || !isUuid(decoded[1])) throw new QueryError('after');
    const [value] = decoded;
    const ok = sort.kind === 'number'
      ? Number.isSafeInteger(value)
      : typeof value === 'string' && chars(value) <= SORT_TEXT_MAX && (sort.kind !== 'date' || isDate(value));
    if (!ok) throw new QueryError('after');
    after = [value as Value, decoded[1] as string];
  }
  return { limit, sort, after, filters, mine };
}

/** The cursor for the row after which the next page starts. */
export function cursorOf(sort: Sort, row: Record<string, unknown>): string {
  const v = row[sort.key];
  return Buffer.from(JSON.stringify([sort.kind === 'number' ? Number(v) : v, row.id]), 'utf8').toString('base64url');
}

/**
 * The columns a caller reads: system columns, then each field — a private
 * one only on the caller's own rows, decided in SQL (data-spec §4.7).
 */
export function readable(d: Database, t: Table, user: string | null): { sql: string; params: Value[] } {
  const params: Value[] = [];
  const cols = ['id', 'owner', 'created', 'updated'].map((c) => q(d, c));
  for (const f of t.fields) {
    for (const c of fieldColumns(f)) {
      if (f.private) {
        cols.push(`CASE WHEN ${q(d, 'owner')} = ? THEN ${q(d, c)} END AS ${q(d, c)}`);
        params.push(user);
      } else {
        cols.push(q(d, c));
      }
    }
  }
  return { sql: cols.join(', '), params };
}

/**
 * The columns an ADMIN reads (data-spec §11): every field, private ones
 * included, and the owner's address from the accounts table. The table is
 * aliased `r` so the subquery's `u` columns can never shadow a field name.
 */
function adminColumns(d: Database, t: Table): string {
  const cols = ['id', 'owner', 'created', 'updated', ...t.fields.flatMap(fieldColumns)].map((c) => `r.${q(d, c)}`);
  cols.push(`(SELECT u.${q(d, 'email')} FROM ${q(d, 'az_users')} u WHERE u.${q(d, 'id')} = r.${q(d, 'owner')}) AS ${q(d, 'az_owner_email')}`);
  return cols.join(', ');
}

/** The admin list's WHERE: the filters and `mine`, without the keyset — for the page and the count. */
function adminWhere(d: Database, lq: ListQuery, admin: string): { parts: string[]; params: Value[] } {
  const parts: string[] = [];
  const params: Value[] = [];
  if (lq.mine) {
    parts.push(`r.${q(d, 'owner')} = ?`);
    params.push(admin);
  }
  for (const f of lq.filters) {
    parts.push(f.sql(d));
    params.push(...f.params);
  }
  return { parts, params };
}

/**
 * An admin page (data-spec §11): no rule predicate — admins see every row —
 * the same filters, keyset and limit as a list, and the owner's address.
 */
export function adminSelectList(d: Database, t: Table, lq: ListQuery, admin: string): { sql: string; params: Value[] } {
  const w = adminWhere(d, lq, admin);
  const where = [...w.parts];
  const params = [...w.params];
  const key = `r.${q(d, lq.sort.key)}`;
  const id = `r.${q(d, 'id')}`;
  const dir = lq.sort.desc ? 'DESC' : 'ASC';
  if (lq.after) {
    const cmp = lq.sort.desc ? '<' : '>';
    where.push(`(${key} ${cmp} ? OR (${key} = ? AND ${id} ${cmp} ?))`);
    params.push(lq.after[0], lq.after[0], lq.after[1]);
  }
  const limit = Math.trunc(lq.limit);
  if (!(limit >= 1 && limit <= LIMIT_MAX)) throw new Error('adminSelectList: limit out of range');
  return {
    sql: `SELECT ${adminColumns(d, t)} FROM ${q(d, physical(t.name))} r${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${key} ${dir}, ${id} ${dir} LIMIT ${limit + 1}`,
    params,
  };
}

/** How many rows the admin list's filters match — admins only (§5.1: no public count). */
export function adminCount(d: Database, t: Table, lq: ListQuery, admin: string): { sql: string; params: Value[] } {
  const w = adminWhere(d, lq, admin);
  return {
    sql: `SELECT COUNT(*) AS n FROM ${q(d, physical(t.name))} r${w.parts.length ? ` WHERE ${w.parts.join(' AND ')}` : ''}`,
    params: w.params,
  };
}

/** One row by id for an admin, with the owner's address. */
export function adminSelectOne(d: Database, t: Table, id: string): { sql: string; params: Value[] } {
  return { sql: `SELECT ${adminColumns(d, t)} FROM ${q(d, physical(t.name))} r WHERE r.${q(d, 'id')} = ?`, params: [id] };
}

/**
 * One page: the readable columns, the rule's owner predicate, the filters,
 * the keyset, ordered by the sort key then id, `limit + 1` rows so the
 * caller knows whether there is a next page. LIMIT is a range-checked
 * integer from parseQuery, written into the text — never request text.
 */
export function selectList(d: Database, t: Table, lq: ListQuery, user: string | null, ownerOnly: boolean): { sql: string; params: Value[] } {
  const cols = readable(d, t, user);
  const where: string[] = [];
  const params: Value[] = [...cols.params];
  if (ownerOnly || lq.mine) {
    where.push(`${q(d, 'owner')} = ?`);
    params.push(user);
  }
  for (const f of lq.filters) {
    where.push(f.sql(d));
    params.push(...f.params);
  }
  const key = q(d, lq.sort.key);
  const id = q(d, 'id');
  const dir = lq.sort.desc ? 'DESC' : 'ASC';
  if (lq.after) {
    const cmp = lq.sort.desc ? '<' : '>';
    where.push(`(${key} ${cmp} ? OR (${key} = ? AND ${id} ${cmp} ?))`);
    params.push(lq.after[0], lq.after[0], lq.after[1]);
  }
  const limit = Math.trunc(lq.limit);
  if (!(limit >= 1 && limit <= LIMIT_MAX)) throw new Error('selectList: limit out of range');
  return {
    sql: `SELECT ${cols.sql} FROM ${q(d, physical(t.name))}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${key} ${dir}, ${id} ${dir} LIMIT ${limit + 1}`,
    params,
  };
}

/** One row by id, under the same read predicate as a list. */
export function selectOne(d: Database, t: Table, id: string, user: string | null, ownerOnly: boolean): { sql: string; params: Value[] } {
  const cols = readable(d, t, user);
  return {
    sql: `SELECT ${cols.sql} FROM ${q(d, physical(t.name))} WHERE ${q(d, 'id')} = ?${ownerOnly ? ` AND ${q(d, 'owner')} = ?` : ''}`,
    params: [...cols.params, id, ...(ownerOnly ? [user] : [])],
  };
}

/** An aggregation chat may ask for (chat-block-spec §20.5): one measure, at most one grouping and one filter. */
export interface Aggregate {
  readonly fn: 'count' | 'sum' | 'avg' | 'min' | 'max';
  /** The measured field — `number` or `money`; null for `count`. */
  readonly field: Field | null;
  /** The grouping field — `choice`, `flag`, `date` or `datetime`; null for one figure. */
  readonly by: Field | null;
  /** Required on a date grouping, absent otherwise. */
  readonly bucket: 'day' | 'month' | 'year' | null;
  readonly where: { readonly field: Field; readonly value: Value } | null;
  /** Groups to read: the cap plus one, so the caller knows there were more (at most AGGREGATE_LIMIT_MAX). */
  readonly limit: number;
  /**
   * Also read, per group, how many rows had a value of the measured field
   * (`n`): what a caller needs to combine groups' sums into an average — the
   * ISO weeks chat-query.ts builds from days (chat-block-spec §19.11).
   */
  readonly counted?: boolean;
}

/** The most groups one aggregation reads: 24 ISO weeks of days, and the one more that says there were more. */
export const AGGREGATE_LIMIT_MAX = 7 * 24 + 1;

export const AGGREGATE_MEASURE: ReadonlySet<FieldType> = new Set(['number', 'money']);
export const AGGREGATE_GROUP: ReadonlySet<FieldType> = new Set(['choice', 'flag', 'date', 'datetime']);
export const AGGREGATE_FILTER: ReadonlySet<FieldType> = new Set(['choice', 'flag']);

/** strftime / to_char / DATE_FORMAT patterns per bucket. */
const BUCKET_FORMAT = {
  sqlite: { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' },
  postgres: { day: 'YYYY-MM-DD', month: 'YYYY-MM', year: 'YYYY' },
  mysql: { day: '%Y-%m-%d', month: '%Y-%m', year: '%Y' },
} as const;
const BUCKET_CHARS = { day: 10, month: 7, year: 4 } as const;

/**
 * A datetime column (epoch ms, UTC) or a date column (`YYYY-MM-DD`) as its
 * bucket's text. No time zone is involved on any engine: SQLite's
 * `unixepoch` is UTC, and the other two add the milliseconds to the epoch
 * as a plain timestamp, so the three agree (test:backend-db measures it).
 */
function bucketOf(d: Database, f: Field, bucket: 'day' | 'month' | 'year'): string {
  const col = q(d, f.name);
  if (f.type === 'date') return `substr(${col}, 1, ${BUCKET_CHARS[bucket]})`;
  const fmt = BUCKET_FORMAT[d][bucket];
  if (d === 'sqlite') return `strftime('${fmt}', ${col} / 1000, 'unixepoch')`;
  if (d === 'postgres') return `to_char(TIMESTAMP '1970-01-01 00:00:00' + ${col} * INTERVAL '1 millisecond', '${fmt}')`;
  return `DATE_FORMAT(DATE_ADD('1970-01-01 00:00:00', INTERVAL ${col} DIV 1000 SECOND), '${fmt}')`;
}

/**
 * One aggregation as one parameterised SELECT. Identifiers come only from
 * the table model, quoted; the filter value is a parameter; the formats and
 * LIMIT are the server's own. A private field is never read: the caller
 * cannot name one (chat-query.ts validates against the public schema) and
 * this refuses it again. Rows whose group is NULL are left out. A date
 * grouping returns the latest buckets first; a category grouping the
 * largest first, ties by name.
 */
export function selectAggregate(d: Database, t: Table, a: Aggregate): { sql: string; params: Value[] } {
  for (const f of [a.field, a.by, a.where?.field]) {
    if (f && (f.private || !t.fields.includes(f))) throw new Error('selectAggregate: a field outside the public schema');
  }
  if ((a.fn === 'count') !== (a.field === null) || (a.field && !AGGREGATE_MEASURE.has(a.field.type))) throw new Error('selectAggregate: bad measure');
  if (a.by && !AGGREGATE_GROUP.has(a.by.type)) throw new Error('selectAggregate: bad grouping');
  const dated = a.by !== null && (a.by.type === 'date' || a.by.type === 'datetime');
  if (dated !== (a.bucket !== null)) throw new Error('selectAggregate: a bucket goes with a date grouping only');
  if (a.where && !AGGREGATE_FILTER.has(a.where.field.type)) throw new Error('selectAggregate: bad filter');
  const limit = Math.trunc(a.limit);
  if (!(limit >= 1 && limit <= AGGREGATE_LIMIT_MAX)) throw new Error('selectAggregate: limit out of range');
  if (a.counted && (a.field === null || a.by === null)) throw new Error('selectAggregate: a count of values goes with a measure and a grouping');

  const measure = a.field === null ? 'COUNT(*)' : `${a.fn.toUpperCase()}(${q(d, a.field.name)})`;
  const where: string[] = [];
  const params: Value[] = [];
  if (a.where) {
    where.push(`${q(d, a.where.field.name)} = ?`);
    params.push(a.where.value);
  }
  const table = q(d, physical(t.name));
  if (a.by === null) {
    return { sql: `SELECT ${measure} AS ${q(d, 'v')} FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`, params };
  }
  where.push(`${q(d, a.by.name)} IS NOT NULL`);
  const group = a.bucket ? bucketOf(d, a.by, a.bucket) : q(d, a.by.name);
  const g = q(d, 'g');
  const v = q(d, 'v');
  const order = a.bucket ? `${g} DESC` : `${v} DESC, ${g} ASC`;
  const counted = a.counted && a.field ? `, COUNT(${q(d, a.field.name)}) AS ${q(d, 'n')}` : '';
  return {
    sql: `SELECT ${group} AS ${g}, ${measure} AS ${v}${counted} FROM ${table} WHERE ${where.join(' AND ')} GROUP BY ${group} ORDER BY ${order} LIMIT ${limit}`,
    params,
  };
}
