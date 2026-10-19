/**
 * @az module tool-rows
 * Purpose: a data tool's reply as the page may show it — its rows checked one by one against the declared fields, then aggregated by this code's own arithmetic.
 * Spec: docs/chat-block-spec.md §21.2.3, §21.2.4, §22.4
 * Exports: TOOL_RESULT, ToolRow, toolRows, aggregateTool, toolMinute
 * Edit guide: one row wrong refuses the whole reply; nothing here reaches the model; no Node-only API.
 * Tests: packages/backend/test/chat-tools.test.ts, packages/chat-runtime/test/runtime.test.ts
 */

/**
 * The built-in server checks its endpoints' replies here (backend
 * chat-tools.ts), and the app runtime its own functions' rows
 * (chat-runtime runtime.ts): the same row check, the same caps, the same
 * aggregates — count, sum, avg, min, max, by a text or a date field, or the
 * rows' columns — so a tool's figures are the same whoever answers it.
 * Imports only the answer checker's own modules.
 */

import { cleanText } from './chat-answer.ts';
import type { Figures, RowsResult } from './figures.ts';
import { clampText, type ToolCards, type ToolShape } from './chat-rich.ts';
import { isDay, type ToolFieldType } from './tool-shape.ts';

/** chat-block-spec §21.2.4: what one reply may be, and how long one is kept. */
export const TOOL_RESULT = {
  bytes: 256 * 1024,
  rows: 200,
  /** A text value's longest, after cleaning. */
  text: 200,
  value: 1e15,
  cacheMs: 60_000,
  cacheEntries: 200,
  /** Groups a chart shows, and a group's label; a cell (§20.2). The rows shown are the component's: a table's 20, an explore's 200. */
  groups: 24,
  label: 24,
  cell: 120,
} as const;

/** One checked row: exactly the declared fields, each value its type. */
export type ToolRow = Readonly<Record<string, string | number | boolean>>;

/** The JSON value `v` as a value of `type`, or undefined when it is not one. */
function fieldValue(type: ToolFieldType, v: unknown): string | number | boolean | undefined {
  switch (type) {
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= TOOL_RESULT.value ? (v === 0 ? 0 : v) : undefined;
    case 'bool': return typeof v === 'boolean' ? v : undefined;
    case 'date': return isDay(v) ? v : undefined;
    case 'text': {
      if (typeof v !== 'string') return undefined;
      const s = cleanText(v).trim();
      return [...s].length <= TOOL_RESULT.text ? s : undefined;
    }
  }
}

/**
 * A reply's rows, or null: a JSON array of at most 200 objects, each with
 * exactly the declared fields and each value its declared type (text
 * cleaned as the model's is and at most 200 characters, numbers finite and
 * at most 10¹⁵, dates real `YYYY-MM-DD` days). One row wrong refuses all.
 */
export function toolRows(fields: Readonly<Record<string, ToolFieldType>>, value: unknown): ToolRow[] | null {
  if (!Array.isArray(value) || value.length > TOOL_RESULT.rows) return null;
  const names = Object.keys(fields);
  const out: ToolRow[] = [];
  for (const row of value) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return null;
    const keys = Object.keys(row);
    if (keys.length !== names.length || !keys.every((k) => Object.hasOwn(fields, k))) return null;
    const checked: Record<string, string | number | boolean> = {};
    for (const n of names) {
      const v = fieldValue(fields[n], (row as Record<string, unknown>)[n]);
      if (v === undefined) return null;
      checked[n] = v;
    }
    out.push(checked);
  }
  return out;
}

/** A figure kept exact to 15 significant digits, or null past 10¹⁵ (never shown rounded past what a double holds). */
function figure(n: number | null): number | null {
  if (n === null || !Number.isFinite(n) || Math.abs(n) > TOOL_RESULT.value) return null;
  const r = Number(n.toPrecision(15));
  return r === 0 ? 0 : r;
}

