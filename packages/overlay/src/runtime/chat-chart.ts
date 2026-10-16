/**
 * @az runtime chat-chart
 * Purpose: a chart in a chat answer as pure geometry — validation, nice ticks, scales, paths and the text summary; no DOM, no library.
 * Spec: docs/chat-block-spec.md §20.2, §20.4, §20.8
 * Exports: ChartKind, ChartUnit, ChartSeries, ChartData, SvgNode, ChartBox, Ticks, CHART_LIMITS, VALUE_MAX, validChart,
 *   Format, SERIES_PATTERNS, niceTicks, chartBox, chartGeometry, chartSummary, chartRows, thinned, round2
 * Edit guide: no DOM here and nothing from the network is trusted: validChart is the only way in, and geometry only
 *   ever sees what it passed. Paint is a `part` name the DOM writer maps to a class — never a colour or a style.
 * Tests: packages/overlay/test/chat-chart.test.ts
 */

/**
 * A chart answer arrives as a typed event the server already validated and
 * clamped (chat-block-spec §20.2). The page checks it again, strictly —
 * after the server's clamp, anything over a limit is a forgery and the
 * whole chart is ignored — then turns it into a small tree of SVG nodes.
 *
 * The tree names no colour. Each mark carries a `part` ("fill-2",
 * "line-1", "axis"…) that the DOM writer turns into the class the chat
 * word's template gave that part, so every paint is a theme token in the
 * generated stylesheet (§20.4) and the page never writes `fill`, `stroke`
 * or `style` — except `fill="url(#…)"`, which points only at a pattern this
 * same tree defines.
 *
 * Geometry is in CSS pixels for the width the figure measures, so text
 * stays the theme's size instead of shrinking with the box, and every
 * coordinate is rounded to 0.01 so a given width always draws the same
 * bytes.
 */

export type ChartKind = 'bar' | 'line' | 'area' | 'pie' | 'donut';
/** No unit, a percentage, or a lower-case ISO currency code — money already in major units. */
export type ChartUnit = null | 'percent' | string;

export interface ChartSeries {
  readonly name: string;
  readonly points: readonly (readonly [string, number])[];
}

/** Where figures came from (§20.2, §21.2.4): the site's tables, the model, or one of the operator's tools. */
export type FigureSource = 'site' | 'model' | 'tool';

/** The longest source label a tool's figures carry (env.ts TOOL_LIMITS.label). */
export const SOURCE_MAX = 40;

const MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/;

/**
 * An event's provenance, checked: `model` with no date; `site` with its UTC
 * day; `tool` with its UTC minute and the operator's label — or null.
 */
export function sourceOf(v: Readonly<Record<string, unknown>>): { src: FigureSource; asOf: string | null; source: string | null } | null {
  if (v.src === 'model') return (v.asOf === undefined || v.asOf === null) && v.source === undefined ? { src: 'model', asOf: null, source: null } : null;
  if (v.src === 'site') return typeof v.asOf === 'string' && DAY.test(v.asOf) && v.source === undefined ? { src: 'site', asOf: v.asOf, source: null } : null;
  if (v.src === 'tool' && typeof v.asOf === 'string' && MINUTE.test(v.asOf) && text(v.source, SOURCE_MAX)) return { src: 'tool', asOf: v.asOf, source: v.source };
  return null;
}

export interface ChartData {
  readonly kind: ChartKind;
  readonly title: string;
  readonly unit: ChartUnit;
  readonly src: FigureSource;
  readonly series: readonly ChartSeries[];
  /** Site figures: the UTC day they were read, `YYYY-MM-DD`; a tool's: the UTC minute, `YYYY-MM-DDTHH:MMZ`. */
  readonly asOf: string | null;
  /** A tool's figures only: the operator's label for it (chat-block-spec §21.2.4). */
  readonly source: string | null;
  /** Site and tool figures only: more groups existed than the chart shows. */
  readonly more: boolean;
}

