/**
 * @az module chat-explore
 * Purpose: an answer's explore — one data set, its controls and its views — read from the model's lines, checked whole, and its views bound to the data's columns.
 * Spec: docs/chat-block-spec.md §21.3
 * Exports: EXPLORE_LIMITS, EXPLORE_OPS, EXPLORE_FNS, ExploreOp, ExploreFn, ExploreColumnType, ExploreColumn, ExploreCell, ExploreControl,
 *   ExploreOperand, ExploreWhere, ExploreView, ExploreViewLine, ExploreSource, RichExplore, ExploreReader, BoundExplore, readExplore,
 *   bindExplore, exploreLines, exploreColumnNames
 * Edit guide: no expression syntax — an operand is one variable, one literal or nothing; a computation is a closed name; every
 *   value the page will compare is typed here (number, day, text) and every reference resolved to a column index or a control.
 * Tests: packages/backend/test/chat-explore.test.ts
 */

/**
 * `explore` (chat-block-spec §21.3) is the one rich component a visitor
 * changes: a data set, up to four controls bound to local variables, and up
 * to four views that the page recomputes in place (overlay chat-explore.ts).
 * Every line of it sits one level under its head:
 *
 *     explore "Plan cost"
 *       columns "Plan" "Seats" "Price"
 *       row "Solo" 1 9
 *       row "Team" 10 29
 *       slider seats "Team size" 1 50 step 1 value 5
 *       toggle period "Billing" "Monthly" "Annual"
 *       field budget "Budget" number 0 500
 *       form "Find a plan" send "Which plan fits {budget} a month?"
 *       view table where Seats >= $seats
 *       view stat "Cheapest that fits" min Price where Seats >= $seats unit usd
 *       view chart bar "Price by plan" sum Price by Plan where Seats >= $seats
 *
 * The data is the model's rows (labelled AI-generated), or `from <table>
 * columns …` (the site's public rows, as an anonymous visitor pages through
 * them), or `from tool <name> … columns …` (an operator's tool). There is no
 * expression language: a `where` is one column, one of six operators and one
 * operand — a `$variable`, a string, a number or a day; an aggregate is one of
 * five names. A view naming a column, a variable or a type that does not fit
 * is dropped by itself (counted `view`); a line the forms do not have drops
 * the whole explore.
 *
 * Part of the answer checker package (packages/chat-answer); imports only its siblings.
 */

import type { LineToken } from './chat-answer.ts';
import { isDay } from './tool-shape.ts';

/** chat-block-spec §21.3.3. The page holds the same (overlay chat-explore.ts EXPLORE_CAPS). */
export const EXPLORE_LIMITS = {
  title: 80,
  columns: 6,
  rows: 200,
  /** A column's heading. */
  header: 40,
  /** A text cell: a category a view filters or groups by — a chart label's length (§20.2). */
  cell: 24,
  /** Sliders, dates, toggles and fields. */
  controls: 4,
  views: 4,
  /** A variable's name: a lower-case letter, then letters and digits. */
  name: 16,
  /** A control's or a form's label, a stat's label. */
  label: 40,
  steps: 1000,
  /** A toggle's options, and their length. */
  toggleMin: 2,
  toggleMax: 4,
  option: 24,
  /** A choice field's options. */
  choiceMin: 2,
  choiceMax: 8,
  /** A form's question: its characters before the holes are filled, and its holes. */
  template: 160,
  holes: 8,
  firstDay: '1900-01-01',
  lastDay: '2100-12-31',
  /** Groups a bar, line or area chart shows; slices a pie or donut shows (§20.2). */
  groups: 24,
  slices: 6,
  /** The child lines one explore may hold: the columns, the rows, the controls, their forms and the views. */
  lines: 1 + 200 + 4 + 4 + 4,
  /** The resolved explore as the page receives it, in UTF-8 bytes — inside the answer's 48 KB. */
  bytes: 40 * 1024,
  value: 1e15,
} as const;