/** count, or sum/avg/min/max of `field`, over `rows`; null when there is nothing to measure. */
function measure(rows: readonly ToolRow[], shape: Extract<ToolShape, { kind: 'figures' }>): number | null {
  if (shape.fn === 'count') return rows.length;
  const values = rows.map((r) => r[shape.field!] as number);
  if (values.length === 0) return shape.fn === 'sum' ? 0 : null;
  switch (shape.fn) {
    case 'sum': return values.reduce((a, b) => a + b, 0);
    case 'avg': return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min': return Math.min(...values);
    case 'max': return Math.max(...values);
  }
}

const cellOf = (type: ToolFieldType, v: string | number | boolean): string | number =>
  type === 'number' ? v as number : type === 'bool' ? (v ? 'Yes' : 'No') : clampText(String(v), TOOL_RESULT.cell);

/**
 * The figures a component shows, from checked rows, by the server's own
 * arithmetic (§21.2.3): one figure; groups by a text field (largest first,
 * at most `cap`, `more` when there were more) or a date field (the latest
 * `cap` days, oldest first); or the first `cap` rows' columns. Null when the
 * rows cannot be shown so: a figure past 10¹⁵, or two groups whose labels
 * are the same once clamped.
 */
export function aggregateTool(rows: readonly ToolRow[], shape: ToolShape, fields: Readonly<Record<string, ToolFieldType>>, cap: number): Figures | RowsResult | ToolCards | null {
  if (shape.kind === 'cards') {
    // The first rows with a title, in the endpoint's order, as cards: text values only (the row check made them text), trimmed.
    const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
    const titled = rows.filter((r) => text(r[shape.title]) !== null).slice(0, cap);
    return {
      kind: 'toolcards',
      items: titled.map((r) => ({
        title: text(r[shape.title])!, text: shape.text ? text(r[shape.text]) : null, image: shape.image ? text(r[shape.image]) : null,
      })),
    };
  }
  if (shape.kind === 'rows') {
    return {
      kind: 'rows',
      columns: shape.columns.map((c) => ({ label: c, type: fields[c] === 'number' ? 'number' as const : fields[c] === 'date' ? 'date' as const : 'text' as const, unit: null })),
      // `cap` rows: a table's 20, an explore's 200 (§21.3) — every row a reply may hold.
      rows: rows.slice(0, Math.min(cap, TOOL_RESULT.rows)).map((r) => shape.columns.map((c) => cellOf(fields[c], r[c]))),
    };
  }
  if (shape.by === null) {
    const v = measure(rows, shape);
    const value = figure(v);
    if (v !== null && value === null) return null;
    return { kind: 'figures', unit: null, value, groups: null, more: false, dated: false };
  }
  const by = shape.by;
  const dated = fields[by] === 'date';
  const groups = new Map<string, ToolRow[]>();
  for (const r of rows) {
    const g = String(r[by]);
    // A blank group has no label to show; it is left out, as a NULL group is from the site's tables.
    if (g.trim() === '') continue;
    const list = groups.get(g);
    if (list) list.push(r); else groups.set(g, [r]);
  }
  const out: [string, number][] = [];
  for (const [g, list] of groups) {
    const v = figure(measure(list, shape));
    if (v === null) return null;
    out.push([g, v]);
  }
  const limit = Math.min(cap, TOOL_RESULT.groups);
  let shown: [string, number][];
  if (dated) {
    out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    shown = out.slice(-limit);
  } else {
    out.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    shown = out.slice(0, limit);
  }
  const labelled = shown.map(([g, v]): [string, number] => [dated ? g : clampText(g, TOOL_RESULT.label), v]);
  if (new Set(labelled.map(([l]) => l)).size !== labelled.length) return null;
  return { kind: 'figures', unit: null, value: null, groups: labelled, more: out.length > shown.length, dated };
}

/** The minute a reply was read, as the page shows it: `YYYY-MM-DDTHH:MMZ`, UTC. */
export const toolMinute = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}Z`;
