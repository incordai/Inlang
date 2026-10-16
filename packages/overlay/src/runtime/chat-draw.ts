/**
 * @az runtime chat-draw
 * Purpose: draws an answer's chart, table, stat cards, image cards, dashboard or unavailable note into copies of the chat word's templates.
 * Spec: docs/chat-block-spec.md §20.2, §20.4, §20.6, §20.8, §21.2.4
 * Exports: drawRich, RichDraw, RICH_KEYS, DRAW_COPY, frame, tableOf, drawChart, formatter, provenance, clonePart, slot, fill, drop
 * Edit guide: text only through textContent; attributes only geometry, classes copied from the templates, ids, aria and
 *   checked URLs (a destination on the allow-list, a row image at the backend's own path); never a style or markup.
 * Tests: scripts/chat-e2e.mjs, packages/overlay/test/chat-figures.test.ts
 */

/**
 * Every event is checked first (chat-chart.ts validChart, chat-figures.ts),
 * then drawn into clones of the hidden parts the chat word made
 * (words/chat/figures.ts): a figure's frame with its title, the
 * "AI-generated figures" label — removed only for the site's own figures
 * and a tool's — or the source line ("From the site's data · <day>", or
 * "From <the operator's label> · <minute>" for a tool's), the SVG, a one-sentence summary and the same figures
 * as a real table; a table with sortable headers; stat cards whose change is
 * a sign, a glyph and words; image cards whose image is a template's <img>
 * or the backend's own row image; a dashboard's grid of these.
 *
 * A chart is drawn for the width its answer has, and drawn again when that
 * width changes by 32 px or more, so its text stays the theme's size.
 */

import { SERIES_PATTERNS, chartBox, chartGeometry, chartRows, chartSummary, validChart, type ChartData, type FigureSource, type SvgNode } from './chat-chart.ts';
import {
  announceOf, deltaWords, sortedRows, validCards, validDashboard, validStats, validTable, writeSvg,
  type CardItem, type FigureContext, type StatItem, type TableData, type Tile,
} from './chat-figures.ts';

/** The block keys this module draws. */
export const RICH_KEYS = ['chart', 'table', 'stats', 'cards', 'dashboard', 'unavailable'] as const;

/** Fixed copy the drawing adds (the rest is in the templates). */
export const DRAW_COPY = {
  ai: 'AI-generated figures',
  /** Before a tool's label: "From <label> · <date, time> UTC" (§21.2.4). */
  from: 'From',
} as const;

/** A redraw happens only past this change in width. */
const REDRAW_PX = 32;
/** The width a chart is drawn at before its answer has been laid out. */
const FALLBACK_WIDTH = 640;
const FALLBACK_FONT = 14;

export interface RichDraw {
  readonly doc: Document;
  /** The shell's hidden parts container. */
  readonly components: HTMLElement;
  /** The allow-list check, the backend's origin; assets come from the parts. */
  readonly allowed: (to: string) => boolean;
  /** Writes a checked destination on an anchor — chat.ts setDestination, the one place a link is written. */
  readonly link: (anchor: Element, to: string) => boolean;
  readonly backend: string;
  /** The answer element the component goes in: its width is the chart's. */
  readonly within: HTMLElement;
  /** Unique per drawn component: its ids and pattern ids end with it. */
  readonly suffix: string;
  /** Watches a drawn chart's width; returns the stop. */
  readonly observe?: (el: Element, redraw: () => void) => () => void;
}

const partEl = (components: HTMLElement, key: string, extra?: [string, string]): HTMLElement | null => {
  for (const el of components.children) {
    if (el.getAttribute('data-az-chat-part') !== key) continue;
    if (extra && el.getAttribute(extra[0]) !== extra[1]) continue;
    return el.firstElementChild as HTMLElement | null;
  }
  return null;
};
export const clonePart = (components: HTMLElement, key: string): HTMLElement | null => {
  const el = partEl(components, key);
  return el ? el.cloneNode(true) as HTMLElement : null;
};
/** A slot by its name — names are this module's constants, never network text. */
export const slot = (root: Element, name: string): HTMLElement | null => root.querySelector<HTMLElement>(`[data-az-chat-slot="${name}"]`);
export const fill = (root: Element, name: string, text: string) => {
  const el = slot(root, name);
  if (el) el.textContent = text;
};
export const drop = (root: Element, name: string) => slot(root, name)?.remove();

