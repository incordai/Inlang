/**
 * @az server data-values
 * Purpose: the data tables' runtime model, every value's validation, and rows as the API returns them.
 * Spec: docs/data-spec.md §4.3–§4.5, §5.2, §9
 * Exports: Table, Field, FieldType, Rules, Who, Stored, ValueProblem, loadTables, ownedRowDeletes, checkValue, storedDefault, outRow, fieldColumns, imageVersion, q, physical, isUuid, isDate, chars, TEXT_LIMITS
 * Edit guide: the server is the first line (the database the second): every value is checked here before any statement.
 * Tests: packages/backend/test/data-api.test.ts
 */

/**
 * The model is generated from the `.az` file into `server/data.json`; it is
 * read once at start and shape-checked, so a damaged file stops the server
 * instead of reaching SQL. Identifiers in SQL only ever come from here, and
 * are quoted.
 *
 * Copied into a generated server only when the site declares data; imports
 * only its siblings and node built-ins.
 */

import { isEmail } from './app.ts';
import type { Database } from './env.ts';

export type Who = 'anyone' | 'signedin' | 'owner';
export type Rules = { readonly read: readonly Who[]; readonly create: readonly Who[]; readonly edit: readonly Who[]; readonly delete: readonly Who[] };
export type FieldType = 'text' | 'longtext' | 'number' | 'money' | 'flag' | 'date' | 'datetime' | 'email' | 'url' | 'choice' | 'image' | 'ref';

export interface Field {
  readonly name: string;
  readonly type: FieldType;
  readonly currency?: string;
  readonly choices?: readonly string[];
  readonly ref?: string;
  readonly required: boolean;
  readonly unique: boolean;
  readonly index: boolean;
  readonly search: boolean;
  readonly private: boolean;
  readonly locked: boolean;
  readonly default?: string | number | boolean;
}

export interface Table {
  readonly name: string;
  readonly fields: readonly Field[];
  readonly rules: Rules;
}

/** Characters, as the databases count them (code points, not UTF-16 units). */
export const TEXT_LIMITS = { text: 200, longtext: 10_000, email: 254, url: 2048, choice: 63 } as const;

