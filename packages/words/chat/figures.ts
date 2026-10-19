/**
 * @az module chat-figures
 * Purpose: the hidden templates an answer's charts, tables, stat cards, image cards, dashboards, explores, maps, share control,
 *   bar buttons and held-component placeholders are drawn from.
 * Spec: docs/chat-block-spec.md §20.4, §20.6, §20.7, §20.8, §21.3.4, §21.4.3, §21.4.5, §19.18
 * Exports: FIGURE_COPY, MAP_COPY, SERIES_PARTS, BAR_ICONS, richParts, assetParts, sharePart, barButton, skeletonParts
 * Edit guide: every paint is a class from a theme token — the runtime copies a part's class, never writes a colour or a style;
 *   a slot the runtime fills is an element marked data-az-chat-slot, filled with textContent only.
 * Tests: packages/words/test/chat-shell.test.ts, scripts/chat-e2e.mjs
 */

/**
 * The page draws a chart as SVG from the typed event (overlay
 * chat-chart.ts). The SVG has no colour of its own: each mark carries a
 * part name ("fill-2", "line-1", "axis"…) and the runtime gives it the class
 * of the matching element in the hidden `paint` template here — so every
 * colour is a series token or a role token, in the generated stylesheet,
 * dark mode included, and the page never writes `fill`, `stroke` or `style`.
 *
 * The other templates are the frame around a figure (its title, the
 * "AI-generated figures" label, the source line, the text summary and the
 * table equivalent), a table's cells, a stat card, an image card, a
 * dashboard's grid, the "could not be loaded" note, each gallery image a
 * card may show, and the share control.
 *
 * An explore (§21.3.4) is a labelled section of real controls — a range
 * input with its label and an <output>, a date input, a radio group, a form
 * of labelled fields and one button — and the views it recomputes. The
 * runtime (overlay chat-explore-draw.ts) clones each control's template,
 * writes its values through properties and its words through textContent.
 */

import { contentShare, px, visuallyHidden, type EmitContext, type EmittedNode, type ThemeLike } from '../../core/src/emit-contract.ts';
import type { SpecChatAnswer } from '../../core/src/spec-block.ts';

/** Fixed copy; never model text. The runtime's own copy lives in overlay chat-draw.ts. */
export const FIGURE_COPY = {
  ai: 'AI-generated figures',
  source: 'From the site’s data',
  details: 'Show the figures as a table',
  unavailable: 'These figures could not be loaded:',
  share: 'Share this answer',
  shareInclude: 'Include my question',
  shareCreate: 'Create link',
  shareLink: 'Link to this answer',
  shareDelete: 'Link to delete it (keep it private)',
} as const;

/** A map's fixed copy (§21.4.3, §21.4.5); the runtime's own is in overlay chat-map.ts MAP_TEXT, the same words. */
export const MAP_COPY = {
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  reset: 'Reset view',
  list: 'Show the places as a list',
  show: 'Show on the map',
} as const;

/** The paint parts a chart's marks name (overlay chat-chart.ts), each a class here. */
export const SERIES_PARTS = [1, 2, 3, 4, 5, 6] as const;
/** A dash per line series past the first, so lines differ by more than colour (§20.4). */
const DASHES = ['', '6 3', '2 3', '8 3 2 3', '1 3', '10 4'] as const;

const slot = (name: string, tag: string, style: EmittedNode['style'], extra: Record<string, string> = {}): EmittedNode =>
  ({ tag, attrs: { 'data-az-chat-slot': name, ...extra }, style, children: [] });

/** One part, as the runtime finds it by `data-az-chat-part`. */
const part = (key: string, node: EmittedNode, extra: Record<string, string> = {}): EmittedNode =>
  ({ tag: 'div', attrs: { class: 'az-chat-part', 'data-az-chat-part': key, ...extra }, style: { minWidth: 0, maxWidth: '100%' }, children: [node] });

