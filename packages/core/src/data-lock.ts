/**
 * @az module data-lock
 * Purpose: the schema lock — storage schema and exposure, replay, file-vs-lock diff, AZ1701–AZ1708.
 * Spec: docs/data-spec.md §6.1–§6.2, §18.7
 * Exports: LOCK_FORMAT, LockField, OnDelete, onDeleteOf, ReadLevel, Exposure, exposureOf, LockTable, Fill, LockOp, LockStep, DataLock, LockFlags, Change, PlanResult, LockError, storageOf, applyOp, replay, parseLock, serialiseLock, canonicalSteps, plan, checkLock
 * Edit guide: a new op needs replay, plan and the backend's DDL (packages/backend/src/data-ddl.ts) in the same change.
 * Tests: packages/core/test/data-lock.test.ts
 */

/**
 * The `.az` file says what the tables ARE; the lock says how they got there
 * (data-spec §6.1). Locked: what storage depends on, and what each table
 * exposes — who reads it and which fields are `private` — so that showing
 * stored rows to more people is a reviewed step (`--expose`, AZ1708), never
 * a side effect of an edited rule. `search`, `locked`, `default` and the
 * write rules are read from the file at build time and change without a
 * step. Pure: the digest function is passed in, because core runs in a
 * browser (index.ts).
 */

import type { Diagnostic, Pos } from './lex.ts';
import { DATA_TYPES, sortable, type DataType, type SpecTable } from './data.ts';

export const LOCK_FORMAT = 1;

export interface LockField {
  readonly name: string;
  readonly type: DataType;
  readonly currency?: string;
  readonly choices?: readonly string[];
  readonly ref?: string;
  /**
   * `ref` only: what deleting the row it points at does (data-spec §4.3) —
   * `cascade` for a required ref, `setnull` for an optional one, so nobody
   * else's row can stop an owner deleting their own. Absent in steps written
   * before this rule: those foreign keys RESTRICT until a step relinks them.
   */
  readonly onDelete?: OnDelete;
  readonly required: boolean;
  readonly unique: boolean;
  readonly index: boolean;
}

export type OnDelete = 'cascade' | 'setnull';
const ON_DELETE: ReadonlySet<string> = new Set<OnDelete>(['cascade', 'setnull']);

/** The rule: a required ref's rows go with their target; an optional ref is cleared. */
export const onDeleteOf = (f: { readonly required: boolean }): OnDelete => (f.required ? 'cascade' : 'setnull');

/**
 * Who beyond admins reads a table's rows: its widest read rule (rules add
 * up, data-spec §4.7). `none`: admins only.
 */
export type ReadLevel = 'none' | 'owner' | 'signedin' | 'anyone';
const READ_LEVELS: readonly ReadLevel[] = ['none', 'owner', 'signedin', 'anyone'];

/** What a table shows: its read level and its `private` fields, sorted. */
export interface Exposure {
  readonly read: ReadLevel;
  readonly private: readonly string[];
}

/** A file table's exposure. */
export function exposureOf(t: SpecTable): Exposure {
  const read = t.rules.read;
  return {
    read: read.includes('anyone') ? 'anyone' : read.includes('signedin') ? 'signedin' : read.includes('owner') ? 'owner' : 'none',
    private: t.fields.filter((f) => f.private).map((f) => f.name).sort(),
  };
}

/**
 * Who other than a row's owner (and admins) reads a column: the table's
 * level when that reaches other accounts, else `none`. A private field
 * (`field` given) reaches only its owner.
 */
const othersOf = (e: Exposure, field?: string): ReadLevel =>
  (e.read === 'anyone' || e.read === 'signedin') && (field === undefined || !e.private.includes(field)) ? e.read : 'none';
const rank = (l: ReadLevel) => READ_LEVELS.indexOf(l);
const shownTo: Readonly<Record<ReadLevel, string>> = {
  none: 'admins only', owner: 'its owner', signedin: 'every signed-in account', anyone: 'anyone',
};

export interface LockTable {
  readonly name: string;
  readonly fields: readonly LockField[];
  /** Absent in locks written before exposure was recorded; the next step records it. */
  readonly expose?: Exposure;
}

/** A value written into existing rows when a field gains one (never into DDL). */
export type Fill = string | number | boolean;

