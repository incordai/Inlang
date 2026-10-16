/**
 * @az server chat-rich
 * Purpose: an answer's charts, tables, stat cards, image cards and dashboards — read from the model's lines, checked and clamped, and their `from` figures filled by the server.
 * Spec: docs/chat-block-spec.md §20.2, §20.3, §20.5, §20.6, §21.2.3
 * Exports: RICH_WORDS, RichWord, RICH_LIMITS, RICH_FORMS, RichLine, RichBlock, RichChart, RichTable, RichStat, RichCard, RichCards,
 *   RichDashboard, RichTile, RichRules, RichRead, Resolved, FiguresRun, ToolRequest, ToolShape, ToolsRun, ToolAnswer, richBlock,
 *   resolveRich, clampText, parseNumber, richLines
 * Edit guide: the model's numbers are numbers or the component goes; its words never reach SQL (a `from` is resolved by
 *   chat-query.ts against the public schema) nor a URL (a `from tool` names a declared tool and typed values, called by
 *   chat-tools.ts); `src` is set here and nowhere else; an image is a build key, never a URL.
 * Tests: packages/backend/test/chat-rich.test.ts, packages/backend/test/chat-attacks.test.ts
 */

/**
 * The answer parser (chat-answer.ts) holds a component's lines until its
 * block ends and hands the five rich words here whole:
 *
 *     chart bar "Orders by status" from orders count by status
 *     chart line "Expected"
 *       point "Nov" 140
 *     table "Plans" sortable
 *       columns "Plan" "Seats"
 *       row "Team" 10
 *     stats
 *       stat "Orders" from orders count by placed month
 *       stat "Conversion" 3.2 unit percent delta 0.4
 *     cards
 *       card "Linen shirt"
 *         image i1
 *         text "Breathable."
 *         link "See it" /shop
 *     dashboard "This month"
 *       stat "Orders" from orders count
 *       chart bar "By status" from orders count by status
 *
 * Numbers the model wrote are figures it wrote: they get `src: model`, and
 * the page shows them with the "AI-generated figures" label. A `from …` is
 * a request the server answers with exact figures (resolveRich, through
 * chat-query.ts): those get `src: site` and the day they were read. Nothing
 * the model writes can set `src`. Labels and cells are clamped to their caps
 * at a grapheme boundary; a malformed number, a shape the forms do not
 * have, a link off the allow-list — the component is dropped whole.
 *
 * `from tool <name> <param> <value>… <aggregate>` (§21.2.3) asks one of the
 * operator's declared tools instead: the name must be one the server was
 * started with, each parameter declared and its value of its type and in
 * its bounds — or the component is dropped (`tool`). The request is checked
 * here, whole, before anything is called; chat-tools.ts calls it and its
 * figures get `src: tool` with the operator's label. The model never reads
 * what a tool answered: the answer's record holds the request line only.
 *
 * Copied into a generated server with chat; imports env.ts's parameter checks and types.
 */

import type { LineToken } from './chat-answer.ts';
import type { CardsResult, Figures, RowsResult } from './chat-query.ts';
import { isDay, paramValueOk, type ChatToolShape, type ToolParam } from './env.ts';

export const RICH_WORDS = ['chart', 'table', 'stats', 'cards', 'dashboard'] as const;
export type RichWord = (typeof RICH_WORDS)[number];

/** chat-block-spec §20.2. The page holds the same (overlay chat-chart.ts, chat-figures.ts). */
export const RICH_LIMITS = {
  title: 80,
  label: 24,
  series: 4,
  points: 24,
  slices: 6,
  columns: 6,
  rows: 20,
  header: 40,
  cell: 120,
  stats: 4,
  statLabel: 40,
  cards: 4,
  cardTitle: 80,
  cardText: 300,
  linkLabel: 40,
  tiles: 6,
  heavyTiles: 4,
  /** Data points across one answer. */
  answerPoints: 240,
  /** `from` requests across one answer. */
  answerQueries: 6,
  /** `from tool` calls across one answer, inside its requests (§21.2.4). */
  answerCalls: 3,
  /** Child lines one component may hold before it is too big to be one. */
  lines: 160,
  /** The largest figure. */
  value: 1e15,
} as const;

