/**
 * @az word feature
 * Purpose: a set of features or benefits as items, with optional section actions.
 * Spec: docs/feature-block-spec.md · terms: az explain feature
 * Renders: section.az-feature.az-feature--{variant} > h2.az-feature-title? · p.az-feature-sub? ·
 *   ul.az-feature-items > li.az-feature-item(.az-feature-item--lead) > img.az-feature-media? (rows, bento) ·
 *     div.az-feature-item-body > svg|img.az-feature-icon? · h3|h2.az-feature-item-title ·
 *     p.az-feature-item-text? · div.az-feature-item-link? ·
 *   ul.az-feature-actions? > li > a|button ·
 *   with `from <table>`: div.az-from (core fromShell) in place of the item list — skeleton items, an empty
 *     rows container, the template list (one featureItem()), status line, retry/sign-in, noscript
 * Variants: grid — columns tracks (default 3), two below md, one below sm (two for a spec sheet) ·
 *   rows — one per row, media alternates sides on desktop, above text below sm ·
 *   bento — uneven tiles; the lead item gets the larger tile.
 * Modifiers: reveal — data-az-reveal on the block, data-az-reveal-item on items; the overlay runtime hides by script, once.
 * Props: title → h2.az-feature-title · sub → p.az-feature-sub · columns → grid tracks ·
 *   item title/text/icon/media/lead → the item parts above; item link → div.az-feature-item-link ·
 *   from → rows of a table fill the items after the page (data-spec §10): title ← text, text ← text/longtext, media ← image.
 * Styling: theme tokens only; row gap larger than column gap; below.md / below.sm track counts;
 *   icons inlined and sanitised (ctx.inlineSvg) so they take the text colour.
 * Behaviour: none; section buttons by target-web/src/actions.ts; `from` rows by the overlay runtime's rows.ts.
 * Edit guide: one item → featureItem(); grid tracks → featureList(); loading item → skeletonItem();
 *   media `sizes` → mediaSizes(), which must follow featureList()'s tracks.
 *   Keep: items render their own props (never the generic slot renderer); no skipped heading level.
 * Tests: packages/words/test/props.test.ts, packages/words/test/variants.test.ts, packages/words/test/structure.test.ts, packages/words/test/feature-items.test.ts, packages/words/test/responsive.test.ts, packages/words/test/from-blocks.test.ts
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
import {
  contentShare, framed, fromFill, fromShell, isFromMark, px, revealed, skeletonLine, type EmitContext, type EmittedNode,
} from '../../core/src/emit-contract.ts';

/** The manifest's `columns` default. */
const DEFAULT_COLUMNS = 3;

/** Between sm and md a grid or bento caps at this many tracks (featureList). */
const MD_MAX_COLUMNS = 2;

/** `rows`: media and text share the row in equal columns, from sm up. */
const ROWS_COLUMNS = 2;

/**
 * gallery-spec §7 rule 3: how wide an item's media is drawn at each
 * viewport — the `sizes` the target writes beside the srcset it builds. It
 * follows featureList() and featureItem(): `rows` is the whole content
 * below sm (media above the text), then one of two equal columns; `bento`
 * is one tile per row below sm, at most two under md, then `columns`. Each
 * value is an upper bound — gaps and gutters only make the box smaller —
 * and a share of the viewport is capped by the same share of the site
 * frame, which the content never exceeds.
 */
