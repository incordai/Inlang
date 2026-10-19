/**
 * @az runtime chat-chart-ui
 * Purpose: a drawn chart's values on hover, tap and keyboard focus — a tooltip drawn in the chart, the arrow keys between its marks, the status region told — and its legend entries pointing at their series.
 * Spec: docs/chat-block-spec.md §20.4, §19.18 (issue #29)
 * Exports: wireChart, ChartWiring, ChartFocus
 * Edit guide: attributes only — a class from the paint template, data-state on the marks and legend entries pointed at, the
 *   tooltip's geometry and tabindex; its words by textContent. Pure decisions (which mark, what it says, where the tooltip
 *   sits) are chat-chart.ts's, unit tested there.
 * Tests: packages/chat-render/test/chat-chart.test.ts, scripts/chat-public-e2e.mjs
 */

/**
 * A chart is one stop in the Tab order. Focused, it shows its first mark's
 * tooltip (or the one last shown) and the status region hears it; the arrow
 * keys move to the next or previous mark (Home and End to the ends), each
 * said in turn; Escape hides the tooltip. A pointer over the chart shows the
 * mark under it, quietly; a tap shows it and says it. The mark shown — and
 * every mark of a legend entry pointed at — is marked open, which the paint
 * draws with the focus colour's edge; its legend entry is marked open too.
 */

import { MARK_ATTR, markText, nearestMark, tipPlace, type ChartBox, type ChartData, type ChartMark, type Format } from './chat-chart.ts';

/** Which mark a chart shows, kept across its redraws (a resize draws a new SVG). */
export interface ChartFocus { active: number }

export interface ChartWiring {
  readonly doc: Document;
  readonly svg: SVGSVGElement;
  readonly data: ChartData;
  readonly box: ChartBox;
  readonly marks: readonly ChartMark[];
  readonly format: Format;
  /** The class a paint part is drawn with (the paint template's). */
  readonly classOf: (part: string) => string | null;
  /** The legend's entries, in the legend's order: a pie's slices, or a chart's series; empty without a legend. */
  readonly legend: readonly HTMLElement[];
  /** Tells the status region at once; absent where there is none. */
  readonly announce?: (text: string) => void;
  readonly focus: ChartFocus;
}

const SVG = 'http://www.w3.org/2000/svg';
const OPEN = 'open';
/** The tooltip's padding and height, in the chart's text size. */
const TIP_PAD_EM = 0.6;
const TIP_HEIGHT_EM = 2;

/** Wire one drawn chart; its listeners go with its SVG, which a redraw replaces. */
export function wireChart(w: ChartWiring): void {
  const { doc, svg, data, box, marks, format, legend } = w;
  if (marks.length === 0) return;
  const round = data.kind === 'pie' || data.kind === 'donut';
  const nodes = new Map<number, Element>();
  for (const el of svg.querySelectorAll(`[${MARK_ATTR}]`)) nodes.set(Number(el.getAttribute(MARK_ATTR)), el);
  /** A mark's legend entry: a slice's by its label, a series' by its number; none for a one-series chart. */
  const entryOf = (m: ChartMark): number => (round ? data.series[0].points.findIndex((p) => p[0] === m.label) : data.series.length > 1 ? m.series : -1);

  // The tooltip: a box and a line of text, drawn last so it is over every mark; in the page only while shown.
  const tip = doc.createElementNS(SVG, 'g');
  const rect = doc.createElementNS(SVG, 'rect');
  const text = doc.createElementNS(SVG, 'text');
  const paint = (el: Element, part: string) => { const c = w.classOf(part); if (c) el.setAttribute('class', c); };
  paint(rect, 'tip');
  paint(text, 'tip-text');
  rect.setAttribute('rx', String(Math.round(box.font / 4)));
  tip.append(rect, text);

  const clear = () => {
    for (const el of svg.querySelectorAll(`[${MARK_ATTR}][data-state]`)) el.removeAttribute('data-state');
    for (const li of legend) li.removeAttribute('data-state');
  };
  const hide = () => {
    clear();
    tip.remove();
  };
  /** Mark `i` shown: highlighted, its legend entry too, its tooltip placed over it — and said, when `speak`. */
  const show = (i: number, speak: boolean) => {
    const m = marks[i];
    if (!m) return;
    w.focus.active = i;
    clear();
    nodes.get(i)?.setAttribute('data-state', OPEN);
    legend[entryOf(m)]?.setAttribute('data-state', OPEN);
    const words = markText(data, m, format);
    text.textContent = words;
    svg.append(tip);
    const width = text.getComputedTextLength() + 2 * TIP_PAD_EM * box.font;
    const height = TIP_HEIGHT_EM * box.font;
    const at = tipPlace(m, box, width, height);
    rect.setAttribute('x', String(at.x));
    rect.setAttribute('y', String(at.y));
    rect.setAttribute('width', String(Math.round(width * 100) / 100));
    rect.setAttribute('height', String(height));
    text.setAttribute('x', String(Math.round((at.x + TIP_PAD_EM * box.font) * 100) / 100));
    text.setAttribute('y', String(Math.round((at.y + height * 0.68) * 100) / 100));
    if (speak) w.announce?.(words);
  };
  /** Every mark of legend entry `k` highlighted — a series, or a slice — without a tooltip. */
  const point = (k: number) => {
    clear();
    tip.remove();
    marks.forEach((m, i) => { if (entryOf(m) === k) nodes.get(i)?.setAttribute('data-state', OPEN); });
    // A line series is drawn as its line, too.
    if (!round) for (const line of svg.querySelectorAll('path:not([data-az-chat-mark])')) if (line.getAttribute('class') === w.classOf(`line-${k + 1}`)) line.setAttribute('data-state', OPEN);
    legend[k]?.setAttribute('data-state', OPEN);
  };

  svg.setAttribute('tabindex', '0');
  const focused = () => doc.activeElement === svg;
  svg.addEventListener('focus', () => show(w.focus.active >= 0 ? w.focus.active : 0, true));
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const last = marks.length - 1;
    const at = w.focus.active < 0 ? 0 : w.focus.active;
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? Math.min(last, at + 1)
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? Math.max(0, at - 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
    if (to !== null) {
      e.preventDefault();
      show(to, true);
      return;
    }
    if (e.key === 'Escape' && tip.isConnected) {
      hide();
      // Dismissed here: the panel's own Escape (stop, then close) waits for the next press.
      e.stopPropagation();
    }
  });
  /** The mark under a pointer, in the chart's own pixels. */
  const under = (e: PointerEvent): number => {
    const r = svg.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return -1;
    return nearestMark(data, box, marks, ((e.clientX - r.left) * box.width) / r.width, ((e.clientY - r.top) * box.height) / r.height);
  };
  svg.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const i = under(e);
    if (i >= 0) show(i, false);
    else if (!focused()) hide();
  });
  svg.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    const i = under(e);
    if (i >= 0) show(i, true);
  });
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && !focused()) hide();
  });
  // Legend entries point at their series while the pointer is over them; the shown mark comes back after.
  legend.forEach((li, k) => {
    li.onpointerenter = () => point(k);
    li.onpointerleave = () => (focused() && w.focus.active >= 0 ? show(w.focus.active, false) : hide());
  });
}