export const EXPLORE_OPS = ['=', '!=', '<', '<=', '>', '>='] as const;
export type ExploreOp = (typeof EXPLORE_OPS)[number];
export const EXPLORE_FNS = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type ExploreFn = (typeof EXPLORE_FNS)[number];
export type ExploreColumnType = 'text' | 'number' | 'date';
const KINDS: readonly string[] = ['bar', 'line', 'area', 'pie', 'donut'];

export interface ExploreColumn { readonly label: string; readonly type: ExploreColumnType; readonly unit: string | null }
export type ExploreCell = string | number | null;

/** A control as the page draws it; `name` is its variable. */
export type ExploreControl =
  | { readonly kind: 'slider'; readonly name: string; readonly label: string; readonly min: number; readonly max: number; readonly step: number; readonly value: number }
  | { readonly kind: 'date'; readonly name: string; readonly label: string; readonly min: string; readonly max: string; readonly value: string }
  | { readonly kind: 'toggle'; readonly name: string; readonly label: string; readonly options: readonly string[]; readonly value: string }
  | { readonly kind: 'field'; readonly name: string; readonly label: string; readonly type: 'number'; readonly min: number; readonly max: number; readonly value: number }
  | { readonly kind: 'field'; readonly name: string; readonly label: string; readonly type: 'choice'; readonly options: readonly string[]; readonly value: string }
  | { readonly kind: 'form'; readonly label: string; readonly action: 'apply'; readonly fields: readonly string[] }
  /** `template`: literal text and `{ var }` holes, each hole one of this form's own fields. */
  | { readonly kind: 'form'; readonly label: string; readonly action: 'send'; readonly fields: readonly string[]; readonly template: readonly (string | { readonly var: string })[] };

/** A `where`'s operand, typed: one variable, or one literal. */
export type ExploreOperand =
  | { readonly var: string } | { readonly text: string } | { readonly number: number } | { readonly date: string };
export interface ExploreWhere { readonly column: number; readonly op: ExploreOp; readonly value: ExploreOperand }

/** A view bound to the data: columns by index, its unit decided. */
export type ExploreView =
  | { readonly kind: 'table'; readonly where: ExploreWhere | null }
  | { readonly kind: 'stat'; readonly label: string; readonly fn: ExploreFn; readonly column: number | null; readonly where: ExploreWhere | null; readonly unit: string | null }
  | {
    readonly kind: 'chart'; readonly chart: string; readonly title: string; readonly fn: ExploreFn; readonly column: number | null;
    readonly by: number; readonly where: ExploreWhere | null; readonly unit: string | null;
  };

/** A view as the model wrote it — columns by name, the operand as written — and the canonical line it is kept as. */
export interface ExploreViewLine {
  readonly kind: 'table' | 'stat' | 'chart';
  readonly chart: string | null;
  readonly title: string | null;
  readonly fn: ExploreFn | null;
  readonly column: string | null;
  readonly by: string | null;
  /** `number`: the operand read as the answer grammar's number (chat-rich.ts parseNumber), or null when it is not one. */
  readonly where: { readonly column: string; readonly op: string; readonly operand: LineToken; readonly number: number | null } | null;
  readonly unit: string | null;
  /** The line after `view `, canonical. */
  readonly words: string;
}

/** Where the rows come from: the model's own, a site table's (the words after `from`), or a tool's (its checked request). */
export type ExploreSource<Tool> =
  | { readonly kind: 'rows'; readonly columns: readonly ExploreColumn[]; readonly rows: readonly (readonly ExploreCell[])[] }
  | { readonly kind: 'from'; readonly from: readonly string[] }
  | { readonly kind: 'tool'; readonly tool: Tool };

/** An explore as read from the model, before its rows (when they are the server's) are fetched. */
export interface RichExplore<Tool = { readonly words: string }> {
  readonly title: string;
  readonly source: ExploreSource<Tool>;
  readonly controls: readonly ExploreControl[];
  readonly views: readonly ExploreViewLine[];
}

