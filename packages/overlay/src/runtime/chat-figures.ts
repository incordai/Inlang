/**
 * @az runtime chat-figures
 * Purpose: an answer's table, stat cards, image cards and dashboard as the page checks them — closed shapes, every limit, images by key or by the server's own row path only — plus table sorting, delta wording, announcements and the SVG writer.
 * Spec: docs/chat-block-spec.md §20.2, §20.4, §20.6, §20.8
 * Exports: TableData, StatItem, CardItem, CardImageRef, DashboardData, Tile, FigureContext, FIGURE_LIMITS, validTable, validStats,
 *   validCards, validDashboard, sortedRows, deltaWords, announceOf, writeSvg, SvgDocument, SvgElementLike, SVG_ATTRIBUTES
 * Edit guide: nothing from the network is trusted twice — a value over a limit, an unknown key, a URL that is not the
 *   backend's own image path for that very row, is refused whole. No DOM here: writeSvg takes any document-like
 *   object and writes only allow-listed geometry attributes and a class per part.
 * Tests: packages/overlay/test/chat-figures.test.ts
 */

/**
 * The server validated and clamped every component (chat-block-spec §20.2);
 * the page checks again because it renders, and a forged or damaged event
 * must be inert. The rules are the server's limits: after its clamp, an
 * over-long value can only be a forgery, so the component is ignored whole.
 *
 * Images (§20.6) never come as a URL the model wrote. A build asset is a
 * key looked up in the shell's own table (`FigureContext.assets`); a row's
 * image must be exactly the path the backend serves that row's field at,
 * on the backend's origin — anything else, and the card keeps its text and
 * shows no image.
 */

import { sourceOf, validChart, type ChartData, type FigureSource, type SvgNode } from './chat-chart.ts';
import { rowSrcset, type RowImage } from './rows-logic.ts';

export const FIGURE_LIMITS = {
  title: 80,
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
  /** Charts and tables among a dashboard's tiles. */
  heavyTiles: 4,
} as const;

const VALUE_MAX = 1e15;
const CURRENCY = /^[a-z]{3}$/;
const KEY = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME = /^[a-z][a-z0-9]*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && [...v].length <= max;
const maybeText = (v: unknown, max: number): v is string => typeof v === 'string' && [...v].length <= max;
const figure = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= VALUE_MAX;
const unitOk = (v: unknown): v is string | null | undefined => v === null || v === undefined || v === 'percent' || (typeof v === 'string' && CURRENCY.test(v));


/** What the page knows that the event cannot tell it: its build assets, its allow-list, its backend. */
export interface FigureContext {
  /** Build asset keys → the shell's own image (src, srcset, size, the author's alt). */
  readonly assets: ReadonlyMap<string, { readonly src: string; readonly srcset: string | null; readonly width: number; readonly height: number; readonly alt: string }>;
  /** Whether a destination is on the shell's allow-list (chat-block-spec §6.2). */
  readonly allowed: (to: string) => boolean;
  /** The backend's origin, `https://api.example` — where row images live. */
  readonly backend: string;
}

export interface TableData {
  readonly title: string;
  readonly columns: readonly { readonly label: string; readonly type: 'text' | 'number'; readonly unit: string | null }[];
  readonly rows: readonly (readonly (string | number | null)[])[];
  readonly sortable: boolean;
  readonly src: FigureSource;
  readonly asOf: string | null;
  readonly source: string | null;
}

export function validTable(v: unknown): TableData | null {
  if (!isRecord(v) || !only(v, ['title', 'columns', 'rows', 'sortable', 'src', 'asOf', 'source'])) return null;
  const from = sourceOf(v);
  if (!from || !text(v.title, FIGURE_LIMITS.title)) return null;
  if (v.sortable !== undefined && typeof v.sortable !== 'boolean') return null;
  if (!Array.isArray(v.columns) || v.columns.length < 1 || v.columns.length > FIGURE_LIMITS.columns) return null;
  const columns: TableData['columns'][number][] = [];
  for (const c of v.columns) {
    if (!isRecord(c) || !only(c, ['label', 'type', 'unit']) || !text(c.label, FIGURE_LIMITS.header)) return null;
    if (c.type !== 'text' && c.type !== 'number') return null;
    if (!unitOk(c.unit) || (c.type === 'text' && c.unit !== undefined && c.unit !== null)) return null;
    columns.push({ label: c.label, type: c.type, unit: (c.unit ?? null) as string | null });
  }
  if (!Array.isArray(v.rows) || v.rows.length < 1 || v.rows.length > FIGURE_LIMITS.rows) return null;
  const rows: (string | number | null)[][] = [];
  for (const r of v.rows) {
    if (!Array.isArray(r) || r.length !== columns.length) return null;
    const row: (string | number | null)[] = [];
    for (let i = 0; i < r.length; i++) {
      const cell = r[i];
      if (cell === null) row.push(null);
      else if (columns[i].type === 'number' ? !figure(cell) : !maybeText(cell, FIGURE_LIMITS.cell)) return null;
      else row.push(cell === 0 ? 0 : cell as string | number);
    }
    rows.push(row);
  }
  return { title: v.title, columns, rows, sortable: v.sortable === true, ...from };
}

