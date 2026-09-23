/**
 * @az word feature
 * Purpose: a set of features or benefits as items, with optional section actions.
 * Spec: docs/feature-block-spec.md · terms: az explain feature
 * Renders: section.az-feature.az-feature--{variant} > h2.az-feature-title? · p.az-feature-sub? ·
 *   ul.az-feature-items > li.az-feature-item(.az-feature-item--lead) > img.az-feature-media? (rows, bento) ·
 *     div.az-feature-item-body > svg|img.az-feature-icon? · h3|h2.az-feature-item-title ·
 *     p.az-feature-item-text? · div.az-feature-item-link? ·
 *   ul.az-feature-actions? > li > a|button
 * Variants: grid — columns tracks (default 3), two below md, one below sm (two for a spec sheet) ·
 *   rows — one per row, media alternates sides on desktop, above text below sm ·
 *   bento — uneven tiles; the lead item gets the larger tile.
 * Modifiers: reveal — data-az-reveal on the block, data-az-reveal-item on items; the overlay runtime hides by script, once.
 * Props: title → h2.az-feature-title · sub → p.az-feature-sub · columns → grid tracks ·
 *   item title/text/icon/media/lead → the item parts above; item link → div.az-feature-item-link.
 * Styling: theme tokens only; row gap larger than column gap; below.md / below.sm track counts;
 *   icons inlined and sanitised (ctx.inlineSvg) so they take the text colour.
 * Behaviour: none; section buttons by target-web/src/actions.ts.
 * Edit guide: one item → featureItem(); grid tracks → the ul's style/below.
 *   Keep: items render their own props (never the generic slot renderer); no skipped heading level.
 * Tests: packages/words/test/props.test.ts, packages/words/test/variants.test.ts, packages/words/test/structure.test.ts, packages/words/test/feature-items.test.ts, packages/words/test/responsive.test.ts
 */

/**
 * `feature` — web emitter.
 *
 * feature-block-spec.md is the specification; this implements its structural
 * core. Every design value arrives through `ctx.theme` — `az lint` proves
 * it (assumption A7), and a test walks the emitted tree to prove the OUTPUT
 * stays inside the token set too.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { framed, px, revealed, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/** The manifest's `columns` default. */
const DEFAULT_COLUMNS = 3;

/** §6: "a label of ≤3 words" — the spec-sheet exception to one column. */
const SPEC_SHEET_MAX_WORDS = 3;

/** `lead` is a flag written bare on the item: `item "Sewn, not glued" lead`. */
const isLead = (item: SpecBlock) =>
  'lead' in item.props || item.args.slice(1).some((a) => a.kind === 'word' && a.value === 'lead');

/**
 * One item. §7: the icon is always decorative (the title carries the
 * meaning); `media` belongs to `rows` and `bento` and is illustration beside
 * its title, so it is decorative too. §4: item titles are body type with
 * weight, never the display face.
 *
 * §6 `rows`: media beside text, alternating sides row by row (every second
 * row puts the media on the right); below sm media sits above the text in
 * every row and the alternation is dropped.
 */
function featureItem(item: SpecBlock, index: number, variant: string, ctx: EmitContext, heading: 'h2' | 'h3'): EmittedNode {
  const t = ctx.theme;
  const rows = variant === 'rows';
  const media = item.props.media && (rows || variant === 'bento')
    ? {
        tag: 'img',
        attrs: {
          src: ctx.asset(item.props.media),
          alt: '',
          class: 'az-feature-media',
          loading: 'lazy',
          decoding: 'async',
        },
        style: {
          display: 'block',
          width: '100%',
          height: 'auto',
          borderRadius: px(t.radius.md),
          order: rows && index % 2 === 1 ? 1 : undefined,
        },
        below: rows && index % 2 === 1 ? { sm: { order: 0 } } : undefined,
      } satisfies EmittedNode
    : null;

  const text: EmittedNode[] = [];
  if (item.props.icon) {
    const style = { display: 'block', height: px(t.space[32]), width: 'auto', marginBottom: px(t.space[16]) };
    // §7: inlined and sanitised, so it takes the theme's colour; decorative
    // either way. Without file access the target offers no inlining, and the
    // file is shown as an <img>, which cannot run script either.
    const inlined = ctx.inlineSvg?.(item.props.icon);
    text.push(inlined
      ? { ...inlined, attrs: { ...inlined.attrs, class: 'az-feature-icon' }, style }
      : { tag: 'img', attrs: { src: ctx.asset(item.props.icon), alt: '', 'aria-hidden': 'true', class: 'az-feature-icon' }, style });
  }
  text.push({
    tag: heading,
    attrs: { class: 'az-feature-item-title' },
    style: {
      fontFamily: t.type.body,
      fontSize: t.typeSize.lg,
      fontWeight: t.type['weight-bold'],
      lineHeight: t.type['leading-tight'],
      textWrap: 'balance',
      margin: `0 0 ${px(t.space[8])}`,
    },
    children: [item.args[0]?.value ?? ''],
  });
  if (item.props.text) {
    text.push({
      tag: 'p',
      attrs: { class: 'az-feature-item-text' },
      style: {
        fontSize: t.typeSize.base,
        lineHeight: t.type['leading-body'],
        color: t.color.muted,
        textWrap: 'pretty',
        margin: 0,
      },
      children: [item.props.text],
    });
  }
  for (const link of item.children.filter((c) => c.word === 'link')) {
    text.push({
      tag: 'div',
      attrs: { class: 'az-feature-item-link' },
      style: { marginTop: px(t.space[12]) },
      children: [ctx.action(link, { hierarchy: 'link' })],
    });
  }

  const body: EmittedNode = {
    tag: 'div',
    attrs: { class: 'az-feature-item-body' },
    style: { maxWidth: `${t.size['measure-body']}ch` },
    children: text,
  };

  return {
    tag: 'li',
    attrs: { class: `az-feature-item${isLead(item) ? ' az-feature-item--lead' : ''}` },
    style: rows
      ? {
          listStyle: 'none',
          display: 'grid',
          gridTemplateColumns: media ? 'repeat(2, minmax(0, 1fr))' : 'minmax(0, 1fr)',
          columnGap: px(t.space[48]),
          alignItems: 'center',
        }
      : { listStyle: 'none' },
    below: rows && media ? { sm: { gridTemplateColumns: 'minmax(0, 1fr)', rowGap: px(t.space[24]) } } : undefined,
    children: media ? [media, body] : [body],
  };
}

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

  // The word renders its own items: the generic slot renderer prints every
  // prop as a paragraph, which put `icon`/`media` paths and the `lead` flag on
  // the page as text.
  // The outline never skips a level: items are <h3> under the section's
  // <h2> title, and <h2> themselves when there is no title (feature-spec
  // §10; faq and pricing specs: no skipped level).
  const heading = block.props.title ? 'h3' : 'h2';
  const items = itemFills.map((c, i) => featureItem(c, i, variant, ctx, heading));
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

  return revealed(block, t, {
    tag: 'section',
    attrs: { class: `az-feature az-feature--${variant}` },
    style: {
      paddingBlock: px(t.space[96]),
      paddingInline: framed(t),
      background: t.color.bg,
      color: t.color.text,
    },
    // The mobile gutter below sm (theme-spec §1).
    below: { sm: { paddingInline: px(t.size['gutter-sm']) } },
    children,
  }, 'az-feature-item');
}