function mediaSizes(variant: string, columns: number, ctx: EmitContext): string {
  const t = ctx.theme;
  const frame = ctx.site.frame;
  const sm = `(width < ${px(t.breakpoint.sm)}) ${contentShare(1, frame, t.breakpoint.sm)}`;
  if (variant === 'rows') return `${sm}, ${contentShare(ROWS_COLUMNS, frame)}`;
  const mdColumns = Math.min(columns, MD_MAX_COLUMNS);
  const md = `(width < ${px(t.breakpoint.md)}) ${contentShare(mdColumns, frame, t.breakpoint.md)}`;
  // At two columns or fewer md draws them as wide as the desktop does: no condition of its own.
  return [sm, ...(mdColumns === columns ? [] : [md]), contentShare(columns, frame)].join(', ');
}

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
function featureItem(
  item: SpecBlock, index: number, variant: string, columns: number, ctx: EmitContext, heading: 'h2' | 'h3',
): EmittedNode {
  const t = ctx.theme;
  const rows = variant === 'rows';
  // From a table, the row's image URL fills it after the page (data-spec §10).
  const fromRow = isFromMark(item.props.media ?? '');
  const media = item.props.media && (rows || variant === 'bento')
    ? {
        tag: 'img',
        attrs: {
          src: fromRow ? item.props.media : ctx.asset(item.props.media),
          alt: '',
          class: 'az-feature-media',
          loading: 'lazy',
          decoding: 'async',
          // gallery-spec §7 rule 3: the layout's widths, for the srcset the
          // build writes — or, for a row (whose file is the server's), the
          // one the rows runtime writes from its width copies (data-spec §8).
          sizes: mediaSizes(variant, columns, ctx),
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
          // One equal column per child: media and text side by side, and a
          // row from a table that has no image (its <img> dropped) takes the
          // whole width with its text alone.
          gridAutoFlow: 'column',
          gridAutoColumns: 'minmax(0, 1fr)',
          columnGap: px(t.space[48]),
          alignItems: 'center',
        }
      : { listStyle: 'none' },
    below: rows && media ? { sm: { gridAutoFlow: 'row', rowGap: px(t.space[24]) } } : undefined,
    children: media ? [media, body] : [body],
  };
}

/** The item list: `columns` tracks for grid and bento, one column for rows. */
function featureList(variant: string, columns: number, specSheet: boolean, ctx: EmitContext, items: EmittedNode[]): EmittedNode {
  const t = ctx.theme;
  const tracks = (n: number) => `repeat(${n}, minmax(0, 1fr))`;
  return {
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
      md: { gridTemplateColumns: tracks(Math.min(columns, MD_MAX_COLUMNS)) },
      sm: { gridTemplateColumns: variant === 'grid' && specSheet ? tracks(2) : tracks(1) },
    },
    children: items,
  };
}

/**
 * A loading item (data-spec §10.3): a title line and two lines of text, in
 * the item's own box, so the skeleton is about as tall as the rows.
 */
function skeletonItem(variant: string, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const text = (width: string) => skeletonLine(t, t.typeSize.base, t.type['leading-body'], width);
  return {
    tag: 'li',
    attrs: { class: 'az-feature-item az-from-skeleton-item' },
    style: { listStyle: 'none', display: 'grid', rowGap: px(t.space[8]), maxWidth: variant === 'rows' ? `${t.size['measure-body']}ch` : undefined },
    children: [skeletonLine(t, t.typeSize.lg, t.type['leading-tight'], '60%'), text('100%'), text('80%')],
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

  // The word renders its own items: the generic slot renderer prints every
  // prop as a paragraph, which put `icon`/`media` paths and the `lead` flag on
  // the page as text.
  // The outline never skips a level: items are <h3> under the section's
  // <h2> title, and <h2> themselves when there is no title (feature-spec
  // §10; faq and pricing specs: no skipped level).
  const heading = block.props.title ? 'h3' : 'h2';
  if (block.from) {
    // data-spec §10: items load from a table after the page. The template is
    // one item rendered by featureItem() itself, so a row is an item.
    const template = featureItem(fromFill(block.from), 0, variant, columns, ctx, heading);
    children.push(fromShell(block.from, featureList(variant, columns, false, ctx, [template]), skeletonItem(variant, ctx), ctx));
  }
  const items = itemFills.map((c, i) => featureItem(c, i, variant, columns, ctx, heading));
  if (items.length > 0) children.push(featureList(variant, columns, specSheet, ctx, items));

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
    // Rows arrive after the reveal is set up, so a `from` block rises as one
    // unit rather than staggering a skeleton the rows then replace.
  }, block.from ? undefined : 'az-feature-item');
}