export type LockOp =
  | { readonly op: 'createTable'; readonly table: string; readonly fields: readonly LockField[] }
  | { readonly op: 'dropTable'; readonly table: string }
  | { readonly op: 'renameTable'; readonly table: string; readonly to: string }
  | { readonly op: 'addField'; readonly table: string; readonly field: LockField; readonly fill?: Fill }
  | { readonly op: 'dropField'; readonly table: string; readonly field: string }
  | { readonly op: 'renameField'; readonly table: string; readonly field: string; readonly to: string }
  | { readonly op: 'setField'; readonly table: string; readonly field: LockField; readonly fill?: Fill }
  /** No SQL: the generated statements enforce the rules; the lock records them so that widening is reviewed. */
  | { readonly op: 'expose'; readonly table: string; readonly read: ReadLevel; readonly private: readonly string[] };

export interface LockStep {
  readonly version: number;
  readonly ops: readonly LockOp[];
}

export interface DataLock {
  readonly format: number;
  readonly steps: readonly LockStep[];
  readonly digest: string;
}

/** A lock that cannot be read, or whose steps do not replay — AZ1706. */
export class LockError extends Error {}

/* ------------------------------------------------------------------ */
/* Storage schema                                                      */
/* ------------------------------------------------------------------ */

/**
 * The storage-relevant part of the file's tables, in the lock's field shape.
 * `index` is what the database holds: written, or implied because the API
 * sorts by the field (data-spec §4.5, §5.1) — a unique field already has its
 * own index.
 */
export function storageOf(tables: readonly SpecTable[]): LockTable[] {
  return tables.map((t) => ({
    name: t.name,
    fields: t.fields.map((f) => lockField({
      name: f.name, type: f.type, currency: f.currency, choices: f.choices, ref: f.ref,
      ...(f.type === 'ref' ? { onDelete: onDeleteOf(f) } : {}),
      required: f.required, unique: f.unique, index: f.index || (sortable(f) && !f.unique),
    })),
    expose: exposureOf(t),
  }));
}

/** A field with absent options left out and keys in one fixed order. */
function lockField(f: LockField): LockField {
  return {
    name: f.name,
    type: f.type,
    ...(f.currency !== undefined ? { currency: f.currency } : {}),
    ...(f.choices !== undefined ? { choices: [...f.choices] } : {}),
    ...(f.ref !== undefined ? { ref: f.ref } : {}),
    ...(f.onDelete !== undefined ? { onDelete: f.onDelete } : {}),
    required: f.required,
    unique: f.unique,
    index: f.index,
  };
}

/* ------------------------------------------------------------------ */
/* Reading, writing, replaying                                         */
/* ------------------------------------------------------------------ */

const NAME = /^[a-z][a-z0-9]*$/;
const TYPES: ReadonlySet<string> = new Set(DATA_TYPES);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** JSON with every object's keys sorted — the bytes the digest covers. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** The text a lock's digest is computed over. */
export const canonicalSteps = (steps: readonly LockStep[]): string => canonical(steps);

/** The lock file's bytes: stable key order, two-space indent, one final newline. */
export function serialiseLock(steps: readonly LockStep[], digest: (text: string) => string): string {
  const lock: DataLock = { format: LOCK_FORMAT, steps, digest: digest(canonicalSteps(steps)) };
  return `${JSON.stringify(lock, null, 2)}\n`;
}

function checkField(v: unknown): LockField {
  if (!isObject(v)) throw new LockError('a field is not an object');
  const { name, type, currency, choices, ref, onDelete, required, unique, index } = v;
  const known = new Set(['name', 'type', 'currency', 'choices', 'ref', 'onDelete', 'required', 'unique', 'index']);
  for (const k of Object.keys(v)) if (!known.has(k)) throw new LockError(`unknown field key '${k}'`);
  if (typeof name !== 'string' || !NAME.test(name)) throw new LockError('a field name is invalid');
  if (typeof type !== 'string' || !TYPES.has(type)) throw new LockError(`field '${name}' has an unknown type`);
  if (typeof required !== 'boolean' || typeof unique !== 'boolean' || typeof index !== 'boolean') {
    throw new LockError(`field '${name}' has a malformed modifier`);
  }
  if ((currency !== undefined) !== (type === 'money') || (currency !== undefined && (typeof currency !== 'string' || !/^[a-z]{3}$/.test(currency)))) {
    throw new LockError(`field '${name}' has a malformed currency`);
  }
  if ((ref !== undefined) !== (type === 'ref') || (ref !== undefined && (typeof ref !== 'string' || !NAME.test(ref)))) {
    throw new LockError(`field '${name}' has a malformed ref`);
  }
  if (onDelete !== undefined && (type !== 'ref' || typeof onDelete !== 'string' || !ON_DELETE.has(onDelete))) {
    throw new LockError(`field '${name}' has a malformed onDelete`);
  }
  if ((choices !== undefined) !== (type === 'choice')) throw new LockError(`field '${name}' has malformed choices`);
  if (choices !== undefined && (!Array.isArray(choices) || choices.length < 2
    || choices.some((c) => typeof c !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c) || c.length > 63)
    || new Set(choices).size !== choices.length)) {
    throw new LockError(`field '${name}' has malformed choices`);
  }
  return lockField(v as unknown as LockField);
}