/** The paint classes: one SVG element per part name, its style the token the mark is drawn in. */
function paint(t: ThemeLike): EmittedNode {
  // Each series token read by name, so the word's reads list them (theme-reads.ts).
  const tokens = [t.color['series-1'], t.color['series-2'], t.color['series-3'], t.color['series-4'], t.color['series-5'], t.color['series-6']];
  const series = (n: number) => tokens[n - 1];
  const children: EmittedNode[] = [];
  // Issue #29: the mark under the pointer or the arrow keys — and every mark of a legend entry pointed at — is marked
  // open by the runtime (data-state), and drawn with the focus colour's edge on top of its own paint.
  const active = { stroke: t.color.focus, strokeWidth: px(t.size.ring) };
  for (const n of SERIES_PARTS) {
    children.push({ tag: 'g', attrs: { 'data-az-chat-paint': `fill-${n}` }, style: { fill: series(n), stroke: 'none' }, states: { open: active } });
    // A patterned mark is filled by its pattern (a url() the SVG holds); its class only draws the edge.
    children.push({ tag: 'g', attrs: { 'data-az-chat-paint': `patterned-${n}` }, style: { stroke: series(n), strokeWidth: '1px' }, states: { open: active } });
    children.push({
      tag: 'g', attrs: { 'data-az-chat-paint': `line-${n}` },
      style: { fill: 'none', stroke: series(n), strokeWidth: px(t.size.ring), strokeLinejoin: 'round', strokeLinecap: 'round', ...(DASHES[n - 1] ? { strokeDasharray: DASHES[n - 1] } : {}) },
      // A line pointed at by its legend entry is drawn twice as heavy, in its own colour: its dash stays readable.
      states: { open: { strokeWidth: `calc(2 * ${px(t.size.ring)})` } },
    });
  }
  children.push(
    { tag: 'g', attrs: { 'data-az-chat-paint': 'pattern-ink' }, style: { fill: 'none', stroke: t.color.surface, strokeWidth: px(t.size.ring) } },
    { tag: 'g', attrs: { 'data-az-chat-paint': 'axis' }, style: { stroke: t.color['border-strong'], strokeWidth: '1px' } },
    { tag: 'g', attrs: { 'data-az-chat-paint': 'grid' }, style: { stroke: t.color.border, strokeWidth: '1px' } },
    { tag: 'g', attrs: { 'data-az-chat-paint': 'tick' }, style: { fill: t.color.muted, fontSize: t.typeSize.sm } },
    { tag: 'g', attrs: { 'data-az-chat-paint': 'label' }, style: { fill: t.color.text, fontSize: t.typeSize.sm } },
    // Issue #29: a mark's tooltip, drawn in the chart itself — the surface and the text the rest of the answer uses.
    { tag: 'g', attrs: { 'data-az-chat-paint': 'tip' }, style: { fill: t.color.surface, stroke: t.color['border-strong'], strokeWidth: '1px' } },
    { tag: 'g', attrs: { 'data-az-chat-paint': 'tip-text' }, style: { fill: t.color.text, fontSize: t.typeSize.sm, fontWeight: t.type['weight-bold'] } },
    // The chart itself: drawn at its box's width; a stop in the Tab order whose arrow keys walk its marks (issue #29).
    {
      tag: 'g', attrs: { 'data-az-chat-paint': 'svg' }, style: { display: 'block', maxWidth: '100%', height: 'auto', overflow: 'visible' },
      states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
    },
  );
  return { tag: 'svg', attrs: { 'aria-hidden': 'true', focusable: 'false', width: '0', height: '0' }, style: { position: 'absolute', width: 0, height: 0 }, children };
}

