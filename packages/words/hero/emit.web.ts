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
        // `full` sets its type on the scrim: `muted` is for the page's own
        // background, and on the scrim it falls to 2.4:1 in the light scheme.
        color: variant === 'full' ? t.color['on-scrim'] : t.color.muted,
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
        color: variant === 'full' ? t.color['on-scrim'] : t.color.muted,
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
  // Buttons through the primitive (buttons-and-sections §1): the first `cta`
  // primary, `alt` secondary; below xs the primary fills the row and the
  // secondary becomes a text link (§5).
  // `full` sets everything on the scrim, its actions included.
  const actions = ctx.actions(block, ['cta', 'alt'], { compactBelow: 'xs', tone: variant === 'full' ? 'scrim' : undefined });
  if (actions.length > 0) {
    // Slot fills are <li>; an <li> in a <div> is invalid HTML.
    children.push({
      tag: 'ul',
      attrs: { class: 'az-hero-actions' },
      style: {
        display: 'flex', gap: px(t.space[16]), marginTop: px(t.space[48]),
        marginBottom: 0, listStyle: 'none', padding: 0,
      },
      // §5: under 480px the primary goes full-width; the secondary stays a
      // text link, which a full-width row does not change.
      below: { xs: { flexDirection: 'column', alignItems: 'stretch' } },
      children: actions,
    });
  }

  // §8 — `3d` draws into the page's one renderer (scene-spec §5). The hero
  // never creates it: it emits the view the renderer draws into — its box,
  // how it moves, its model if any — and the runtime does the rest. Inside
  // it, the poster: the static tier, the loading state and reduced motion
  // all show it. `describe` is its alt text (§9); `alt` is the secondary
  // button, never an image description. Not lazy — it is in the first
  // viewport — and no fetchpriority: the TEXT is the LCP element (§8).
  const threeD = block.modifiers.includes('3d');
  const behind = variant === 'full';
  if (threeD) {
    const poster: EmittedNode[] = block.props.poster
      ? [{
          tag: 'img',
          attrs: {
            src: ctx.asset(block.props.poster),
            alt: block.props.describe ?? '',
            class: 'az-hero-poster',
            decoding: 'async',
            'data-az-live-part': '',
          },
          style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' },
          // The canvas draws here now; the poster steps aside, not away.
          states: { live: { visibility: 'hidden' } },
        }]
      : [];
    children.push({
      tag: 'div',
      attrs: {
        class: 'az-hero-visual',
        'data-az-3d': 'hero',
        'data-az-camera': block.modifiers.includes('scroll') ? 'scroll'
          : block.modifiers.includes('parallax') ? 'parallax' : 'fixed',
        ...(block.props.model ? { 'data-az-model': ctx.asset(block.props.model) } : {}),
        // §9: named by `describe` when the author gave one; without it the
        // headline carries the meaning and the visual is decorative.
        ...(block.props.describe
          ? { role: 'img', 'aria-label': block.props.describe }
          : { 'aria-hidden': 'true' }),
      },
      // `full` puts the visual behind the type (under its scrim); every other
      // layout gives it its own rectangle in the flow (§8's table, row 1).
      style: behind
        ? { position: 'absolute', inset: '0', zIndex: t.layer.behind }
        : { position: 'relative', width: '100%', aspectRatio: variant === 'split' ? '4 / 3' : '16 / 9', marginTop: variant === 'split' ? undefined : px(t.space[48]) },
      children: poster,
    });
  }

  // §2 — `split` gives the text ONE column and the visual the other. Placing
  // eyebrow, title, sub and actions straight into a two-column grid paired
  // them up across the columns instead. The media column is emitted even
  // before a poster exists: it is where the visual — poster now, the 3D
  // canvas later — takes its 40–50% of the width.
  const content: EmittedNode[] = variant === 'split'
    ? [
        {
          tag: 'div',
          attrs: { class: 'az-hero-text' },
          style: { minWidth: 0 },
          children: children.filter((c) => c.attrs?.class !== 'az-hero-visual'),
        },
        {
          tag: 'div',
          attrs: { class: 'az-hero-media' },
          style: { minWidth: 0 },
          children: children.filter((c) => c.attrs?.class === 'az-hero-visual'),
        },
      ]
    : children;

  return {
    tag: 'header',
    attrs: {
      class: `az-hero az-hero--${variant}`,
      'data-height': heightWord,
      ...(threeD ? { 'data-az-3d-host': '' } : {}),
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
      // A 3D `full` hero is the positioning context for its visual, and its
      // own stacking context, so the visual sits under the type, not over it.
      position: threeD && behind ? 'relative' : undefined,
      isolation: threeD && behind ? 'isolate' : undefined,
    },
    // §8: while the canvas draws behind a `full` hero, the flat scrim becomes
    // a gradient over the scene — never a flat layer that dims it whole.
    states: threeD && behind
      ? { live: { background: `linear-gradient(to top, color-mix(in srgb, ${t.color.scrim} 88%, transparent), color-mix(in srgb, ${t.color.scrim} 55%, transparent))` } }
      : undefined,
    // §10: under 768px `split` restacks to `stack` — text above, media
    // below, which is already the source order. center, stack and minimal
    // are unchanged; full's crop and scrim wait for the 3D runtime.
    // Every variant takes the mobile gutter below sm (§3, theme-spec §1).
    below: {
      sm: {
        paddingInline: px(t.size['gutter-sm']),
        ...(variant === 'split' ? { gridTemplateColumns: 'minmax(0, 1fr)', columnGap: 0 } : {}),
      },
    },
    children: content,
  };
}