/** One SVG element: tag, geometry attributes, a paint `part`, text. */
export interface SvgNode {
  readonly tag: 'svg' | 'g' | 'defs' | 'pattern' | 'rect' | 'path' | 'line' | 'text' | 'circle';
  readonly attrs: Readonly<Record<string, string>>;
  readonly part?: string;
  readonly text?: string;
  readonly children?: readonly SvgNode[];
}

/** chat-block-spec §20.2, the chart row. */
export const CHART_LIMITS = {
  title: 80,
  label: 24,
  seriesName: 24,
  series: 4,
  points: 24,
  slices: 6,
  /** Points across one chart: 4 series × 24. */
  total: 96,
} as const;

/** The largest magnitude a figure may have (§20.2): well inside a double's exact integers. */
export const VALUE_MAX = 1e15;

const KINDS: ReadonlySet<string> = new Set(['bar', 'line', 'area', 'pie', 'donut']);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY = /^[a-z]{3}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A string of 1–max characters (code points), not blank. */
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && [...v].length <= max;
const figure = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= VALUE_MAX;

/**
 * The chart in an event, or null: every key known, every limit held. Two
 * series of one chart have the same labels in the same order; a pie has
 * one series of non-negative values that sum above zero.
 */
export function validChart(v: unknown): ChartData | null {
  if (!isRecord(v)) return null;
  const known = new Set(['kind', 'title', 'unit', 'src', 'series', 'asOf', 'source', 'more']);
  if (Object.keys(v).some((k) => !known.has(k))) return null;
  const { kind, title, unit, series, more } = v;
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null;
  if (!text(title, CHART_LIMITS.title)) return null;
  if (!(unit === null || unit === undefined || unit === 'percent' || (typeof unit === 'string' && CURRENCY.test(unit)))) return null;
  const from = sourceOf(v);
  if (!from) return null;
  if (more !== undefined && typeof more !== 'boolean') return null;
  if (from.src === 'model' && more === true) return null;
  if (!Array.isArray(series) || series.length < 1) return null;
  const round = kind === 'pie' || kind === 'donut';
  if (series.length > (round ? 1 : CHART_LIMITS.series)) return null;
  const out: ChartSeries[] = [];
  let labels: string[] | null = null;
  for (const s of series) {
    if (!isRecord(s) || Object.keys(s).some((k) => k !== 'name' && k !== 'points')) return null;
    if (!text(s.name, CHART_LIMITS.seriesName) || !Array.isArray(s.points)) return null;
    const min = kind === 'bar' ? 1 : 2;
    const max = round ? CHART_LIMITS.slices : CHART_LIMITS.points;
    if (s.points.length < min || s.points.length > max) return null;
    const points: [string, number][] = [];
    for (const p of s.points) {
      if (!Array.isArray(p) || p.length !== 2 || !text(p[0], CHART_LIMITS.label) || !figure(p[1])) return null;
      points.push([p[0], p[1] === 0 ? 0 : p[1]]);
    }
    const own = points.map((p) => p[0]);
    if (new Set(own).size !== own.length) return null;
    if (labels === null) labels = own;
    else if (labels.length !== own.length || labels.some((l, i) => l !== own[i])) return null;
    out.push({ name: s.name, points });
  }
  if (round) {
    const values = out[0].points.map((p) => p[1]);
    if (values.some((x) => x < 0) || values.reduce((a, b) => a + b, 0) <= 0) return null;
  }
  return {
    kind: kind as ChartKind, title, unit: (unit ?? null) as ChartUnit, ...from,
    series: out, more: more === true,
  };
}

/** A coordinate rounded to 0.01, never `-0`. */
export const round2 = (n: number): number => {
  const r = Math.round(n * 100) / 100;
  return r === 0 ? 0 : r;
};
const s2 = (n: number): string => String(round2(n));

/** Axis bounds and tick values. */
export interface Ticks {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly values: readonly number[];
}

