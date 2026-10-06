/**
 * @az module data
 * Purpose: `data <table>` declarations: fields, types, modifiers, allow rules → SpecTable, with every check.
 * Spec: docs/data-spec.md §4, §12
 * Exports: buildTables, DATA_TYPES, DATA_MODIFIERS, WHO, ACTIONS, TEXT_LIMITS, SpecTable, SpecField, SpecRules, Who, Action, DataType
 * Edit guide: the vocabulary is closed; a new type needs ddl (packages/backend/src/data-ddl.ts), the server's validator and a description.
 * Tests: packages/core/test/data.test.ts
 */

/**
 * Data tables, declared in words (data-spec §4).
 *
 * `data products` sits directly under `site`, beside `backend`. Each line
 * beneath it is either a field — `price money usd required` — or a rule —
 * `allow anyone read`. Nothing here is an expression: the file names WHO may
 * do WHAT from two closed lists, and the server writes the predicate
 * (PRD principle 7). A table with no `allow` line is admin-only.
 *
 * This module turns the linked statements into `SpecTable`s and reports every
 * problem the spec lists, with the fix in the message (CONVENTIONS §5).
 */

import type { Diagnostic, Pos } from './lex.ts';
import type { Arg } from './parse.ts';
import { quotable as shown } from './secrets.ts';
import { CURRENCY_DIGITS } from './currencies.ts';

export const DATA_TYPES = [
  'text', 'longtext', 'number', 'money', 'flag', 'date', 'datetime', 'email', 'url', 'choice', 'image', 'ref',
] as const;
export type DataType = (typeof DATA_TYPES)[number];

export const DATA_MODIFIERS = ['required', 'unique', 'index', 'search', 'private', 'locked', 'default'] as const;
export type DataModifier = (typeof DATA_MODIFIERS)[number];

export const WHO = ['anyone', 'signedin', 'owner'] as const;
export type Who = (typeof WHO)[number];

export const ACTIONS = ['read', 'create', 'edit', 'delete'] as const;
export type Action = (typeof ACTIONS)[number];

/** ≤60 characters each — `az explain data <type>` and the MCP catalogue. */
export const TYPE_DESCRIPTIONS: Readonly<Record<DataType, string>> = {
  text: 'One line of text, up to 200 characters',
  longtext: 'Plain paragraphs, up to 10,000 characters',
  number: 'A whole number',
  money: 'An amount in minor units; currency fixed: money usd',
  flag: 'On or off',
  date: 'A calendar day, YYYY-MM-DD',
  datetime: 'An instant, epoch milliseconds',
  email: 'An email address',
  url: 'An http(s) link',
  choice: 'One of the listed values: choice draft live',
  image: 'An uploaded image (arrives with uploads, phase D3)',
  ref: 'Belongs to a row of another table: ref categories',
};

export const MODIFIER_DESCRIPTIONS: Readonly<Record<DataModifier, string>> = {
  required: 'Must be given on create and cannot be cleared',
  unique: 'No two rows may hold the same value',
  index: 'Build an index for filtering and sorting',
  search: 'Included in the q= search; at most 4 per table',
  private: 'Readable only by the row\'s owner and admins',
  locked: 'Only admins may set or change it',
  default: 'Value on create when none is given: default 0',
};

export const WHO_DESCRIPTIONS: Readonly<Record<Who, string>> = {
  anyone: 'Every visitor, signed in or not',
  signedin: 'Any signed-in account',
  owner: 'The signed-in account that created the row',
};

export const ACTION_DESCRIPTIONS: Readonly<Record<Action, string>> = {
  read: 'List rows and read one by id',
  create: 'Add a row',
  edit: 'Change fields of an existing row',
  delete: 'Remove a row',
};

/** Fixed caps (data-spec §4.3, §16 Q10 — fixed in v1). */
export const TEXT_LIMITS = { text: 200, longtext: 10_000, email: 254, url: 2048, choice: 63 } as const;
/** `number`, `money` and `datetime` stay JavaScript-safe integers on every engine. */
export const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