/** The page's language, for numbers and dates. */
const langOf = (doc: Document) => doc.documentElement.lang || 'en';

/** A number as the page shows it, in its unit: a currency, a percentage, or none. */
export function formatter(doc: Document, unit: string | null): (n: number) => string {
  const lang = langOf(doc);
  let f: Intl.NumberFormat;
  try {
    f = unit === 'percent'
      ? new Intl.NumberFormat(lang, { style: 'unit', unit: 'percent', maximumFractionDigits: 2 })
      : unit ? new Intl.NumberFormat(lang, { style: 'currency', currency: unit.toUpperCase() })
        : new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
  } catch {
    // A currency code the browser does not know: the number and the code, as text.
    const plain = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
    return (n) => `${plain.format(n)} ${unit?.toUpperCase() ?? ''}`.trim();
  }
  const compact = new Intl.NumberFormat(lang, { notation: 'compact', maximumFractionDigits: 1 });
  return (n) => (unit === null && Math.abs(n) >= 10_000 ? compact.format(n) : f.format(n));
}

/** A `YYYY-MM-DD` day as the page shows it, in UTC. */
function dayText(doc: Document, day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Intl.DateTimeFormat(langOf(doc), { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** A `YYYY-MM-DDTHH:MMZ` minute as the page shows it, in UTC, said so. */
function minuteText(doc: Document, minute: string): string {
  const at = new Date(`${minute.slice(0, 16)}:00Z`);
  return `${new Intl.DateTimeFormat(langOf(doc), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(at)} UTC`;
}

/** A tool's source line: the operator's label and when its figures were read — operator copy and the server's clock, never the model's. */
const toolLine = (doc: Document, source: string, asOf: string) => `${DRAW_COPY.from} ${source} · ${minuteText(doc, asOf)}`;

/** What a stat card says of where its figure came from: the AI label, a tool's source line, or the site's read day. */
export function provenance(doc: Document, src: FigureSource, asOf: string | null, source: string | null): string {
  if (src === 'model') return DRAW_COPY.ai;
  if (src === 'tool') return source && asOf ? toolLine(doc, source, asOf) : '';
  return asOf ? dayText(doc, asOf) : '';
}

/** What the page knows that an event cannot tell it: its gallery images (from the parts), the allow-list, the backend. */
function figureContext(d: RichDraw): FigureContext {
  const assets = new Map<string, { src: string; srcset: string | null; width: number; height: number; alt: string }>();
  for (const el of d.components.children) {
    const key = el.getAttribute('data-az-chat-asset');
    const img = el.firstElementChild;
    if (el.getAttribute('data-az-chat-part') !== 'asset' || key === null || !img) continue;
    assets.set(key, {
      src: img.getAttribute('src') ?? '', srcset: img.getAttribute('srcset'), alt: img.getAttribute('alt') ?? '',
      width: Number(img.getAttribute('width') ?? 0), height: Number(img.getAttribute('height') ?? 0),
    });
  }
  return { assets, allowed: d.allowed, backend: d.backend };
}

/** A figure's frame: title, then the AI label for model figures or the source line for the site's or a tool's. */
export function frame(d: RichDraw, title: string, src: FigureSource, asOf: string | null, source: string | null): HTMLElement | null {
  const f = clonePart(d.components, 'figure');
  if (!f) return null;
  fill(f, 'title', title);
  if (src === 'site') {
    f.querySelector('[data-az-chat-ai]')?.remove();
    fill(f, 'asOf', asOf ? dayText(d.doc, asOf) : '');
  } else if (src === 'tool') {
    f.querySelector('[data-az-chat-ai]')?.remove();
    const line = f.querySelector('[data-az-chat-source]');
    if (line) line.textContent = source && asOf ? toolLine(d.doc, source, asOf) : '';
  } else {
    f.querySelector('[data-az-chat-source]')?.remove();
  }
  return f;
}

/** The class a chart part is painted with: the matching element's in the paint template. */
function painter(d: RichDraw): ((part: string) => string | null) | null {
  const paint = partEl(d.components, 'paint');
  if (!paint) return null;
  const classes = new Map<string, string>();
  for (const el of paint.children) {
    const name = el.getAttribute('data-az-chat-paint');
    const cls = el.getAttribute('class');
    if (name && cls) classes.set(name, cls);
  }
  return (part) => classes.get(part) ?? null;
}

/** The theme's small text size in px, read from the tick paint (the chart's labels), for label widths. */
function fontOf(d: RichDraw): number {
  const tick = partEl(d.components, 'paint')?.querySelector('[data-az-chat-paint="tick"]');
  const view = d.doc.defaultView;
  const px = tick && view ? parseFloat(view.getComputedStyle(tick).fontSize) : NaN;
  return Number.isFinite(px) && px > 0 ? px : FALLBACK_FONT;
}

/** A table element from the table part: caption, headers (sortable when asked), rows. */
export function tableOf(d: RichDraw, id: string, caption: string, head: readonly { label: string; type: 'text' | 'number'; unit: string | null }[],
  rows: readonly (readonly (string | number | null)[])[], sortable: boolean): HTMLElement | null {
  const wrap = clonePart(d.components, 'table');
  if (!wrap) return null;
  const headRow = slot(wrap, 'head');
  const bodyRow = slot(wrap, 'row');
  const th = slot(wrap, 'th');
  const thSort = slot(wrap, 'th-sort');
  const td = slot(wrap, 'td');
  const tdNum = slot(wrap, 'td-number');
  if (!headRow || !bodyRow || !th || !thSort || !td || !tdNum) return null;
  fill(wrap, 'caption', caption);
  const captionId = `az-chat-cap-${id}`;
  slot(wrap, 'caption')?.setAttribute('id', captionId);
  wrap.setAttribute('aria-labelledby', captionId);
  const tbody = bodyRow.parentElement!;
  const formats = head.map((h) => formatter(d.doc, h.unit));
  const draw = (list: readonly (readonly (string | number | null)[])[]) => {
    tbody.replaceChildren(...list.map((r) => {
      const tr = bodyRow.cloneNode(false) as HTMLElement;
      r.forEach((cell, i) => {
        const c = (head[i].type === 'number' ? tdNum : td).cloneNode(false) as HTMLElement;
        c.removeAttribute('data-az-chat-slot');
        c.textContent = cell === null ? '' : typeof cell === 'number' ? formats[i](cell) : cell;
        tr.append(c);
      });
      tr.removeAttribute('data-az-chat-slot');
      return tr;
    }));
  };
  const collator = new Intl.Collator(langOf(d.doc));
  const cells: HTMLElement[] = head.map((h) => {
    const c = (sortable ? thSort : th).cloneNode(true) as HTMLElement;
    c.removeAttribute('data-az-chat-slot');
    const label = sortable ? c.querySelector('button') : c;
    if (label) label.textContent = h.label;
    return c;
  });
  if (sortable) {
    cells.forEach((c, i) => {
      c.querySelector('button')?.addEventListener('click', () => {
        const next = c.getAttribute('aria-sort') === 'ascending' ? 'descending' : 'ascending';
        for (const other of cells) other.setAttribute('aria-sort', 'none');
        c.setAttribute('aria-sort', next);
        draw(sortedRows(rows, i, head[i].type, next, collator));
      });
    });
  }
  headRow.replaceChildren(...cells);
  headRow.removeAttribute('data-az-chat-slot');
  draw(rows);
  return wrap;
}

/** A chart in its frame: the SVG, its summary, its legend, its table equivalent; redrawn when its width changes. */
export function drawChart(d: RichDraw, c: ChartData): HTMLElement | null {
  const classOf = painter(d);
  const f = frame(d, c.title, c.src, c.asOf, c.source);
  const body = f && slot(f, 'body');
  if (!f || !body || !classOf) return null;
  const fmt = formatter(d.doc, c.unit);
  const summaryId = `az-chat-sum-${d.suffix}`;
  const summary = slot(f, 'summary');
  if (summary) {
    summary.id = summaryId;
    summary.textContent = chartSummary(c, fmt);
  }
  const font = fontOf(d);
  let drawnWidth = -1;
  const render = () => {
    const width = d.within.clientWidth || FALLBACK_WIDTH;
    if (Math.abs(width - drawnWidth) < REDRAW_PX) return;
    drawnWidth = width;
    const svg = writeSvg(d.doc, chartGeometry(c, chartBox(width, font), `az-chat-${d.suffix}`, fmt), classOf);
    const own = classOf('svg');
    if (own) svg.setAttribute('class', own);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-labelledby', summaryId);
    body.replaceChildren(svg);
  };
  render();
  // The legend: every series by name with its paint, when there is more than one, and every slice of a pie.
  const legend = slot(f, 'legend');
  const item = slot(f, 'legend-item');
  const round = c.kind === 'pie' || c.kind === 'donut';
  const keys = round ? c.series[0].points.map((p) => p[0]) : c.series.length > 1 ? c.series.map((s) => s.name) : [];
  if (legend && item && keys.length > 0) {
    const total = round ? c.series[0].points.reduce((a, p) => a + p[1], 0) : 0;
    legend.replaceChildren(...keys.map((name, i) => {
      const li = item.cloneNode(true) as HTMLElement;
      li.removeAttribute('data-az-chat-slot');
      const share = round ? ` — ${Math.round((c.series[0].points[i][1] / total) * 1000) / 10}%` : '';
      fill(li, 'name', `${name}${share}`);
      const swatch = slot(li, 'swatch');
      if (swatch) {
        const box: SvgNode = { tag: 'svg', attrs: { viewBox: '0 0 16 16', width: '16', height: '16', focusable: 'false', 'aria-hidden': 'true' }, children: [
          ...(i > 0 ? [{ tag: 'defs' as const, attrs: {}, children: [{ tag: 'pattern' as const, attrs: { id: `az-chat-${d.suffix}-k${i + 1}`, width: '8', height: '8', patternUnits: 'userSpaceOnUse' }, children: [
            { tag: 'rect' as const, attrs: { width: '8', height: '8' }, part: `fill-${i + 1}` },
            { tag: 'path' as const, attrs: { d: SERIES_PATTERNS[i] ?? '' }, part: 'pattern-ink' },
          ] }] }] : []),
          i > 0
            ? { tag: 'rect' as const, attrs: { width: '16', height: '16', fill: `url(#az-chat-${d.suffix}-k${i + 1})` }, part: `patterned-${i + 1}` }
            : { tag: 'rect' as const, attrs: { width: '16', height: '16' }, part: 'fill-1' },
        ] };
        swatch.replaceChildren(writeSvg(d.doc, box, classOf));
      }
      return li;
    }));
  } else {
    legend?.remove();
  }
  // §20.8: the same figures as a real table, behind a disclosure.
  const equivalent = slot(f, 'equivalent');
  const rows = chartRows(c, fmt);
  // Already formatted: every cell is text, read as the chart shows it.
  const t = tableOf(d, `${d.suffix}-eq`, c.title, rows.head.map((h) => ({ label: h === '' ? (round ? 'Slice' : 'Label') : h, type: 'text' as const, unit: null })), rows.rows, false);
  if (equivalent && t) equivalent.replaceChildren(t);
  else drop(f, 'details');
  if (d.observe) d.observe(f, render);
  return f;
}

/** A table in its frame (no summary, legend or equivalent: it is the figures). */
function drawTable(d: RichDraw, t: TableData): HTMLElement | null {
  const f = frame(d, t.title, t.src, t.asOf, t.source);
  const body = f && slot(f, 'body');
  const table = tableOf(d, d.suffix, t.title, t.columns, t.rows, t.sortable);
  if (!f || !body || !table) return null;
  body.replaceChildren(table);
  for (const name of ['summary', 'legend', 'details']) drop(f, name);
  return f;
}

/** Stat cards: each its label, value, change in words, and its source or the AI label. */
function drawStats(d: RichDraw, items: readonly StatItem[]): HTMLElement | null {
  const list = clonePart(d.components, 'stats');
  const proto = list && slot(list, 'stat');
  if (!list || !proto) return null;
  list.replaceChildren(...items.map((s) => {
    const card = proto.cloneNode(true) as HTMLElement;
    card.removeAttribute('data-az-chat-slot');
    const fmt = formatter(d.doc, s.unit);
    fill(card, 'label', s.label);
    fill(card, 'value', fmt(s.value));
    if (s.delta === null) drop(card, 'delta');
    else {
      const w = deltaWords(s.delta, fmt, s.deltaOf);
      fill(card, 'glyph', w.glyph);
      fill(card, 'words', w.words);
    }
    fill(card, 'ai', provenance(d.doc, s.src, s.asOf, s.source));
    return card;
  }));
  return list;
}

/** Image cards: a template image or the backend's row image, a title, text, a checked link. */
function drawCards(d: RichDraw, items: readonly CardItem[]): HTMLElement | null {
  const list = clonePart(d.components, 'cards');
  const proto = list && slot(list, 'card');
  if (!list || !proto) return null;
  list.replaceChildren(...items.map((c) => {
    const card = proto.cloneNode(true) as HTMLElement;
    card.removeAttribute('data-az-chat-slot');
    const media = slot(card, 'media');
    const img = c.image === null ? null : c.image.kind === 'asset' ? assetImage(d, c.image.key) : rowImage(d, c.image);
    if (img && media) media.replaceChildren(img);
    else media?.remove();
    fill(card, 'title', c.title);
    if (c.text) fill(card, 'text', c.text);
    else drop(card, 'text');
    const link = slot(card, 'link');
    if (c.link && link && d.link(link, c.link.to)) link.textContent = c.link.label;
    else link?.remove();
    // A tool's card says where it came from, as a tool's figures do: operator copy, as text (§19.11).
    if (c.source) fill(card, 'source', toolLine(d.doc, c.source.label, c.source.asOf));
    else drop(card, 'source');
    return card;
  }));
  return list;
}

/** A gallery image a card names by key: a copy of the build's own <img> — its file, srcset, size and alt the build's. */
function assetImage(d: RichDraw, key: string): HTMLElement | null {
  const img = partEl(d.components, 'asset', ['data-az-chat-asset', key]);
  return img ? img.cloneNode(true) as HTMLElement : null;
}

/** The backend's path for a row's image, exactly: `/data/<table>/<id>/<field>?v=…`, copies with `&w=<n>`. */
const ROW_IMAGE = /^\/data\/[a-z][a-z0-9]*\/[0-9a-f-]{36}\/[a-z][a-z0-9]*\?v=[A-Za-z0-9_-]{1,64}(?:&w=\d{1,5})?$/;

/**
 * A row's image (§20.6) on a copy of the row-image template — the one place
 * a chat answer writes an image address, and only the backend's own path for
 * that row's field, on the backend's origin (chat-figures.ts checked it; it
 * is checked again here, each candidate of the srcset too).
 */
function rowImage(d: RichDraw, image: Extract<CardItem['image'], { kind: 'row' }>): HTMLElement | null {
  const template = partEl(d.components, 'row-image');
  let backend: URL;
  try { backend = new URL(d.backend); } catch { return null; }
  const ours = (u: string) => {
    try {
      const url = new URL(u);
      return url.origin === backend.origin && ROW_IMAGE.test(`${url.pathname}${url.search}`);
    } catch {
      return false;
    }
  };
  const set = image.srcset?.split(', ').every((c) => ours(c.split(' ')[0])) ?? true;
  if (!template || !ours(image.src) || !set) return null;
  const img = template.cloneNode(true) as HTMLElement;
  img.setAttribute('src', image.src);
  if (image.srcset) img.setAttribute('srcset', image.srcset);
  if (image.width > 0 && image.height > 0) {
    img.setAttribute('width', String(image.width));
    img.setAttribute('height', String(image.height));
  }
  return img;
}

/** The note a component becomes when its figures could not be read. */
function drawUnavailable(d: RichDraw, title: string): HTMLElement | null {
  const note = clonePart(d.components, 'unavailable');
  if (note) fill(note, 'title', title);
  return note;
}

/** One dashboard tile, drawn as its own kind; charts and tables span two columns. */
function drawTile(d: RichDraw, tile: Tile, n: number): { el: HTMLElement; wide: boolean } | null {
  const sub: RichDraw = { ...d, suffix: `${d.suffix}-t${n}` };
  if (tile.kind === 'stat') { const el = drawStats(sub, [tile.stat]); return el ? { el, wide: false } : null; }
  if (tile.kind === 'chart') { const el = drawChart(sub, tile.chart); return el ? { el, wide: true } : null; }
  if (tile.kind === 'table') { const el = drawTable(sub, tile.table); return el ? { el, wide: true } : null; }
  if (tile.kind === 'card') { const el = drawCards(sub, [tile.card]); return el ? { el, wide: false } : null; }
  const el = drawUnavailable(sub, tile.title);
  return el ? { el, wide: false } : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * One rich component, `word` its block key and `data` its value, checked
 * then drawn — with what the status region says of it — or null when it
 * does not check out or the shell has no template for it.
 */
export function drawRich(d: RichDraw, word: string, data: unknown): { el: HTMLElement; said: string } | null {
  const ctx = figureContext(d);
  switch (word) {
    case 'chart': {
      const c = validChart(data);
      const el = c && drawChart(d, c);
      return c && el ? { el, said: announceOf({ kind: 'chart', data: c }) } : null;
    }
    case 'table': {
      const t = validTable(data);
      const el = t && drawTable(d, t);
      return t && el ? { el, said: announceOf({ kind: 'table', data: t }) } : null;
    }
    case 'stats': {
      const s = validStats(data);
      const el = s && drawStats(d, s);
      return s && el ? { el, said: announceOf({ kind: 'stats', data: s }) } : null;
    }
    case 'cards': {
      const c = validCards(data, ctx);
      const el = c && drawCards(d, c);
      return c && el ? { el, said: announceOf({ kind: 'cards', data: c }) } : null;
    }
    case 'dashboard': {
      const dash = validDashboard(data, ctx);
      const root = clonePart(d.components, 'dashboard');
      const grid = root && slot(root, 'tiles');
      const tile = grid && slot(grid, 'tile');
      const wideTile = grid && slot(grid, 'tile-wide');
      if (!dash || !root || !grid || !tile || !wideTile) return null;
      const titleId = `az-chat-dash-${d.suffix}`;
      fill(root, 'title', dash.title);
      slot(root, 'title')?.setAttribute('id', titleId);
      root.setAttribute('aria-labelledby', titleId);
      grid.replaceChildren(...dash.tiles.map((t, n) => {
        const drawn = drawTile(d, t, n);
        const holder = (drawn?.wide ? wideTile : tile).cloneNode(false) as HTMLElement;
        holder.removeAttribute('data-az-chat-slot');
        if (drawn) holder.append(drawn.el);
        return holder;
      }));
      return { el: root, said: announceOf({ kind: 'dashboard', data: dash }) };
    }
    case 'unavailable': {
      if (!isRecord(data) || typeof data.title !== 'string' || data.title.length > 80) return null;
      const el = drawUnavailable(d, data.title);
      return el ? { el, said: `${data.title}: the figures could not be loaded.` } : null;
    }
    default:
      return null;
  }
}