/** The reader's own helpers (chat-rich.ts reader): its string, number and unit rules, its requests, its failure. */
export interface ExploreReader<Tool> {
  readonly bare: (t: LineToken | undefined, v?: string) => boolean;
  readonly str: (t: LineToken | undefined) => t is LineToken;
  /** A bare number of the answer grammar — or the explore goes. */
  readonly num: (t: LineToken | undefined) => number;
  /** A bare word as the answer grammar's number, or null (chat-rich.ts parseNumber). */
  readonly parseNumber: (s: string) => number | null;
  /** The parser's cleaning of every model string (chat-answer.ts cleanText). */
  readonly clean: (s: string) => string;
  /** A label within its cap in code points, cut at a grapheme boundary (chat-rich.ts clampText). */
  readonly clampText: (s: string, max: number) => string;
  /** `from …` at `i`, counted against the answer's requests. */
  readonly from: (tokens: readonly LineToken[], i: number) => string[];
  /** `from tool …` at `i`: a checked request whose rows are the declared fields named after `columns`. */
  readonly tool: (tokens: readonly LineToken[], i: number) => Tool;
  readonly isTool: (tokens: readonly LineToken[], i: number) => boolean;
  /** The column names a tool request lists. */
  readonly toolColumns: (tool: Tool) => readonly string[];
  readonly fail: (why: 'shape' | 'empty' | 'too_many' | 'number') => never;
}

const VAR = /^[a-z][a-z0-9]{0,15}$/;
const REF = /^\$([a-z][a-z0-9]{0,15})$/;
const CURRENCY = /^[a-z]{3}$/;
const quoted = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
const tokenWord = (t: LineToken): string => (t.kind === 'string' ? quoted(t.value) : t.value);
const inRange = (d: string) => d >= EXPLORE_LIMITS.firstDay && d <= EXPLORE_LIMITS.lastDay;
/** A number's position on a step grid: whole within a rounding error of the grammar's 15 digits. */
const onGrid = (v: number, min: number, step: number) => {
  const k = (v - min) / step;
  return Math.abs(k - Math.round(k)) < 1e-9;
};

/** The column names a `from <table> columns f… [sort …]` lists, or the explore goes. */
export function exploreColumnNames(words: readonly string[], fail: ExploreReader<unknown>['fail']): string[] {
  if (words[1] !== 'columns') return fail('shape');
  const names: string[] = [];
  for (const w of words.slice(2)) {
    if (w === 'sort') break;
    names.push(w);
  }
  if (names.length < 1 || names.length > EXPLORE_LIMITS.columns) fail('shape');
  return names;
}

/**
 * The explore under `head` (`explore "title"`), its child lines one level
 * down — or a failure through `r.fail`. The model's own rows are typed here:
 * a column of bare numbers is numbers, of bare days is days, of strings is
 * text (each cell at most EXPLORE_LIMITS.cell characters, clamped); any mix is
 * no explore.
 */