/** Each form the model is taught (chat-block-spec §20.3), beside the reader, so the two never drift. */
export const RICH_FORMS: Readonly<Record<RichWord, { readonly lines: readonly string[]; readonly about: string }>> = {
  chart: {
    lines: [
      'chart bar "A title" from orders count by status',
      'chart line "A title"',
      '  unit percent',
      '  series "A series name"',
      '    point "A label" 140',
    ],
    about: `a chart: bar, line, area, pie or donut. Best with "from" — the site counts its own data exactly (the tables are listed at the end). Your own numbers are shown labelled as AI-generated; then write points (2 to ${RICH_LIMITS.points}, at most ${RICH_LIMITS.slices} for a pie), or up to ${RICH_LIMITS.series} series of the same labels; "unit" is optional (percent, or a currency code such as usd)`,
  },
  table: {
    lines: ['table "A title" from orders columns item total sort placed desc', 'table "A title" sortable', '  columns "A heading" "Another"', '  row "A cell" 10'],
    about: `a table: "from" a table's columns (at most ${RICH_LIMITS.columns}, ${RICH_LIMITS.rows} rows), or your own columns and rows; "sortable" lets the visitor sort it`,
  },
  stats: {
    lines: ['stats', '  stat "A label" from orders count by placed month', '  stat "A label" 3.2 unit percent delta 0.4'],
    about: `1 to ${RICH_LIMITS.stats} figures with a label; "from" with a date grouping shows the latest period and its change`,
  },
  cards: {
    lines: ['cards', '  card "A title"', '    image i1', '    text "One or two sentences"', '    link "A label" /contact', 'cards from products title name text summary image photo'],
    about: `1 to ${RICH_LIMITS.cards} cards; an image only by the key of a site image listed at the end, never an address; a link only to a listed destination`,
  },
  dashboard: {
    lines: ['dashboard "A title"', '  stat "A label" from orders count', '  chart bar "A title" from orders count by status', '  card "A title"', '    text "Its text"'],
    about: `2 to ${RICH_LIMITS.tiles} stats, charts, tables or cards under one title; a chart inside one has one series`,
  },
};

/** A child line of a held component: its depth (1 or 2) and tokens. */
export interface RichLine { readonly depth: number; readonly tokens: readonly LineToken[] }

type Unit = string | null;

/** A tool's aggregate (§21.2.3): a count or a measure of a number field, by a text or date field; or columns of rows. */
export type ToolShape =
  | { readonly kind: 'figures'; readonly fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; readonly field: string | null; readonly by: string | null }
  | { readonly kind: 'rows'; readonly columns: readonly string[] };

/** A `from tool …` request, checked against the tool's declaration: what chat-tools.ts calls and aggregates. */
export interface ToolRequest {
  readonly tool: string;
  /** Each parameter's value as the JSON body carries it. */
  readonly args: Readonly<Record<string, string | number | boolean>>;
  readonly shape: ToolShape;
  /** The request in its canonical words, after `from ` — what the record holds. */
  readonly words: string;
}

export type RichChart =
  | { readonly kind: string; readonly title: string; readonly unit: Unit; readonly src: 'model'; readonly series: readonly { readonly name: string; readonly points: readonly (readonly [string, number])[] }[] }
  | { readonly kind: string; readonly title: string; readonly from: readonly string[] }
  | { readonly kind: string; readonly title: string; readonly tool: ToolRequest };
export type RichTable =
  | { readonly title: string; readonly sortable: boolean; readonly src: 'model'; readonly columns: readonly { readonly label: string; readonly type: 'text' | 'number' }[]; readonly rows: readonly (readonly (string | number)[])[] }
  | { readonly title: string; readonly sortable: boolean; readonly from: readonly string[] }
  | { readonly title: string; readonly sortable: boolean; readonly tool: ToolRequest };
export type RichStat =
  | { readonly label: string; readonly value: number; readonly unit: Unit; readonly delta?: number; readonly src: 'model' }
  | { readonly label: string; readonly from: readonly string[] }
  | { readonly label: string; readonly tool: ToolRequest };
export interface RichCard {
  readonly title: string;
  readonly text?: string;
  readonly image?: { readonly asset: string };
  readonly link?: { readonly label: string; readonly to: string };
}
export type RichCards = readonly RichCard[] | { readonly from: readonly string[] };
export type RichTile = { readonly stat: RichStat } | { readonly chart: RichChart } | { readonly table: RichTable } | { readonly card: RichCard };
export interface RichDashboard { readonly title: string; readonly tiles: readonly RichTile[] }

/** A rich component as read from the model — with `from` requests still to fill. */
export type RichBlock =
  | { readonly chart: RichChart }
  | { readonly table: RichTable }
  | { readonly stats: readonly RichStat[] }
  | { readonly cards: RichCards }
  | { readonly dashboard: RichDashboard };

/** What a chat page lets its rich components use (from context.json). */
export interface RichRules {
  readonly show: readonly string[];
  readonly destinations: readonly string[];
  /** Build image keys an image card may name. */
  readonly images: readonly string[];
  /** The operator's tools a `from tool` may name (§21.2): their shapes, never a URL or a key. None when absent. */
  readonly tools?: readonly ChatToolShape[];
}

/** One component read, or why it was dropped; how many points and requests it holds; images it lost. */
export type RichRead =
  | { readonly ok: true; readonly block: RichBlock; readonly points: number; readonly queries: number; readonly calls: number; readonly lostImages: number }
  | { readonly ok: false; readonly why: 'shape' | 'not_shown' | 'destination' | 'too_many' | 'empty' | 'number' | 'tool' };

const KINDS: ReadonlySet<string> = new Set(['bar', 'line', 'area', 'pie', 'donut']);
const CURRENCY = /^[a-z]{3}$/;
const NUMBER = /^-?(?:0|[1-9][0-9]{0,15})(?:\.[0-9]{1,15})?$/;

/**
 * A number exactly as the answer grammar writes one — digits, one optional
 * point, an optional minus; at most 15 significant digits and 10¹⁵ in size —
 * or null. `NaN`, `Infinity`, `1e9`, `0x10`, `1,000` and `12%` are not numbers.
 */