/** data-spec §4.6. */
export const MAX_TABLES = 20;
export const MAX_FIELDS = 30;
export const MAX_SEARCH = 4;
const CHOICES_MIN = 2;
const CHOICES_MAX = 30;

/**
 * Names a field may not take: the system columns, the rule keyword, the
 * query operators (`?price.in=`), and the query parameters themselves — a
 * field called `sort` would make `?sort=` mean two things.
 */
export const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  'id', 'owner', 'created', 'updated', 'allow', 'mine',
  'lt', 'lte', 'gt', 'gte', 'in',
  'limit', 'after', 'sort', 'q',
]);

/** Table names that read as the account system or collide with server paths (data-spec §4.6). */
export const RESERVED_TABLES: Readonly<Record<string, string>> = {
  users: 'profiles', sessions: 'visits', tokens: 'codes', accounts: 'profiles',
  admin: 'staff', files: 'documents', auth: 'logins', data: 'records', health: 'checks',
};

/** Table and field names: lowercase letters and digits (they become SQL and JS identifiers). */
const NAME = /^[a-z][a-z0-9]*$/;
const TABLE_LEN = { min: 2, max: 30 };
const FIELD_LEN = { min: 1, max: 30 };
/** Choice values: word-shaped, so they read as words in the file and as strings in the API. */
const VALUE = /^[a-z0-9][a-z0-9-]*$/;
/** A calendar date the three engines sort as text. */
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const UNIQUE_TYPES: ReadonlySet<DataType> = new Set(['text', 'email', 'number', 'date']);
const INDEX_TYPES: ReadonlySet<DataType> = new Set(['text', 'number', 'money', 'flag', 'date', 'datetime', 'choice', 'ref', 'email']);
const SEARCH_TYPES: ReadonlySet<DataType> = new Set(['text', 'longtext', 'email']);

export interface SpecField {
  readonly name: string;
  readonly type: DataType;
  /** `money` only: the ISO 4217 code, lowercase. */
  readonly currency?: string;
  /** `choice` only: the values, in the order written. */
  readonly choices?: readonly string[];
  /** `ref` only: the table it points at. */
  readonly ref?: string;
  readonly required: boolean;
  readonly unique: boolean;
  readonly index: boolean;
  readonly search: boolean;
  readonly private: boolean;
  readonly locked: boolean;
  /** Typed like the field: text as a string, number/money/datetime as a number, flag as a boolean. */
  readonly default?: string | number | boolean;
}

/** Who may do each action; each list sorted, empty = nobody but admins. */
export type SpecRules = { readonly [A in Action]: readonly Who[] };

export interface SpecTable {
  readonly name: string;
  readonly fields: readonly SpecField[];
  readonly rules: SpecRules;
}

/** The linked shape of a `data` statement and its lines (link.ts keeps them raw). */
export interface DataWord {
  readonly args: readonly Arg[];
  readonly children: readonly DataLine[];
  readonly pos: Pos;
}
export interface DataLine {
  readonly word: string;
  readonly args: readonly Arg[];
  readonly children: readonly DataLine[];
  readonly pos: Pos;
}