export interface StatItem {
  readonly label: string;
  readonly value: number;
  readonly unit: string | null;
  readonly delta: number | null;
  /** Site and tool figures only: what the delta is measured against, e.g. "2026-09". */
  readonly deltaOf: string | null;
  readonly src: FigureSource;
  readonly asOf: string | null;
  readonly source: string | null;
}

function validStat(v: unknown): StatItem | null {
  if (!isRecord(v) || !only(v, ['label', 'value', 'unit', 'delta', 'deltaOf', 'src', 'asOf', 'source'])) return null;
  const from = sourceOf(v);
  if (!from || !text(v.label, FIGURE_LIMITS.statLabel) || !figure(v.value) || !unitOk(v.unit)) return null;
  if (v.delta !== undefined && v.delta !== null && !figure(v.delta)) return null;
  if (v.deltaOf !== undefined && v.deltaOf !== null && (from.src === 'model' || !text(v.deltaOf, 24))) return null;
  return {
    label: v.label, value: v.value === 0 ? 0 : v.value, unit: (v.unit ?? null) as string | null,
    delta: typeof v.delta === 'number' ? v.delta : null, deltaOf: typeof v.deltaOf === 'string' ? v.deltaOf : null, ...from,
  };
}

export function validStats(v: unknown): StatItem[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > FIGURE_LIMITS.stats) return null;
  const out: StatItem[] = [];
  for (const s of v) {
    const ok = validStat(s);
    if (!ok) return null;
    out.push(ok);
  }
  return out;
}

export type CardImageRef =
  | { readonly kind: 'asset'; readonly key: string; readonly src: string; readonly srcset: string | null; readonly width: number; readonly height: number; readonly alt: string }
  | { readonly kind: 'row'; readonly src: string; readonly srcset: string | null; readonly width: number; readonly height: number; readonly alt: '' };

export interface CardItem {
  readonly title: string;
  readonly text: string | null;
  readonly image: CardImageRef | null;
  readonly link: { readonly label: string; readonly to: string } | null;
  /** A tool's card (`cards from tool`, chat-block-spec §19.11): the operator's label and the minute it was read; null for any other card. */
  readonly source: { readonly label: string; readonly asOf: string } | null;
}

/**
 * A row image is accepted only as the exact path the backend serves that
 * row's field at — `<backend>/data/<table>/<id>/<field>?v=<version>`, and
 * each copy that path with `&w=<width>` — on the backend's own origin.
 */
function rowImage(v: unknown, ctx: FigureContext): CardImageRef | null {
  if (!isRecord(v) || !only(v, ['row', 'url', 'width', 'height', 'variants']) || !isRecord(v.row)) return null;
  const { table, id, field } = v.row;
  if (typeof table !== 'string' || !NAME.test(table) || typeof id !== 'string' || !UUID.test(id) || typeof field !== 'string' || !NAME.test(field)) return null;
  if (typeof v.url !== 'string') return null;
  let url: URL;
  let backend: URL;
  try {
    url = new URL(v.url);
    backend = new URL(ctx.backend);
  } catch {
    return null;
  }
  const path = `/data/${table}/${id}/${field}`;
  const version = url.searchParams.get('v');
  const exact = url.origin === backend.origin && url.pathname === `${backend.pathname.replace(/\/$/, '')}${path}`
    && [...url.searchParams.keys()].join() === 'v' && version !== null && /^[A-Za-z0-9_-]{1,64}$/.test(version);
  if (!exact) return null;
  const width = typeof v.width === 'number' && Number.isSafeInteger(v.width) && v.width > 0 ? v.width : 0;
  const height = typeof v.height === 'number' && Number.isSafeInteger(v.height) && v.height > 0 ? v.height : 0;
  const variants: { url: string; width: number }[] = [];
  if (v.variants !== undefined) {
    if (!Array.isArray(v.variants)) return null;
    for (const x of v.variants) {
      if (!isRecord(x) || typeof x.url !== 'string' || typeof x.width !== 'number' || !Number.isSafeInteger(x.width)) return null;
      if (x.url !== `${url.href}&w=${x.width}`) return null;
      variants.push({ url: x.url, width: x.width });
    }
  }
  const image: RowImage = { url: url.href, width, height, variants };
  return { kind: 'row', src: url.href, srcset: rowSrcset(image, ctx.backend), width, height, alt: '' };
}