function checkFill(v: unknown): Fill | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v))) return v;
  throw new LockError('a fill value is malformed');
}

function checkOp(v: unknown): LockOp {
  if (!isObject(v) || typeof v.op !== 'string' || typeof v.table !== 'string' || !NAME.test(v.table)) {
    throw new LockError('an op is malformed');
  }
  const keys = (...k: string[]) => {
    for (const key of Object.keys(v)) if (!['op', 'table', ...k].includes(key)) throw new LockError(`op '${v.op}' has an unknown key '${key}'`);
  };
  const name = (x: unknown) => {
    if (typeof x !== 'string' || !NAME.test(x)) throw new LockError(`op '${v.op}' names something invalid`);
    return x;
  };
  switch (v.op) {
    case 'createTable':
      keys('fields');
      if (!Array.isArray(v.fields) || v.fields.length === 0) throw new LockError('createTable has no fields');
      return { op: 'createTable', table: v.table, fields: v.fields.map(checkField) };
    case 'dropTable':
      keys();
      return { op: 'dropTable', table: v.table };
    case 'renameTable':
      keys('to');
      return { op: 'renameTable', table: v.table, to: name(v.to) };
    case 'addField':
    case 'setField': {
      keys('field', 'fill');
      const fill = checkFill(v.fill);
      return { op: v.op, table: v.table, field: checkField(v.field), ...(fill !== undefined ? { fill } : {}) };
    }
    case 'dropField':
      keys('field');
      return { op: 'dropField', table: v.table, field: name(v.field) };
    case 'renameField':
      keys('field', 'to');
      return { op: 'renameField', table: v.table, field: name(v.field), to: name(v.to) };
    case 'expose': {
      keys('read', 'private');
      if (typeof v.read !== 'string' || !(READ_LEVELS as readonly string[]).includes(v.read)) {
        throw new LockError(`expose: '${v.table}' has an unknown read level`);
      }
      const hidden = v.private;
      // Sorted and distinct, as plan writes it: one spelling per state.
      if (!Array.isArray(hidden) || hidden.some((x, i) => typeof x !== 'string' || !NAME.test(x) || (i > 0 && hidden[i - 1] >= x))) {
        throw new LockError(`expose: '${v.table}' has a malformed private list`);
      }
      return { op: 'expose', table: v.table, read: v.read as ReadLevel, private: hidden as string[] };
    }
    default:
      throw new LockError(`unknown op '${v.op}'`);
  }
}

/**
 * Read a lock's text: shape, digest, and that every step replays. Any
 * failure is a LockError — the file was edited by hand or damaged (AZ1706).
 */
export function parseLock(text: string, digest: (text: string) => string): DataLock {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new LockError('not JSON');
  }
  if (!isObject(raw) || raw.format !== LOCK_FORMAT || !Array.isArray(raw.steps) || typeof raw.digest !== 'string') {
    throw new LockError('not a format-1 lock');
  }
  for (const k of Object.keys(raw)) if (!['format', 'steps', 'digest'].includes(k)) throw new LockError(`unknown key '${k}'`);
  const steps: LockStep[] = raw.steps.map((s, i) => {
    if (!isObject(s) || s.version !== i + 1 || !Array.isArray(s.ops) || s.ops.length === 0
      || Object.keys(s).some((k) => k !== 'version' && k !== 'ops')) {
      throw new LockError(`step ${i + 1} is malformed`);
    }
    return { version: i + 1, ops: s.ops.map(checkOp) };
  });
  if (digest(canonicalSteps(steps)) !== raw.digest) throw new LockError('the digest does not match the steps');
  replay(steps);
  return { format: LOCK_FORMAT, steps, digest: raw.digest };
}