/** The smallest 1, 2, 5 or 10 × 10ᵏ at or above `x`. */
function niceStep(x: number): number {
  const exp = Math.floor(Math.log10(x));
  const f = x / 10 ** exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * 10 ** exp;
}

/** Decimal places a step needs, so 0.1 + 0.2 prints as 0.3. */
const decimals = (step: number): number => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));

/**
 * Nice bounds and 3–6 ticks covering [lo, hi] (the classic nice-numbers
 * rule): a step of 1, 2 or 5 × 10ᵏ, bounds on whole steps. `zero` pulls
 * the domain to include 0 (bars and areas start at zero). A flat domain
 * opens to one step around its value.
 */
export function niceTicks(lo: number, hi: number, zero: boolean): Ticks {
  let a = Math.min(lo, hi);
  let b = Math.max(lo, hi);
  if (zero) {
    a = Math.min(a, 0);
    b = Math.max(b, 0);
  }
  if (a === b) {
    const pad = a === 0 ? 1 : Math.abs(a) / 2;
    if (zero && a >= 0) b = a + pad;
    else if (zero) a = b - pad;
    else {
      a -= pad;
      b += pad;
    }
  }
  const lo2 = a;
  const hi2 = b;
  // A step at or above range ÷ intervals gives at most intervals + 1 steps
  // once the bounds round outward, and — rounding up at most 2.5× — at least two.
  const forIntervals = (intervals: number): Ticks => {
    const step = niceStep((hi2 - lo2) / intervals);
    const d = decimals(step);
    const fix = (x: number) => Number(x.toFixed(d));
    const min = fix(Math.floor(lo2 / step + 1e-9) * step);
    const max = fix(Math.ceil(hi2 / step - 1e-9) * step);
    const values: number[] = [];
    for (let i = 0; ; i++) {
      const v = fix(min + i * step);
      if (v > max + step / 2) break;
      values.push(v === 0 ? 0 : v);
    }
    return { min, max, step, values: values.length >= 2 ? values : [min, max] };
  };
  // The most ticks that stay at six or fewer; three always do.
  return [5, 4].map(forIntervals).find((t) => t.values.length <= 6) ?? forIntervals(3);
}

/** The drawing box for a measured width (§20.4): 280–960 px wide, 3∕5 as tall, at least 200. */
export interface ChartBox {
  readonly width: number;
  readonly height: number;
  /** The theme's small text size in px, for label widths. */
  readonly font: number;
}

export function chartBox(measured: number, font: number): ChartBox {
  const width = Math.round(Math.min(960, Math.max(280, Number.isFinite(measured) ? measured : 280)));
  return { width, height: Math.max(200, Math.round(width * 0.6)), font };
}

/** A label's width estimate: an average advance of 0.6 em per character. */
const textWidth = (s: string, font: number): number => [...s].length * font * 0.6;

/**
 * Which of `n` category labels to draw so none overlaps: every k-th, the
 * first and the last always, and the one before the last dropped when it
 * would crowd it.
 */
export function thinned(labels: readonly string[], band: number, font: number): number[] {
  const n = labels.length;
  if (n === 0) return [];
  const widest = Math.max(...labels.map((l) => textWidth(l, font))) + font;
  const k = Math.max(1, Math.ceil(widest / Math.max(band, 1)));
  const out: number[] = [];
  for (let i = 0; i < n; i += k) out.push(i);
  if (out[out.length - 1] !== n - 1) {
    if (out.length > 1 && n - 1 - out[out.length - 1] < k) out.pop();
    out.push(n - 1);
  }
  return out;
}

