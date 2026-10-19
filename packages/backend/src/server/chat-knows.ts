/**
 * @az server chat-knows
 * Purpose: the rows a chat `knows` (chat-block-spec §8.2) — read per question as a signed-out visitor reads them, sent as untrusted data.
 * Spec: docs/chat-block-spec.md §8.2, §8.3, §6.1 (indirect injection)
 * Exports: KNOWS_LIMITS, KnowsRun, KnowsOptions, createKnows, knowsProblems, searchText, rowsSection
 * Edit guide: every read is the anonymous list's own code (parseQuery → selectList with no user → outRow with no user);
 *   only the public, non-image fields the build listed and the server's own model agree on are sent; nothing here is ever trusted text.
 * Tests: packages/backend/test/chat-knows.test.ts, scripts/backend-db-chat.mjs
 */

/**
 * A chat that `knows orders` is told, with each question, some rows of that
 * table: the rows whose `search` fields hold the visitor's words, or the
 * newest. They are read through the very code `GET /data/<t>` uses for a
 * signed-out visitor, so the table's rules apply unchanged: a private field
 * reads as NULL there and is not sent here, an owner's column never is, an
 * image never is.
 *
 * The build refuses a table strangers can write to (AZ1253) — a row a
 * stranger wrote would be instructions to the model dressed as data — and
 * the server checks the same again before it starts (knowsProblems), so a
 * hand-edited context cannot widen what is read.
 *
 * What is sent is labelled data: one `<site-rows>` section per table, one
 * JSON object per row, with `<`, `>` and `&` escaped so no row can close its
 * section. Bounded: 20 rows, 2 000 characters a row, 12 000 a table; each
 * read cancelled by the database past the public list's deadline; cached
 * 60 s per (table, search).
 *
 * Copied into a generated server only when the site has chat and data.
 */

import { grant, LIST_DEADLINE_MS } from './data-api.ts';
import { parseQuery, selectList } from './data-query.ts';
import { outRow, type Field, type Table } from './data-values.ts';
import { QueryTimeout, type Db } from './db.ts';
import type { Database } from './env.ts';
import { clampText } from '#chat-answer/chat-rich.ts';
import type { ContextTable } from './chat.ts';

/** chat-block-spec §8.2. */
export const KNOWS_LIMITS = {
  rows: 20,
  rowChars: 2_000,
  tableChars: 12_000,
  /** The list route's own bounds on `q` (data-spec §5.1). */
  searchMin: 2,
  searchMax: 100,
  cacheMs: 60_000,
  cacheEntries: 500,
} as const;

/** The rows sections for a chat's tables and the visitor's latest words: '' when there is nothing to send. */
export type KnowsRun = (tables: readonly string[], question: string) => Promise<string>;

export interface KnowsOptions {
  readonly db: Db;
  readonly database: Database;
  /** The server's own model of every table (tables.json). */
  readonly tables: readonly Table[];
  /** The tables chats know, as the build listed them (context.json `knows`). */
  readonly known: readonly ContextTable[];
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

/**
 * Why the server must not start with this context's `knows`: a table it has
 * no model of, one a signed-out visitor cannot list, one anyone may write
 * to, or a field the build listed that is private here. Empty when all is
 * well (chat-block-spec §8.2: "re-checked at start-up").
 */
export function knowsProblems(known: readonly ContextTable[], tables: readonly Table[] | undefined): string[] {
  const out: string[] = [];
  for (const k of known) {
    const t = tables?.find((x) => x.name === k.name);
    if (!t) { out.push(`chat knows '${k.name}', which this server has no table for`); continue; }
    const g = grant(t.rules.read, null);
    if (!g.ok || g.ownerOnly) out.push(`chat knows '${k.name}', which signed-out visitors can't read`);
    if (t.rules.create.length > 0 || t.rules.edit.length > 0) out.push(`chat knows '${k.name}', which others than the site's admins can write to`);
    for (const f of k.fields) {
      const own = t.fields.find((x) => x.name === f.name);
      if (!own || own.private || own.type === 'image') out.push(`chat knows '${k.name}.${f.name}', which is not a public field here`);
    }
  }
  return out;
}

/**
 * The visitor's words as a search: whitespace runs made one space, control
 * characters gone, cut to the list route's 100 characters — or null when
 * fewer than 2 are left.
 */
export function searchText(question: string): string | null {
  const one = question.replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim();
  const cut = [...one].slice(0, KNOWS_LIMITS.searchMax).join('').trim();
  return [...cut].length >= KNOWS_LIMITS.searchMin ? cut : null;
}

/** A value as the model reads it: money in major units with its currency, a datetime as its ISO instant. */
function shown(f: Field, v: unknown, digits: number | undefined): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (f.type === 'money' && typeof v === 'number') {
    const d = digits ?? 2;
    return `${(v / 10 ** d).toFixed(d)} ${(f.currency ?? '').toUpperCase()}`.trim();
  }
  if (f.type === 'datetime' && typeof v === 'number') return new Date(v).toISOString();
  if (typeof v === 'string') return clampText(v, KNOWS_LIMITS.rowChars);
  return typeof v === 'number' || typeof v === 'boolean' ? v : null;
}