/** A figure's frame: caption (title, the AI label, the source), the body, the summary, the legend, the table equivalent. */
function figure(t: ThemeLike): EmittedNode {
  const small = { margin: 0, fontSize: t.typeSize.sm, lineHeight: t.type['leading-body'] };
  return {
    tag: 'figure',
    attrs: { class: 'az-chat-figure' },
    // Its rows from the top: a figure stretched to a taller neighbour's height in a dashboard row keeps the room at its foot.
    style: {
      display: 'grid', alignContent: 'start', gap: px(t.space[8]), margin: 0, padding: px(t.space[12]),
      background: t.color.surface, border: `1px solid ${t.color.border}`, borderRadius: px(t.radius.md), minWidth: 0,
    },
    children: [
      {
        tag: 'figcaption', attrs: { class: 'az-chat-figure-caption' },
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: `${px(t.space[4])} ${px(t.space[12])}` },
        children: [
          slot('title', 'span', { fontWeight: t.type['weight-bold'], fontSize: t.typeSize.base, color: t.color.text }, { class: 'az-chat-figure-title' }),
          // §20.2: fixed copy from the build; the runtime removes it only for the site's own figures.
          {
            tag: 'span', attrs: { class: 'az-chat-ai', 'data-az-chat-ai': '' },
            style: { ...small, padding: `0 ${px(t.space[8])}`, border: `1px solid ${t.color['border-strong']}`, borderRadius: px(t.radius.sm), color: t.color.text },
            children: [FIGURE_COPY.ai],
          },
          {
            tag: 'span', attrs: { class: 'az-chat-source', 'data-az-chat-source': '' },
            style: { ...small, color: t.color.muted },
            children: [`${FIGURE_COPY.source} · `, slot('asOf', 'span', {})],
          },
        ],
      },
      {
        // Issue #29: the chart and its legend in one row that wraps — a pie's legend beside it when there is room, under it when not.
        tag: 'div', attrs: { class: 'az-chat-figure-plot', 'data-az-chat-slot': 'plot' },
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: `${px(t.space[8])} ${px(t.space[16])}`, minWidth: 0 },
        children: [
          slot('body', 'div', { flex: '0 1 auto', minWidth: 0, maxWidth: '100%' }, { class: 'az-chat-figure-body' }),
          {
            tag: 'ul', attrs: { class: 'az-chat-legend', 'data-az-chat-slot': 'legend' },
            // Columns two 128 steps wide: one list beside a pie or on a phone, two under a wide chart.
            style: {
              flex: `1 1 ${px(t.space[128])}`, display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, calc(2 * ${px(t.space[128])})), 1fr))`,
              gap: `${px(t.space[4])} ${px(t.space[16])}`, margin: 0, padding: 0, listStyle: 'none', minWidth: 0,
            },
            children: [{
              tag: 'li', attrs: { class: 'az-chat-legend-item', 'data-az-chat-slot': 'legend-item' },
              style: { ...small, display: 'flex', alignItems: 'center', gap: px(t.space[8]), color: t.color.text, minWidth: 0, overflowWrap: 'anywhere' },
              // The entry of the series or slice pointed at (issue #29): underlined, so colour is not the only sign.
              states: { open: { textDecoration: 'underline', textUnderlineOffset: '0.2em' } },
              children: [slot('swatch', 'span', { display: 'inline-flex', flex: 'none', width: px(t.space[16]), height: px(t.space[16]) }), slot('name', 'span', {})],
            }],
          },
        ],
      },
      slot('summary', 'p', { ...small, color: t.color.muted }, { class: 'az-chat-summary' }),
      {
        tag: 'details', attrs: { class: 'az-chat-figures-table', 'data-az-chat-slot': 'details' },
        style: { ...small },
        children: [
          {
            tag: 'summary', attrs: { class: 'az-chat-figures-summary' },
            style: { cursor: 'pointer', color: t.color.text, minHeight: px(t.size.tap), display: 'flex', alignItems: 'center' },
            states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
            children: [FIGURE_COPY.details],
          },
          slot('equivalent', 'div', { minWidth: 0 }),
        ],
      },
    ],
  };
}

/** A table: its scrolling region, the table, a header cell plain and sortable, a text cell, a number cell. */
function table(t: ThemeLike): EmittedNode {
  const cell = { padding: `${px(t.space[8])} ${px(t.space[12])}`, borderBottom: `1px solid ${t.color.border}`, textAlign: 'start', verticalAlign: 'top' };
  return {
    tag: 'div',
    // §20.8: a narrow table scrolls in its own region, reachable by keyboard and named by its caption.
    attrs: { class: 'az-chat-table-wrap', tabindex: '0', role: 'region' },
    style: { overflowX: 'auto', maxWidth: '100%' },
    states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
    children: [{
      tag: 'table', attrs: { class: 'az-chat-table' },
      style: { borderCollapse: 'collapse', width: '100%', fontSize: t.typeSize.sm, color: t.color.text },
      children: [
        slot('caption', 'caption', { ...visuallyHidden('').style }),
        {
          tag: 'thead', children: [{ tag: 'tr', attrs: { 'data-az-chat-slot': 'head' }, children: [
            { tag: 'th', attrs: { scope: 'col', 'data-az-chat-slot': 'th' }, style: { ...cell, fontWeight: t.type['weight-bold'], borderBottom: `1px solid ${t.color['border-strong']}` }, children: [] },
            {
              tag: 'th', attrs: { scope: 'col', 'data-az-chat-slot': 'th-sort', 'aria-sort': 'none' },
              style: { padding: 0, borderBottom: `1px solid ${t.color['border-strong']}` },
              children: [{
                tag: 'button', attrs: { type: 'button', class: 'az-chat-sort', 'data-az-chat-slot': 'sort' },
                style: {
                  display: 'flex', alignItems: 'center', gap: px(t.space[4]), width: '100%', minHeight: px(t.size.tap),
                  padding: `${px(t.space[8])} ${px(t.space[12])}`, background: 'transparent', border: 0, font: 'inherit',
                  fontWeight: t.type['weight-bold'], color: t.color.text, cursor: 'pointer', textAlign: 'start',
                },
                states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: `-${px(t.size.ring)}` } },
                children: [],
              }],
            },
          ] }],
        },
        {
          tag: 'tbody', children: [{ tag: 'tr', attrs: { 'data-az-chat-slot': 'row' }, children: [
            { tag: 'td', attrs: { 'data-az-chat-slot': 'td' }, style: { ...cell, overflowWrap: 'anywhere' }, children: [] },
            { tag: 'td', attrs: { 'data-az-chat-slot': 'td-number' }, style: { ...cell, textAlign: 'end', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }, children: [] },
          ] }],
        },
      ],
    }],
  };
}

/**
 * A stat value's size, in hundredths of its card's width (issue #20): seven characters ("$270.00") at about 0.6 em each
 * fill 84% of the card at 20cqi, so the commonest values fit the narrowest card with room to spare.
 */
const STAT_VALUE_CQI = 20;

/** Stat cards: a list of label, value and change — the change in a glyph and words, never colour (§20.2). */
function stats(t: ThemeLike): EmittedNode {
  return {
    tag: 'dl', attrs: { class: 'az-chat-stats' },
    style: { display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${px(t.space[128])}, 1fr))`, gap: px(t.space[12]), margin: 0 },
    children: [{
      tag: 'div', attrs: { class: 'az-chat-stat', 'data-az-chat-slot': 'stat' },
      // Issue #20: the card is the size container its value is set against.
      style: {
        display: 'grid', alignContent: 'start', gap: px(t.space[4]), padding: px(t.space[12]), background: t.color.surface, border: `1px solid ${t.color.border}`,
        borderRadius: px(t.radius.md), minWidth: 0, containerType: 'inline-size',
      },
      children: [
        slot('label', 'dt', { margin: 0, fontSize: t.typeSize.sm, color: t.color.muted }),
        // Issue #20: the value is set against its card's width, between lg and 2xl — "$270.00" fits a 128-px card — and a
        // longer one wraps before any digit is hidden: a cut-off number reads as another number.
        slot('value', 'dd', {
          margin: 0, fontSize: `clamp(${t.typeSize.lg}, ${STAT_VALUE_CQI}cqi, ${t.typeSize['2xl']})`, fontWeight: t.type['weight-bold'],
          lineHeight: t.type['leading-tight'], color: t.color.text, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere', minWidth: 0,
        }),
        {
          tag: 'dd', attrs: { 'data-az-chat-slot': 'delta' }, style: { margin: 0, fontSize: t.typeSize.sm, color: t.color.text },
          children: [slot('glyph', 'span', {}, { 'aria-hidden': 'true' }), ' ', slot('words', 'span', {})],
        },
        slot('ai', 'dd', { margin: 0, fontSize: t.typeSize.sm, color: t.color.muted }),
      ],
    }],
  };
}

