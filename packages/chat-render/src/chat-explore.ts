/**
 * @az runtime chat-explore
 * Purpose: an answer's explore as the page checks and computes it — its closed shape and every cap, the controls' values, and the closed computations (one where, one aggregate, one grouping) as a pure function of rows, a view and the variables.
 * Spec: docs/chat-block-spec.md §21.3
 * Exports: EXPLORE_CAPS, EXPLORE_TEXT, ExploreData, ExploreColumn, ExploreCell, ExploreControl, ExploreView, ExploreWhere, ExploreOperand,
 *   ExploreFn, ExploreOp, Vars, ViewResult, validExplore, initialVars, matches, computeView, viewChart, viewTitle, controlValue,
 *   sendText, groupLabel
 * Edit guide: no DOM, no eval, no `Function`, no expression syntax — a `switch` over the closed operator and aggregate names, on
 *   numbers and days already parsed; an event that breaks any cap is refused whole, never repaired.
 * Tests: packages/chat-render/test/chat-explore.test.ts
 */

/**
 * The server read the model's explore and bound its views to the data
 * (backend chat-explore.ts); the page checks it again, because it renders —
 * a forged or damaged event must be inert — then evaluates the views here
 * every time the visitor moves a control. The evaluation is data in,
 * numbers out: a view's `where` keeps the rows whose one cell compares with
 * one operand (a variable's current value or a literal), its aggregate is
 * count, sum, avg, min or max over the kept rows (by a grouping column for a
 * chart), and every figure is held to 15 significant digits and 10¹⁵. There
 * is nothing that reads text as code anywhere on this path.
 */

import { sourceOf, validChart, type ChartData, type FigureSource } from './chat-chart.ts';
import { visitorText } from './chat-logic.ts';

/** chat-block-spec §21.3.3 — the server's EXPLORE_LIMITS (backend chat-explore.ts), held again. */
export const EXPLORE_CAPS = {
  title: 80,
  columns: 6,
  rows: 200,
  header: 40,
  cell: 24,
  controls: 4,
  views: 4,
  label: 40,
  steps: 1000,
  toggleMin: 2,
  toggleMax: 4,
  option: 24,
  choiceMin: 2,
  choiceMax: 8,
  template: 160,
  holes: 8,
  firstDay: '1900-01-01',
  lastDay: '2100-12-31',
  groups: 24,
  slices: 6,
  /** Rows a table view shows (§20.2's table). */
  shown: 20,
  value: 1e15,
} as const;

/** Fixed copy: what a view says when it has no figure to show (§21.3.7). */
export const EXPLORE_TEXT = {
  empty: 'No rows match.',
  none: 'No figures for these rows.',
  overflow: 'These figures are too large to show.',
  undrawable: 'Too few figures to draw this chart.',
  apply: 'Apply',
  /** A send form's button: the words it will ask, shown before it asks (§21.3.3). */
  ask: (q: string) => `Ask: ${q}`,
  rows: (n: number) => (n === 1 ? '1 row matches.' : `${n} rows match.`),
  shownOf: (shown: number, total: number) => `${total} rows match; the first ${shown} are shown.`,
} as const;

export type ExploreOp = '=' | '!=' | '<' | '<=' | '>' | '>=';
export type ExploreFn = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type ExploreCell = string | number | null;
export interface ExploreColumn { readonly label: string; readonly type: 'text' | 'number' | 'date'; readonly unit: string | null }

export type ExploreControl =
  | { readonly kind: 'slider'; readonly name: string; readonly label: string; readonly min: number; readonly max: number; readonly step: number; readonly value: number }
  | { readonly kind: 'date'; readonly name: string; readonly label: string; readonly min: string; readonly max: string; readonly value: string }
  | { readonly kind: 'toggle'; readonly name: string; readonly label: string; readonly options: readonly string[]; readonly value: string }
  | { readonly kind: 'field'; readonly name: string; readonly label: string; readonly type: 'number'; readonly min: number; readonly max: number; readonly value: number }
  | { readonly kind: 'field'; readonly name: string; readonly label: string; readonly type: 'choice'; readonly options: readonly string[]; readonly value: string }
  | { readonly kind: 'form'; readonly label: string; readonly action: 'apply'; readonly fields: readonly string[] }
  | { readonly kind: 'form'; readonly label: string; readonly action: 'send'; readonly fields: readonly string[]; readonly template: readonly (string | { readonly var: string })[] };