function validCard(v: unknown, ctx: FigureContext): CardItem | null {
  if (!isRecord(v) || !only(v, ['title', 'text', 'image', 'link', 'src', 'source', 'asOf']) || !text(v.title, FIGURE_LIMITS.cardTitle)) return null;
  // Only a tool's card says where it came from, with both its label and its minute; a card with neither says nothing (§19.11).
  let source: CardItem['source'] = null;
  if (v.src !== undefined || v.source !== undefined || v.asOf !== undefined) {
    const from = sourceOf(v);
    if (!from || from.src !== 'tool' || from.source === null || from.asOf === null) return null;
    source = { label: from.source, asOf: from.asOf };
  }
  if (v.text !== undefined && v.text !== null && !maybeText(v.text, FIGURE_LIMITS.cardText)) return null;
  let image: CardImageRef | null = null;
  if (isRecord(v.image) && only(v.image, ['asset']) && typeof v.image.asset === 'string' && KEY.test(v.image.asset)) {
    const a = ctx.assets.get(v.image.asset);
    image = a ? { kind: 'asset', key: v.image.asset, ...a } : null;
  } else if (v.image !== undefined && v.image !== null) {
    image = rowImage(v.image, ctx);
  }
  let link: CardItem['link'] = null;
  if (v.link !== undefined && v.link !== null) {
    // A link off the allow-list drops the card, as a cta is dropped (§6.2): never a link elsewhere.
    if (!isRecord(v.link) || !only(v.link, ['label', 'to']) || !text(v.link.label, FIGURE_LIMITS.linkLabel)
      || typeof v.link.to !== 'string' || !ctx.allowed(v.link.to)) return null;
    link = { label: v.link.label, to: v.link.to };
  }
  return { title: v.title, text: typeof v.text === 'string' && v.text !== '' ? v.text : null, image, link, source };
}

export function validCards(v: unknown, ctx: FigureContext): CardItem[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > FIGURE_LIMITS.cards) return null;
  const out: CardItem[] = [];
  for (const c of v) {
    const ok = validCard(c, ctx);
    if (!ok) return null;
    out.push(ok);
  }
  return out;
}

export type Tile =
  | { readonly kind: 'unavailable'; readonly title: string }
  | { readonly kind: 'stat'; readonly stat: StatItem }
  | { readonly kind: 'chart'; readonly chart: ChartData }
  | { readonly kind: 'table'; readonly table: TableData }
  | { readonly kind: 'card'; readonly card: CardItem };

export interface DashboardData {
  readonly title: string;
  readonly tiles: readonly Tile[];
}

export function validDashboard(v: unknown, ctx: FigureContext): DashboardData | null {
  if (!isRecord(v) || !only(v, ['title', 'tiles']) || !text(v.title, FIGURE_LIMITS.title)) return null;
  if (!Array.isArray(v.tiles) || v.tiles.length < 2 || v.tiles.length > FIGURE_LIMITS.tiles) return null;
  const tiles: Tile[] = [];
  for (const t of v.tiles) {
    if (!isRecord(t) || Object.keys(t).length !== 1) return null;
    if ('unavailable' in t) {
      // A tile whose figures the server could not read in time (chat-block-spec §20.5).
      if (!isRecord(t.unavailable) || !only(t.unavailable, ['title']) || !text(t.unavailable.title, FIGURE_LIMITS.title)) return null;
      tiles.push({ kind: 'unavailable', title: t.unavailable.title });
    } else if ('stat' in t) {
      const s = validStat(t.stat);
      if (!s) return null;
      tiles.push({ kind: 'stat', stat: s });
    } else if ('chart' in t) {
      const c = validChart(t.chart);
      if (!c) return null;
      tiles.push({ kind: 'chart', chart: c });
    } else if ('table' in t) {
      const tb = validTable(t.table);
      if (!tb) return null;
      tiles.push({ kind: 'table', table: tb });
    } else if ('card' in t) {
      const c = validCard(t.card, ctx);
      if (!c) return null;
      tiles.push({ kind: 'card', card: c });
    } else {
      return null;
    }
  }
  if (tiles.filter((t) => t.kind === 'chart' || t.kind === 'table').length > FIGURE_LIMITS.heavyTiles) return null;
  return { title: v.title, tiles };
}

/**
 * The rows in a column's order: numbers numerically, text by the collator,
 * empty cells last either way; stable, so equal rows keep the server's order.
 */
export function sortedRows(
  rows: readonly (readonly (string | number | null)[])[], column: number, type: 'text' | 'number', direction: 'ascending' | 'descending',
  collator: Intl.Collator,
): (readonly (string | number | null)[])[] {
  const sign = direction === 'ascending' ? 1 : -1;
  return rows.map((r, i) => [r, i] as const).sort(([a, ia], [b, ib]) => {
    const x = a[column];
    const y = b[column];
    if (x === null || y === null) return x === y ? ia - ib : x === null ? 1 : -1;
    const c = type === 'number' ? (x as number) - (y as number) : collator.compare(String(x), String(y));
    return c === 0 ? ia - ib : sign * c;
  }).map(([r]) => r);
}