/** JSON whose `<`, `>` and `&` are escapes, so no row can write `</site-rows>`. */
const inert = (v: unknown): string => JSON.stringify(v).replace(/[<>&]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** One row within its cap: its longest text cut until the whole fits. */
function rowLine(row: Record<string, string | number | boolean | null>): string {
  let line = inert(row);
  for (let i = 0; line.length > KNOWS_LIMITS.rowChars && i < Object.keys(row).length; i++) {
    const longest = Object.entries(row).filter(([, v]) => typeof v === 'string').sort((a, b) => (b[1] as string).length - (a[1] as string).length)[0];
    if (!longest) break;
    const over = line.length - KNOWS_LIMITS.rowChars;
    row[longest[0]] = clampText(longest[1] as string, Math.max(1, (longest[1] as string).length - over - 1));
    line = inert(row);
  }
  return line.length > KNOWS_LIMITS.rowChars ? '' : line;
}

/** A table's rows as its section of the model's input; '' for none. */
export function rowsSection(table: string, lines: readonly string[]): string {
  return lines.length === 0 ? '' : `<site-rows table="${table}">\n${lines.join('\n')}\n</site-rows>`;
}

export function createKnows(o: KnowsOptions): KnowsRun {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const cache = new Map<string, { at: number; lines: string[] }>();

  /** The public fields both the build and this server agree on, in the server's order. */
  const sent = (t: Table, k: ContextTable): { field: Field; digits: number | undefined }[] =>
    t.fields.filter((f) => !f.private && f.type !== 'image' && k.fields.some((x) => x.name === f.name))
      .map((f) => ({ field: f, digits: k.fields.find((x) => x.name === f.name)?.digits }));

  async function read(t: Table, q: string | null): Promise<Record<string, unknown>[] | null> {
    const params = new URLSearchParams({ limit: String(KNOWS_LIMITS.rows), ...(q !== null ? { q } : {}) });
    const lq = parseQuery(t, params, false);
    const s = selectList(o.database, t, lq, null, false);
    try {
      const rows = await o.db.allWithin(s.sql, s.params, LIST_DEADLINE_MS);
      return rows.slice(0, lq.limit).map((r) => outRow(t, r, null));
    } catch (e) {
      if (e instanceof QueryTimeout) {
        log(`chat: a knows read ran past ${LIST_DEADLINE_MS} ms and was cancelled`);
        return null;
      }
      throw e;
    }
  }

  async function linesOf(t: Table, k: ContextTable, question: string): Promise<string[]> {
    const fields = sent(t, k);
    // The visitor's words are looked for only in the public `search` fields the list route itself searches.
    const searchable = t.fields.some((f) => f.search && !f.private);
    const q = searchable ? searchText(question) : null;
    const key = JSON.stringify([t.name, q]);
    const hit = cache.get(key);
    if (hit && now() - hit.at < KNOWS_LIMITS.cacheMs) {
      cache.delete(key);
      cache.set(key, hit);
      return hit.lines;
    }
    let rows = await read(t, q);
    // Words no row holds: the newest rows, as for a table with no search field.
    if (rows !== null && rows.length === 0 && q !== null) rows = await read(t, null);
    if (rows === null) return [];
    const lines: string[] = [];
    let size = 0;
    for (const r of rows) {
      const row: Record<string, string | number | boolean | null> = {};
      for (const { field, digits } of fields) row[field.name] = shown(field, r[field.name], digits);
      const line = rowLine(row);
      if (line === '' || size + line.length + 1 > KNOWS_LIMITS.tableChars) continue;
      size += line.length + 1;
      lines.push(line);
    }
    cache.delete(key);
    cache.set(key, { at: now(), lines });
    while (cache.size > KNOWS_LIMITS.cacheEntries) cache.delete(cache.keys().next().value as string);
    return lines;
  }

  return async (names, question) => {
    const sections: string[] = [];
    for (const name of names) {
      const t = o.tables.find((x) => x.name === name);
      const k = o.known.find((x) => x.name === name);
      // knowsProblems refused anything else at start; this is the second line.
      const g = t ? grant(t.rules.read, null) : null;
      if (!t || !k || !g?.ok || g.ownerOnly || t.rules.create.length > 0 || t.rules.edit.length > 0) continue;
      const section = rowsSection(name, await linesOf(t, k, question));
      if (section) sections.push(section);
    }
    return sections.join('\n\n');
  };
}