/** Image cards: an article with its image, title, text and link. */
function cards(t: ThemeLike): EmittedNode {
  return {
    tag: 'ul', attrs: { class: 'az-chat-cards' },
    style: { display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${px(t.space[128])}, 1fr))`, gap: px(t.space[12]), margin: 0, padding: 0, listStyle: 'none' },
    children: [{
      tag: 'li', attrs: { class: 'az-chat-card', 'data-az-chat-slot': 'card' },
      style: { display: 'grid', alignContent: 'start', gap: px(t.space[8]), padding: px(t.space[12]), background: t.color.surface, border: `1px solid ${t.color.border}`, borderRadius: px(t.radius.md), minWidth: 0 },
      children: [
        slot('media', 'div', { borderRadius: px(t.radius.sm), overflow: 'hidden', background: t.color['surface-alt'] }),
        slot('title', 'h3', { margin: 0, fontSize: t.typeSize.base, lineHeight: t.type['leading-tight'], color: t.color.text }),
        slot('text', 'p', { margin: 0, fontSize: t.typeSize.sm, lineHeight: t.type['leading-body'], color: t.color.muted }),
        // A tool's card says where it came from (chat-block-spec §19.11); the runtime drops it from any other card.
        slot('source', 'p', { margin: 0, fontSize: t.typeSize.sm, color: t.color.muted }),
        {
          tag: 'a', attrs: { class: 'az-chat-card-link', 'data-az-chat-slot': 'link' },
          style: { fontSize: t.typeSize.sm, color: t.color.accent, textDecoration: 'underline', minHeight: px(t.size.tap), display: 'inline-flex', alignItems: 'center' },
          states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
          children: [],
        },
      ],
    }],
  };
}

/** An image a card shows: as wide as the card, its shape kept. */
const imageStyle = { display: 'block', width: '100%', height: 'auto', aspectRatio: '4 / 3', objectFit: 'cover' } as const;

/**
 * A dashboard (issues #20, #31): its title; its stats together as one
 * headline row — short cards never sit beside a tall chart with a gap under
 * them; then its other tiles in a dense grid whose columns are at least two
 * 128 steps wide, so a chart is drawn at a size its text reads at (one
 * column on a phone, two in a panel); a table takes a whole row.
 */
function dashboard(t: ThemeLike): EmittedNode {
  return {
    tag: 'section', attrs: { class: 'az-chat-dashboard' },
    style: { display: 'grid', gap: px(t.space[12]), minWidth: 0 },
    children: [
      slot('title', 'h3', { margin: 0, fontSize: t.typeSize.base, color: t.color.text }, { class: 'az-chat-dashboard-title' }),
      slot('stats', 'div', { minWidth: 0 }, { class: 'az-chat-dashboard-stats' }),
      {
        tag: 'div', attrs: { class: 'az-chat-tiles', 'data-az-chat-slot': 'tiles' },
        style: {
          display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, calc(2 * ${px(t.space[128])})), 1fr))`,
          gridAutoFlow: 'row dense', gap: px(t.space[12]),
        },
        children: [
          { tag: 'div', attrs: { class: 'az-chat-tile', 'data-az-chat-slot': 'tile' }, style: { display: 'grid', minWidth: 0 }, children: [] },
          {
            tag: 'div', attrs: { class: 'az-chat-tile az-chat-tile--wide', 'data-az-chat-slot': 'tile-wide' },
            style: { display: 'grid', minWidth: 0, gridColumn: '1 / -1' },
            children: [],
          },
        ],
      },
    ],
  };
}

/** The note a component becomes when the server could not read its figures in time (§20.5). */
function unavailable(t: ThemeLike): EmittedNode {
  return {
    tag: 'p', attrs: { class: 'az-chat-unavailable' },
    style: { margin: 0, fontSize: t.typeSize.sm, color: t.color.muted },
    children: [`${FIGURE_COPY.unavailable} `, slot('title', 'span', {})],
  };
}

/**
 * An explore (§21.3.4): its title, its controls' templates and the views'
 * holders. Each control is a real one — the range input's value is in an
 * <output> tied to it, the toggle is radios in a fieldset (arrow keys move
 * between them), a form's fields are labelled and its one button submits.
 */