/** The pattern each series past the first is filled with, so colour is never the only signal (a legend swatch draws it too). */
export const SERIES_PATTERNS: readonly string[] = [
  '',
  'M0 8L8 0',                 // 2: diagonal hatch
  'M2 2h1v1h-1zM6 6h1v1h-1z', // 3: dots
  'M0 8L8 0M0 0L8 8',         // 4: cross-hatch
  'M4 0V8',                   // 5: vertical
  'M0 4H8',                   // 6: horizontal
];
/** Line markers per series: circle, square, triangle, diamond. */
const MARKERS: readonly ((x: number, y: number) => string)[] = [
  (x, y) => `M${s2(x - 3.5)} ${s2(y)}a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0Z`,
  (x, y) => `M${s2(x - 3)} ${s2(y - 3)}h6v6h-6Z`,
  (x, y) => `M${s2(x)} ${s2(y - 4)}L${s2(x + 4)} ${s2(y + 3)}H${s2(x - 4)}Z`,
  (x, y) => `M${s2(x)} ${s2(y - 4)}L${s2(x + 4)} ${s2(y)}L${s2(x)} ${s2(y + 4)}L${s2(x - 4)} ${s2(y)}Z`,
];

/** `fill-n` for the first series (solid) and a pattern reference after it. */
function paint(i: number, id: string): { part: string; attrs: Record<string, string> } {
  return i === 0
    ? { part: 'fill-1', attrs: {} }
    : { part: `patterned-${i + 1}`, attrs: { fill: `url(#${id}-p${i + 1})` } };
}

function patternDefs(count: number, id: string): SvgNode {
  const children: SvgNode[] = [];
  for (let i = 1; i < count; i++) {
    children.push({
      tag: 'pattern',
      attrs: { id: `${id}-p${i + 1}`, width: '8', height: '8', patternUnits: 'userSpaceOnUse' },
      children: [
        { tag: 'rect', attrs: { width: '8', height: '8' }, part: `fill-${i + 1}` },
        { tag: 'path', attrs: { d: SERIES_PATTERNS[i] }, part: 'pattern-ink' },
      ],
    });
  }
  return { tag: 'defs', attrs: {}, children };
}

/** Label for a tick or value, from the DOM writer (Intl); geometry only measures it. */
export type Format = (n: number) => string;

/**
 * The chart as SVG nodes for one box. `id` prefixes every pattern id (the
 * answer's own suffix, as rows.ts re-suffixes ids), `format` writes numbers.
 */