export type ExploreOperand = { readonly var: string } | { readonly text: string } | { readonly number: number } | { readonly date: string };
export interface ExploreWhere { readonly column: number; readonly op: ExploreOp; readonly value: ExploreOperand }

export type ExploreView =
  | { readonly kind: 'table'; readonly where: ExploreWhere | null }
  | { readonly kind: 'stat'; readonly label: string; readonly fn: ExploreFn; readonly column: number | null; readonly where: ExploreWhere | null; readonly unit: string | null }
  | {
    readonly kind: 'chart'; readonly chart: 'bar' | 'line' | 'area' | 'pie' | 'donut'; readonly title: string; readonly fn: ExploreFn;
    readonly column: number | null; readonly by: number; readonly where: ExploreWhere | null; readonly unit: string | null;
  };

export interface ExploreData {
  readonly title: string;
  readonly src: FigureSource;
  readonly asOf: string | null;
  readonly source: string | null;
  readonly columns: readonly ExploreColumn[];
  readonly rows: readonly (readonly ExploreCell[])[];
  readonly controls: readonly ExploreControl[];
  readonly views: readonly ExploreView[];
}

/** Each variable's current value: a number (slider, number field), a day (date) or a text (toggle, choice). */
export type Vars = ReadonlyMap<string, number | string>;

const OPS: readonly string[] = ['=', '!=', '<', '<=', '>', '>='];
const FNS: readonly string[] = ['count', 'sum', 'avg', 'min', 'max'];
const CHARTS: readonly string[] = ['bar', 'line', 'area', 'pie', 'donut'];
const VAR = /^[a-z][a-z0-9]{0,15}$/;
const CURRENCY = /^[a-z]{3}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
/** Code points, as every other page check counts a label (chat-chart.ts). */
const points = (s: string) => [...s].length;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && points(v) <= max;
const figure = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= EXPLORE_CAPS.value;
const unitOk = (v: unknown): v is string | null => v === null || v === 'percent' || (typeof v === 'string' && CURRENCY.test(v));
/** A real `YYYY-MM-DD` day. */
export const isDay = (v: unknown): v is string => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};
const inRange = (d: string) => d >= EXPLORE_CAPS.firstDay && d <= EXPLORE_CAPS.lastDay;
const onGrid = (v: number, min: number, step: number) => {
  const k = (v - min) / step;
  return Math.abs(k - Math.round(k)) < 1e-9;
};
const unique = (list: readonly string[]) => new Set(list).size === list.length;

/** A cell of a column's type: a text category within its cap, a number within 10¹⁵, a real day — or an empty one. */
function cellOk(type: ExploreColumn['type'], v: unknown): boolean {
  if (v === null) return true;
  if (type === 'number') return figure(v);
  if (type === 'date') return isDay(v);
  return typeof v === 'string' && points(v) <= EXPLORE_CAPS.cell;
}

