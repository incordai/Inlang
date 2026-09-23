/**
 * `cta` — web emitter.
 *
 * cta-block-spec.md §3, the inverted-palette rule, is the reason this word
 * needs an emitter at all rather than a generic section:
 *
 *   `band` paints its OWN surface — usually the accent — so the buttons inside
 *   it cannot use the page's button colours. An accent-filled button on an
 *   accent band is a rectangle you can only find by hovering it. Primary
 *   inverts to filled `accent-contrast` with an accent label; secondary is an
 *   outline in `accent-contrast`, never the page's border.
 *
 * The three variants carry different WEIGHT, which is why they are words and
 * not a style prop: `band` is a hard stop before the footer and the page's
 * main conversion; `card` is contained and reads as an aside, so §2 says not
 * to use it for the main conversion; `split` pairs the ask with one genuinely
 * good image, at a 45–55% text column — below 40% the title breaks badly, the
 * same floor as hero §3.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { px, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'band';

  // Only `band` repaints the surface, so only `band` inverts (§3).
  const inverted = variant === 'band';
  const surface = inverted ? t.color.accent : t.color.bg;
  const ink = inverted ? t.color['accent-contrast'] : t.color.text;

  const children: EmittedNode[] = [];

  if (block.props.title) {
    children.push({
      tag: 'h2',
      attrs: { class: 'az-cta-title' },
      style: {
        fontSize: t.typeSize['2xl'],
        lineHeight: t.type['leading-tight'],
        fontFamily: t.type.display,
        fontWeight: t.type['weight-display'],
        // The measure goes on the text, never the container — hero-spec §3.
        maxWidth: `${t.size['measure-display']}ch`,
        margin: `0 0 ${px(t.space[16])}`,
        color: ink,
      },
      children: [block.props.title],
    });
  }

  if (block.props.sub) {
    children.push({
      tag: 'p',
      attrs: { class: 'az-cta-sub' },
      style: {
        fontSize: t.typeSize.lg,
        lineHeight: t.type['leading-body'],
        // §3: the muted colour is defined against the PAGE, so on an inverted
        // band it inverts with the buttons rather than staying page-muted.
        color: inverted ? t.color['accent-contrast'] : t.color.muted,
        maxWidth: `${t.size['measure-body']}ch`,
        margin: `0 0 ${px(t.space[24])}`,
      },
      children: [block.props.sub],
    });
  }

  // §3: on the accent band the buttons invert — contrast is measured against
  // the band, not the page.
  // §6: on the band, below sm the buttons stack and the primary fills the row.
  const actions = ctx.actions(block, ['cta', 'alt'], {
    tone: inverted ? 'inverted' : 'page',
    fullWidthBelow: inverted ? 'sm' : undefined,
  });
  if (actions.length > 0) {
    // Slot fills are <li>, so the row is a list — an <li> in a <div> is
    // invalid HTML, and a list also tells a reader how many actions there are.
    children.push({
      tag: 'ul',
      attrs: {
        class: 'az-cta-actions',
        // Marks which palette the buttons must be checked against — contrast
        // is measured against the BAND, not the page (§3, gate item 4).
        'data-palette': inverted ? 'inverted' : 'page',
      },
      style: { display: 'flex', gap: px(t.space[16]), flexWrap: 'wrap', listStyle: 'none', padding: 0, margin: 0 },
      below: inverted ? { sm: { flexDirection: 'column', alignItems: 'stretch' } } : undefined,
      children: actions,
    });
  }

  const text: EmittedNode = {
    tag: 'div',
    attrs: { class: 'az-cta-text' },
    children,
  };

  // `split` is the only variant with a media column (§2, §10 `requires`).
  const media = variant === 'split' ? splitMedia(block, ctx) : null;

  return {
    tag: 'section',
    attrs: { class: `az-cta az-cta--${variant}` },
    style: {
      // `split` puts the ask beside one image at a 45-55% text column; `band`
      // and `card` are a single column.
      display: variant === 'split' ? 'grid' : 'block',
      gridTemplateColumns: variant === 'split' ? 'minmax(0, 1fr) minmax(0, 1fr)' : undefined,
      alignItems: variant === 'split' ? 'center' : undefined,
      columnGap: variant === 'split' ? px(t.space[48]) : undefined,

      paddingBlock: px(t.space[96]),
      paddingInline: px(t.size['gutter-lg']),

      // `card` is INSET on the page background and reads as a contained
      // aside; `band` is full-bleed with its own surface and a hard edge.
      background: variant === 'card' ? t.color.surface : surface,
      color: ink,
      borderRadius: variant === 'card' ? px(t.radius.lg) : undefined,
      marginInline: variant === 'card' ? px(t.size['gutter-lg']) : undefined,
      border: variant === 'card' ? `1px solid ${t.color.border}` : undefined,
    },
    // §6, below sm: every variant takes the mobile gutter (theme-spec §1);
    // `band` drops its vertical padding a step; `card`'s inset drops to the
    // gutter; `split` restacks — text above, media below (source order).
    below: {
      sm: {
        paddingInline: px(t.size['gutter-sm']),
        paddingBlock: variant === 'band' ? px(t.space[64]) : undefined,
        marginInline: variant === 'card' ? px(t.size['gutter-sm']) : undefined,
        gridTemplateColumns: variant === 'split' ? 'minmax(0, 1fr)' : undefined,
        rowGap: variant === 'split' ? px(t.space[32]) : undefined,
      },
    },
    children: variant === 'split' ? (media ? [text, media] : [text]) : children,
  };
}

/**
 * The `split` image, after the text so a restack puts it below (§6).
 *
 * Its alt text is `describe`, never `alt` — `alt` is the secondary-button slot
 * (§11). Without a `describe` the image is decorative and gets `alt=""`; §9
 * allows no third option. `data-media` records which, because §6 drops
 * decorative media from the phone restack and keeps informative media.
 */
function splitMedia(block: SpecBlock, ctx: EmitContext): EmittedNode | null {
  if (!block.props.media) return null;
  const describe = block.props.describe;
  return {
    tag: 'div',
    attrs: {
      class: 'az-cta-media',
      'data-media': describe ? 'informative' : 'decorative',
    },
    // §6: decorative media is DROPPED below sm, not shrunk — stacked on a
    // phone it is a spacer between the visitor and the button. Informative
    // media (it has a `describe`) stays, below the text.
    below: describe ? undefined : { sm: { display: 'none' } },
    children: [{
      tag: 'img',
      attrs: {
        src: ctx.asset(block.props.media),
        alt: describe ?? '',
        class: 'az-cta-media-img',
        // A closing cta sits below the fold; it must not compete for LCP.
        loading: 'lazy',
        decoding: 'async',
      },
      style: {
        display: 'block',
        width: '100%',
        height: 'auto',
        borderRadius: px(ctx.theme.radius.lg),
      },
    }],
  };
}
