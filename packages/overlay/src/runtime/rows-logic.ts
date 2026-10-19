/**
 * @az runtime rows-logic
 * Purpose: the decisions of a `from` block's runtime as pure functions: its config, values, links, copy.
 * Spec: docs/data-spec.md §10.3, §13 (stored XSS, dangerous links)
 * Exports: parseRowsConfig, rowText, rowImage, attributeValue, emptyWithout, paragraphs, problemCopy, markerProp, RowsConfig
 * Edit guide: keep pure (no DOM); every decision here has a unit test; never turn a value into markup.
 * Tests: packages/overlay/test/rows.test.ts
 */

/**
 * What a `from` block's runtime (rows.ts) decides, without a DOM, so each
 * rule is tested in Node. Copied into every generated project beside it.
 * A row image's address and srcset rules are the chat renderer's
 * (chat-render row-image.ts), which a chat's image cards use too: one rule.
 * Imports only that file (#chat-render).
 */

import { safeUrl, type RowImage, type RowVariant } from '#chat-render/row-image.ts';

/** A block's `data-az-from` attribute, as the emitter wrote it (core fromShell). */
export interface RowsConfig {
  /** The table, by its name in the .az file. */
  readonly table: string;
  /** The prop that is the fill's first value; a row without it is not shown. */
  readonly label: string | null;
  /** The typed client's list query: limit, sort, mine, equality filters. */
  readonly query: Readonly<Record<string, string | number | boolean>>;
  /** Slot prop → the field whose value fills it. */
  readonly map: Readonly<Record<string, string>>;
  /** Slot prop → that field's data type (`text`, `longtext`). */
  readonly types: Readonly<Record<string, string>>;
  /** What the block says when there are no rows. */
  readonly empty: string;
}

/** A name the compiler writes: a table, a field or a prop. Anything else is not ours. */
const NAME = /^[a-z][a-z0-9]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A record of names to names, or null. */
function names(v: unknown): Record<string, string> | null {
  if (!isRecord(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!NAME.test(k) || typeof x !== 'string' || !NAME.test(x)) return null;
    out[k] = x;
  }
  return out;
}

/**
 * The config the emitter wrote, checked, or null. The attribute is the
 * build's own output, but a page can be edited after it ships: anything
 * that is not the shape the compiler writes is refused, not guessed at.
 */
export function parseRowsConfig(text: string | null): RowsConfig | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.table !== 'string' || !NAME.test(raw.table) || typeof raw.empty !== 'string') return null;
  const map = names(raw.map);
  const types = names(raw.types);
  if (!map || !types || !isRecord(raw.query)) return null;
  const label = raw.label === null ? null : typeof raw.label === 'string' && Object.hasOwn(map, raw.label) ? raw.label : undefined;
  if (label === undefined) return null;
  const query: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw.query)) {
    if (!NAME.test(k)) return null;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
    query[k] = v;
  }
  return { table: raw.table, label, query, map, types, empty: raw.empty };
}

/**
 * A row's value for a field, as text — or null when it has none. Only
 * plain values become text; an object or array a server should never send
 * for a text field is treated as absent, not stringified.
 */
export function rowText(row: unknown, field: string): string | null {
  if (!isRecord(row) || !Object.hasOwn(row, field)) return null;
  const v = row[field];
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return null;
}

const size = (n: unknown) => (typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0);

/**
 * A row's image field (data-spec §8: `{ url, width, height, variants }` or
 * null) — its URL, size and copies, or null. A copy that is not a URL and a
 * width is dropped; a server from before copies sends none. The URLs still
 * go through safeUrl where they are used.
 */
export function rowImage(row: unknown, field: string): RowImage | null {
  if (!isRecord(row) || !Object.hasOwn(row, field)) return null;
  const v = row[field];
  if (!isRecord(v) || typeof v.url !== 'string' || v.url === '') return null;
  const variants = Array.isArray(v.variants)
    ? v.variants.filter((x): x is RowVariant => isRecord(x) && typeof x.url === 'string' && size(x.width) > 0)
      .map((x) => ({ url: x.url, width: x.width }))
    : [];
  return { url: v.url, width: size(v.width), height: size(v.height), variants };
}

/**
 * A longtext value as paragraphs of lines: a blank line starts a new
 * paragraph, a single newline is a line break inside one (data-spec §4.3
 * longtext keeps the author's breaks; it is never markup).
 */
export function paragraphs(text: string): string[][] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.split('\n').map((line) => line.trimEnd()))
    .map((lines) => {
      while (lines.length > 0 && lines[0].trim() === '') lines.shift();
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
      return lines;
    })
    .filter((lines) => lines.length > 0);
}

/**
 * The one line a block shows when its rows cannot load (data-spec §10.3).
 * `rate_limited` and a network failure get their own copy, as the auth form
 * does; every other refusal is the same sentence — the reason belongs to
 * the server's logs, not to the visitor.
 */
export function problemCopy(code: string): string {
  switch (code) {
    case 'rate_limited': return 'Too many requests in a short time. Wait a moment, then try again.';
    case 'unknown': return 'This list could not load. Check the connection, then try again.';
    default: return 'This list could not load right now. Try again in a moment.';
  }
}

/** Attributes a browser follows or fetches: a row's value there must be a safe URL. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(['src', 'href', 'poster', 'action', 'formaction', 'cite', 'data']);

/**
 * A template attribute with its markers replaced by a row's values, or null
 * to drop the attribute. A URL attribute keeps only a safe URL (safeUrl), and
 * only when every marker in it has a value — a row without its image or link
 * has none, rather than the template's remainder (the page, or a base path);
 * an event handler, `style` or `srcset` never takes a row's value at all —
 * no emitter writes a marker there, and none ever should.
 */
export function attributeValue(
  name: string, template: string, valueOf: (prop: string) => string | null, base: string,
): string | null {
  const lower = name.toLowerCase();
  if (lower.startsWith('on') || lower === 'style' || lower === 'srcset') return null;
  let missing = false;
  const filled = template.replace(/\uE000([a-z][a-z0-9]*)\uE000/g, (_, prop: string) => {
    const value = valueOf(prop);
    if (value === null || value.trim() === '') missing = true;
    return value ?? '';
  });
  if (URL_ATTRIBUTES.has(lower)) return missing ? null : safeUrl(filled, base);
  return filled;
}

/**
 * Whether an element shows nothing once `attr` is dropped from it — an image
 * without its source — so the row's copy loses the element rather than keep
 * an empty box (the word lays an item without media out as its own case).
 */
export function emptyWithout(tagName: string, attr: string): boolean {
  return tagName.toLowerCase() === 'img' && attr.toLowerCase() === 'src';
}

/** The prop a text node stands for, when it is exactly one template marker. */
export function markerProp(text: string): string | null {
  const m = /^\uE000([a-z][a-z0-9]*)\uE000$/.exec(text);
  return m ? m[1] : null;
}