function controlOf(v: unknown): ExploreControl | null {
  if (!isRecord(v)) return null;
  const label = text(v.label, EXPLORE_CAPS.label) ? v.label : null;
  if (label === null) return null;
  const name = typeof v.name === 'string' && VAR.test(v.name) ? v.name : null;
  const options = (min: number, max: number): string[] | null => {
    const o = v.options;
    return Array.isArray(o) && o.length >= min && o.length <= max && o.every((x) => text(x, EXPLORE_CAPS.option)) && unique(o as string[]) ? [...o as string[]] : null;
  };
  switch (v.kind) {
    case 'slider': {
      if (!only(v, ['kind', 'name', 'label', 'min', 'max', 'step', 'value']) || name === null) return null;
      const { min, max, step, value } = v;
      if (!figure(min) || !figure(max) || !figure(step) || !figure(value) || !(min < max) || !(step > 0) || step > max - min
        || (max - min) / step > EXPLORE_CAPS.steps + 1e-9 || value < min || value > max || !onGrid(value, min, step)) return null;
      return { kind: 'slider', name, label, min, max, step, value };
    }
    case 'date': {
      if (!only(v, ['kind', 'name', 'label', 'min', 'max', 'value']) || name === null) return null;
      const { min, max, value } = v;
      if (!isDay(min) || !isDay(max) || !isDay(value) || !inRange(min) || !inRange(max) || !(min < max) || value < min || value > max) return null;
      return { kind: 'date', name, label, min, max, value };
    }
    case 'toggle': {
      if (!only(v, ['kind', 'name', 'label', 'options', 'value']) || name === null) return null;
      const o = options(EXPLORE_CAPS.toggleMin, EXPLORE_CAPS.toggleMax);
      return o && v.value === o[0] ? { kind: 'toggle', name, label, options: o, value: o[0] } : null;
    }
    case 'field': {
      if (name === null) return null;
      if (v.type === 'number') {
        if (!only(v, ['kind', 'name', 'label', 'type', 'min', 'max', 'value'])) return null;
        const { min, max, value } = v;
        return figure(min) && figure(max) && min < max && value === min ? { kind: 'field', name, label, type: 'number', min, max, value: min } : null;
      }
      if (v.type === 'choice') {
        if (!only(v, ['kind', 'name', 'label', 'type', 'options', 'value'])) return null;
        const o = options(EXPLORE_CAPS.choiceMin, EXPLORE_CAPS.choiceMax);
        return o && v.value === o[0] ? { kind: 'field', name, label, type: 'choice', options: o, value: o[0] } : null;
      }
      return null;
    }
    case 'form': {
      if (!Array.isArray(v.fields) || v.fields.length < 1 || !v.fields.every((f) => typeof f === 'string' && VAR.test(f)) || !unique(v.fields as string[])) return null;
      const fields = [...v.fields as string[]];
      if (v.action === 'apply') return only(v, ['kind', 'label', 'action', 'fields']) ? { kind: 'form', label, action: 'apply', fields } : null;
      if (v.action !== 'send' || !only(v, ['kind', 'label', 'action', 'fields', 'template']) || !Array.isArray(v.template)) return null;
      const template: (string | { var: string })[] = [];
      let holes = 0;
      let length = 0;
      for (const p of v.template) {
        if (typeof p === 'string' && p !== '' && !p.includes('\n') && !p.includes('{') && !p.includes('}')) { template.push(p); length += points(p); continue; }
        if (!isRecord(p) || !only(p, ['var']) || typeof p.var !== 'string' || !fields.includes(p.var)) return null;
        template.push({ var: p.var });
        holes++;
        length += p.var.length + 2;
      }
      if (holes < 1 || holes > EXPLORE_CAPS.holes || length > EXPLORE_CAPS.template) return null;
      return { kind: 'form', label, action: 'send', fields, template };
    }
    default:
      return null;
  }
}

/** The variables a view may read, with their types: every control's but a send form's fields (they only ever ask). */
function readable(controls: readonly ExploreControl[]): Map<string, ExploreColumn['type']> {
  const sent = new Set(controls.flatMap((c) => (c.kind === 'form' && c.action === 'send' ? c.fields : [])));
  const out = new Map<string, ExploreColumn['type']>();
  for (const c of controls) {
    if (c.kind === 'form' || sent.has(c.name)) continue;
    out.set(c.name, c.kind === 'slider' || (c.kind === 'field' && c.type === 'number') ? 'number' : c.kind === 'date' ? 'date' : 'text');
  }
  return out;
}

function whereOf(v: unknown, columns: readonly ExploreColumn[], vars: ReadonlyMap<string, ExploreColumn['type']>): ExploreWhere | null | undefined {
  if (v === null) return null;
  if (!isRecord(v) || !only(v, ['column', 'op', 'value']) || !Number.isInteger(v.column) || typeof v.op !== 'string' || !OPS.includes(v.op)) return undefined;
  const column = v.column as number;
  if (column < 0 || column >= columns.length) return undefined;
  const type = columns[column].type;
  const op = v.op as ExploreOp;
  if (type === 'text' && op !== '=' && op !== '!=') return undefined;
  const o = v.value;
  if (!isRecord(o) || Object.keys(o).length !== 1) return undefined;
  if ('var' in o) return typeof o.var === 'string' && vars.get(o.var) === type ? { column, op, value: { var: o.var } } : undefined;
  if (type === 'text' && 'text' in o) return text(o.text, EXPLORE_CAPS.cell) ? { column, op, value: { text: o.text } } : undefined;
  if (type === 'number' && 'number' in o) return figure(o.number) ? { column, op, value: { number: o.number } } : undefined;
  if (type === 'date' && 'date' in o) return isDay(o.date) ? { column, op, value: { date: o.date } } : undefined;
  return undefined;
}

