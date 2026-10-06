/**
 * @az module from
 * Purpose: `from <table>` in a block (data-spec §10): checks a block's mapping against the tables, builds SpecFrom.
 * Spec: docs/data-spec.md §10, §12 (AZ1260–AZ1269)
 * Exports: FromManifest, FromField, FROM_SETTINGS, FROM_EMPTY, buildFrom, fromWords
 * Edit guide: never name a word — which slot, which props, which field types come from word.json `from`.
 * Tests: packages/core/test/from.test.ts
 */

/**
 * A block's items, loaded from a data table after the page (data-spec §10).
 *
 * The link stage keeps the `from` line raw, as it keeps `data` (link.ts);
 * this stage checks it against the tables, which only exist once every
 * `data` declaration has been read. Everything a word may map, and from
 * which field types, is the word's manifest `from` entry — core decides
 * nothing about `feature` or `faq`.
 *
 * What is refused here mirrors the server's own allow-lists
 * (backend/src/server/data-query.ts), so a block can never be compiled into
 * a request the server answers 400: sort keys are `created`, `updated` or a
 * required sortable field; filters are equality on a `choice` or `flag`
 * field; private fields count only where every row read is the visitor's
 * own (`mine`, or a table only owners read) — exactly when the server opens
 * them.
 */

import type { Diagnostic, Pos } from './lex.ts';
import type { Arg } from './parse.ts';
import type { SpecFrom } from './spec-block.ts';
import type { SpecField, SpecTable } from './data.ts';
import { closest } from './suggest.ts';
import { quotable as shown } from './secrets.ts';

/** One slot prop a row may fill: which field types fit it. */
export interface FromField {
  /** The data types whose values this prop can show (data-spec §10.2). */
  readonly types: readonly string[];
  /** A mapping the block cannot render without. */
  readonly required?: boolean;
  /** The prop is the fill's first value (`item "Title"`), not a named prop. */
  readonly label?: boolean;
  /** ≤60 characters, for `az explain`. */
  readonly description: string;
}

/** A word's manifest `from` entry: the slot rows fill and what may be mapped. */
export interface FromManifest {
  /** The slot each row becomes one fill of. */
  readonly slot: string;
  /** ≤60 characters, for `az explain`. */
  readonly description: string;
  /** Rows per page: `default` when no `limit` is written, `max` the slot's cap. */
  readonly limit: { readonly default: number; readonly max: number };
  readonly map: Readonly<Record<string, FromField>>;
  /**
   * Block props `from` decides: a written value that differs has no effect
   * (AZ1265) — faq's FAQPage data is only useful pre-rendered (§10.3).
   */
  readonly props?: Readonly<Record<string, string>>;
}

/** The settings beside the mappings, each ≤60 characters (data-spec §10.1). */
export const FROM_SETTINGS: Readonly<Record<string, string>> = {
  sort: 'Row order: a field or created/updated, then asc or desc',
  limit: 'How many rows to show',
  filter: 'Only rows whose choice or flag field equals a value',
  mine: "Only the signed-in visitor's own rows",
  empty: 'What the block says when there are no rows',
};

/** The copy for no rows when the block writes no `empty`. */
export const FROM_EMPTY = 'Nothing here yet.';

/** data-spec §10.1: at most two filter lines. */
const MAX_FILTERS = 2;
/** `empty` is one sentence, not a paragraph (AZ1409 above it). */
const EMPTY_MAX_WORDS = 16;
/** The field types a filter may test — the server's equality list, minus what a file cannot write. */
const FILTERABLE: ReadonlySet<string> = new Set(['choice', 'flag']);
/** The server's sortable types (backend/src/server/data-query.ts SORTABLE). */
const SORTABLE: ReadonlySet<string> = new Set(['text', 'number', 'money', 'date', 'datetime', 'choice']);
/** `sort <field> <direction>`; ascending when none is written, as the API's. */
const SORT_DIRECTIONS: readonly string[] = ['asc', 'desc'];
/** System columns every row has (data-spec §4.4) that a block may sort by. */
const SYSTEM_SORT = ['created', 'updated'];
/**
 * Field types the data grammar does not accept yet: data.ts refuses `image`
 * until uploads ship (data-spec §15, D3), so a mapping that only an image
 * can fill is named and refused here too (AZ1214), never compiled.
 */