export function parseNumber(s: string): number | null {
  if (!NUMBER.test(s)) return null;
  // Significant digits: leading and trailing zeros hold no precision.
  const digits = s.replace(/^-/, '').replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  if (digits.length > 15) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > RICH_LIMITS.value) return null;
  return n === 0 ? 0 : n;
}

/** Strip and normalise as the parser does for every string (chat-answer.ts cleanText), then trim. */
type Clean = (s: string) => string;

/**
 * `s` cut to `max` user-perceived characters, ending in `…` when cut — at a
 * grapheme boundary, so an emoji or a combining mark is never split.
 */
export function clampText(s: string, max: number): string {
  const graphemes = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].map((g) => g.segment);
  if (graphemes.length <= max) return s;
  return `${graphemes.slice(0, max - 1).join('').trimEnd()}…`;
}

const quoted = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
const numberText = (n: number): string => String(n);
/** The aggregates a tool request may end with (§21.2.3) — the closed set of §20.5. */
const TOOL_FNS: ReadonlySet<string> = new Set(['count', 'sum', 'avg', 'min', 'max']);

class Drop extends Error {
  readonly why: Extract<RichRead, { ok: false }>['why'];
  constructor(why: Extract<RichRead, { ok: false }>['why']) {
    super(why);
    this.why = why;
  }
}
const fail = (why: Extract<RichRead, { ok: false }>['why']): never => { throw new Drop(why); };

interface Node { readonly tokens: readonly LineToken[]; readonly children: Node[] }

/** The held lines as a tree two levels deep, or a drop: depth 1 under the head, depth 2 under the last depth-1 line. */
function treeOf(lines: readonly RichLine[]): Node[] {
  if (lines.length > RICH_LIMITS.lines) fail('too_many');
  const top: Node[] = [];
  for (const l of lines) {
    if (l.tokens.length === 0) fail('shape');
    if (l.depth === 1) top.push({ tokens: l.tokens, children: [] });
    else if (l.depth === 2 && top.length > 0) top[top.length - 1].children.push({ tokens: l.tokens, children: [] });
    else fail('shape');
  }
  return top;
}

