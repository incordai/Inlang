/**
 * `feature` — web emitter.
 *
 * feature-block-spec.md is the specification; this implements its structural
 * core. Every design value arrives through `ctx.theme` — `az lint` proves
 * it (assumption A7), and a test walks the emitted tree to prove the OUTPUT
 * stays inside the token set too.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { px, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/** The manifest's `columns` default. */
const DEFAULT_COLUMNS = 3;

/** §6: "a label of ≤3 words" — the spec-sheet exception to one column. */
const SPEC_SHEET_MAX_WORDS = 3;

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'grid';
  const children: EmittedNode[] = [];

  // A section heading is an <h2>: the hero owns the page's only <h1>
  // (hero-spec §4), so the outline stays valid at exactly one level down.
  if (block.props.title) {
    children.push({
      tag: 'h2',
      attrs: { class: 'az-feature-title' },
      style: {
        fontSize: t.typeSize['2xl'],
        lineHeight: t.type['leading-tight'],
        fontFamily: t.type.display,
        fontWeight: t.type['weight-display'],
        // The MEASURE goes on the text, never the container — hero-spec §3.
        maxWidth: `${t.size['measure-display']}ch`,
        margin: `0 0 ${px(t.space[16])}`,
      },
      children: [block.props.title],
    });
  }

  if (block.props.sub) {
    children.push({
      tag: 'p',
      attrs: { class: 'az-feature-sub' },
      style: {
        fontSize: t.typeSize.lg,
        lineHeight: t.type['leading-body'],
        color: t.color.muted,
        maxWidth: `${t.size['measure-body']}ch`,
        margin: `0 0 ${px(t.space[48])}`,
      },
      children: [block.props.sub],
    });
  }

  // §6 below sm: one column — except a grid whose every item is an icon and
  // a label of three words or fewer with no text, which reads as a spec
  // sheet in two. Between sm and md a grid caps at two columns, or three
  // tracks at ~800px make 22ch measures. `rows` is one column already.
  const itemFills = block.children.filter((c) => c.word === 'item');
  const specSheet = itemFills.length > 0 && itemFills.every((c) =>
    !!c.props.icon && !c.props.text && (c.args[0]?.value ?? '').trim().split(/\s+/).length <= SPEC_SHEET_MAX_WORDS);
  const columns = Number(block.props.columns ?? DEFAULT_COLUMNS);
  const tracks = (n: number) => `repeat(${n}, minmax(0, 1fr))`;

  const items = ctx.slot('item');
  if (items.length > 0) {
    children.push({
      tag: 'ul',
      attrs: { class: 'az-feature-items' },
      style: {
        display: 'grid',
        // `columns` counts items, so a number is honest here — PRD §6.1a.
        gridTemplateColumns: variant === 'rows'
          ? '1fr'
          : tracks(columns),
        // Row gap exceeds column gap, or a grid of items reads as columns of
        // text instead of a set.
        columnGap: px(t.space[32]),
        rowGap: px(t.space[48]),
        listStyle: 'none', padding: 0, margin: 0,
      },
      below: variant === 'rows' ? undefined : {
        md: { gridTemplateColumns: tracks(Math.min(columns, 2)) },
        sm: { gridTemplateColumns: variant === 'grid' && specSheet ? tracks(2) : tracks(1) },
      },
      children: items,
    });
  }

  // Section actions (spec §5/§6): the button primitive — one primary `cta`,
  // one `alt` — after the section's content, never inside an item.
  const actions = ctx.actions(block, ['cta', 'alt']);
  if (actions.length > 0) {
    children.push({
      tag: 'ul',
      attrs: { class: 'az-feature-actions' },
      style: {
        display: 'flex', flexWrap: 'wrap', gap: px(t.space[16]),
        listStyle: 'none', padding: 0, margin: `${px(t.space[48])} 0 0`,
      },
      children: actions,
    });
  }

  return {
    tag: 'section',
    attrs: { class: `az-feature az-feature--${variant}` },
    style: {
      paddingBlock: px(t.space[96]),
      paddingInline: px(t.size['gutter-lg']),
      background: t.color.bg,
      color: t.color.text,
    },
    // The mobile gutter below sm (theme-spec §1).
    below: { sm: { paddingInline: px(t.size['gutter-sm']) } },
    children,
  };
}