interface TableState {
  readonly fields: Map<string, LockField>;
  expose?: Exposure;
}
type Tables = Map<string, TableState>;

/** Apply one op to a schema, refusing anything that does not fit it. */
export function applyOp(tables: Tables, op: LockOp): void {
  const table = tables.get(op.table);
  const need = () => {
    if (!table) throw new LockError(`${op.op}: no table '${op.table}'`);
    return table;
  };
  const refOk = (f: LockField, extra?: string) => {
    if (f.ref !== undefined && !tables.has(f.ref) && f.ref !== extra) {
      throw new LockError(`${op.op}: '${op.table}.${f.name}' points at missing table '${f.ref}'`);
    }
  };
  switch (op.op) {
    case 'createTable': {
      if (table) throw new LockError(`createTable: '${op.table}' exists`);
      const fields = new Map<string, LockField>();
      for (const f of op.fields) {
        if (fields.has(f.name)) throw new LockError(`createTable: '${op.table}.${f.name}' twice`);
        refOk(f, op.table);
        fields.set(f.name, f);
      }
      tables.set(op.table, { fields });
      return;
    }
    case 'dropTable': {
      need();
      for (const [name, other] of tables) {
        if (name === op.table) continue;
        for (const f of other.fields.values()) {
          if (f.ref === op.table) throw new LockError(`dropTable: '${name}.${f.name}' still points at '${op.table}'`);
        }
      }
      tables.delete(op.table);
      return;
    }
    case 'renameTable': {
      const t = need();
      if (tables.has(op.to)) throw new LockError(`renameTable: '${op.to}' exists`);
      tables.delete(op.table);
      tables.set(op.to, t);
      for (const { fields } of tables.values()) {
        for (const [n, f] of fields) if (f.ref === op.table) fields.set(n, { ...f, ref: op.to });
      }
      return;
    }
    case 'addField': {
      const t = need().fields;
      if (t.has(op.field.name)) throw new LockError(`addField: '${op.table}.${op.field.name}' exists`);
      refOk(op.field);
      t.set(op.field.name, op.field);
      return;
    }
    case 'dropField': {
      const s = need();
      if (!s.fields.has(op.field)) throw new LockError(`dropField: no '${op.table}.${op.field}'`);
      // A table may pass through zero fields inside a step (a dropped table's
      // refs go before the table); a final schema never has one, because the
      // file needs a field per table (AZ1230) and must equal it (AZ1701).
      s.fields.delete(op.field);
      if (s.expose) s.expose = { ...s.expose, private: s.expose.private.filter((x) => x !== op.field) };
      return;
    }
    case 'renameField': {
      const s = need();
      const t = s.fields;
      const f = t.get(op.field);
      if (!f) throw new LockError(`renameField: no '${op.table}.${op.field}'`);
      if (t.has(op.to)) throw new LockError(`renameField: '${op.table}.${op.to}' exists`);
      t.delete(op.field);
      t.set(op.to, { ...f, name: op.to });
      // A private field stays private under its new name.
      if (s.expose?.private.includes(op.field)) {
        s.expose = { ...s.expose, private: s.expose.private.map((x) => (x === op.field ? op.to : x)).sort() };
      }
      return;
    }
    case 'expose': {
      const s = need();
      for (const f of op.private) if (!s.fields.has(f)) throw new LockError(`expose: no '${op.table}.${f}'`);
      s.expose = { read: op.read, private: [...op.private] };
      return;
    }
    case 'setField': {
      const t = need().fields;
      const was = t.get(op.field.name);
      if (!was) throw new LockError(`setField: no '${op.table}.${op.field.name}'`);
      if (was.type !== op.field.type || was.currency !== op.field.currency || was.ref !== op.field.ref) {
        throw new LockError(`setField: '${op.table}.${op.field.name}' changes its storage type`);
      }
      t.set(op.field.name, op.field);
      return;
    }
  }
}

/** The schema the steps produce, tables in creation order. */
export function replay(steps: readonly LockStep[]): LockTable[] {
  const tables: Tables = new Map();
  for (const s of steps) for (const op of s.ops) applyOp(tables, op);
  return toList(tables);
}

const toList = (tables: Tables): LockTable[] =>
  [...tables].map(([name, s]) => ({ name, fields: [...s.fields.values()], ...(s.expose ? { expose: s.expose } : {}) }));

/* ------------------------------------------------------------------ */
/* Planning a step                                                     */
/* ------------------------------------------------------------------ */