export function chartGeometry(data: ChartData, box: ChartBox, id: string, format: Format): SvgNode {
  const { width, height, font } = box;
  const root = (children: SvgNode[]): SvgNode => ({
    tag: 'svg',
    attrs: { viewBox: `0 0 ${width} ${height}`, width: String(width), height: String(height), focusable: 'false' },
    children,
  });
  if (data.kind === 'pie' || data.kind === 'donut') return root(pie(data, box, id));

  const labels = data.series[0].points.map((p) => p[0]);
  const values = data.series.flatMap((s) => s.points.map((p) => p[1]));
  const ticks = niceTicks(Math.min(...values), Math.max(...values), data.kind !== 'line');
  const tickWidth = Math.max(...ticks.values.map((v) => textWidth(format(v), font)));
  const left = Math.ceil(tickWidth + font);
  const right = data.kind === 'bar' ? font : Math.ceil(Math.min(width / 4, Math.max(...data.series.map((s) => textWidth(s.name, font))) + font));
  const top = Math.ceil(font);
  const bottom = Math.ceil(font * 2.2);
  const plotW = width - left - right;
  const plotH = height - top - bottom;
  const y = (v: number) => top + plotH - ((v - ticks.min) / (ticks.max - ticks.min)) * plotH;
  const n = labels.length;

  const grid: SvgNode[] = ticks.values.map((v): SvgNode => ({
    tag: 'g', attrs: {},
    children: [
      { tag: 'line', attrs: { x1: s2(left), x2: s2(left + plotW), y1: s2(y(v)), y2: s2(y(v)) }, part: v === 0 ? 'axis' : 'grid' },
      { tag: 'text', attrs: { x: s2(left - font / 2), y: s2(y(v) + font / 3), 'text-anchor': 'end' }, part: 'tick', text: format(v) },
    ],
  }));

  // Categories: bars sit in bands; lines and areas put a point at each band's centre.
  const band = plotW / n;
  const cx = (i: number) => left + band * (i + 0.5);
  const xLabels: SvgNode[] = thinned(labels, band, font).map((i): SvgNode => ({
    tag: 'text', attrs: { x: s2(cx(i)), y: s2(top + plotH + font * 1.5), 'text-anchor': 'middle' }, part: 'tick', text: labels[i],
  }));

  const marks: SvgNode[] = [];
  if (data.kind === 'bar') {
    const inner = band * 0.8;
    const each = inner / data.series.length;
    const base = y(Math.max(ticks.min, Math.min(0, ticks.max)));
    data.series.forEach((s, si) => {
      const p = paint(si, id);
      s.points.forEach(([, v], i) => {
        const x0 = left + band * i + band * 0.1 + each * si + (data.series.length > 1 ? each * 0.05 : 0);
        const w = data.series.length > 1 ? each * 0.9 : each;
        const yv = y(v);
        marks.push({
          tag: 'rect',
          attrs: { x: s2(x0), y: s2(Math.min(yv, base)), width: s2(w), height: s2(Math.abs(base - yv)), ...p.attrs },
          part: p.part,
        });
      });
    });
  } else {
    const zeroY = y(Math.max(ticks.min, Math.min(0, ticks.max)));
    data.series.forEach((s, si) => {
      const pts = s.points.map(([, v], i) => [cx(i), y(v)] as const);
      const line = pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'}${s2(px)} ${s2(py)}`).join('');
      if (data.kind === 'area') {
        const p = paint(si, id);
        marks.push({
          tag: 'path',
          attrs: { d: `${line}L${s2(pts[pts.length - 1][0])} ${s2(zeroY)}L${s2(pts[0][0])} ${s2(zeroY)}Z`, ...p.attrs },
          part: p.part,
        });
      }
      marks.push({ tag: 'path', attrs: { d: line }, part: `line-${si + 1}` });
      const marker = MARKERS[si % MARKERS.length];
      for (const [px, py] of pts) marks.push({ tag: 'path', attrs: { d: marker(px, py) }, part: `fill-${si + 1}` });
      // Each line is named at its end, so the legend is not the only key.
      const [lx, ly] = pts[pts.length - 1];
      marks.push({
        tag: 'text', attrs: { x: s2(lx + font / 2), y: s2(ly + font / 3), 'text-anchor': 'start' }, part: 'label',
        text: data.series.length > 1 ? s.name : format(s.points[s.points.length - 1][1]),
      });
    });
  }
  const defs = data.series.length > 1 ? [patternDefs(data.series.length, id)] : [];
  return root([...defs, { tag: 'g', attrs: {}, children: grid }, { tag: 'g', attrs: {}, children: marks }, { tag: 'g', attrs: {}, children: xLabels }]);
}