function viewOf(v: unknown, d: Pick<ExploreData, 'columns' | 'rows'>, vars: ReadonlyMap<string, ExploreColumn['type']>): ExploreView | null {
  if (!isRecord(v)) return null;
  const where = whereOf(v.where, d.columns, vars);
  if (where === undefined) return null;
  if (v.kind === 'table') return only(v, ['kind', 'where']) ? { kind: 'table', where } : null;
  if (typeof v.fn !== 'string' || !FNS.includes(v.fn) || !unitOk(v.unit)) return null;
  const fn = v.fn as ExploreFn;
  let column: number | null = null;
  if (fn === 'count') {
    if (v.column !== null) return null;
  } else {
    if (!Number.isInteger(v.column) || (v.column as number) < 0 || (v.column as number) >= d.columns.length || d.columns[v.column as number].type !== 'number') return null;
    column = v.column as number;
  }
  const unit = v.unit as string | null;
  if (v.kind === 'stat') {
    return only(v, ['kind', 'label', 'fn', 'column', 'where', 'unit']) && text(v.label, EXPLORE_CAPS.label) ? { kind: 'stat', label: v.label, fn, column, where, unit } : null;
  }
  if (v.kind !== 'chart' || !only(v, ['kind', 'chart', 'title', 'fn', 'column', 'by', 'where', 'unit'])) return null;
  if (typeof v.chart !== 'string' || !CHARTS.includes(v.chart) || !text(v.title, EXPLORE_CAPS.title)) return null;
  if (!Number.isInteger(v.by) || (v.by as number) < 0 || (v.by as number) >= d.columns.length) return null;
  const by = v.by as number;
  const chart = v.chart as Extract<ExploreView, { kind: 'chart' }>['chart'];
  const round = chart === 'pie' || chart === 'donut';
  // The grouping fits the chart over the whole data set (filtering only ever removes groups), and a pie's measure is never negative.
  const groups = new Set(d.rows.map((r) => r[by]).filter((g) => g !== null && g !== '')).size;
  if (groups > (round ? EXPLORE_CAPS.slices : EXPLORE_CAPS.groups) || groups < (chart === 'bar' ? 1 : 2)) return null;
  if (round && column !== null && d.rows.some((r) => typeof r[column!] === 'number' && (r[column!] as number) < 0)) return null;
  return { kind: 'chart', chart, title: v.title, fn, column, by, where, unit };
}

/**
 * The explore in an event, or null: every key known, every cap held, every
 * index in range, every type consistent — the rows' cells with their
 * columns, a `where`'s operand with its column, a variable with a control
 * of that type, each field owned by exactly one form written after it.
 */
export function validExplore(v: unknown): ExploreData | null {
  if (!isRecord(v) || !only(v, ['title', 'src', 'asOf', 'source', 'columns', 'rows', 'controls', 'views'])) return null;
  const from = sourceOf(v);
  if (!from || !text(v.title, EXPLORE_CAPS.title)) return null;
  if (!Array.isArray(v.columns) || v.columns.length < 1 || v.columns.length > EXPLORE_CAPS.columns) return null;
  const columns: ExploreColumn[] = [];
  for (const c of v.columns) {
    if (!isRecord(c) || !only(c, ['label', 'type', 'unit']) || !text(c.label, EXPLORE_CAPS.header)) return null;
    if (c.type !== 'text' && c.type !== 'number' && c.type !== 'date') return null;
    const unit = c.unit ?? null;
    if (!unitOk(unit) || (c.type !== 'number' && unit !== null)) return null;
    columns.push({ label: c.label, type: c.type, unit });
  }
  if (!unique(columns.map((c) => c.label))) return null;
  if (!Array.isArray(v.rows) || v.rows.length < 1 || v.rows.length > EXPLORE_CAPS.rows) return null;
  const rows: ExploreCell[][] = [];
  for (const r of v.rows) {
    if (!Array.isArray(r) || r.length !== columns.length || !r.every((cell, i) => cellOk(columns[i].type, cell))) return null;
    rows.push(r.map((cell) => (cell === 0 ? 0 : cell as ExploreCell)));
  }
  if (!Array.isArray(v.controls)) return null;
  const controls: ExploreControl[] = [];
  const names = new Set<string>();
  const unowned: string[] = [];
  let inputs = 0;
  for (const raw of v.controls) {
    const c = controlOf(raw);
    if (!c) return null;
    if (c.kind === 'form') {
      // A form owns exactly the fields written since the form before it.
      if (c.fields.length !== unowned.length || c.fields.some((f, i) => f !== unowned[i])) return null;
      unowned.length = 0;
    } else {
      if (names.has(c.name) || ++inputs > EXPLORE_CAPS.controls) return null;
      names.add(c.name);
      if (c.kind === 'field') unowned.push(c.name);
    }
    controls.push(c);
  }
  if (unowned.length > 0) return null;
  const vars = readable(controls);
  if (!Array.isArray(v.views) || v.views.length < 1 || v.views.length > EXPLORE_CAPS.views) return null;
  const views: ExploreView[] = [];
  for (const raw of v.views) {
    const view = viewOf(raw, { columns, rows }, vars);
    if (!view) return null;
    views.push(view);
  }
  return { title: v.title, ...from, columns, rows, controls, views };
}