export interface LockFlags {
  /** `products=items` (table) or `products.title=name` (field) — old name to new. */
  readonly rename: readonly string[];
  /** `products` (table), `products.stock` (field), `products.status.sold` (choice value). */
  readonly drop: readonly string[];
  /** `products.sku` — the field becomes unique. */
  readonly unique: readonly string[];
  /** `products` — rows already stored become readable by more people (AZ1708). */
  readonly expose?: readonly string[];
}

export interface Change {
  /** `exposes`: no data is lost, but stored rows reach more readers (accepted with --expose). */
  readonly kind: 'safe' | 'destructive' | 'exposes';
  readonly text: string;
}

export interface PlanResult {
  readonly ops: LockOp[];
  readonly changes: Change[];
  /** Changes not allowed without a flag, or never: AZ1702–AZ1705, AZ1707, AZ1708. */
  readonly problems: { readonly code: string; readonly message: string }[];
  /** Flags that name nothing pending — a usage error, not a schema problem. */
  readonly flagErrors: string[];
}

const sameStorage = (a: LockField, b: LockField) =>
  a.type === b.type && a.currency === b.currency && a.ref === b.ref;
const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  (a ?? []).length === (b ?? []).length && (a ?? []).every((v, i) => v === (b ?? [])[i]);

/** The value an existing row gets when a field arrives or becomes required. */
function fillOf(f: LockField, spec: SpecTable | undefined): Fill | undefined {
  const d = spec?.fields.find((x) => x.name === f.name)?.default;
  if (d !== undefined) return d;
  return f.type === 'flag' ? false : undefined;
}

/** `shown to anyone, private: email` — a table's exposure, for a change line. */
const shown = (e: Exposure) => `shown to ${shownTo[e.read]}${e.private.length > 0 ? `, private: ${e.private.join(', ')}` : ''}`;

/**
 * Each way `now` shows rows already stored to more readers than `was` did
 * (`kept`: the fields both have, by their new names). Empty when nothing
 * already stored reaches anyone new — narrowing, or only new fields.
 */
function widening(table: string, was: Exposure, now: Exposure, kept: readonly string[]): string[] {
  const out: string[] = [];
  if (rank(othersOf(now)) > rank(othersOf(was))) out.push(`${table} becomes readable by ${shownTo[now.read]} (it was ${shownTo[was.read]})`);
  if (othersOf(now) === 'none') return out;
  for (const f of kept) {
    if (was.private.includes(f) && !now.private.includes(f)) out.push(`${table}.${f} is no longer private — ${shownTo[now.read]} can read it`);
  }
  return out;
}

const sameExposure = (a: Exposure | undefined, b: Exposure | undefined) => canonical(a ?? null) === canonical(b ?? null);

/**
 * The step that takes the lock's schema to the file's tables, the changes it
 * makes (safe or destructive), and what blocks it. Renames are never guessed:
 * a vanished name next to a new one is AZ1703 until a flag says which.
 */