/** The reader for one component, sharing its clean, its rules and its counts. */
function reader(rules: RichRules, clean: Clean) {
  let points = 0;
  let queries = 0;
  let calls = 0;
  let lostImages = 0;
  const bare = (t: LineToken | undefined, v?: string) => t?.kind === 'bare' && (v === undefined || t.value === v);
  const str = (t: LineToken | undefined): t is LineToken => t?.kind === 'string';
  /** A string token as shown text: cleaned, clamped, never empty. */
  const label = (t: LineToken | undefined, max: number): string => {
    if (!str(t)) return fail('shape');
    const v = clean(t.value).trim();
    if (v === '') fail('empty');
    return clampText(v, max);
  };
  const num = (t: LineToken | undefined): number => {
    if (!bare(t)) return fail('shape');
    const n = parseNumber(t!.value);
    return n === null ? fail('number') : n;
  };
  const unit = (t: LineToken | undefined): string => {
    if (!bare(t) || !(t!.value === 'percent' || CURRENCY.test(t!.value))) fail('shape');
    return t!.value;
  };
  /** `from …` at `i`: the words after it, all bare, counted against the answer's requests. */
  const from = (tokens: readonly LineToken[], i: number): string[] => {
    const words = tokens.slice(i + 1);
    if (words.length < 2 || !words.every((w) => w.kind === 'bare')) fail('shape');
    queries++;
    return words.map((w) => w.value);
  };
  const shown = (w: string) => { if (!rules.show.includes(w)) fail('not_shown'); };
  const isTool = (tokens: readonly LineToken[], i: number) => bare(tokens[i], 'from') && bare(tokens[i + 1], 'tool');

  /** One parameter's value as the model wrote it, of its declared type and in its bounds — or the component goes. */
  const argOf = (p: ToolParam, t: LineToken): string | number | boolean => {
    let v: string | number | boolean | null = null;
    if (p.type === 'int' || p.type === 'number') v = bare(t) ? parseNumber(t.value) : null;
    else if (p.type === 'bool') v = bare(t, 'yes') ? true : bare(t, 'no') ? false : null;
    else if (p.type === 'date') v = bare(t) && isDay(t.value) ? t.value : null;
    else if (p.type === 'enum') v = t.kind === 'string' ? clean(t.value).trim() : t.value;
    else if (t.kind === 'string') {
      // A text value is one line: a line break in it is not a value an endpoint is asked with.
      const x = clean(t.value).trim();
      v = x.includes('\n') ? null : x;
    }
    if (v === null || !paramValueOk(p, v)) fail('tool');
    return v as string | number | boolean;
  };
  /** A value in its canonical word: a number, yes/no, a day, a bare enum value when it can be one, else a string. */
  const argWord = (p: ToolParam, v: string | number | boolean): string => {
    if (typeof v === 'number') return numberText(v);
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (p.type === 'date' || (p.type === 'enum' && /^[A-Za-z0-9._-]+$/.test(v))) return v;
    return quoted(v);
  };

  /**
   * `from tool <name> {<param> <value>} (count | sum|avg|min|max <field>) [by <field>]`,
   * or `… columns <field> {<field>}` — `tokens[i]` is `from`. `want` is what
   * the component can show: a chart groups, a stat is one figure or the
   * latest of a date grouping, a table either groups or lists rows.
   */
  const toolOf = (tokens: readonly LineToken[], i: number, want: 'chart' | 'stat' | 'table'): ToolRequest => {
    const w = tokens.slice(i + 2);
    const nameT = w.shift();
    const decl = bare(nameT) ? (rules.tools ?? []).find((x) => x.name === nameT!.value) : undefined;
    if (!decl) return fail('tool');
    const args: Record<string, string | number | boolean> = {};
    const words = ['tool', decl.name];
    const starts = (t: LineToken | undefined) => bare(t) && (TOOL_FNS.has(t!.value) || t!.value === 'columns');
    while (w.length > 0 && !starts(w[0])) {
      const p = w.shift()!;
      const v = w.shift();
      const param = bare(p) && Object.hasOwn(decl.params, p.value) ? decl.params[p.value] : undefined;
      if (!param || v === undefined || Object.hasOwn(args, p.value)) return fail('tool');
      args[p.value] = argOf(param, v);
      words.push(p.value, argWord(param, args[p.value]));
    }
    for (const [name, p] of Object.entries(decl.params)) if (p.required && !Object.hasOwn(args, name)) fail('tool');
    const field = (t: LineToken | undefined, types: readonly string[]): string => {
      if (!bare(t) || !Object.hasOwn(decl.fields, t!.value) || !types.includes(decl.fields[t!.value])) return fail('tool');
      return t!.value;
    };
    const head = w.shift();
    let shape: ToolShape;
    if (bare(head, 'columns')) {
      if (want !== 'table') fail('tool');
      const columns = w.splice(0).map((t) => field(t, ['text', 'number', 'date', 'bool']));
      if (columns.length < 1 || columns.length > RICH_LIMITS.columns || new Set(columns).size !== columns.length) fail('tool');
      shape = { kind: 'rows', columns };
      words.push('columns', ...columns);
    } else {
      if (!bare(head) || !TOOL_FNS.has(head!.value)) return fail('tool');
      const fn = head!.value as Extract<ToolShape, { kind: 'figures' }>['fn'];
      const measure = fn === 'count' ? null : field(w.shift(), ['number']);
      let by: string | null = null;
      if (bare(w[0], 'by')) {
        w.shift();
        // A stat shows the latest period of a date grouping; a grouping by text is a chart's or a table's.
        by = field(w.shift(), want === 'stat' ? ['date'] : ['text', 'date']);
      }
      if (w.length > 0 || (want === 'chart' && by === null)) fail('tool');
      shape = { kind: 'figures', fn, field: measure, by };
      words.push(fn, ...(measure ? [measure] : []), ...(by ? ['by', by] : []));
    }
    queries++;
    calls++;
    return { tool: decl.name, args, shape, words: words.join(' ') };
  };

  /** `chart <kind> "title"` with `from …`, or with its points (one series inside a dashboard). */
  function chart(head: readonly LineToken[], children: readonly Node[], inTile: boolean): RichChart {
    shown('chart');
    if (!bare(head[1]) || !KINDS.has(head[1].value)) fail('shape');
    const kind = head[1].value;
    const title = label(head[2], RICH_LIMITS.title);
    if (isTool(head, 3)) {
      if (children.length > 0) fail('shape');
      return { kind, title, tool: toolOf(head, 3, 'chart') };
    }
    if (bare(head[3], 'from')) {
      if (children.length > 0) fail('shape');
      return { kind, title, from: from(head, 3) };
    }
    if (head.length !== 3) fail('shape');
    const round = kind === 'pie' || kind === 'donut';
    let u: Unit = null;
    const series: { name: string; points: [string, number][] }[] = [];
    const pointOf = (n: Node): [string, number] => {
      if (!bare(n.tokens[0], 'point') || n.tokens.length !== 3 || n.children.length > 0) fail('shape');
      return [label(n.tokens[1], RICH_LIMITS.label), num(n.tokens[2])];
    };
    children.forEach((n, i) => {
      if (bare(n.tokens[0], 'unit') && i === 0 && n.tokens.length === 2 && n.children.length === 0) { u = unit(n.tokens[1]); return; }
      if (bare(n.tokens[0], 'series') && !inTile && n.tokens.length === 2) {
        if (series.length > 0 && series[0].name === '') fail('shape');
        series.push({ name: label(n.tokens[1], RICH_LIMITS.label), points: n.children.map(pointOf) });
        return;
      }
      if (bare(n.tokens[0], 'point')) {
        if (series.length > 0 && series[0].name !== '') fail('shape');
        if (series.length === 0) series.push({ name: '', points: [] });
        series[0].points.push(pointOf(n));
        return;
      }
      fail('shape');
    });
    if (series.length === 0) fail('empty');
    if (series.length > (round ? 1 : RICH_LIMITS.series)) fail('too_many');
    const labels = series[0].points.map((p) => p[0]);
    for (const s of series) {
      const min = kind === 'bar' ? 1 : 2;
      if (s.points.length < min) fail('empty');
      if (s.points.length > (round ? RICH_LIMITS.slices : RICH_LIMITS.points)) fail('too_many');
      const own = s.points.map((p) => p[0]);
      if (new Set(own).size !== own.length || own.length !== labels.length || own.some((l, i) => l !== labels[i])) fail('shape');
    }
    if (round) {
      const values = series[0].points.map((p) => p[1]);
      if (values.some((v) => v < 0) || values.reduce((a, b) => a + b, 0) <= 0) fail('number');
    }
    points += series.reduce((n, s) => n + s.points.length, 0);
    // A single unnamed series is named by the chart's title, clamped like any series name.
    const named = series.map((s) => ({ name: s.name === '' ? clampText(title, RICH_LIMITS.label) : s.name, points: s.points }));
    return { kind, title, unit: u, src: 'model', series: named };
  }

  /** `table "title" [sortable]` with `from …`, or columns then rows. */
  function table(head: readonly LineToken[], children: readonly Node[]): RichTable {
    shown('table');
    const title = label(head[1], RICH_LIMITS.title);
    let i = 2;
    const sortable = bare(head[i], 'sortable');
    if (sortable) i++;
    if (isTool(head, i)) {
      if (children.length > 0) fail('shape');
      return { title, sortable, tool: toolOf(head, i, 'table') };
    }
    if (bare(head[i], 'from')) {
      if (children.length > 0) fail('shape');
      return { title, sortable, from: from(head, i) };
    }
    if (head.length !== i) fail('shape');
    const [cols, ...rest] = children;
    if (!cols || !bare(cols.tokens[0], 'columns') || cols.children.length > 0) fail('shape');
    const labels = cols.tokens.slice(1).map((t) => label(t, RICH_LIMITS.header));
    if (labels.length < 1) fail('empty');
    if (labels.length > RICH_LIMITS.columns) fail('too_many');
    if (rest.length < 1) fail('empty');
    if (rest.length > RICH_LIMITS.rows) fail('too_many');
    const raw = rest.map((r) => {
      if (!bare(r.tokens[0], 'row') || r.children.length > 0 || r.tokens.length - 1 !== labels.length) fail('shape');
      return r.tokens.slice(1);
    });
    // A column is numbers when every cell in it is a bare number; otherwise every cell is a string.
    const types = labels.map((_, c) => (raw.every((r) => r[c].kind === 'bare') ? 'number' as const : 'text' as const));
    const rows = raw.map((r) => r.map((t, c) => (types[c] === 'number' ? num(t) : (str(t) ? clampText(clean(t.value).trim(), RICH_LIMITS.cell) : fail('shape')))));
    points += rows.length * labels.length;
    return { title, sortable, src: 'model', columns: labels.map((l, c) => ({ label: l, type: types[c] })), rows };
  }

  /** `stat "label"` with `from …`, or a number with an optional unit and delta. */
  function stat(tokens: readonly LineToken[]): RichStat {
    if (!bare(tokens[0], 'stat')) fail('shape');
    const lab = label(tokens[1], RICH_LIMITS.statLabel);
    if (isTool(tokens, 2)) return { label: lab, tool: toolOf(tokens, 2, 'stat') };
    if (bare(tokens[2], 'from')) return { label: lab, from: from(tokens, 2) };
    const value = num(tokens[2]);
    let u: Unit = null;
    let delta: number | undefined;
    let i = 3;
    if (bare(tokens[i], 'unit')) { u = unit(tokens[i + 1]); i += 2; }
    if (bare(tokens[i], 'delta')) { delta = num(tokens[i + 1]); i += 2; }
    if (i !== tokens.length) fail('shape');
    points++;
    return { label: lab, value, unit: u, ...(delta !== undefined ? { delta } : {}), src: 'model' };
  }

  /** `card "title"` and its image, text and link lines. */
  function card(tokens: readonly LineToken[], children: readonly Node[]): RichCard {
    if (!bare(tokens[0], 'card') || tokens.length !== 2) fail('shape');
    const title = label(tokens[1], RICH_LIMITS.cardTitle);
    let text: string | undefined;
    let image: { asset: string } | undefined;
    let link: { label: string; to: string } | undefined;
    for (const n of children) {
      const [k, a, b] = n.tokens;
      if (bare(k, 'image') && n.tokens.length === 2 && image === undefined) {
        // Only a key the build made; an address of any kind is no image (§20.6) — the card keeps its text.
        if (bare(a) && rules.images.includes(a!.value)) image = { asset: a!.value };
        else lostImages++;
      } else if (bare(k, 'text') && n.tokens.length === 2 && text === undefined) {
        if (!str(a)) fail('shape');
        const v = clean(a!.value).trim();
        if (v !== '') text = clampText(v, RICH_LIMITS.cardText);
      } else if (bare(k, 'link') && n.tokens.length === 3 && link === undefined) {
        const l = label(a, RICH_LIMITS.linkLabel);
        // The allow-list is exact, as a cta's (§6.2); a link anywhere else drops the cards.
        if (!bare(b) || !rules.destinations.includes(b!.value)) fail('destination');
        link = { label: l, to: b!.value };
      } else {
        fail('shape');
      }
    }
    return { title, ...(text !== undefined ? { text } : {}), ...(image ? { image } : {}), ...(link ? { link } : {}) };
  }

  function read(head: readonly LineToken[], lines: readonly RichLine[]): RichBlock {
    const word = head[0].value as RichWord;
    const tree = treeOf(lines);
    switch (word) {
      case 'chart': return { chart: chart(head, tree, false) };
      case 'table': return { table: table(head, tree) };
      case 'stats': {
        shown('stats');
        if (head.length !== 1) fail('shape');
        if (tree.length < 1) fail('empty');
        if (tree.length > RICH_LIMITS.stats) fail('too_many');
        return { stats: tree.map((n) => { if (n.children.length > 0) fail('shape'); return stat(n.tokens); }) };
      }
      case 'cards': {
        shown('cards');
        if (bare(head[1], 'from')) {
          if (tree.length > 0) fail('shape');
          return { cards: { from: from(head, 1) } };
        }
        if (head.length !== 1) fail('shape');
        if (tree.length < 1) fail('empty');
        if (tree.length > RICH_LIMITS.cards) fail('too_many');
        return { cards: tree.map((n) => card(n.tokens, n.children)) };
      }
      case 'dashboard': {
        shown('dashboard');
        if (head.length !== 2) fail('shape');
        const title = label(head[1], RICH_LIMITS.title);
        if (tree.length < 2) fail('empty');
        if (tree.length > RICH_LIMITS.tiles) fail('too_many');
        const tiles: RichTile[] = tree.map((n) => {
          const k = n.tokens[0];
          // A dashboard holds what `show` lists besides it; its tiles one level down, their lines one more.
          if (bare(k, 'stat')) { shown('stats'); if (n.children.length > 0) fail('shape'); return { stat: stat(n.tokens) }; }
          if (bare(k, 'chart')) return { chart: chart(n.tokens, n.children, true) };
          if (bare(k, 'table')) return { table: table(n.tokens, n.children) };
          if (bare(k, 'card')) { shown('cards'); return { card: card(n.tokens, n.children) }; }
          return fail('shape');
        });
        if (tiles.filter((t) => 'chart' in t || 'table' in t).length > RICH_LIMITS.heavyTiles) fail('too_many');
        return { dashboard: { title, tiles } };
      }
    }
  }
  return { read, counts: () => ({ points, queries, calls, lostImages }) };
}