/** A pie or donut: slices clockwise from 12 o'clock; names, values and shares are in the legend and the table. */
function pie(data: ChartData, box: ChartBox, id: string): SvgNode[] {
  const { width, height, font } = box;
  const points = data.series[0].points;
  const total = points.reduce((a, p) => a + p[1], 0);
  const r = Math.max(10, Math.min(width, height) / 2 - font);
  const cx = width / 2;
  const cy = height / 2;
  const inner = data.kind === 'donut' ? r * 0.6 : 0;
  const at = (angle: number, radius: number) => [cx + radius * Math.sin(angle), cy - radius * Math.cos(angle)] as const;
  const slices: SvgNode[] = [];
  let start = 0;
  points.forEach(([, v], i) => {
    if (v <= 0) return;
    const p = paint(i, id);
    const sweep = (v / total) * Math.PI * 2;
    if (sweep >= Math.PI * 2 - 1e-9) {
      // One slice of 100 %: a full ring, drawn as two half arcs (one arc cannot close on itself).
      const ring = (rad: number, dir: 0 | 1) => `M${s2(cx)} ${s2(cy - rad)}A${s2(rad)} ${s2(rad)} 0 1 ${dir} ${s2(cx)} ${s2(cy + rad)}A${s2(rad)} ${s2(rad)} 0 1 ${dir} ${s2(cx)} ${s2(cy - rad)}Z`;
      slices.push({ tag: 'path', attrs: { d: inner > 0 ? `${ring(r, 1)}${ring(inner, 0)}` : ring(r, 1), 'fill-rule': 'evenodd', ...p.attrs }, part: p.part });
      start += sweep;
      return;
    }
    const end = start + sweep;
    const large = sweep > Math.PI ? 1 : 0;
    const [x0, y0] = at(start, r);
    const [x1, y1] = at(end, r);
    let d = `M${s2(x0)} ${s2(y0)}A${s2(r)} ${s2(r)} 0 ${large} 1 ${s2(x1)} ${s2(y1)}`;
    if (inner > 0) {
      const [x2, y2] = at(end, inner);
      const [x3, y3] = at(start, inner);
      d += `L${s2(x2)} ${s2(y2)}A${s2(inner)} ${s2(inner)} 0 ${large} 0 ${s2(x3)} ${s2(y3)}Z`;
    } else {
      d += `L${s2(cx)} ${s2(cy)}Z`;
    }
    slices.push({ tag: 'path', attrs: { d, ...p.attrs }, part: p.part });
    start = end;
  });
  return [...(points.length > 1 ? [patternDefs(points.length, id)] : []), { tag: 'g', attrs: {}, children: slices }];
}

const KIND_NAMES: Record<ChartKind, [string, string]> = {
  bar: ['Bar chart', 'bars'],
  line: ['Line chart', 'points'],
  area: ['Area chart', 'points'],
  pie: ['Pie chart', 'slices'],
  donut: ['Donut chart', 'slices'],
};

/**
 * The chart in one sentence (§20.8): kind, title, how many marks, the range
 * with the labels at each end, and for lines the last value — fixed copy
 * built from the figures, never the model's words beyond its labels.
 */
export function chartSummary(data: ChartData, format: Format): string {
  const [kind, unit] = KIND_NAMES[data.kind];
  const n = data.series[0].points.length;
  const parts: string[] = [];
  for (const s of data.series) {
    let lo = s.points[0];
    let hi = s.points[0];
    for (const p of s.points) {
      if (p[1] < lo[1]) lo = p;
      if (p[1] > hi[1]) hi = p;
    }
    const range = `from ${format(lo[1])} (${lo[0]}) to ${format(hi[1])} (${hi[0]})`;
    const last = data.kind === 'line' || data.kind === 'area' ? `, last ${format(s.points[s.points.length - 1][1])}` : '';
    parts.push(data.series.length > 1 ? `${s.name}: ${range}${last}` : `${range}${last}`);
  }
  const count = data.series.length > 1 ? `${data.series.length} series of ${n} ${unit}` : `${n} ${unit}`;
  const more = data.more ? ' More groups exist than are shown.' : '';
  return `${kind}, ${data.title}: ${count}; ${parts.join('; ')}.${more}`;
}

/** The chart as a table (§20.8): one row per label, a column per series — with a pie's share of the whole. */
export function chartRows(data: ChartData, format: Format): { head: string[]; rows: string[][] } {
  const round = data.kind === 'pie' || data.kind === 'donut';
  const head = ['', ...data.series.map((s) => s.name), ...(round ? ['Share'] : [])];
  const total = round ? data.series[0].points.reduce((a, p) => a + p[1], 0) : 0;
  const rows = data.series[0].points.map(([label], i) => [
    label,
    ...data.series.map((s) => format(s.points[i][1])),
    ...(round ? [`${Math.round((data.series[0].points[i][1] / total) * 1000) / 10}%`] : []),
  ]);
  return { head, rows };
}