export function plan(lockTables: readonly LockTable[], file: readonly SpecTable[], flags: LockFlags): PlanResult {
  const ops: LockOp[] = [];
  const changes: Change[] = [];
  const problems: { code: string; message: string }[] = [];
  const flagErrors: string[] = [];
  const used = new Set<string>();

  const want = storageOf(file);
  const wantByName = new Map(want.map((t) => [t.name, t]));
  const specByName = new Map(file.map((t) => [t.name, t]));
  const have = new Map(lockTables.map((t) => [t.name, t]));

  // --rename: tables first (`a=b`), then fields (`t.a=b`, t = the file's name).
  const tableRename = new Map<string, string>();
  const fieldRename = new Map<string, Map<string, string>>();
  for (const flag of flags.rename) {
    const m = /^([a-z][a-z0-9]*)(?:\.([a-z][a-z0-9]*))?=([a-z][a-z0-9]*)$/.exec(flag);
    if (!m) { flagErrors.push(`--rename ${flag}: write old=new, e.g. --rename products.title=name`); continue; }
    const [, t, f, to] = m;
    if (f === undefined) {
      if (!have.has(t) || wantByName.has(t) || !wantByName.has(to) || have.has(to)) {
        flagErrors.push(`--rename ${flag}: '${t}' must be in the lock only and '${to}' in the file only`);
        continue;
      }
      tableRename.set(t, to);
    } else {
      const map = fieldRename.get(t) ?? new Map<string, string>();
      map.set(f, to);
      fieldRename.set(t, map);
    }
    used.add(`rename:${flag}`);
  }
  const newName = (t: string) => tableRename.get(t) ?? t;
  const oldName = new Map([...have.keys()].map((t) => [newName(t), t]));
  for (const t of fieldRename.keys()) {
    if (!oldName.has(t) || !wantByName.has(t)) flagErrors.push(`--rename ${t}.…: '${t}' must be a table in both the file and the lock`);
  }
  const dropped = new Set(flags.drop);
  const uniques = new Set(flags.unique);
  const exposedFlags = new Set(flags.expose ?? []);
  // Recorded after every field op, so a private list names fields that exist.
  const exposes: LockOp[] = [];
  const exposeOp = (table: string, e: Exposure): LockOp => ({ op: 'expose', table, read: e.read, private: e.private });

  for (const [from, to] of tableRename) {
    ops.push({ op: 'renameTable', table: from, to });
    changes.push({ kind: 'destructive', text: `rename table ${from} to ${to}` });
  }

  // Tables in the lock that the file no longer has.
  const gone = [...have.keys()].filter((t) => !tableRename.has(t) && !wantByName.has(t));
  const fresh = want.filter((t) => !oldName.has(t.name));
  const dropTables: string[] = [];
  for (const t of gone) {
    if (dropped.has(t)) {
      used.add(`drop:${t}`);
      dropTables.push(t);
      changes.push({ kind: 'destructive', text: `drop table ${t} and every row in it` });
    } else if (fresh.length > 0) {
      problems.push({ code: 'AZ1703', message: `data: ${t} became ${fresh[0].name}? renames are never guessed — add --rename ${t}=${fresh[0].name}, or --drop ${t}` });
    } else {
      problems.push({ code: 'AZ1702', message: `data: dropping ${t} loses its data — add --drop ${t} to az backend schema` });
    }
  }

  // Field-level changes on tables both sides have.
  const adds: LockOp[] = [];
  const sets: LockOp[] = [];
  const drops: LockOp[] = [];
  for (const target of want) {
    const from = oldName.get(target.name);
    if (from === undefined) continue;
    const before = have.get(from)!;
    const renames = fieldRename.get(target.name) ?? new Map<string, string>();
    const spec = specByName.get(target.name);
    const beforeByName = new Map<string, LockField>();
    for (const f of before.fields) {
      const to = renames.get(f.name);
      if (to !== undefined) {
        if (target.fields.some((x) => x.name === to) && !before.fields.some((x) => x.name === to)) {
          ops.push({ op: 'renameField', table: target.name, field: f.name, to });
          changes.push({ kind: 'destructive', text: `rename ${target.name}.${f.name} to ${to}` });
          beforeByName.set(to, { ...f, name: to, ref: f.ref === undefined ? undefined : newName(f.ref) });
          continue;
        }
        flagErrors.push(`--rename ${target.name}.${f.name}=${to}: '${to}' must be new in the file`);
      }
      beforeByName.set(f.name, f.ref === undefined ? f : { ...f, ref: newName(f.ref) });
    }
    for (const [f] of renames) {
      if (!before.fields.some((x) => x.name === f)) flagErrors.push(`--rename ${target.name}.${f}: no field '${f}' in the lock`);
    }

    const added = target.fields.filter((f) => !beforeByName.has(f.name));
    for (const f of added) {
      const fill = fillOf(f, spec);
      if (f.required && fill === undefined) {
        problems.push({ code: 'AZ1705', message: `data: ${target.name}.${f.name} is now required with no default — add: default "…"` });
        continue;
      }
      adds.push({ op: 'addField', table: target.name, field: f, ...(fill !== undefined ? { fill } : {}) });
      changes.push({ kind: 'safe', text: `add ${target.name}.${f.name} ${f.type}${fill !== undefined ? ` (existing rows get ${JSON.stringify(fill)})` : ''}` });
    }

    for (const [name, was] of beforeByName) {
      const now = target.fields.find((f) => f.name === name);
      const key = `${target.name}.${name}`;
      if (!now) {
        if (dropped.has(key)) {
          used.add(`drop:${key}`);
          drops.push({ op: 'dropField', table: target.name, field: name });
          changes.push({ kind: 'destructive', text: `drop ${key} and its values` });
        } else {
          const twin = added.find((f) => f.type === was.type);
          problems.push(twin
            ? { code: 'AZ1703', message: `data: ${key} became ${twin.name}? renames are never guessed — add --rename ${key}=${twin.name}, or --drop ${key}` }
            : { code: 'AZ1702', message: `data: dropping ${key} loses its data — add --drop ${key} to az backend schema` });
        }
        continue;
      }
      if (!sameStorage(was, now)) {
        problems.push({ code: 'AZ1704', message: `data: ${key} changed type — add a new field, copy, then --drop the old one` });
        continue;
      }
      if (sameList(was.choices, now.choices) && was.required === now.required
        && was.unique === now.unique && was.index === now.index && was.onDelete === now.onDelete) continue;

      let blocked = false;
      const removed = (was.choices ?? []).filter((c) => !(now.choices ?? []).includes(c));
      for (const c of removed) {
        if (dropped.has(`${key}.${c}`)) {
          used.add(`drop:${key}.${c}`);
          changes.push({ kind: 'destructive', text: `remove '${c}' from ${key} (refused at apply time while a row holds it)` });
        } else {
          blocked = true;
          problems.push({ code: 'AZ1702', message: `data: removing '${c}' from ${key} — rows may hold it; add --drop ${key}.${c} to az backend schema` });
        }
      }
      const newChoices = (now.choices ?? []).filter((c) => !(was.choices ?? []).includes(c));
      if (newChoices.length > 0) changes.push({ kind: 'safe', text: `${key} accepts ${newChoices.join(', ')}` });

      let fill: Fill | undefined;
      if (!was.required && now.required) {
        fill = fillOf(now, spec);
        if (fill === undefined) {
          blocked = true;
          problems.push({ code: 'AZ1705', message: `data: ${key} is now required with no default — add: default "…"` });
        } else {
          changes.push({ kind: 'safe', text: `${key} becomes required (empty rows get ${JSON.stringify(fill)})` });
        }
      }
      if (was.required && !now.required) changes.push({ kind: 'safe', text: `${key} becomes optional` });
      if (!was.unique && now.unique) {
        if (uniques.has(key)) {
          used.add(`unique:${key}`);
          changes.push({ kind: 'destructive', text: `${key} becomes unique (refused at apply time while two rows share a value)` });
        } else {
          blocked = true;
          problems.push({ code: 'AZ1707', message: `data: ${key} becomes unique — rows may already share a value; add --unique ${key} to az backend schema` });
        }
      }
      if (was.unique && !now.unique) changes.push({ kind: 'safe', text: `${key} no longer unique` });
      if (was.index !== now.index) changes.push({ kind: 'safe', text: `${key} ${now.index ? 'gains' : 'loses'} its index` });
      if (was.onDelete !== now.onDelete) {
        // Rebuilt on SQLite (its foreign keys live in the table), so the step
        // waits for --confirm like every change that rewrites rows.
        changes.push({
          kind: 'destructive',
          text: `deleting a ${now.ref} row now ${now.onDelete === 'cascade' ? `deletes the ${target.name} rows that point at it` : `clears ${key}`} (the table is rebuilt on SQLite)`,
        });
      }
      if (!blocked) sets.push({ op: 'setField', table: target.name, field: now, ...(fill !== undefined ? { fill } : {}) });
    }

    // What the table shows. A lock from before exposure was recorded has no
    // older state to compare with: the first record is the baseline.
    const nowShown = target.expose!;
    const wasShown = before.expose && { ...before.expose, private: before.expose.private.map((f) => renames.get(f) ?? f).sort() };
    if (!sameExposure(wasShown, nowShown)) {
      const kept = target.fields.map((f) => f.name).filter((f) => beforeByName.has(f));
      const wider = wasShown ? widening(target.name, wasShown, nowShown, kept) : [];
      if (!wasShown) {
        changes.push({ kind: 'safe', text: `record what ${target.name} shows: ${shown(nowShown)}` });
      } else if (wider.length === 0) {
        changes.push({ kind: 'safe', text: `${target.name} is now ${shown(nowShown)}` });
      } else if (exposedFlags.has(target.name)) {
        used.add(`expose:${target.name}`);
        changes.push({ kind: 'exposes', text: `${wider.join('; ')} — rows stored under the old rules now show` });
      } else {
        problems.push({
          code: 'AZ1708',
          message: `data: ${wider.join('; ')} — rows stored under the old rules would show; add --expose ${target.name} to az backend schema`,
        });
      }
      exposes.push(exposeOp(target.name, nowShown));
    }
  }

  // New tables: a table is created once every table it points at exists, so
  // the foreign keys can be written with it. A cycle between new tables (a ⇄
  // b) is broken by adding the closing ref field after both exist.
  const exists = new Set([...have.keys()].filter((t) => !dropTables.includes(t)).map(newName));
  const pending = [...fresh];
  const deferred: LockOp[] = [];
  while (pending.length > 0) {
    let i = pending.findIndex((t) => t.fields.every((f) => f.ref === undefined || f.ref === t.name || exists.has(f.ref)));
    if (i < 0) {
      i = 0;
      const t = pending[0];
      const late = t.fields.filter((f) => f.ref !== undefined && f.ref !== t.name && !exists.has(f.ref));
      for (const f of late) deferred.push({ op: 'addField', table: t.name, field: f });
      pending[0] = { name: t.name, fields: t.fields.filter((f) => !late.includes(f)) };
    }
    const t = pending.splice(i, 1)[0];
    ops.push({ op: 'createTable', table: t.name, fields: t.fields });
    exists.add(t.name);
  }
  for (const t of fresh) {
    changes.push({ kind: 'safe', text: `create table ${t.name} (${t.fields.length} field${t.fields.length === 1 ? '' : 's'}), ${shown(t.expose!)}` });
    exposes.push(exposeOp(t.name, t.expose!));
  }

  // A dropped table's own refs to other dropped tables go first, so the
  // tables can then drop in any order.
  const dropRefs: LockOp[] = [];
  for (const t of dropTables) {
    for (const f of have.get(t)!.fields) {
      if (f.ref !== undefined && f.ref !== t && dropTables.includes(f.ref)) dropRefs.push({ op: 'dropField', table: t, field: f.name });
    }
  }

  ops.push(...deferred, ...adds, ...sets, ...drops, ...dropRefs, ...dropTables.map((t): LockOp => ({ op: 'dropTable', table: t })), ...exposes);

  for (const d of flags.drop) if (!used.has(`drop:${d}`)) flagErrors.push(`--drop ${d}: nothing by that name is being removed`);
  for (const u of flags.unique) if (!used.has(`unique:${u}`)) flagErrors.push(`--unique ${u}: that field is not becoming unique`);
  for (const x of exposedFlags) if (!used.has(`expose:${x}`)) flagErrors.push(`--expose ${x}: nothing already stored in it becomes readable by more people`);

  return { ops, changes, problems, flagErrors };
}