/** Each variable at its written value — a restored explore starts there too (positions are never saved, O9). */
export function initialVars(d: ExploreData): Map<string, number | string> {
  const out = new Map<string, number | string>();
  for (const c of d.controls) if (c.kind !== 'form') out.set(c.name, c.value);
  return out;
}

/** The operand's value now: a variable's current value, or the literal. */
function operandValue(o: ExploreOperand, vars: Vars): number | string | undefined {
  if ('var' in o) return vars.get(o.var);
  if ('text' in o) return o.text;
  if ('number' in o) return o.number;
  return o.date;
}

/** One cell against one operand, by the closed operator; an empty cell matches nothing (SQL's rule). Days compare as their fixed-width text. */
function compare(cell: ExploreCell, op: ExploreOp, value: number | string | undefined): boolean {
  if (cell === null || value === undefined || typeof cell !== typeof value) return false;
  switch (op) {
    case '=': return cell === value;
    case '!=': return cell !== value;
    case '<': return cell < value;
    case '<=': return cell <= value;
    case '>': return cell > value;
    case '>=': return cell >= value;
  }
}

/** The rows a `where` keeps, in the data's order — all of them without one. */
export function matches(d: Pick<ExploreData, 'rows'>, where: ExploreWhere | null, vars: Vars): (readonly ExploreCell[])[] {
  if (where === null) return [...d.rows];
  const value = operandValue(where.value, vars);
  return d.rows.filter((r) => compare(r[where.column], where.op, value));
}

/** A figure held to 15 significant digits, or null past 10¹⁵ (never shown rounded past what a double holds). */
function held(n: number): number | null {
  if (!Number.isFinite(n) || Math.abs(n) > EXPLORE_CAPS.value) return null;
  const r = Number(n.toPrecision(15));
  return r === 0 ? 0 : r;
}

type Measure = { readonly ok: true; readonly value: number } | { readonly ok: false; readonly why: 'none' | 'overflow' };

/** The aggregate of `rows`, by the closed name: count, or sum/avg/min/max of a number column's values (empty cells left out). */
function measure(rows: readonly (readonly ExploreCell[])[], fn: ExploreFn, column: number | null): Measure {
  let value: number;
  if (fn === 'count') value = rows.length;
  else {
    const values: number[] = [];
    for (const r of rows) {
      const v = r[column!];
      if (typeof v === 'number') values.push(v);
    }
    if (values.length === 0) return { ok: false, why: 'none' };
    switch (fn) {
      case 'sum': value = values.reduce((a, b) => a + b, 0); break;
      case 'avg': value = values.reduce((a, b) => a + b, 0) / values.length; break;
      case 'min': value = values.reduce((a, b) => (b < a ? b : a), values[0]); break;
      case 'max': value = values.reduce((a, b) => (b > a ? b : a), values[0]); break;
    }
  }
  const h = held(value);
  return h === null ? { ok: false, why: 'overflow' } : { ok: true, value: h };
}

/** A number group's label: the plain digits, the same in every engine and never grouped or shortened. */
const NUMBER_LABEL = new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 20 });
export const groupLabel = (cell: string | number): string => (typeof cell === 'number' ? NUMBER_LABEL.format(cell) : cell);

/** What one view shows now. */
export type ViewResult =
  | { readonly kind: 'empty' }
  | { readonly kind: 'none' }
  | { readonly kind: 'overflow' }
  | { readonly kind: 'rows'; readonly rows: readonly (readonly ExploreCell[])[]; readonly total: number }
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'groups'; readonly groups: readonly (readonly [string, number])[] };