export function readExplore<Tool>(head: readonly LineToken[], lines: readonly (readonly LineToken[])[], r: ExploreReader<Tool>): RichExplore<Tool> {
  if (head.length !== 2) r.fail('shape');
  /** A string token as shown text: cleaned, trimmed, never empty, within `max` code points. */
  const label = (t: LineToken | undefined, max: number): string => {
    if (!r.str(t)) return r.fail('shape');
    const v = r.clean(t.value).trim();
    if (v === '') r.fail('empty');
    return r.clampText(v, max);
  };
  const title = label(head[1], EXPLORE_LIMITS.title);
  if (lines.length === 0) r.fail('empty');
  if (lines.length > EXPLORE_LIMITS.lines) r.fail('too_many');
  let i = 0;
  // The source: `columns` and its rows, or one `from …` line.
  let source: ExploreSource<Tool>;
  const first = lines[0];
  if (r.bare(first[0], 'from')) {
    if (r.isTool(first, 0)) {
      const tool = r.tool(first, 0);
      const names = r.toolColumns(tool);
      if (names.length < 1 || names.length > EXPLORE_LIMITS.columns) r.fail('shape');
      source = { kind: 'tool', tool };
    } else {
      const from = r.from(first, 0);
      exploreColumnNames(from.slice(0), r.fail);
      source = { kind: 'from', from };
    }
    i = 1;
  } else if (r.bare(first[0], 'columns')) {
    const labels = first.slice(1).map((t) => label(t, EXPLORE_LIMITS.header));
    if (labels.length < 1) r.fail('empty');
    if (labels.length > EXPLORE_LIMITS.columns) r.fail('too_many');
    if (new Set(labels).size !== labels.length) r.fail('shape');
    i = 1;
    const raw: (readonly LineToken[])[] = [];
    while (i < lines.length && r.bare(lines[i][0], 'row')) {
      if (lines[i].length - 1 !== labels.length) r.fail('shape');
      raw.push(lines[i].slice(1));
      i++;
    }
    if (raw.length < 1) r.fail('empty');
    if (raw.length > EXPLORE_LIMITS.rows) r.fail('too_many');
    const types = labels.map((_, c): ExploreColumnType => {
      const cells = raw.map((row) => row[c]);
      if (cells.every((t) => t.kind === 'string')) return 'text';
      if (cells.every((t) => t.kind === 'bare' && isDay(t.value))) return 'date';
      if (cells.every((t) => t.kind === 'bare')) return 'number';
      return r.fail('shape');
    });
    const rows = raw.map((row) => row.map((t, c): ExploreCell => {
      if (types[c] === 'number') return r.num(t);
      if (types[c] === 'date') return t.value;
      return r.clampText(r.clean(t.value).trim(), EXPLORE_LIMITS.cell);
    }));
    source = { kind: 'rows', columns: labels.map((label, c) => ({ label, type: types[c], unit: null })), rows };
  } else {
    return r.fail('shape');
  }

  // The controls, in the order written; a form owns the fields written since the form before it.
  const controls: ExploreControl[] = [];
  const names = new Set<string>();
  let inputs = 0;
  let pending: string[] = [];
  const varOf = (t: LineToken | undefined): string => {
    if (!r.bare(t) || !VAR.test(t!.value) || names.has(t!.value)) return r.fail('shape');
    names.add(t!.value);
    return t!.value;
  };
  const option = (t: LineToken | undefined): string => label(t, EXPLORE_LIMITS.option);
  const day = (t: LineToken | undefined): string => (r.bare(t) && isDay(t!.value) && inRange(t!.value) ? t!.value : r.fail('shape'));
  for (; i < lines.length && !r.bare(lines[i][0], 'view'); i++) {
    const t = lines[i];
    const word = t[0].kind === 'bare' ? t[0].value : '';
    if (word !== 'form') {
      if (++inputs > EXPLORE_LIMITS.controls) r.fail('too_many');
    }
    switch (word) {
      case 'slider': {
        const name = varOf(t[1]);
        const caption = label(t[2], EXPLORE_LIMITS.label);
        const min = r.num(t[3]);
        const max = r.num(t[4]);
        let k = 5;
        let step = 1;
        if (r.bare(t[k], 'step')) { step = r.num(t[k + 1]); k += 2; }
        let value = min;
        if (r.bare(t[k], 'value')) { value = r.num(t[k + 1]); k += 2; }
        if (k !== t.length || !(min < max) || !(step > 0) || step > max - min || (max - min) / step > EXPLORE_LIMITS.steps + 1e-9
          || value < min || value > max || !onGrid(value, min, step)) r.fail('shape');
        controls.push({ kind: 'slider', name, label: caption, min, max, step, value });
        break;
      }
      case 'date': {
        const name = varOf(t[1]);
        const caption = label(t[2], EXPLORE_LIMITS.label);
        const min = day(t[3]);
        const max = day(t[4]);
        let value = min;
        if (t.length === 7 && r.bare(t[5], 'value')) value = day(t[6]);
        else if (t.length !== 5) r.fail('shape');
        if (!(min < max) || value < min || value > max) r.fail('shape');
        controls.push({ kind: 'date', name, label: caption, min, max, value });
        break;
      }
      case 'toggle': {
        const name = varOf(t[1]);
        const caption = label(t[2], EXPLORE_LIMITS.label);
        const options = t.slice(3).map(option);
        if (options.length < EXPLORE_LIMITS.toggleMin || options.length > EXPLORE_LIMITS.toggleMax || new Set(options).size !== options.length) r.fail('shape');
        controls.push({ kind: 'toggle', name, label: caption, options, value: options[0] });
        break;
      }
      case 'field': {
        const name = varOf(t[1]);
        const caption = label(t[2], EXPLORE_LIMITS.label);
        if (r.bare(t[3], 'number')) {
          if (t.length !== 6) r.fail('shape');
          const min = r.num(t[4]);
          const max = r.num(t[5]);
          if (!(min < max)) r.fail('shape');
          controls.push({ kind: 'field', name, label: caption, type: 'number', min, max, value: min });
        } else if (r.bare(t[3], 'choice')) {
          const options = t.slice(4).map(option);
          if (options.length < EXPLORE_LIMITS.choiceMin || options.length > EXPLORE_LIMITS.choiceMax || new Set(options).size !== options.length) r.fail('shape');
          controls.push({ kind: 'field', name, label: caption, type: 'choice', options, value: options[0] });
        } else {
          r.fail('shape');
        }
        pending.push(name);
        break;
      }
      case 'form': {
        const legend = label(t[1], EXPLORE_LIMITS.label);
        if (pending.length === 0) r.fail('shape');
        const fields = pending;
        pending = [];
        if (t.length === 3 && r.bare(t[2], 'apply')) {
          controls.push({ kind: 'form', label: legend, action: 'apply', fields });
        } else if (t.length === 4 && r.bare(t[2], 'send') && r.str(t[3])) {
          controls.push({ kind: 'form', label: legend, action: 'send', fields, template: templateOf(r.clean(t[3].value).trim(), fields, r.fail) });
        } else {
          r.fail('shape');
        }
        break;
      }
      default:
        r.fail('shape');
    }
  }
  // A field changes nothing until its form is pressed: one with no form after it is no control.
  if (pending.length > 0) r.fail('shape');

  const views: ExploreViewLine[] = [];
  for (; i < lines.length; i++) {
    if (!r.bare(lines[i][0], 'view')) r.fail('shape');
    if (views.length >= EXPLORE_LIMITS.views) r.fail('too_many');
    views.push(viewLine(lines[i], r));
  }
  if (views.length === 0) r.fail('empty');
  return { title, source, controls, views };
}