/**
 * One rich component from its head line's tokens and its held child lines
 * (depth 1 or 2), under `rules` — or why it was dropped.
 */
export function richBlock(head: readonly LineToken[], lines: readonly RichLine[], rules: RichRules, clean: Clean): RichRead {
  const r = reader(rules, clean);
  try {
    const block = r.read(head, lines);
    return { ok: true, block, ...r.counts() };
  } catch (e) {
    if (e instanceof Drop) return { ok: false, why: e.why };
    throw e;
  }
}


/** A rich component in its canonical lines — what the answer's record (its history) holds for it. */
export function richLines(block: RichBlock): string {
  const out: string[] = [];
  const unitPart = (u: Unit) => (u ? ` unit ${u}` : '');
  const chartLines = (c: RichChart, pad: string) => {
    if ('from' in c) { out.push(`${pad}chart ${c.kind} ${quoted(c.title)} from ${c.from.join(' ')}`); return; }
    if ('tool' in c) { out.push(`${pad}chart ${c.kind} ${quoted(c.title)} from ${c.tool.words}`); return; }
    out.push(`${pad}chart ${c.kind} ${quoted(c.title)}`);
    if (c.unit) out.push(`${pad}  unit ${c.unit}`);
    if (c.series.length === 1) for (const [l, v] of c.series[0].points) out.push(`${pad}  point ${quoted(l)} ${numberText(v)}`);
    else for (const s of c.series) {
      out.push(`${pad}  series ${quoted(s.name)}`);
      for (const [l, v] of s.points) out.push(`${pad}    point ${quoted(l)} ${numberText(v)}`);
    }
  };
  const tableLines = (t: RichTable, pad: string) => {
    const head = `${pad}table ${quoted(t.title)}${t.sortable ? ' sortable' : ''}`;
    if ('from' in t) { out.push(`${head} from ${t.from.join(' ')}`); return; }
    if ('tool' in t) { out.push(`${head} from ${t.tool.words}`); return; }
    out.push(head, `${pad}  columns ${t.columns.map((c) => quoted(c.label)).join(' ')}`);
    for (const r of t.rows) out.push(`${pad}  row ${r.map((c) => (typeof c === 'number' ? numberText(c) : quoted(c))).join(' ')}`);
  };
  const statLine = (s: RichStat, pad: string) => out.push('from' in s
    ? `${pad}stat ${quoted(s.label)} from ${s.from.join(' ')}`
    : 'tool' in s ? `${pad}stat ${quoted(s.label)} from ${s.tool.words}`
    : `${pad}stat ${quoted(s.label)} ${numberText(s.value)}${unitPart(s.unit)}${s.delta !== undefined ? ` delta ${numberText(s.delta)}` : ''}`);
  const cardLines = (c: RichCard, pad: string) => {
    out.push(`${pad}card ${quoted(c.title)}`);
    if (c.image) out.push(`${pad}  image ${c.image.asset}`);
    if (c.text) out.push(`${pad}  text ${quoted(c.text)}`);
    if (c.link) out.push(`${pad}  link ${quoted(c.link.label)} ${c.link.to}`);
  };
  if ('chart' in block) chartLines(block.chart, '');
  else if ('table' in block) tableLines(block.table, '');
  else if ('stats' in block) { out.push('stats'); for (const s of block.stats) statLine(s, '  '); }
  else if ('cards' in block) {
    if ('from' in block.cards) out.push(`cards from ${block.cards.from.join(' ')}`);
    else { out.push('cards'); for (const c of block.cards) cardLines(c, '  '); }
  } else {
    out.push(`dashboard ${quoted(block.dashboard.title)}`);
    for (const t of block.dashboard.tiles) {
      if ('stat' in t) statLine(t.stat, '  ');
      else if ('chart' in t) chartLines(t.chart, '  ');
      else if ('table' in t) tableLines(t.table, '  ');
      else cardLines(t.card, '  ');
    }
  }
  return `${out.join('\n')}\n`;
}