const isOne = <T extends string>(list: readonly T[], v: string): v is T => (list as readonly string[]).includes(v);
const own = <T>(o: Readonly<Record<string, T>>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

/** Arguments that look like an address rather than a name (data-spec §12 AZ1249). */
const ADDRESS_KINDS: ReadonlySet<string> = new Set(['pair', 'path', 'route', 'anchor']);

export interface TableReport {
  readonly tables: SpecTable[];
  readonly diagnostics: Diagnostic[];
}

/**
 * Every `data` declaration of the site → tables, plus every diagnostic.
 * `hasBackend`: the site declares `backend` (data needs a server).
 */
export function buildTables(words: readonly DataWord[], hasBackend: boolean): TableReport {
  const diagnostics: Diagnostic[] = [];
  const err = (code: string, message: string, pos: Pos) => diagnostics.push({ code, message, pos, severity: 'error' });
  const warn = (code: string, message: string, pos: Pos) => diagnostics.push({ code, message, pos, severity: 'warning' });

  if (words.length > 0 && !hasBackend) {
    err('AZ1227', 'data: needs a backend — add at site level: backend / database sqlite / email smtp', words[0].pos);
  }
  if (words.length > MAX_TABLES) {
    err('AZ1238', `data: ${words.length} tables, max is ${MAX_TABLES} — merge or drop some`, words[MAX_TABLES].pos);
  }

  const tables: SpecTable[] = [];
  const seen = new Set<string>();
  for (const w of words) {
    const t = table(w, err, warn);
    if (!t) continue;
    if (seen.has(t.name)) {
      err('AZ1228', `data: '${t.name}' declared twice — merge them`, w.pos);
      continue;
    }
    seen.add(t.name);
    tables.push(t);
  }

  // A ref must point at a declared table (data-spec §12 AZ1235).
  for (const [i, t] of tables.entries()) {
    const w = words.find((x) => x.args[0]?.value === t.name) ?? words[i];
    for (const f of t.fields) {
      if (f.ref && !seen.has(f.ref)) {
        const line = w.children.find((c) => c.word === f.name);
        err('AZ1235', `data ${t.name}: '${f.name}' points at '${f.ref}', which is not declared — declare: data ${f.ref}`, line?.pos ?? w.pos);
      }
    }
  }
  return { tables, diagnostics };
}

type Report = (code: string, message: string, pos: Pos) => void;

function table(w: DataWord, err: Report, warn: Report): SpecTable | null {
  const nameArg = w.args[0];
  if (!nameArg || w.args.length !== 1 || nameArg.kind !== 'word') {
    err('AZ1229', 'data: name the table — write: data products', nameArg?.pos ?? w.pos);
    return null;
  }
  const name = nameArg.value;
  const suggestion = own(RESERVED_TABLES, name);
  if (suggestion) {
    err('AZ1229', `data ${name}: '${name}' is reserved — call it '${suggestion}'`, nameArg.pos);
    return null;
  }
  if (!NAME.test(name) || name.length < TABLE_LEN.min || name.length > TABLE_LEN.max) {
    err('AZ1229', `data ${shown(name)}: table names are ${TABLE_LEN.min}–${TABLE_LEN.max} lowercase letters and digits, starting with a letter`, nameArg.pos);
    return null;
  }

  const fields: SpecField[] = [];
  const rules: Record<Action, Set<Who>> = { read: new Set(), create: new Set(), edit: new Set(), delete: new Set() };
  let ruleLines = 0;
  const fieldNames = new Set<string>();

  for (const line of w.children) {
    if (line.children.length > 0) {
      err('AZ1219', `data ${name}: '${line.word}' takes no lines beneath it — write it on one line`, line.children[0].pos);
    }
    if (line.word === 'allow') {
      ruleLines++;
      rule(name, line, rules, err);
      continue;
    }
    const f = field(name, line, err);
    if (!f) continue;
    if (fieldNames.has(f.name)) {
      err('AZ1239', `data ${name}: '${f.name}' declared twice — keep one`, line.pos);
      continue;
    }
    fieldNames.add(f.name);
    fields.push(f);
  }

  if (w.children.every((c) => c.word === 'allow')) {
    err('AZ1230', `data ${name}: no fields — add one: name text required`, w.pos);
  }
  if (fields.length > MAX_FIELDS) {
    err('AZ1238', `data ${name}: ${fields.length} fields, max is ${MAX_FIELDS} — split the table`, w.pos);
  }
  const searched = fields.filter((f) => f.search).length;
  if (searched > MAX_SEARCH) {
    err('AZ1245', `data ${name}: ${searched} search fields, max is ${MAX_SEARCH} — keep the ones people search`, w.pos);
  }

  // data-spec §4.7 — the cross-rule conditions.
  const ownerRules = ACTIONS.some((a) => rules[a].has('owner'));
  if (ownerRules && rules.create.has('anyone')) {
    err('AZ1244', `data ${name}: rows made signed out have no owner, so 'owner' rules can't reach them — use: allow signedin create`, w.pos);
  }
  if (ruleLines === 0) {
    warn('AZ1246', `data ${name}: no allow lines — only admins can see it; add: allow anyone read`, w.pos);
  }
  if (rules.create.has('anyone')) {
    warn('AZ1247', `data ${name}: 'anyone create' takes rows from strangers — they are rate-limited; check them in /admin`, w.pos);
  }
  if (rules.read.has('anyone') || rules.read.has('signedin')) {
    for (const f of fields) {
      if (f.type === 'email' && !f.private) {
        const line = w.children.find((c) => c.word === f.name);
        warn('AZ1248', `data ${name}: '${f.name}' is readable by ${rules.read.has('anyone') ? 'anyone' : 'every signed-in account'} — add 'private' unless it is meant to be public`, line?.pos ?? w.pos);
      }
    }
  }

  const sorted = (s: Set<Who>) => WHO.filter((who) => s.has(who));
  return {
    name,
    fields,
    rules: { read: sorted(rules.read), create: sorted(rules.create), edit: sorted(rules.edit), delete: sorted(rules.delete) },
  };
}

/** `allow <who> <action…>` — the closed matrix of data-spec §4.7. */
function rule(table: string, line: DataLine, rules: Record<Action, Set<Who>>, err: Report): void {
  const [whoArg, ...actionArgs] = line.args;
  if (!whoArg || !isOne(WHO, whoArg.value)) {
    err('AZ1240', `data ${table}: '${shown(whoArg?.value ?? '')}' is not who — use anyone, signedin or owner`, whoArg?.pos ?? line.pos);
    return;
  }
  const who = whoArg.value;
  if (actionArgs.length === 0) {
    err('AZ1240', `data ${table}: allow ${who} what? — write: allow ${who} read`, line.pos);
    return;
  }
  for (const a of actionArgs) {
    if (!isOne(ACTIONS, a.value)) {
      err('AZ1240', `data ${table}: '${shown(a.value)}' is not an action — use read, create, edit or delete`, a.pos);
      continue;
    }
    const action = a.value;
    if (who === 'anyone' && (action === 'edit' || action === 'delete')) {
      err('AZ1241', `data ${table}: anyone can't edit or delete — use: allow owner edit delete`, a.pos);
      continue;
    }
    if (who === 'signedin' && (action === 'edit' || action === 'delete')) {
      err('AZ1242', `data ${table}: every signed-in account editing every row is unsafe — use: allow owner edit delete`, a.pos);
      continue;
    }
    if (who === 'owner' && action === 'create') {
      err('AZ1243', `data ${table}: 'owner create' — a row has no owner until it exists; use: allow signedin create`, a.pos);
      continue;
    }
    rules[action].add(who);
  }
}

/** One field line: `name type type-args… modifiers…`. */
function field(table: string, line: DataLine, err: Report): SpecField | null {
  const name = line.word;
  if (RESERVED_FIELDS.has(name)) {
    err('AZ1229', `data ${table}: '${name}' is a system or query name — pick another name`, line.pos);
    return null;
  }
  if (!NAME.test(name) || name.length < FIELD_LEN.min || name.length > FIELD_LEN.max) {
    err('AZ1229', `data ${table}: field names are ${FIELD_LEN.min}–${FIELD_LEN.max} lowercase letters and digits, starting with a letter — '${shown(name)}' is not`, line.pos);
    return null;
  }
  for (const a of line.args) {
    if (ADDRESS_KINDS.has(a.kind)) {
      err('AZ1249', `data ${table}: '${shown(a.value)}' is an address or key — data lines take names, words and numbers`, a.pos);
      return null;
    }
  }
  const [typeArg, ...rest] = line.args;
  if (!typeArg) {
    err('AZ1231', `data ${table}: '${name}' has no type — write: ${name} text`, line.pos);
    return null;
  }
  if (!isOne(DATA_TYPES, typeArg.value)) {
    err('AZ1231', `data ${table}: '${shown(typeArg.value)}' is not a type — use ${DATA_TYPES.slice(0, -1).join(', ')} or ${DATA_TYPES[DATA_TYPES.length - 1]}`, typeArg.pos);
    return null;
  }
  const type = typeArg.value;
  if (type === 'image') {
    // data-spec §15: image fields ship with uploads (D3), after the image
    // library decision (§16 Q6). Accepting the type now would compile a
    // field nothing can set.
    err('AZ1214', `data ${table}: '${name} image' is not available yet — image fields arrive with uploads`, typeArg.pos);
    return null;
  }

  const isModifier = (a: Arg | undefined) => a !== undefined && a.kind === 'word' && isOne(DATA_MODIFIERS, a.value);
  let i = 0;
  let currency: string | undefined;
  let choices: string[] | undefined;
  let ref: string | undefined;

  if (type === 'money') {
    const c = rest[0];
    if (!c || isModifier(c) || c.kind !== 'word') {
      err('AZ1232', `data ${table}: '${name} money' needs a currency — write: ${name} money usd`, typeArg.pos);
      return null;
    }
    if (!Object.hasOwn(CURRENCY_DIGITS, c.value)) {
      err('AZ1415', `data ${table}: '${shown(c.value)}' is not an ISO 4217 currency — e.g. usd, eur, gbp, jpy`, c.pos);
      return null;
    }
    currency = c.value;
    i = 1;
  } else if (type === 'choice') {
    const values: string[] = [];
    while (i < rest.length && !isModifier(rest[i])) {
      const v = rest[i];
      if (v.kind !== 'word' || !VALUE.test(v.value) || v.value.length > TEXT_LIMITS.choice) {
        err('AZ1233', `data ${table}: '${shown(v.value)}' is not a choice value — use lowercase words, e.g. draft live`, v.pos);
        return null;
      }
      if (values.includes(v.value)) {
        err('AZ1233', `data ${table}: '${v.value}' listed twice in '${name}' — list each value once`, v.pos);
        return null;
      }
      values.push(v.value);
      i++;
    }
    if (values.length < CHOICES_MIN || values.length > CHOICES_MAX) {
      err('AZ1233', values.length < CHOICES_MIN
        ? `data ${table}: '${name} choice' needs ${CHOICES_MIN} or more values — write: ${name} choice draft live`
        : `data ${table}: '${name}' has ${values.length} values, max is ${CHOICES_MAX} — use a ref to a table instead`, typeArg.pos);
      return null;
    }
    choices = values;
  } else if (type === 'ref') {
    const t = rest[0];
    if (!t || isModifier(t) || t.kind !== 'word') {
      err('AZ1234', `data ${table}: '${name} ref' needs a table — write: ${name} ref categories`, typeArg.pos);
      return null;
    }
    ref = t.value;
    i = 1;
  }

  const mods = { required: false, unique: false, index: false, search: false, private: false, locked: false };
  let def: string | number | boolean | undefined;
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (!isModifier(a)) {
      err('AZ1236', `data ${table}: '${shown(a.value)}' is not a modifier of '${name}' — use ${DATA_MODIFIERS.join(', ')}`, a.pos);
      return null;
    }
    const mod = a.value as DataModifier;
    const refuse = () => err('AZ1236', `data ${table}: '${mod}' does not apply to ${type} — remove it`, a.pos);
    switch (mod) {
      case 'required': if (type === 'flag') { refuse(); return null; } mods.required = true; break;
      case 'unique': if (!UNIQUE_TYPES.has(type)) { refuse(); return null; } mods.unique = true; break;
      case 'index': if (!INDEX_TYPES.has(type)) { refuse(); return null; } mods.index = true; break;
      case 'search': if (!SEARCH_TYPES.has(type)) { refuse(); return null; } mods.search = true; break;
      case 'private': mods.private = true; break;
      case 'locked': if (type === 'ref') { refuse(); return null; } mods.locked = true; break;
      case 'default': {
        if (type === 'ref') { refuse(); return null; }
        const v = rest[i + 1];
        const parsed = v ? defaultValue(type, v, choices) : null;
        if (parsed === null) {
          err('AZ1237', `data ${table}: ${defaultHint(name, type, choices, v)}`, v?.pos ?? a.pos);
          return null;
        }
        def = parsed;
        i++;
        break;
      }
    }
  }
  if (mods.private && mods.search) {
    err('AZ1236', `data ${table}: '${name}' is private, so it can't be searched by others — remove 'search'`, line.pos);
    return null;
  }
  // Only admins set a locked field, so a new row's value can only be its default.
  if (mods.locked && mods.required && def === undefined) {
    err('AZ1236', `data ${table}: '${name}' is locked and required, so new rows need its default — add: default …`, line.pos);
    return null;
  }

  return {
    name, type,
    ...(currency !== undefined ? { currency } : {}),
    ...(choices !== undefined ? { choices } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...mods,
    ...(def !== undefined ? { default: def } : {}),
  };
}

/** A `default` value typed like its field, or null when it does not fit. */
function defaultValue(type: DataType, a: Arg, choices: readonly string[] | undefined): string | number | boolean | null {
  const v = a.value;
  switch (type) {
    case 'text':
    case 'longtext':
      return a.kind === 'string' && textOk(v, TEXT_LIMITS[type], type === 'longtext') ? v : null;
    case 'email':
      return a.kind === 'string' && v.length <= TEXT_LIMITS.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : null;
    case 'url':
      return a.kind === 'string' && v.length <= TEXT_LIMITS.url && /^https?:\/\/[^\s]+$/i.test(v) ? v : null;
    case 'number':
    case 'money':
    case 'datetime': {
      if (a.kind !== 'number' || !/^-?\d+$/.test(v)) return null;
      const n = Number(v);
      if (!Number.isSafeInteger(n)) return null;
      if ((type === 'money' || type === 'datetime') && n < 0) return null;
      return n;
    }
    case 'flag':
      return a.kind === 'word' && (v === 'on' || v === 'off') ? v === 'on' : null;
    case 'date':
      return (a.kind === 'word' || a.kind === 'string') && isDate(v) ? v : null;
    case 'choice':
      return a.kind === 'word' && choices?.includes(v) ? v : null;
    default:
      return null;
  }
}

function defaultHint(name: string, type: DataType, choices: readonly string[] | undefined, a: Arg | undefined): string {
  const got = a ? `'${shown(a.value)}' is not` : 'needs';
  switch (type) {
    case 'text': case 'longtext': case 'email': case 'url':
      return `default ${got} a quoted ${type} — write: default "…"`;
    case 'number': case 'datetime':
      return `default ${got} a whole number — write: default 0`;
    case 'money':
      return `default ${got} an amount in minor units — write: default 1999`;
    case 'flag':
      return `default ${got} on or off — write: default on`;
    case 'date':
      return `default ${got} a date — write: default 2025-01-31`;
    case 'choice':
      return `default ${got} one of ${name}'s values — write: default ${choices?.[0] ?? 'value'}`;
    default:
      return `default ${got} valid here`;
  }
}

/** One line of text (or paragraphs for longtext), no control characters, within the cap. */
export function textOk(v: string, max: number, paragraphs: boolean): boolean {
  // Characters as the databases count them: code points, not UTF-16 units.
  if (v.trim().length === 0 || [...v].length > max) return false;
  const control = paragraphs ? /[\u0000-\u0008\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  return !control.test(v);
}

/** A real calendar day between 0001-01-01 and 9999-12-31. */
export function isDate(v: string): boolean {
  const m = DATE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= days[mo - 1];
}