const NAME = /^[a-z][a-z0-9]*$/;
const TYPES: ReadonlySet<string> = new Set(['text', 'longtext', 'number', 'money', 'flag', 'date', 'datetime', 'email', 'url', 'choice', 'image', 'ref']);
const WHO: ReadonlySet<string> = new Set(['anyone', 'signedin', 'owner']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const physical = (table: string) => `azd_${table}`;
export const q = (d: Database, name: string) => (d === 'mysql' ? `\`${name}\`` : `"${name}"`);
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
export const chars = (v: string) => [...v].length;

/**
 * A field's columns: one, or for an image its stored key with the width and
 * height beside it (data-spec §4.3). Field names never hold `_`.
 */
export const fieldColumns = (f: Field): readonly string[] =>
  f.type === 'image' ? [f.name, `${f.name}__w`, `${f.name}__h`] : [f.name];

/** The version an image URL carries: its stored key's UUID, new on every upload (data-spec §8). */
export const imageVersion = (key: string) => key.slice(0, key.indexOf('.'));

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The model from data.json, shape-checked; throws naming the first problem. */
export function loadTables(raw: unknown): Table[] {
  if (!isObject(raw) || !Array.isArray(raw.tables)) throw new Error('data.json: no tables');
  return raw.tables.map((t: unknown) => {
    if (!isObject(t) || typeof t.name !== 'string' || !NAME.test(t.name) || !Array.isArray(t.fields) || !isObject(t.rules)) {
      throw new Error('data.json: a table is malformed');
    }
    const rules = t.rules;
    for (const a of ['read', 'create', 'edit', 'delete']) {
      const list = rules[a];
      if (!Array.isArray(list) || !list.every((w) => typeof w === 'string' && WHO.has(w))) throw new Error(`data.json: ${t.name} rules are malformed`);
    }
    const fields = t.fields.map((f: unknown) => {
      if (!isObject(f) || typeof f.name !== 'string' || !NAME.test(f.name) || typeof f.type !== 'string' || !TYPES.has(f.type)) {
        throw new Error(`data.json: a field of ${t.name} is malformed`);
      }
      return f as unknown as Field;
    });
    return { name: t.name, fields, rules: rules as unknown as Rules };
  });
}

/**
 * One statement per table deleting an account's own rows, `?` its id —
 * run when an unverified account is claimed (store.ts claimUnverified). A
 * row of another account that points at a deleted row follows its ref's
 * rule: a required ref's row goes with it, an optional one is cleared.
 */
export const ownedRowDeletes = (d: Database, tables: readonly Table[]): string[] =>
  tables.map((t) => `DELETE FROM ${q(d, physical(t.name))} WHERE ${q(d, 'owner')} = ?`);

/** A real calendar day, 0001-01-01 … 9999-12-31. */
function isDate(v: string): boolean {
  const m = DATE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[mo - 1];
}

const CONTROL_LINE = /[\u0000-\u001f\u007f]/;
const CONTROL_PARAGRAPHS = /[\u0000-\u0008\u000b-\u001f\u007f]/;

/** http(s) only, as a browser would parse it; no credentials in it. */
function isUrl(v: string): boolean {
  if (/[\s\u0000-\u001f\u007f]/.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === '' && u.hostname !== '';
  } catch {
    return false;
  }
}

export type ValueProblem = 'invalid' | 'too_long';
export type Stored = string | number | null;

/**
 * A request value as the value to store, or the problem with it. `null` (and
 * an empty or blank string) means "no value"; whether that is allowed is the
 * caller's (required) decision.
 */
export function checkValue(f: Field, v: unknown): { ok: true; value: Stored } | { ok: false; problem: ValueProblem } {
  if (v === null || (typeof v === 'string' && v.trim() === '')) return { ok: true, value: null };
  const bad = { ok: false as const, problem: 'invalid' as const };
  const long = { ok: false as const, problem: 'too_long' as const };
  switch (f.type) {
    case 'text': case 'longtext': {
      if (typeof v !== 'string') return bad;
      const value = f.type === 'text' ? v.trim() : v;
      if ((f.type === 'text' ? CONTROL_LINE : CONTROL_PARAGRAPHS).test(value)) return bad;
      return chars(value) > TEXT_LIMITS[f.type] ? long : { ok: true, value };
    }
    case 'email': {
      if (typeof v !== 'string') return bad;
      const value = v.trim();
      if (chars(value) > TEXT_LIMITS.email) return long;
      return isEmail(value) ? { ok: true, value } : bad;
    }
    case 'url': {
      if (typeof v !== 'string') return bad;
      if (chars(v) > TEXT_LIMITS.url) return long;
      return isUrl(v) ? { ok: true, value: v } : bad;
    }
    case 'choice':
      return typeof v === 'string' && (f.choices ?? []).includes(v) ? { ok: true, value: v } : bad;
    case 'number':
      return Number.isSafeInteger(v) ? { ok: true, value: v as number } : bad;
    case 'money': case 'datetime':
      return Number.isSafeInteger(v) && (v as number) >= 0 ? { ok: true, value: v as number } : bad;
    case 'flag':
      return typeof v === 'boolean' ? { ok: true, value: v ? 1 : 0 } : bad;
    case 'date':
      return typeof v === 'string' && isDate(v) ? { ok: true, value: v } : bad;
    case 'ref':
      return isUuid(v) ? { ok: true, value: v } : bad;
    case 'image':
      // Set only by uploading its bytes (PUT /data/<t>/<id>/<field>), never in a JSON body.
      return bad;
  }
}

/** A stored default as the value to store (flags 0/1). */
export const storedDefault = (f: Field): Stored | undefined =>
  f.default === undefined ? (f.type === 'flag' ? 0 : undefined) : typeof f.default === 'boolean' ? (f.default ? 1 : 0) : f.default;

const NUMERIC: ReadonlySet<FieldType> = new Set(['number', 'money', 'datetime']);

/**
 * A row as the API returns it: `{ id, created, updated, mine, …fields }`.
 * The owner's id never leaves the server — `mine` says whether it is the
 * caller. Engines return 64-bit integers as numbers or strings; both become
 * numbers (every stored value is a safe integer). An image is `{ url, width,
 * height }`: `imageBase` is the server's public URL plus the route prefix
 * (`/data` or `/admin/data`), and the URL's `v` is the stored key's UUID, so
 * a new upload is a new URL and the old one may be cached for good.
 */
export function outRow(t: Table, row: Record<string, unknown>, user: string | null, imageBase = '/data'): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: row.id,
    created: Number(row.created),
    updated: Number(row.updated),
    mine: user !== null && row.owner === user,
  };
  for (const f of t.fields) {
    const v = row[f.name];
    if (f.type === 'image') {
      out[f.name] = typeof v === 'string' && v !== ''
        ? { url: `${imageBase}/${t.name}/${String(row.id)}/${f.name}?v=${imageVersion(v)}`, width: Number(row[`${f.name}__w`]), height: Number(row[`${f.name}__h`]) }
        : null;
      continue;
    }
    out[f.name] = v === null || v === undefined
      ? (f.type === 'flag' ? false : null)
      : f.type === 'flag' ? Number(v) === 1
        : NUMERIC.has(f.type) ? Number(v)
          : v;
  }
  return out;
}

export { isDate };