function explore(t: ThemeLike, ctx: EmitContext): EmittedNode {
  const small = { margin: 0, fontSize: t.typeSize.sm, lineHeight: t.type['leading-body'] };
  const ring = { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } };
  const field = {
    minHeight: px(t.size.tap), padding: `0 ${px(t.space[8])}`, fontSize: t.typeSize.sm,
    background: t.color.surface, color: t.color.text, border: `1px solid ${t.color['border-strong']}`, borderRadius: px(t.radius.sm),
  };
  const labelStyle = { ...small, color: t.color.text, fontWeight: t.type['weight-bold'] };
  const control = (name: string, children: EmittedNode[]): EmittedNode => ({
    tag: 'div', attrs: { class: 'az-chat-explore-control', 'data-az-chat-slot': name },
    style: { display: 'grid', gap: px(t.space[4]), minWidth: 0 }, children,
  });
  const submit = ctx.submit('', { hierarchy: 'secondary' });
  return {
    // A group, not a landmark: a transcript may hold many explores, and a view's table is a region of its own.
    tag: 'section', attrs: { class: 'az-chat-explore', role: 'group' },
    style: { display: 'grid', gap: px(t.space[12]), minWidth: 0 },
    children: [
      slot('title', 'h3', { margin: 0, fontSize: t.typeSize.base, color: t.color.text }, { class: 'az-chat-explore-title' }),
      {
        tag: 'div', attrs: { class: 'az-chat-explore-controls', 'data-az-chat-slot': 'controls' },
        style: { display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${px(t.space[128])}, 1fr))`, gap: px(t.space[12]), alignItems: 'start' },
        children: [
          control('slider', [
            slot('label', 'label', labelStyle),
            {
              tag: 'div', attrs: { class: 'az-chat-explore-range' }, style: { display: 'flex', alignItems: 'center', gap: px(t.space[8]) },
              children: [
                {
                  tag: 'input', attrs: { type: 'range', 'data-az-chat-slot': 'input', class: 'az-chat-explore-slider' },
                  style: { flex: '1 1 auto', minWidth: 0, minHeight: px(t.size.tap), accentColor: t.color.accent }, states: ring,
                },
                slot('output', 'output', { ...small, color: t.color.text, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }),
              ],
            },
          ]),
          control('date', [
            slot('label', 'label', labelStyle),
            { tag: 'input', attrs: { type: 'date', 'data-az-chat-slot': 'input', class: 'az-chat-explore-date' }, style: { ...field, width: '100%' }, states: ring },
          ]),
          {
            tag: 'fieldset', attrs: { class: 'az-chat-explore-toggle', 'data-az-chat-slot': 'toggle' },
            style: { display: 'grid', gap: px(t.space[4]), margin: 0, padding: 0, border: '0', minWidth: 0 },
            children: [
              slot('legend', 'legend', { ...labelStyle, padding: 0 }),
              {
                tag: 'div', attrs: { 'data-az-chat-slot': 'options' }, style: { display: 'flex', flexWrap: 'wrap', gap: `0 ${px(t.space[16])}` },
                children: [{
                  tag: 'label', attrs: { class: 'az-chat-explore-option', 'data-az-chat-slot': 'option' },
                  style: { ...small, display: 'inline-flex', alignItems: 'center', gap: px(t.space[8]), minHeight: px(t.size.tap), color: t.color.text },
                  children: [
                    { tag: 'input', attrs: { type: 'radio', 'data-az-chat-slot': 'radio' }, style: { width: px(t.space[16]), height: px(t.space[16]), accentColor: t.color.accent }, states: ring },
                    slot('text', 'span', {}),
                  ],
                }],
              },
            ],
          },
          {
            tag: 'form', attrs: { class: 'az-chat-explore-form', 'data-az-chat-slot': 'form' },
            style: { display: 'grid', gap: px(t.space[8]), minWidth: 0, gridColumn: '1 / -1' },
            children: [{
              tag: 'fieldset', attrs: { class: 'az-chat-explore-fieldset' },
              style: { display: 'grid', gap: px(t.space[8]), margin: 0, padding: 0, border: '0', minWidth: 0 },
              children: [
                slot('legend', 'legend', { ...labelStyle, padding: 0 }),
                {
                  tag: 'div', attrs: { 'data-az-chat-slot': 'fields' },
                  style: { display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${px(t.space[128])}, 1fr))`, gap: px(t.space[12]) },
                  children: [
                    control('field-number', [
                      slot('label', 'label', labelStyle),
                      { tag: 'input', attrs: { type: 'number', step: 'any', required: 'required', 'data-az-chat-slot': 'input', class: 'az-chat-explore-number' }, style: { ...field, width: '100%' }, states: ring },
                    ]),
                    control('field-choice', [
                      slot('label', 'label', labelStyle),
                      {
                        tag: 'select', attrs: { 'data-az-chat-slot': 'input', class: 'az-chat-explore-choice' }, style: { ...field, width: '100%' }, states: ring,
                        children: [{ tag: 'option', attrs: { 'data-az-chat-slot': 'choice' }, children: [] }],
                      },
                    ]),
                  ],
                },
                {
                  tag: 'div', attrs: { class: 'az-chat-explore-submit' }, style: { display: 'flex', flexWrap: 'wrap', gap: px(t.space[8]) },
                  children: [{ ...submit, attrs: { ...submit.attrs, type: 'submit', 'data-az-chat-slot': 'submit' } }],
                },
              ],
            }],
          },
        ],
      },
      {
        tag: 'div', attrs: { class: 'az-chat-explore-views', 'data-az-chat-slot': 'views' },
        style: { display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${px(t.space[128])}, 1fr))`, gap: px(t.space[12]) },
        children: [
          { tag: 'div', attrs: { class: 'az-chat-tile', 'data-az-chat-slot': 'view' }, style: { minWidth: 0 }, children: [] },
          {
            tag: 'div', attrs: { class: 'az-chat-tile az-chat-tile--wide', 'data-az-chat-slot': 'view-wide' },
            style: { minWidth: 0, gridColumn: '1 / -1' },
            children: [],
          },
        ],
      },
    ],
  };
}

/**
 * A map (§21.4.3): its title and the fixed labels its source earns, the
 * stage the map draws in (an image named by its summary, which the arrow
 * and + − keys move), az's own zoom and reset buttons, the attribution line,
 * the fallback note, and the list equivalent — the places in order, each its
 * coordinates in words, and each route's stops — in a <details> that is the
 * whole component when the map cannot be drawn. The popup a pin opens is a
 * part of its own, filled by textContent and handed to the map library.
 */
function map(t: ThemeLike, ctx: EmitContext): EmittedNode {
  const small = { margin: 0, fontSize: t.typeSize.sm, lineHeight: t.type['leading-body'] };
  const ring = { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } };
  const button = (name: string, label: string): EmittedNode => {
    const b = ctx.submit(label, { hierarchy: 'secondary' });
    return { ...b, attrs: { ...b.attrs, type: 'button', 'data-az-chat-slot': name } };
  };
  const label = { ...small, padding: `0 ${px(t.space[8])}`, border: `1px solid ${t.color['border-strong']}`, borderRadius: px(t.radius.sm), color: t.color.text };
  return {
    tag: 'figure', attrs: { class: 'az-chat-map', 'data-az-chat-map': 'loading' },
    style: {
      display: 'grid', gap: px(t.space[8]), margin: 0, padding: px(t.space[12]),
      background: t.color.surface, border: `1px solid ${t.color.border}`, borderRadius: px(t.radius.md), minWidth: 0,
    },
    children: [
      {
        tag: 'figcaption', attrs: { class: 'az-chat-map-caption' },
        style: { display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: `${px(t.space[4])} ${px(t.space[12])}` },
        children: [
          slot('title', 'span', { fontWeight: t.type['weight-bold'], fontSize: t.typeSize.base, color: t.color.text }, { class: 'az-chat-map-title' }),
          // §21.4.4: fixed copy the runtime picks by the source the server set — the model cannot remove it.
          slot('label', 'span', label, { class: 'az-chat-map-label' }),
          {
            tag: 'span', attrs: { class: 'az-chat-source', 'data-az-chat-slot': 'source' },
            style: { ...small, color: t.color.muted },
            children: [`${FIGURE_COPY.source} · `, slot('asOf', 'span', {})],
          },
        ],
      },
      {
        // The map's own box: a fixed shape, so nothing moves when it draws; the library fills it.
        tag: 'div', attrs: { class: 'az-chat-map-stage', 'data-az-chat-slot': 'stage', role: 'img', tabindex: '0' },
        style: {
          position: 'relative', overflow: 'hidden', width: '100%', aspectRatio: '4 / 3', minWidth: 0,
          background: t.color['surface-alt'], borderRadius: px(t.radius.sm),
        },
        states: ring,
        children: [],
      },
      {
        tag: 'div', attrs: { class: 'az-chat-map-controls', 'data-az-chat-slot': 'controls' },
        style: { display: 'flex', flexWrap: 'wrap', gap: px(t.space[8]) },
        children: [button('zoom-in', MAP_COPY.zoomIn), button('zoom-out', MAP_COPY.zoomOut), button('reset', MAP_COPY.reset)],
      },
      // §21.4.3: the map data's attribution, the operator's line from the server, always visible under the map.
      slot('attribution', 'p', { ...small, color: t.color.muted }, { class: 'az-chat-map-attribution' }),
      // Issue #21: shown while the view is deeper than its tiles — there is no street detail to draw there.
      slot('detail', 'p', { ...small, color: t.color.muted }, { class: 'az-chat-map-detail', hidden: 'hidden' }),
      slot('note', 'p', { ...small, color: t.color.text }, { class: 'az-chat-map-note', hidden: 'hidden' }),
      {
        tag: 'details', attrs: { class: 'az-chat-map-list', 'data-az-chat-slot': 'list' },
        style: { ...small },
        children: [
          {
            tag: 'summary', attrs: { class: 'az-chat-map-summary' },
            style: { cursor: 'pointer', color: t.color.text, minHeight: px(t.size.tap), display: 'flex', alignItems: 'center' },
            states: ring,
            children: [MAP_COPY.list],
          },
          {
            tag: 'ol', attrs: { class: 'az-chat-map-pins', 'data-az-chat-slot': 'pins' },
            style: { display: 'grid', gap: px(t.space[8]), margin: 0, paddingInlineStart: px(t.space[24]), color: t.color.text },
            children: [{
              tag: 'li', attrs: { class: 'az-chat-map-pin', 'data-az-chat-slot': 'pin' },
              style: { display: 'grid', gap: px(t.space[4]) },
              children: [
                slot('pin-label', 'span', { fontWeight: t.type['weight-bold'] }),
                slot('pin-where', 'span', { color: t.color.muted }),
                slot('pin-src', 'span', { color: t.color.muted }),
                {
                  tag: 'button', attrs: { type: 'button', class: 'az-chat-map-show', 'data-az-chat-slot': 'pin-show' },
                  style: {
                    justifySelf: 'start', minHeight: px(t.size.tap), padding: `0 ${px(t.space[8])}`, font: 'inherit', fontSize: t.typeSize.sm,
                    background: 'transparent', color: t.color.accent, border: 0, textDecoration: 'underline', cursor: 'pointer',
                  },
                  states: ring,
                  children: [MAP_COPY.show],
                },
              ],
            }],
          },
          {
            tag: 'div', attrs: { class: 'az-chat-map-routes', 'data-az-chat-slot': 'routes' },
            style: { display: 'grid', gap: px(t.space[8]) },
            children: [{
              // A group named by its title (the runtime ties them): a heading here would break the transcript's order.
              tag: 'section', attrs: { class: 'az-chat-map-route', 'data-az-chat-slot': 'route', role: 'group' },
              style: { display: 'grid', gap: px(t.space[4]) },
              children: [
                slot('route-title', 'p', { margin: 0, fontSize: t.typeSize.sm, fontWeight: t.type['weight-bold'], color: t.color.text }),
                {
                  tag: 'ol', attrs: { 'data-az-chat-slot': 'stops' },
                  style: { margin: 0, paddingInlineStart: px(t.space[24]), color: t.color.text },
                  children: [slot('stop', 'li', {})],
                },
              ],
            }],
          },
        ],
      },
    ],
  };
}

/** A pin's popup: its label and its source's label, handed to the map library as an element (setDOMContent, §21.4.3). */
function mapPopup(t: ThemeLike): EmittedNode {
  return {
    tag: 'div', attrs: { class: 'az-chat-map-popup' },
    style: { display: 'grid', gap: px(t.space[4]), fontSize: t.typeSize.sm, lineHeight: t.type['leading-body'], color: t.color.text },
    children: [slot('label', 'strong', {}), slot('src', 'span', { color: t.color.muted })],
  };
}

/**
 * The rich templates a chat's `show` needs (chat-block-spec §20): the paint
 * classes and the figure frame for any of them, then each component's own.
 * An explore draws charts, tables and stat cards too (§21.3.4).
 */
export function richParts(answer: SpecChatAnswer, ctx: EmitContext): EmittedNode[] {
  const t = ctx.theme;
  const show = answer.show;
  const rich = ['chart', 'table', 'stats', 'cards', 'dashboard', 'explore', 'map'].filter((w) => show.includes(w));
  if (rich.length === 0) return [];
  const has = (...words: string[]) => words.some((w) => show.includes(w));
  return [
    ...(has('chart', 'dashboard', 'explore') && t.color['series-1'] !== undefined ? [part('paint', paint(t))] : []),
    part('figure', figure(t)),
    part('table', table(t)),
    ...(has('stats', 'dashboard', 'explore') ? [part('stats', stats(t))] : []),
    ...(has('cards', 'dashboard') ? [part('cards', cards(t))] : []),
    ...(has('dashboard') ? [part('dashboard', dashboard(t))] : []),
    ...(has('explore') ? [part('explore', explore(t, ctx))] : []),
    ...(has('map') ? [part('map', map(t, ctx)), part('map-popup', mapPopup(t))] : []),
    part('unavailable', unavailable(t)),
  ];
}

/**
 * Each gallery image a card may name (§20.6), as an <img> the build sized
 * and gave a srcset — the only image files an answer can show, by key.
 */
export function assetParts(answer: SpecChatAnswer, ctx: EmitContext): EmittedNode[] {
  if (!answer.show.includes('cards')) return [];
  // A row's image (a `cards from` table): the runtime sets its address — the backend's own path, checked — on a copy.
  const row = part('row-image', { tag: 'img', attrs: { alt: '', loading: 'lazy', decoding: 'async', class: 'az-chat-card-img' }, style: imageStyle });
  return [row, ...(answer.images ?? []).map((i) => part('asset', {
    tag: 'img',
    attrs: { src: ctx.asset(i.src), alt: i.alt, loading: 'lazy', decoding: 'async', sizes: contentShare(1, undefined), class: 'az-chat-card-img' },
    style: imageStyle,
  }, { 'data-az-chat-asset': i.key }))];
}

/** The answer bar's icons (issue #30), on a 24-unit grid, stroked in currentColor: two sheets; an arrow up out of a tray. */
export const BAR_ICONS = {
  copy: { viewBox: '0 0 24 24', d: 'M9 9h11v11H9zM5 15H4V4h11v1' },
  share: { viewBox: '0 0 24 24', d: 'M12 15V3M7 8l5-5l5 5M5 12v8h14v-8' },
} as const;

/**
 * One small icon button of an answer's bar (issue #30): named by its label,
 * which its tooltip shows too — beside it, on hover or keyboard focus (the
 * runtime shows and hides it; Escape hides it). The tooltip repeats the
 * name, so it is hidden from assistive technology. Its colour is the bar's:
 * faint until the answer is pointed at or focused.
 */
export function barButton(t: ThemeLike, label: string, icon: { readonly viewBox: string; readonly d: string }, attrs: Record<string, string>): EmittedNode {
  return {
    tag: 'span', attrs: { class: 'az-chat-bar-item' },
    style: { position: 'relative', display: 'inline-flex' },
    children: [
      {
        tag: 'button', attrs: { type: 'button', class: 'az-chat-bar-button', 'aria-label': label, ...attrs },
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: px(t.space[32]), height: px(t.space[32]),
          margin: 0, padding: 0, border: 0, borderRadius: px(t.radius.sm), background: 'transparent', color: 'inherit', cursor: 'pointer',
        },
        states: {
          hover: { background: t.color['surface-alt'], color: t.color.text },
          focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: 0, color: t.color.text },
          expanded: { color: t.color.text },
        },
        children: [{
          tag: 'svg',
          attrs: { 'aria-hidden': 'true', focusable: 'false', viewBox: icon.viewBox, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
          style: { width: '1.25em', height: '1.25em' },
          children: [{ tag: 'path', attrs: { d: icon.d } }],
        }],
      },
      {
        tag: 'span', attrs: { class: 'az-chat-tip', 'aria-hidden': 'true', hidden: 'hidden', 'data-az-chat-tip': '' },
        style: {
          position: 'absolute', insetInlineStart: `calc(100% + ${px(t.space[4])})`, insetBlockStart: '50%', transform: 'translateY(-50%)',
          padding: `${px(t.space[4])} ${px(t.space[8])}`, fontSize: t.typeSize.sm, lineHeight: t.type['leading-tight'], whiteSpace: 'nowrap',
          background: t.color.surface, color: t.color.text, border: `1px solid ${t.color['border-strong']}`, borderRadius: px(t.radius.sm),
          boxShadow: t.shadow.md, zIndex: t.layer.tooltip, pointerEvents: 'none',
        },
        children: [label],
      },
    ],
  };
}

/**
 * The placeholders a held component stands on while the server reads its
 * figures (issue #28): a frame of the shape the component will take — a
 * figure's (a chart, an explore or a dashboard), a map's, a table's rows, or
 * two cards (stats, image cards) — on the theme's quiet grounds. Hidden from
 * assistive technology: the status region says what arrives.
 */
export function skeletonParts(t: ThemeLike): EmittedNode[] {
  const shade = { display: 'block', background: t.color['surface-alt'], borderRadius: px(t.radius.sm) };
  const bar = (width: string): EmittedNode => ({ tag: 'span', style: { ...shade, height: '1em', width } });
  const block = (ratio: string): EmittedNode => ({ tag: 'span', style: { ...shade, aspectRatio: ratio } });
  const box = { display: 'grid', gap: px(t.space[8]), padding: px(t.space[12]), border: `1px solid ${t.color.border}`, borderRadius: px(t.radius.md), background: t.color.surface, minWidth: 0 };
  const frame = (name: string, children: EmittedNode[]): EmittedNode =>
    ({ tag: 'div', attrs: { class: 'az-chat-skeleton', 'data-az-chat-slot': name, 'aria-hidden': 'true' }, style: box, children });
  const card = (): EmittedNode => ({ tag: 'span', style: { ...box, display: 'grid' }, children: [bar('50%'), { tag: 'span', style: { ...shade, height: '2em', width: '70%' } }] });
  return [
    frame('skeleton-figure', [bar('40%'), block('5 / 3')]),
    frame('skeleton-map', [bar('40%'), block('4 / 3')]),
    frame('skeleton-table', [bar('40%'), bar('100%'), bar('100%'), bar('100%')]),
    {
      tag: 'div', attrs: { class: 'az-chat-skeleton', 'data-az-chat-slot': 'skeleton-tiles', 'aria-hidden': 'true' },
      style: { display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${px(t.space[128])}, 1fr))`, gap: px(t.space[12]), minWidth: 0 },
      children: [card(), card()],
    },
  ];
}