/* ------------------------------------------------------------------ */
/* The build-time check                                                */
/* ------------------------------------------------------------------ */

/** Order-free comparison: tables and fields by name, and what each table shows. */
function sameSchema(a: readonly LockTable[], b: readonly LockTable[]): boolean {
  if (a.length !== b.length) return false;
  const byName = new Map(b.map((t) => [t.name, t]));
  return a.every((t) => {
    const u = byName.get(t.name);
    if (!u || u.fields.length !== t.fields.length || !sameExposure(t.expose, u.expose)) return false;
    const fields = new Map(u.fields.map((f) => [f.name, f]));
    return t.fields.every((f) => {
      const g = fields.get(f.name);
      return g !== undefined && canonical(lockField(f)) === canonical(lockField(g));
    });
  });
}

/**
 * AZ1701 when the file's tables are not the lock's final schema (or there is
 * a lock and no tables, or tables and no lock); AZ1706 when the lock cannot
 * be trusted. `lockText` null means the lock file does not exist.
 */
export function checkLock(
  tables: readonly SpecTable[],
  lockText: string | null,
  names: { readonly source: string; readonly lock: string },
  digest: (text: string) => string,
  at: Pos,
): Diagnostic[] {
  if (lockText === null && tables.length === 0) return [];
  const differ = (): Diagnostic => ({
    code: 'AZ1701',
    message: `data: the file and ${names.lock} differ — run: az backend plan ${names.source}, then az backend schema ${names.source}`,
    pos: at,
    severity: 'error',
  });
  if (lockText === null) return [differ()];
  let lock: DataLock;
  try {
    lock = parseLock(lockText, digest);
  } catch (e) {
    if (!(e instanceof LockError)) throw e;
    return [{
      code: 'AZ1706',
      message: `data: ${names.lock} is edited by hand or damaged (${e.message}) — restore it from version control`,
      pos: at,
      severity: 'error',
    }];
  }
  return sameSchema(replay(lock.steps), storageOf(tables)) ? [] : [differ()];
}