/** `{name}` holes in a form's question, each one of `fields`; anything else between braces is no question. */
function templateOf(text: string, fields: readonly string[], fail: ExploreReader<unknown>['fail']): (string | { var: string })[] {
  if (text === '' || text.includes('\n') || [...text].length > EXPLORE_LIMITS.template) return fail('shape');
  const parts: (string | { var: string })[] = [];
  let literal = '';
  let holes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '}') return fail('shape');
    if (c !== '{') { literal += c; continue; }
    const end = text.indexOf('}', i + 1);
    const name = end < 0 ? '' : text.slice(i + 1, end);
    if (!VAR.test(name) || !fields.includes(name)) return fail('shape');
    if (literal !== '') parts.push(literal);
    literal = '';
    parts.push({ var: name });
    holes++;
    i = end;
  }
  if (literal !== '') parts.push(literal);
  if (holes < 1 || holes > EXPLORE_LIMITS.holes) fail('shape');
  return parts;
}

/**
 * One `view …` line as written: its words read, never bound. A view whose
 * words are not one of the three forms is kept as a view that cannot bind
 * (`words` null-shaped), so it is dropped by itself.
 */
function viewLine<Tool>(t: readonly LineToken[], r: ExploreReader<Tool>): ExploreViewLine {
  const words = t.slice(1).map(tokenWord).join(' ');
  const bad: ExploreViewLine = { kind: 'table', chart: null, title: null, fn: null, column: null, by: null, where: null, unit: null, words: '' };
  const ref = (x: LineToken | undefined): string | null => (x === undefined ? null : x.kind === 'string' ? r.clean(x.value).trim() : x.value);
  let k = 1;
  const kind = t[k]?.kind === 'bare' ? t[k].value : '';
  k++;
  let chart: string | null = null;
  let title: string | null = null;
  let fn: ExploreFn | null = null;
  let column: string | null = null;
  let by: string | null = null;
  if (kind === 'chart') {
    chart = t[k]?.kind === 'bare' && KINDS.includes(t[k].value) ? t[k].value : null;
    if (chart === null) return bad;
    k++;
  }
  if (kind === 'stat' || kind === 'chart') {
    if (!r.str(t[k])) return bad;
    const v = r.clean(t[k].value).trim();
    if (v === '') return bad;
    title = r.clampText(v, kind === 'stat' ? EXPLORE_LIMITS.label : EXPLORE_LIMITS.title);
    k++;
    const f = t[k]?.kind === 'bare' ? t[k].value : '';
    if (!(EXPLORE_FNS as readonly string[]).includes(f)) return bad;
    fn = f as ExploreFn;
    k++;
    if (fn !== 'count') {
      column = ref(t[k]);
      if (column === null) return bad;
      k++;
    }
    if (kind === 'chart') {
      if (!r.bare(t[k], 'by')) return bad;
      by = ref(t[k + 1]);
      if (by === null) return bad;
      k += 2;
    }
  } else if (kind !== 'table') {
    return bad;
  }
  let where: ExploreViewLine['where'] = null;
  if (r.bare(t[k], 'where')) {
    const c = ref(t[k + 1]);
    const op = t[k + 2];
    const operand = t[k + 3];
    if (c === null || op?.kind !== 'bare' || operand === undefined) return bad;
    // A string operand is compared with cells kept as cells are: cleaned, trimmed, clamped.
    const kept: LineToken = operand.kind === 'string' ? { kind: 'string', value: r.clampText(r.clean(operand.value).trim(), EXPLORE_LIMITS.cell) } : operand;
    where = { column: c, op: op.value, operand: kept, number: kept.kind === 'bare' ? r.parseNumber(kept.value) : null };
    k += 4;
  }
  let unit: string | null = null;
  if (r.bare(t[k], 'unit')) {
    const u = t[k + 1];
    if (kind === 'table' || u?.kind !== 'bare' || !(u.value === 'percent' || CURRENCY.test(u.value))) return bad;
    unit = u.value;
    k += 2;
  }
  // Anything after the closed form — a second operator, a parenthesis, a function — is no view.
  if (k !== t.length) return bad;
  return { kind: kind as ExploreViewLine['kind'], chart, title, fn, column, by, where, unit, words };
}

