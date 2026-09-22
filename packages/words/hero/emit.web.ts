/**
 * `hero` — web emitter.
 *
 * hero-block-spec.md is the specification; this file implements it. The rules
 * encoded here are the ones the spec says are most often got wrong, so each
 * carries the section it comes from.
 *
 * Every design value arrives through `ctx.theme`. There is not one colour or
 * off-scale length in this file, and `az lint` proves it (assumption A7).
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { px, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/** §6 — height is a WORD, and the emitter supplies the unit. */
const HEIGHT: Record<string, number> = {
  compact: 70,
  peek: 85,     // default: leaves the next section visible, which earns the scroll
  tall: 92,
  full: 100,
};

/** §4 — display type is fluid; `full` and `minimal` get the larger step. */
const bigDisplay = (variant: string | null) =>
  variant === 'full' || variant === 'minimal';

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'center';
  const heightWord = block.props.height ?? 'peek';
  const children: EmittedNode[] = [];

  // §4 — the eyebrow is styled small and tracked but is NOT a heading. Marking
  // it up as one breaks the document outline, which is invisible until an
  // audit and then expensive.
  if (block.props.eyebrow) {
    children.push({
      tag: 'p',
      attrs: { class: 'az-hero-eyebrow' },
      style: {
        fontSize: t.typeSize.xs,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: t.color.muted,
        marginBottom: px(t.space[16]),
      },
      children: [block.props.eyebrow],
    });
  }

  // §4 — exactly one <h1> per page, and it lives here.
  if (block.props.title) {
    children.push({
      tag: 'h1',
      attrs: { class: 'az-hero-title' },
      style: {
        // §3 — the MEASURE goes on the text, never on the container. Putting
        // it on the container squeezes the sub to one word per line.
        maxWidth: `${t.size['measure-display']}ch`,
        fontSize: bigDisplay(variant) ? t.typeSize['display-lg'] : t.typeSize.display,
        lineHeight: t.type['leading-display'],
        letterSpacing: '-0.03em',
        fontWeight: t.type['weight-display'],
        fontFamily: t.type.display,
        color: t.color.text,
        margin: 0,
      },
      children: [block.props.title],
    });
  }

  if (block.props.sub) {
    children.push({
      tag: 'p',
      attrs: { class: 'az-hero-sub' },
      style: {
        maxWidth: `${t.size['measure-body']}ch`,
        fontSize: t.typeSize.lg,
        lineHeight: t.type['leading-body'],
        color: t.color.muted,
        // §7 — the gap before the buttons is the LARGEST internal gap: it
        // separates "what this is" from "what to do".
        margin: `${px(t.space[24])} 0 0`,
      },
      children: [block.props.sub],
    });
  }

  // §5 — one primary, one secondary. `alt` is the secondary (§1): it follows
  // the primary in the same row and is rendered by the same slot path, so its
  // destination is handled exactly as a `cta`'s is.
  const actions = [...ctx.slot('cta'), ...ctx.slot('alt')];
  if (actions.length > 0) {
    children.push({
      tag: 'div',
      attrs: { class: 'az-hero-actions' },
      style: { display: 'flex', gap: px(t.space[16]), marginTop: px(t.space[48]) },
      children: actions,
    });
  }

  // §8 — every 3D hero ships a poster: the static tier, the loading state and
  // reduced motion all show it. `describe` is its alt text (§9); `alt` is the
  // secondary button, never an image description. Not lazy — it is in the
  // first viewport — and no fetchpriority, because the TEXT is the LCP
  // element (§8), not the media.
  if (block.modifiers.includes('3d') && block.props.poster) {
    children.push({
      tag: 'img',
      attrs: {
        src: ctx.asset(block.props.poster),
        alt: block.props.describe ?? '',
        class: 'az-hero-poster',
        decoding: 'async',
      },
      style: { display: 'block', width: '100%', height: 'auto', objectFit: 'cover' },
    });
  }

  return {
    tag: 'header',
    attrs: {
      class: `az-hero az-hero--${variant}`,
      'data-height': heightWord,
    },
    style: {
      // §6 — svh, not vh. Browser chrome makes 100vh taller than the visible
      // area, so content clips on a phone.
      minHeight: `${HEIGHT[heightWord] ?? HEIGHT.peek}svh`,
      // §2 — the layouts differ in WHERE the media sits relative to the type:
      //   split  the visual IS the product, so it takes a real column beside
      //          the text (40-50% width). Two columns, not one.
      //   stack  a tall visual or a UI shot: type first, media below the fold
      //          line at full width. One column, and the type does not centre
      //          vertically or the media is pushed off screen.
      //   center/full/minimal  a single centred column of type.
      display: variant === 'split' ? 'grid' : 'flex',
      gridTemplateColumns: variant === 'split' ? 'minmax(0, 1fr) minmax(0, 1fr)' : undefined,
      alignItems: variant === 'split' ? 'center' : undefined,
      columnGap: variant === 'split' ? px(t.space[48]) : undefined,
      flexDirection: variant === 'split' ? undefined : 'column',
      justifyContent: variant === 'stack' ? 'flex-start' : 'center',
      paddingBlock: variant === 'stack' ? px(t.space[96]) : undefined,
      textAlign: variant === 'center' || variant === 'full' ? 'center' : undefined,
      paddingInline: px(t.size['gutter-lg']),
      // §8 — text sits over media only with a SCRIM, and a scrim is a gradient
      // over a colour, never a flat opacity layer that dims the whole image.
      background: variant === 'full' ? t.color.scrim : 'transparent',
      color: variant === 'full' ? t.color['on-scrim'] : t.color.text,
    },
    children,
  };
}