const DEFERRED_TYPES: ReadonlySet<string> = new Set(['image']);

/** The raw `from` line and its children, as link.ts keeps them. */
export interface FromLine {
  readonly word: string;
  readonly args: readonly Arg[];
  readonly children: readonly FromLine[];
  readonly pos: Pos;
}

export interface FromContext {
  readonly tables: readonly SpecTable[];
  /** Routes the site wraps in <Protected> (auth's site-level `protect`). */
  readonly protect: ReadonlySet<string>;
  /** The page with `auth login` — where a signed-out visitor signs in — or null. */
  readonly login: string | null;
  readonly report: (d: Diagnostic) => void;
}

const article = (word: string) => (/^[aeiou]/.test(word) ? 'an' : 'a');
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Words whose manifest takes `from`, sorted — for the message that names them. */
export function fromWords(manifests: ReadonlyMap<string, { readonly from?: FromManifest }>): string[] {
  return [...manifests.entries()].filter(([, m]) => m.from).map(([name]) => name).sort();
}

/**
 * Check one block's `from` line and build what the target needs, or null
 * when it cannot be built (every reason is reported). `route` is the page
 * the block is on — AZ1267 asks whether that page is protected.
 */
export function buildFrom(
  word: string, written: Readonly<Record<string, Arg>>, line: FromLine, spec: FromManifest,
  route: string, ctx: FromContext,
): SpecFrom | null {
  let failed = false;
  const err = (code: string, message: string, pos: Pos) => {
    failed = true;
    ctx.report({ code, message: `${word}: ${message}`, pos, severity: 'error' });
  };
  const warn = (code: string, message: string, pos: Pos) =>
    ctx.report({ code, message: `${word}: ${message}`, pos, severity: 'warning' });

  const name = line.args[0];
  if (!name || name.kind !== 'word') {
    err('AZ1205', "'from' needs a table — write: from <table>", name?.pos ?? line.pos);
    return null;
  }
  if (line.args.length > 1) {
    err('AZ1406', `'from' takes one table — remove '${shown(line.args[1].value)}'`, line.args[1].pos);
  }
  const table = ctx.tables.find((t) => t.name === name.value);
  if (!table) {
    const guess = closest(name.value, ctx.tables.map((t) => t.name));
    err('AZ1260', `from '${shown(name.value)}' — no such table; ${guess
      ? `did you mean '${guess}'?` : `declare it at site level: data ${shown(name.value)}`}`, name.pos);
    return null;
  }

  const mine = line.children.some((c) => c.word === 'mine');
  // The server opens private fields to a caller exactly when every row it
  // reads is theirs: `mine`, or a table only owners read (data-query.ts).
  const own = mine || (table.rules.read.length > 0 && table.rules.read.every((w) => w === 'owner'));
  const fieldOf = (arg: Arg): SpecField | null => {
    const f = table.fields.find((x) => x.name === arg.value);
    if (f) return f;
    const guess = closest(arg.value, table.fields.map((x) => x.name));
    err('AZ1261', `from ${table.name} — no field '${shown(arg.value)}'${guess ? `; did you mean '${guess}'?` : ''}`, arg.pos);
    return null;
  };

  const map: Record<string, string> = {};
  const types: Record<string, string> = {};
  const filter: Record<string, string> = {};
  let sort: string | null = null;
  let limit: number | null = null;
  let empty: string | null = null;
  const seen = new Set<string>();
  const once = (c: FromLine): boolean => {
    if (!seen.has(c.word)) { seen.add(c.word); return true; }
    if (c.word === 'mine') warn('AZ1203', "'mine' repeated — once is enough", c.pos);
    else err('AZ1504', `'${c.word}' set twice — keep one`, c.pos);
    return false;
  };
  const oneValue = (c: FromLine, hint: string): Arg | null => {
    if (c.children.length > 0) err('AZ1219', `'${c.word}' takes no lines beneath it`, c.children[0].pos);
    if (c.args.length === 0) { err('AZ1205', `'${c.word}' has no value — write: ${c.word} ${hint}`, c.pos); return null; }
    if (c.args.length > 1) { err('AZ1406', `'${c.word}' takes one value — remove '${shown(c.args[1].value)}'`, c.args[1].pos); return null; }
    return c.args[0];
  };

  for (const c of line.children) {
    const target = Object.hasOwn(spec.map, c.word) ? spec.map[c.word] : undefined;
    if (target) {
      if (!once(c)) continue;
      const arg = oneValue(c, '<field>');
      if (!arg) continue;
      if (target.types.every((t) => DEFERRED_TYPES.has(t))) {
        err('AZ1214', `'${c.word}' from a table is not available yet — image fields arrive with uploads (D3)`, c.pos);
        continue;
      }
      const f = fieldOf(arg);
      if (!f) continue;
      if (!target.types.includes(f.type)) {
        const fits = target.types.filter((t) => !DEFERRED_TYPES.has(t));
        err('AZ1262', `'${c.word}' needs ${article(fits[0])} ${fits.join(' or ')} field, '${f.name}' is ${f.type}`, arg.pos);
        continue;
      }
      if (f.private && !own) {
        err('AZ1266', `'${c.word}' maps a private field — it would be blank for everyone but its owner`, arg.pos);
        continue;
      }
      map[c.word] = f.name;
      types[c.word] = f.type;
      continue;
    }
    switch (c.word) {
      case 'sort': {
        // `sort created desc`: a field, then a direction. The API spells it
        // `-created`, which is not a word the lexer reads (GRAMMAR §1.4).
        if (!once(c)) break;
        if (c.children.length > 0) err('AZ1219', "'sort' takes no lines beneath it", c.children[0].pos);
        const [keyArg, dirArg, extra] = c.args;
        if (!keyArg) { err('AZ1205', "'sort' has no value — write: sort created desc", c.pos); break; }
        if (extra) { err('AZ1406', `'sort' takes a field and a direction — remove '${shown(extra.value)}'`, extra.pos); break; }
        if (dirArg && !SORT_DIRECTIONS.includes(dirArg.value)) {
          err('AZ1208', `'${shown(dirArg.value)}' is not a direction — try: ${SORT_DIRECTIONS.join(', ')}`, dirArg.pos);
          break;
        }
        const f = table.fields.find((x) => x.name === keyArg.value);
        const ok = SYSTEM_SORT.includes(keyArg.value)
          || (f !== undefined && f.required && SORTABLE.has(f.type) && (!f.private || own));
        if (!ok) {
          err('AZ1269', `sort '${shown(keyArg.value)}' is not created, updated or a required field of ${table.name}`, keyArg.pos);
          break;
        }
        sort = `${dirArg?.value === 'desc' ? '-' : ''}${keyArg.value}`;
        break;
      }
      case 'limit': {
        if (!once(c)) break;
        const arg = oneValue(c, String(spec.limit.default));
        if (!arg) break;
        if (!/^\d+$/.test(arg.value)) {
          err('AZ1407', `'${shown(arg.value)}' is not a whole number — limit takes one`, arg.pos);
          break;
        }
        const n = Number(arg.value);
        if (n < 1) err('AZ1408', `'limit ${arg.value}' is out of range — use 1 to ${spec.limit.max}`, arg.pos);
        else if (n > spec.limit.max) err('AZ1264', `limit ${n}, max is ${spec.limit.max} for ${word}`, arg.pos);
        else limit = n;
        break;
      }
      case 'filter': {
        if (c.children.length > 0) err('AZ1219', "'filter' takes no lines beneath it", c.children[0].pos);
        const [fieldArg, valueArg, extra] = c.args;
        if (!fieldArg || !valueArg) {
          err('AZ1205', "'filter' needs a field and a value — write: filter status live", c.pos);
          break;
        }
        if (extra) {
          err('AZ1406', `'filter' takes a field and one value — remove '${shown(extra.value)}'`, extra.pos);
          break;
        }
        const f = fieldOf(fieldArg);
        if (!f) break;
        if (!FILTERABLE.has(f.type)) {
          err('AZ1269', `filter '${f.name}' is not a choice or flag field of ${table.name}`, fieldArg.pos);
          break;
        }
        if (f.private && !own) {
          err('AZ1269', `filter '${f.name}' is private — only 'mine' rows can be filtered by it`, fieldArg.pos);
          break;
        }
        if (Object.hasOwn(filter, f.name)) {
          err('AZ1504', `filter '${f.name}' set twice — keep one`, c.pos);
          break;
        }
        const values = f.type === 'flag' ? ['on', 'off'] : [...(f.choices ?? [])];
        if (!values.includes(valueArg.value)) {
          err('AZ1208', `'${shown(valueArg.value)}' is not a ${f.name} — try: ${values.join(', ')}`, valueArg.pos);
          break;
        }
        if (Object.keys(filter).length === MAX_FILTERS) {
          err('AZ1213', `more than ${MAX_FILTERS} filters — keep ${MAX_FILTERS}`, c.pos);
          break;
        }
        filter[f.name] = valueArg.value;
        break;
      }
      case 'mine':
        if (!once(c)) break;
        if (c.args.length > 0) err('AZ1406', `'mine' takes no value — remove '${shown(c.args[0].value)}'`, c.args[0].pos);
        if (c.children.length > 0) err('AZ1219', "'mine' takes no lines beneath it", c.children[0].pos);
        break;
      case 'empty': {
        if (!once(c)) break;
        const arg = oneValue(c, '"Nothing here yet"');
        if (!arg) break;
        if (arg.kind !== 'string') {
          err('AZ1205', `'empty' is a sentence — write it in quotes: empty "${shown(arg.value)}"`, arg.pos);
          break;
        }
        const n = wordCount(arg.value);
        if (n > EMPTY_MAX_WORDS) warn('AZ1409', `empty is ${n} words, ${EMPTY_MAX_WORDS} is the limit — shorten it`, arg.pos);
        empty = arg.value;
        break;
      }
      default:
        err('AZ1405', `'${shown(c.word)}' is not a from setting — use ${[...Object.keys(spec.map), ...Object.keys(FROM_SETTINGS)].join(', ')}`, c.pos);
    }
  }

  for (const [key, f] of Object.entries(spec.map)) {
    if (f.required && !seen.has(key)) err('AZ1207', `from ${table.name} needs '${key}' — add: ${key} <field>`, line.pos);
  }

  // Who reads it decides what a visitor sees (data-spec §10.3).
  if (table.rules.read.length === 0) {
    err('AZ1267', `no allow line lets the site read '${table.name}' — add: allow anyone read`, name.pos);
  } else if (!table.rules.read.includes('anyone') && !mine && !ctx.protect.has(route)) {
    warn('AZ1267', `signed-out visitors can't read '${table.name}' — protect this page or add: allow anyone read`, name.pos);
  }

  for (const [prop, value] of Object.entries(spec.props ?? {})) {
    const arg = Object.hasOwn(written, prop) ? written[prop] : undefined;
    if (arg && arg.value !== value) {
      warn('AZ1265', `${prop} ${shown(arg.value)} has no effect with 'from' — rows load after the page`, arg.pos);
    }
  }

  if (failed) return null;
  const sorted = (o: Record<string, string>) =>
    Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  const label = Object.entries(spec.map).find(([, f]) => f.label)?.[0] ?? null;
  // A sign-in link only where some visitor may be refused for being signed out.
  const signin = mine || !table.rules.read.includes('anyone') ? ctx.login : null;
  return {
    table: table.name,
    slot: spec.slot,
    label,
    map: sorted(map),
    types: sorted(types),
    sort,
    limit: limit ?? spec.limit.default,
    filter: sorted(filter),
    mine,
    empty: empty ?? FROM_EMPTY,
    signin,
  };
}