/**
 * The share control in a finished answer's bar (§20.7, issue #30): the
 * Share icon button — named "Share this answer", as the text button it
 * replaces was — then, under the bar, the choice to include the question and
 * the two links once made: every one text the runtime fills, nothing from
 * the network as markup. Its root lays out nothing of its own: its button
 * joins the bar's row, its panel takes a row of its own.
 */
export function sharePart(ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const small = { margin: 0, fontSize: t.typeSize.sm, lineHeight: t.type['leading-body'] };
  const create = ctx.submit(FIGURE_COPY.shareCreate, { hierarchy: 'primary' });
  const field = (name: string, label: string): EmittedNode => ({
    tag: 'label', attrs: { class: 'az-chat-share-field', 'data-az-chat-slot': `${name}-field`, hidden: 'hidden' },
    style: { ...small, display: 'grid', gap: px(t.space[4]), color: t.color.muted },
    children: [label, {
      tag: 'input', attrs: { type: 'text', readonly: 'readonly', 'data-az-chat-slot': name, class: 'az-chat-share-url' },
      style: {
        width: '100%', minHeight: px(t.size.tap), padding: `0 ${px(t.space[8])}`, fontSize: t.typeSize.sm,
        background: t.color.surface, color: t.color.text, border: `1px solid ${t.color['border-strong']}`, borderRadius: px(t.radius.sm),
      },
      states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
    }],
  });
  return part('share', {
    tag: 'div', attrs: { class: 'az-chat-share' },
    style: { display: 'contents' },
    children: [
      barButton(t, FIGURE_COPY.share, BAR_ICONS.share, { 'data-az-chat-slot': 'open', 'aria-expanded': 'false' }),
      {
        tag: 'div', attrs: { class: 'az-chat-share-panel', 'data-az-chat-slot': 'panel', hidden: 'hidden' },
        style: { display: 'grid', gap: px(t.space[8]), flex: '1 1 100%', color: t.color.text, paddingBlockStart: px(t.space[4]) },
        children: [
          {
            tag: 'label', attrs: { class: 'az-chat-share-include' }, style: { ...small, display: 'inline-flex', alignItems: 'center', gap: px(t.space[8]), color: t.color.text, minHeight: px(t.size.tap) },
            children: [{ tag: 'input', attrs: { type: 'checkbox', 'data-az-chat-slot': 'include' }, style: { width: px(t.space[16]), height: px(t.space[16]) } }, FIGURE_COPY.shareInclude],
          },
          { ...create, attrs: { ...create.attrs, type: 'button', 'data-az-chat-slot': 'create' } },
          field('url', FIGURE_COPY.shareLink),
          field('delete', FIGURE_COPY.shareDelete),
          slot('note', 'p', { ...small, color: t.color.muted }),
        ],
      },
    ],
  });
}