/** The explore with its views bound to `columns` and `rows`, the ones that do not bind dropped and counted. */
export interface BoundExplore { readonly views: readonly ExploreView[]; readonly lost: number }

/**
 * Each view bound: a column name to its index, the operand to the column's
 * type (a variable to a control of that type the page changes locally), the
 * aggregate to a number column, the grouping within the chart's cap over the
 * whole data set (filtering only ever removes groups), a pie's measure never
 * negative, a unit given or the measured column's own. A view that does not
 * bind is dropped by itself.
 */
export function bindExplore(columns: readonly ExploreColumn[], rows: readonly (readonly ExploreCell[])[], controls: readonly ExploreControl[], lines: readonly ExploreViewLine[]): BoundExplore {
  // The variables a view may read: every control's but a send form's fields, which only ever ask (§21.3.2).
  const sent = new Set(controls.flatMap((c) => (c.kind === 'form' && c.action === 'send' ? c.fields : [])));
  const vars = new Map<string, ExploreColumnType>();
  for (const c of controls) {
    if (c.kind === 'form' || sent.has(c.name)) continue;
    vars.set(c.name, c.kind === 'slider' || (c.kind === 'field' && c.type === 'number') ? 'number' : c.kind === 'date' ? 'date' : 'text');
  }
  const index = (name: string | null) => (name === null ? -1 : columns.findIndex((c) => c.label === name));
  const views: ExploreView[] = [];
  let lost = 0;
  for (const v of lines) {
    const bound = bindView(v, columns, rows, vars, index);
    if (bound) views.push(bound);
    else lost++;
  }
  return { views, lost };
}