/**
 * A delta as glyph and words (§20.2): the sign, ▲ or ▼, and "up"/"down",
 * so the direction is never colour alone — and no colour says whether up is
 * good, which the page cannot know.
 */
export function deltaWords(delta: number, format: (n: number) => string, of: string | null): { glyph: string; words: string } {
  const against = of ? ` vs ${of}` : '';
  if (delta === 0) return { glyph: '', words: `no change${against}` };
  const up = delta > 0;
  return { glyph: up ? '▲' : '▼', words: `${up ? 'up' : 'down'} ${format(Math.abs(delta))}${against}` };
}

/** What the status region says once a component is finished (§20.8), fixed copy. */
export function announceOf(
  c: { kind: 'chart'; data: ChartData } | { kind: 'table'; data: TableData } | { kind: 'stats'; data: readonly StatItem[] }
    | { kind: 'cards'; data: readonly CardItem[] } | { kind: 'dashboard'; data: DashboardData },
): string {
  const ai = (src: FigureSource) => (src === 'model' ? ', AI-generated figures' : '');
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  switch (c.kind) {
    case 'chart': {
      const n = c.data.series[0].points.length;
      const unit = c.data.kind === 'bar' ? ['bar', 'bars'] : c.data.kind === 'pie' || c.data.kind === 'donut' ? ['slice', 'slices'] : ['point', 'points'];
      return `Chart: ${c.data.title}, ${plural(n, unit[0], unit[1])}${ai(c.data.src)}`;
    }
    case 'table': return `Table: ${c.data.title}, ${plural(c.data.rows.length, 'row', 'rows')}${ai(c.data.src)}`;
    case 'stats': return `${plural(c.data.length, 'stat card', 'stat cards')}${c.data.some((s) => s.src === 'model') ? ', AI-generated figures' : ''}`;
    case 'cards': return plural(c.data.length, 'card', 'cards');
    case 'dashboard': {
      const ai = c.data.tiles.some((t) => (t.kind === 'stat' && t.stat.src === 'model') || (t.kind === 'chart' && t.chart.src === 'model') || (t.kind === 'table' && t.table.src === 'model'));
      return `Dashboard: ${c.data.title}, ${plural(c.data.tiles.length, 'tile', 'tiles')}${ai ? ', some AI-generated figures' : ''}`;
    }
  }
}

/** The little of a DOM the writer needs, so this module stays DOM-free (a browser's document fits). */
export interface SvgElementLike<E> {
  setAttribute(name: string, value: string): void;
  appendChild(child: E): unknown;
  textContent: string | null;
}
export interface SvgDocument<E> {
  createElementNS(ns: 'http://www.w3.org/2000/svg', tag: string): E;
}

/** The SVG attributes the writer sets — geometry and structure only; a paint is a class. */
export const SVG_ATTRIBUTES: ReadonlySet<string> = new Set([
  'viewBox', 'width', 'height', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'd', 'points',
  'text-anchor', 'fill-rule', 'patternUnits', 'id', 'focusable', 'fill',
  // A mark's index in reading order (chat-chart.ts MARK_ATTR): what the pointer and the arrow keys find (issue #29).
  'data-az-chat-mark',
]);

/**
 * Builds the SVG for a geometry tree: elements in the SVG namespace,
 * allow-listed attributes only (`fill` only as a reference to a pattern in
 * this same tree), a class per part from `classOf`, text as textContent.
 */
export function writeSvg<E extends SvgElementLike<E>>(
  doc: SvgDocument<E>, node: SvgNode, classOf: (part: string) => string | null, ids: ReadonlySet<string> = collectIds(node),
): E {
  const el = doc.createElementNS('http://www.w3.org/2000/svg', node.tag);
  for (const [k, v] of Object.entries(node.attrs)) {
    if (!SVG_ATTRIBUTES.has(k)) continue;
    if (k === 'fill') {
      const m = /^url\(#([A-Za-z0-9_-]+)\)$/.exec(v);
      if (!m || !ids.has(m[1])) continue;
    }
    el.setAttribute(k, v);
  }
  if (node.part) {
    const cls = classOf(node.part);
    if (cls) el.setAttribute('class', cls);
  }
  if (node.text !== undefined) el.textContent = node.text;
  for (const c of node.children ?? []) el.appendChild(writeSvg(doc, c, classOf, ids));
  return el;
}

function collectIds(node: SvgNode, out: Set<string> = new Set()): Set<string> {
  if (node.tag === 'pattern' && node.attrs.id) out.add(node.attrs.id);
  for (const c of node.children ?? []) collectIds(c, out);
  return out;
}