/** A `from` request answered: the kind of answer it wants decides which parse chat-query runs. */
export type FiguresRun = (kind: 'figures' | 'rows' | 'cards', words: readonly string[], cap: number) => Promise<Figures | RowsResult | CardsResult | 'unavailable' | null>;

/** A tool's rows, aggregated for the component, with the operator's label and the minute they were read (`YYYY-MM-DDTHH:MMZ`). */
export interface ToolAnswer { readonly result: Figures | RowsResult; readonly source: string; readonly at: string }

/** A `from tool` request answered (chat-tools.ts): `cap` is the groups the component shows. */
export type ToolsRun = (req: ToolRequest, cap: number) => Promise<ToolAnswer | 'unavailable'>;

/** What the page receives for one rich component: its figures filled, or a note that they could not be. */
export type Resolved = Record<string, unknown>;

/** The note a component becomes when its figures could not be read in time (§20.5): never the model's numbers instead. */
const unavailable = (title: string): Resolved => ({ unavailable: { title } });

/** The two columns a grouped table of figures shows: the grouping, and the measure. */
const figureColumns = (by: string, measure: string, unit: string | null) => [
  { label: clampText(by, RICH_LIMITS.header), type: 'text', unit: null },
  { label: clampText(measure, RICH_LIMITS.header), type: 'number', unit },
];