function bindView(
  v: ExploreViewLine, columns: readonly ExploreColumn[], rows: readonly (readonly ExploreCell[])[],
  vars: ReadonlyMap<string, ExploreColumnType>, index: (name: string | null) => number,
): ExploreView | null {
  if (v.words === '') return null;
  let where: ExploreWhere | null = null;
  if (v.where) {
    const c = index(v.where.column);
    const op = v.where.op as ExploreOp;
    if (c < 0 || !(EXPLORE_OPS as readonly string[]).includes(op)) return null;
    const type = columns[c].type;
    // Text is a category: equal to one, or not.
    if (type === 'text' && op !== '=' && op !== '!=') return null;
    const t = v.where.operand;
    let value: ExploreOperand | null = null;
    const ref = t.kind === 'bare' ? REF.exec(t.value) : null;
    if (ref) value = vars.get(ref[1]) === type ? { var: ref[1] } : null;
    else if (type === 'text') value = t.kind === 'string' && t.value !== '' ? { text: t.value } : null;
    else if (type === 'date') value = t.kind === 'bare' && isDay(t.value) ? { date: t.value } : null;
    else value = v.where.number === null ? null : { number: v.where.number };
    if (value === null) return null;
    where = { column: c, op, value };
  }
  if (v.kind === 'table') return { kind: 'table', where };
  const fn = v.fn!;
  let column: number | null = null;
  if (fn !== 'count') {
    column = index(v.column);
    if (column < 0 || columns[column].type !== 'number') return null;
  }
  const unit = v.unit ?? (column !== null ? columns[column].unit : null);
  if (v.kind === 'stat') return { kind: 'stat', label: v.title!, fn, column, where, unit };
  const by = index(v.by);
  if (by < 0) return null;
  const round = v.chart === 'pie' || v.chart === 'donut';
  const groups = new Set(rows.map((row) => row[by]).filter((g) => g !== null && g !== '')).size;
  if (groups > (round ? EXPLORE_LIMITS.slices : EXPLORE_LIMITS.groups) || groups < (v.chart === 'bar' ? 1 : 2)) return null;
  // A pie of a measure that can be negative cannot be drawn whatever the visitor picks.
  if (round && column !== null && rows.some((row) => typeof row[column!] === 'number' && (row[column!] as number) < 0)) return null;
  return { kind: 'chart', chart: v.chart!, title: v.title!, fn, column, by, where, unit };
}

/** The explore in its canonical lines — what the answer's record holds: the model's rows, or the request; never a server row. */
export function exploreLines<Tool>(e: RichExplore<Tool>, toolWords: (t: Tool) => string): string[] {
  const out = [`explore ${quoted(e.title)}`];
  const s = e.source;
  if (s.kind === 'rows') {
    out.push(`  columns ${s.columns.map((c) => quoted(c.label)).join(' ')}`);
    for (const r of s.rows) out.push(`  row ${r.map((c, i) => (typeof c === 'number' || s.columns[i].type === 'date' ? String(c) : quoted(String(c)))).join(' ')}`);
  } else if (s.kind === 'from') {
    out.push(`  from ${s.from.join(' ')}`);
  } else {
    out.push(`  from ${toolWords(s.tool)}`);
  }
  for (const c of e.controls) {
    switch (c.kind) {
      case 'slider': out.push(`  slider ${c.name} ${quoted(c.label)} ${c.min} ${c.max} step ${c.step} value ${c.value}`); break;
      case 'date': out.push(`  date ${c.name} ${quoted(c.label)} ${c.min} ${c.max} value ${c.value}`); break;
      case 'toggle': out.push(`  toggle ${c.name} ${quoted(c.label)} ${c.options.map(quoted).join(' ')}`); break;
      case 'field': out.push(c.type === 'number'
        ? `  field ${c.name} ${quoted(c.label)} number ${c.min} ${c.max}`
        : `  field ${c.name} ${quoted(c.label)} choice ${c.options.map(quoted).join(' ')}`); break;
      case 'form': out.push(c.action === 'apply'
        ? `  form ${quoted(c.label)} apply`
        : `  form ${quoted(c.label)} send ${quoted(c.template.map((p) => (typeof p === 'string' ? p : `{${p.var}}`)).join(''))}`); break;
    }
  }
  for (const v of e.views) out.push(`  view ${v.words}`);
  return out;
}