/**
 * One view over the data at the variables' current values: the kept rows
 * (a table: the first 20, and how many there were), one figure (a stat), or
 * a figure per group (a chart: text groups in the order the data first
 * names them, numbers and days ascending; an empty group value, or a group
 * whose measure has no value, is left out). No kept row is `empty`.
 */
export function computeView(d: ExploreData, view: ExploreView, vars: Vars): ViewResult {
  const kept = matches(d, view.where, vars);
  if (kept.length === 0) return { kind: 'empty' };
  if (view.kind === 'table') return { kind: 'rows', rows: kept.slice(0, EXPLORE_CAPS.shown), total: kept.length };
  if (view.kind === 'stat') {
    const m = measure(kept, view.fn, view.column);
    return m.ok ? { kind: 'value', value: m.value } : { kind: m.why };
  }
  const by = view.by;
  const order: (string | number)[] = [];
  const seen = new Set<string | number>();
  for (const r of d.rows) {
    const g = r[by];
    if (g === null || g === '' || seen.has(g)) continue;
    seen.add(g);
    order.push(g);
  }
  if (d.columns[by].type !== 'text') order.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const groups: [string, number][] = [];
  for (const g of order) {
    const members = kept.filter((r) => r[by] === g);
    if (members.length === 0) continue;
    const m = measure(members, view.fn, view.column);
    if (!m.ok) {
      if (m.why === 'overflow') return { kind: 'overflow' };
      continue;
    }
    const label = groupLabel(g);
    if (points(label) > EXPLORE_CAPS.cell) return { kind: 'overflow' };
    groups.push([label, m.value]);
  }
  return groups.length === 0 ? { kind: 'none' } : { kind: 'groups', groups };
}

/** A view's title: a stat's label, a chart's title, a table's the explore's own. */
export const viewTitle = (d: ExploreData, view: ExploreView): string => (view.kind === 'stat' ? view.label : view.kind === 'chart' ? view.title : d.title);

/** A chart view's groups as a chart the page's own check passes (chat-chart.ts validChart) — or null when it cannot be drawn so. */
export function viewChart(d: ExploreData, view: Extract<ExploreView, { kind: 'chart' }>, groups: readonly (readonly [string, number])[]): ChartData | null {
  const name = [...view.title].length > 24 ? `${[...view.title].slice(0, 23).join('').trimEnd()}…` : view.title;
  return validChart({
    kind: view.chart, title: view.title, unit: view.unit, src: d.src,
    ...(d.asOf !== null ? { asOf: d.asOf } : {}), ...(d.source !== null ? { source: d.source } : {}),
    series: [{ name, points: groups.map(([l, v]) => [l, v]) }],
  });
}

/**
 * A control's value from what its input holds, or null when it holds none
 * the control takes: a slider's number snapped to its step within its
 * bounds; a day within the date's bounds; a number field's number within
 * its bounds; one of a toggle's or a choice's options.
 */
export function controlValue(c: Exclude<ExploreControl, { kind: 'form' }>, raw: string): number | string | null {
  switch (c.kind) {
    case 'slider': {
      if (raw.trim() === '') return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      const k = Math.round((Math.min(c.max, Math.max(c.min, n)) - c.min) / c.step);
      const v = held(Math.min(c.max, c.min + k * c.step));
      return v === null ? null : v;
    }
    case 'date':
      return isDay(raw) && raw >= c.min && raw <= c.max ? raw : null;
    case 'field':
      if (c.type === 'choice') return c.options.includes(raw) ? raw : null;
      if (raw.trim() === '') return null;
      {
        const n = Number(raw);
        return Number.isFinite(n) && n >= c.min && n <= c.max ? (held(n) ?? null) : null;
      }
    case 'toggle':
      return c.options.includes(raw) ? raw : null;
  }
}

/**
 * A send form's question: its template with each hole filled by its
 * field's value (a number as `format` writes it, a choice as it is), then
 * checked as a visitor's own words are (chat-logic.ts visitorText) — the
 * exact words the button shows and `ask()` sends. Null when they would not
 * pass.
 */
export function sendText(form: Extract<ExploreControl, { kind: 'form'; action: 'send' }>, values: Vars, format: (n: number) => string): string | null {
  let out = '';
  for (const p of form.template) {
    if (typeof p === 'string') { out += p; continue; }
    const v = values.get(p.var);
    if (v === undefined) return null;
    out += typeof v === 'number' ? format(v) : v;
  }
  return visitorText(out);
}