/**
 * A rich component as the page receives it: model figures marked `src:
 * model`; each `from` answered by `run` and marked `src: site` with the day
 * it was read; each `from tool` answered by `tools` and marked `src: tool`
 * with the operator's label and the minute it was read; a request that does
 * not parse (an unknown table or field, a private one, a grouping that does
 * not fit) drops the component (null); a read that timed out or overflowed,
 * or a tool that failed or answered rows of the wrong shape, becomes the
 * unavailable note.
 */
export async function resolveRich(block: RichBlock, run: FiguresRun | null, day: string, tools: ToolsRun | null = null): Promise<Resolved | null> {
  const site = { src: 'site', asOf: day };
  type Out = Resolved | null | 'unavailable';
  type Source = { readonly from: readonly string[] } | { readonly tool: ToolRequest };
  type Got = { readonly r: Figures | RowsResult | CardsResult | null; readonly meta: Resolved } | 'unavailable';
  /** The figures a source answers, with the provenance the page shows them under. */
  const ask = async (s: Source, kind: 'figures' | 'rows' | 'cards', cap: number): Promise<Got> => {
    if ('from' in s) {
      const r = run ? await run(kind, s.from, cap) : null;
      return r === 'unavailable' ? r : { r, meta: site };
    }
    if (!tools) return { r: null, meta: {} };
    const a = await tools(s.tool, cap);
    return a === 'unavailable' ? a : { r: a.result, meta: { src: 'tool', source: a.source, asOf: a.at } };
  };

  const chart = async (c: RichChart): Promise<Out> => {
    if (!('from' in c) && !('tool' in c)) return { kind: c.kind, title: c.title, unit: c.unit, src: 'model', series: c.series };
    const round = c.kind === 'pie' || c.kind === 'donut';
    const got = await ask(c, 'figures', round ? RICH_LIMITS.slices : RICH_LIMITS.points);
    if (got === 'unavailable') return 'unavailable';
    const r = got.r;
    if (!r || r.kind !== 'figures' || r.groups === null) return null;
    if (r.groups.length < (c.kind === 'bar' ? 1 : 2)) return 'unavailable';
    // A tool's figures are its endpoint's: a pie of negative values is figures that cannot be drawn, not a request that does not parse.
    if (round && (r.groups.some(([, v]) => v < 0) || r.groups.reduce((a, [, v]) => a + v, 0) <= 0)) return 'tool' in c ? 'unavailable' : null;
    return {
      kind: c.kind, title: c.title, unit: r.unit, ...got.meta, more: r.more,
      series: [{ name: clampText(c.title, RICH_LIMITS.label), points: r.groups.map(([l, v]) => [clampText(l, RICH_LIMITS.label), v]) }],
    };
  };
  const table = async (t: RichTable): Promise<Out> => {
    if (!('from' in t) && !('tool' in t)) return { title: t.title, sortable: t.sortable, src: 'model', columns: t.columns, rows: t.rows };
    const rows = 'from' in t ? t.from[1] === 'columns' : t.tool.shape.kind === 'rows';
    const got = await ask(t, rows ? 'rows' : 'figures', RICH_LIMITS.rows);
    if (got === 'unavailable') return 'unavailable';
    const r = got.r;
    if (!r) return null;
    if (r.kind === 'rows') {
      if (r.rows.length === 0) return 'unavailable';
      return {
        title: t.title, sortable: t.sortable, ...got.meta,
        columns: r.columns.map((c) => ({ label: clampText(c.label, RICH_LIMITS.header), type: c.type, unit: c.unit })),
        rows: r.rows,
      };
    }
    if (r.kind !== 'figures' || r.groups === null || r.groups.length === 0) return r.kind === 'figures' && r.groups !== null ? 'unavailable' : null;
    let columns: ReturnType<typeof figureColumns>;
    if ('from' in t) columns = figureColumns(t.from[t.from.indexOf('by') + 1], t.from[1] === 'count' ? 'count' : `${t.from[1]} ${t.from[2]}`, r.unit);
    else {
      const s = t.tool.shape as Extract<ToolShape, { kind: 'figures' }>;
      columns = figureColumns(s.by ?? '', s.field === null ? 'count' : `${s.fn} ${s.field}`, r.unit);
    }
    return { title: t.title, sortable: t.sortable, ...got.meta, columns, rows: r.groups.map(([l, v]) => [l, v]) };
  };
  const stat = async (s: RichStat): Promise<Out> => {
    if (!('from' in s) && !('tool' in s)) return { label: s.label, value: s.value, unit: s.unit, ...(s.delta !== undefined ? { delta: s.delta } : {}), src: 'model' };
    const got = await ask(s, 'figures', 2);
    if (got === 'unavailable') return 'unavailable';
    const r = got.r;
    if (!r || r.kind !== 'figures') return null;
    if (r.groups === null) return r.value === null ? 'unavailable' : { label: s.label, value: r.value, unit: r.unit, ...got.meta };
    // A stat over a date grouping is the latest period, and its change from the one before; over categories it is no stat.
    if (!r.dated) return null;
    const last = r.groups.at(-1);
    if (!last) return 'unavailable';
    const prev = r.groups.length > 1 ? r.groups.at(-2)! : null;
    return {
      label: s.label, value: last[1], unit: r.unit, ...got.meta,
      ...(prev ? { delta: Number((last[1] - prev[1]).toPrecision(15)), deltaOf: prev[0] } : {}),
    };
  };
  const cards = async (c: RichCards): Promise<Resolved[] | null | 'unavailable'> => {
    if (!('from' in c)) return c.map(cardOut);
    const got = await ask(c, 'cards', RICH_LIMITS.cards);
    if (got === 'unavailable') return 'unavailable';
    const r = got.r;
    if (!r || r.kind !== 'cards') return null;
    if (r.items.length === 0) return 'unavailable';
    return r.items.map((i) => ({
      title: i.title, ...(i.text ? { text: i.text } : {}),
      ...(i.image && i.row ? { image: { row: i.row, url: i.image.url, width: i.image.width, height: i.image.height, variants: i.image.variants } } : {}),
    }));
  };
  const cardOut = (c: RichCard): Resolved => ({ ...c });

  const titleOf = (b: RichBlock): string => {
    if ('chart' in b) return b.chart.title;
    if ('table' in b) return b.table.title;
    if ('dashboard' in b) return b.dashboard.title;
    return 'Figures';
  };
  let out: Out;
  if ('chart' in block) { const c = await chart(block.chart); out = c && c !== 'unavailable' ? { chart: c } : c; }
  else if ('table' in block) { const t = await table(block.table); out = t && t !== 'unavailable' ? { table: t } : t; }
  else if ('stats' in block) {
    const items: Resolved[] = [];
    let failed: Out = null;
    for (const s of block.stats) {
      const r = await stat(s);
      if (r === null || r === 'unavailable') { failed = r; break; }
      items.push(r);
    }
    out = failed === null && items.length === block.stats.length ? { stats: items } : failed;
  } else if ('cards' in block) { const c = await cards(block.cards); out = c && c !== 'unavailable' ? { cards: c } : c; }
  else {
    const tiles: Resolved[] = [];
    for (const t of block.dashboard.tiles) {
      if ('card' in t) { tiles.push({ card: cardOut(t.card) }); continue; }
      const r = 'stat' in t ? await stat(t.stat) : 'chart' in t ? await chart(t.chart) : await table(t.table);
      if (r === null) return null;
      // One tile whose figures could not be read is that tile's note; the rest of the dashboard stands.
      const key = 'stat' in t ? 'stat' : 'chart' in t ? 'chart' : 'table';
      tiles.push(r === 'unavailable' ? unavailable('stat' in t ? t.stat.label : 'chart' in t ? t.chart.title : t.table.title) : { [key]: r });
    }
    out = { dashboard: { title: block.dashboard.title, tiles } };
  }
  return out === 'unavailable' ? unavailable(titleOf(block)) : out;
}
