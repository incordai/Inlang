/**
 * @az module chat-figures
 * Purpose: the hidden templates an answer's charts, tables, stat cards, image cards, dashboards, explores, maps and share control are drawn from.
 * Spec: docs/chat-block-spec.md §20.4, §20.6, §20.7, §20.8, §21.3.4, §21.4.3, §21.4.5
 * Exports: FIGURE_COPY, MAP_COPY, SERIES_PARTS, richParts, assetParts, sharePart
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
  for (const n of SERIES_PARTS) {
    children.push({ tag: 'g', attrs: { 'data-az-chat-paint': `fill-${n}` }, style: { fill: series(n), stroke: 'none' } });
    // A patterned mark is filled by its pattern (a url() the SVG holds); its class only draws the edge.
    children.push({ tag: 'g', attrs: { 'data-az-chat-paint': `patterned-${n}` }, style: { stroke: series(n), strokeWidth: '1px' } });
    children.push({
      tag: 'g', attrs: { 'data-az-chat-paint': `line-${n}` },
      style: { fill: 'none', stroke: series(n), strokeWidth: px(t.size.ring), strokeLinejoin: 'round', strokeLinecap: 'round', ...(DASHES[n - 1] ? { strokeDasharray: DASHES[n - 1] } : {}) },
    });
  }
  children.push(
    { tag: 'g', attrs: { 'data-az-chat-paint': 'pattern-ink' }, style: { fill: 'none', stroke: t.color.surface, strokeWidth: px(t.size.ring) } },
    { tag: 'g', attrs: { 'data-az-chat-paint': 'axis' }, style: { stroke: t.color['border-strong'], strokeWidth: '1px' } },
    { tag: 'g', attrs: { 'data-az-chat-paint': 'grid' }, style: { stroke: t.color.border, strokeWidth: '1px' } },
    { tag: 'g', attrs: { 'data-az-chat-paint': 'tick' }, style: { fill: t.color.muted, fontSize: t.typeSize.sm } },
    { tag: 'g', attrs: { 'data-az-chat-paint': 'label' }, style: { fill: t.color.text, fontSize: t.typeSize.sm } },
    // The chart itself: drawn at its box's width, still — nothing moves, so reduced motion has nothing to stop (§20.4).
    { tag: 'g', attrs: { 'data-az-chat-paint': 'svg' }, style: { display: 'block', maxWidth: '100%', height: 'auto', overflow: 'visible' } },
  );
  return { tag: 'svg', attrs: { 'aria-hidden': 'true', focusable: 'false', width: '0', height: '0' }, style: { position: 'absolute', width: 0, height: 0 }, children };
}

/** A figure's frame: caption (title, the AI label, the source), the body, the summary, the legend, the table equivalent. */
function figure(t: ThemeLike): EmittedNode {
  const small = { margin: 0, fontSize: t.typeSize.sm, lineHeight: t.type['leading-body'] };
  return {
    tag: 'figure',
    attrs: { class: 'az-chat-figure' },
    style: {
      display: 'grid', gap: px(t.space[8]), margin: 0, padding: px(t.space[12]),
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
      slot('body', 'div', { minWidth: 0, maxWidth: '100%' }, { class: 'az-chat-figure-body' }),
      slot('summary', 'p', { ...small, color: t.color.muted }, { class: 'az-chat-summary' }),
      {
        tag: 'ul', attrs: { class: 'az-chat-legend', 'data-az-chat-slot': 'legend' },
        style: { display: 'flex', flexWrap: 'wrap', gap: `${px(t.space[4])} ${px(t.space[16])}`, margin: 0, padding: 0, listStyle: 'none' },
        children: [{
          tag: 'li', attrs: { class: 'az-chat-legend-item', 'data-az-chat-slot': 'legend-item' },
          style: { ...small, display: 'inline-flex', alignItems: 'center', gap: px(t.space[8]), color: t.color.text },
          children: [slot('swatch', 'span', { display: 'inline-flex', width: px(t.space[16]), height: px(t.space[16]) }), slot('name', 'span', {})],
        }],
      },
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

/** Stat cards: a list of label, value and change — the change in a glyph and words, never colour (§20.2). */
function stats(t: ThemeLike): EmittedNode {
  return {
    tag: 'dl', attrs: { class: 'az-chat-stats' },
    style: { display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${px(t.space[128])}, 1fr))`, gap: px(t.space[12]), margin: 0 },
    children: [{
      tag: 'div', attrs: { class: 'az-chat-stat', 'data-az-chat-slot': 'stat' },
      style: { display: 'grid', gap: px(t.space[4]), padding: px(t.space[12]), background: t.color.surface, border: `1px solid ${t.color.border}`, borderRadius: px(t.radius.md), minWidth: 0 },
      children: [
        slot('label', 'dt', { margin: 0, fontSize: t.typeSize.sm, color: t.color.muted }),
        slot('value', 'dd', { margin: 0, fontSize: t.typeSize['2xl'], fontWeight: t.type['weight-bold'], lineHeight: t.type['leading-tight'], color: t.color.text, fontVariantNumeric: 'tabular-nums' }),
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

/** A dashboard: its title and a grid whose wide tiles span two columns above sm. */
function dashboard(t: ThemeLike): EmittedNode {
  return {
    tag: 'section', attrs: { class: 'az-chat-dashboard' },
    style: { display: 'grid', gap: px(t.space[12]), minWidth: 0 },
    children: [
      slot('title', 'h3', { margin: 0, fontSize: t.typeSize.base, color: t.color.text }, { class: 'az-chat-dashboard-title' }),
      {
        tag: 'div', attrs: { class: 'az-chat-tiles', 'data-az-chat-slot': 'tiles' },
        style: { display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${px(t.space[128])}, 1fr))`, gap: px(t.space[12]) },
        children: [
          { tag: 'div', attrs: { class: 'az-chat-tile', 'data-az-chat-slot': 'tile' }, style: { minWidth: 0 }, children: [] },
          {
            tag: 'div', attrs: { class: 'az-chat-tile az-chat-tile--wide', 'data-az-chat-slot': 'tile-wide' },
            style: { minWidth: 0, gridColumn: 'span 2' },
            below: { sm: { gridColumn: 'auto' } },
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

/**
 * The share control under a finished answer (§20.7): Share, the choice to
 * include the question, then the two links once made — every one text the
 * runtime fills, nothing from the network as markup.
 */
export function sharePart(ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const small = { margin: 0, fontSize: t.typeSize.sm, lineHeight: t.type['leading-body'] };
  const share = ctx.submit(FIGURE_COPY.share, { hierarchy: 'secondary' });
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
    style: { display: 'grid', gap: px(t.space[8]), justifyItems: 'start' },
    children: [
      { ...share, attrs: { ...share.attrs, type: 'button', 'data-az-chat-slot': 'open', 'aria-expanded': 'false' } },
      {
        tag: 'div', attrs: { class: 'az-chat-share-panel', 'data-az-chat-slot': 'panel', hidden: 'hidden' },
        style: { display: 'grid', gap: px(t.space[8]), width: '100%' },
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
