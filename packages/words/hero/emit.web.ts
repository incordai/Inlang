/**
 * @az word hero
 * Purpose: page opener — the page's only <h1>, a supporting line, up to three actions, optional 3D.
 * Spec: docs/hero-block-spec.md · terms: az explain hero
 * Renders: header.az-hero.az-hero--{variant}[data-height] >
 *   p.az-hero-eyebrow? · h1.az-hero-title? · p.az-hero-sub? ·
 *   ul.az-hero-actions? > li > a|button (ctx.actions: cta primary, alt secondary) ·
 *   div.az-hero-visual[data-az-3d=hero]? > img.az-hero-poster?   (only with 3d) ·
 *   div.az-hero-scrim?   (full + 3d: the gradient over the visual, the same at every width)
 *   split wraps them as div.az-hero-text + div.az-hero-media (visual goes in media).
 * Variants: center — centred column, centred text · split — two-column grid text|media, one column below sm ·
 *   full — scrim background, on-scrim type, visual absolutely behind · stack — column from the top, visual below ·
 *   minimal — one column at the start edge, larger display type (display-lg).
 * Modifiers: 3d — emits the visual box + poster for the page renderer · scroll / parallax — set data-az-camera ·
 *   glass — blurred veil over a backdrop (translucent.states.overBackdrop).
 * Props: eyebrow → p.az-hero-eyebrow · title → h1.az-hero-title · sub → p.az-hero-sub ·
 *   height → min-height in svh (HEIGHT table) + data-height · poster → img.az-hero-poster via ctx.asset ·
 *   describe → poster alt and the visual's aria-label · model → data-az-model via ctx.asset ·
 *   focus → the poster's object-position (the crop's focal point); the poster's `sizes` → posterSizes().
 * Styling: theme tokens only; below.sm mobile gutter (+ split one column); actions below.xs stack;
 *   states.live hides the poster (full: the header clears, the scrim layer stays);
 *   states.overBackdrop gives the veil;
 *   the site's `theme pattern` (t.pattern, var refs) is the header's background except on `full`.
 * Behaviour: 3D drawn by packages/scene-runtime from data-az-3d; buttons by target-web/src/actions.ts.
 * Edit guide: layout per variant → the header's style; type → the h1/p styles; actions → ctx.actions options.
 *   Keep: exactly one <h1>; eyebrow never a heading; measure on the text, not the container; svh not vh;
 *   no raw colour or off-scale px (az lint).
 * Tests: packages/words/test/props.test.ts, packages/words/test/variants.test.ts, packages/words/test/structure.test.ts, packages/words/test/hero-alt.test.ts, packages/words/test/hero-scrim.test.ts, packages/words/test/responsive-pilot.test.ts, packages/words/test/type-on-scrim.test.ts, packages/target-web/test/solid-over-hero.test.ts
 */

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
import {
  contentShare, framed, glassSurface, px, type EmitContext, type EmittedNode,
} from '../../core/src/emit-contract.ts';

/** §6 — height is a WORD, and the emitter supplies the unit. */
const HEIGHT: Record<string, number> = {
  compact: 70,
  peek: 85,     // default: leaves the next section visible, which earns the scroll
  tall: 92,
  full: 100,
};

/**
 * §8/§10 — `full`'s scrim over its visual: alpha stops of `color.scrim`, from
 * the bottom edge to the top, the same at every width. `top` is derived, not
 * chosen (§10): 63% is the smallest whole percent at which `on-scrim` holds
 * 4.5:1 over a pure-white pixel — the worst a poster or scene can show — in
 * every theme and scheme (paper light is the edge); 65 keeps the veil's two
 * points for the browser's compositing (theme VEIL_PERCENT). The gradient
 * never falls below its top stop, so the type holds wherever it sits — the
 * header's height and the copy's length move it. test/hero-scrim.test.ts
 * proves both stops.
 */
export const SCRIM = { bottom: 88, top: 65 } as const;

/** §2: `split`'s text and media share the hero in two equal columns, from sm up. */
const SPLIT_COLUMNS = 2;

/**
 * gallery-spec §7 rule 3: how wide the poster is drawn at each viewport —
 * the `sizes` the target writes beside the srcset it builds. It follows the
 * visual's box (§8): `full` puts it behind the type over the whole header,
 * which is full-bleed — the frame only insets the type — so it is the
 * viewport, never capped. `split` is the whole content below sm (restacked
 * under the text, §10), then one of the two equal columns. `center`,
 * `stack` and `minimal` give it the content's full width. Each value is an
 * upper bound — gaps and gutters only shrink the box — and a share of the
 * viewport is capped by the same share of the site frame.
 */
function posterSizes(variant: string, ctx: EmitContext): string {
  const t = ctx.theme;
  const frame = ctx.site.frame;
  if (variant === 'full') return contentShare(1, undefined);
  if (variant === 'split') {
    return `(width < ${px(t.breakpoint.sm)}) ${contentShare(1, frame, t.breakpoint.sm)}, ${contentShare(SPLIT_COLUMNS, frame)}`;
  }
  return contentShare(1, frame);
}

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
        // On `full` the title sits on the scrim like the eyebrow and sub; its
        // own class overrides the header's colour, and `text` IS `scrim` in
        // every light scheme — a 1:1 title.
        color: variant === 'full' ? t.color['on-scrim'] : t.color.text,
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
      // text link, which a full-width row does not change. A centred column
      // shrinks the row to its buttons, so it stretches back to the width.
      below: { xs: { flexDirection: 'column', alignItems: 'stretch', alignSelf: 'stretch' } },
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
  /** §2 — the layouts whose type is one centred column. */
  const centred = variant === 'center' || variant === 'full';
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
            // The layout's widths, for the srcset the build writes. Loading
            // stays as above: eager, no priority hint.
            sizes: posterSizes(variant, ctx),
          },
          // §10: the poster is cropped to its box — wide on a desktop, tall
          // on a phone under `full` — so `focus` names the part it keeps,
          // as gallery's does (gallery-spec §7).
          style: {
            display: 'block', width: '100%', height: '100%', objectFit: 'cover',
            objectPosition: block.props.focus && block.props.focus !== 'center' ? block.props.focus : undefined,
          },
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
    // §8/§9: the type over the visual sits on a gradient scrim. The header's
    // own background is under the visual, so the scrim is a layer of its own
    // over it — the poster now, the canvas when live. Its light end is the
    // stop that holds over any pixel, at every width (§10, SCRIM).
    if (behind) {
      children.push({
        tag: 'div',
        attrs: { class: 'az-hero-scrim', 'aria-hidden': 'true' },
        style: {
          position: 'absolute', inset: '0', zIndex: t.layer.behind, pointerEvents: 'none',
          background: `linear-gradient(to top, color-mix(in srgb, ${t.color.scrim} ${SCRIM.bottom}%, transparent), color-mix(in srgb, ${t.color.scrim} ${SCRIM.top}%, transparent))`,
        },
      });
    }
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
      //   center/full  a single centred column of type.
      //   minimal      a single column of type at the start edge (§2).
      display: variant === 'split' ? 'grid' : 'flex',
      gridTemplateColumns: variant === 'split' ? 'minmax(0, 1fr) minmax(0, 1fr)' : undefined,
      columnGap: variant === 'split' ? px(t.space[48]) : undefined,
      flexDirection: variant === 'split' ? undefined : 'column',
      // A centred column centres its BOXES, not only the text in them: the
      // title and sub carry their own measure (§3) and the actions are a flex
      // row, so stretched to the width they would sit at the start edge with
      // their text centred inside — off the title's axis.
      alignItems: variant === 'split' || centred ? 'center' : undefined,
      justifyContent: variant === 'stack' ? 'flex-start' : 'center',
      paddingBlock: variant === 'stack' ? px(t.space[96]) : undefined,
      textAlign: centred ? 'center' : undefined,
      paddingInline: framed(t),
      // §8 — text sits over media only with a SCRIM, and a scrim is a gradient
      // over a colour, never a flat opacity layer that dims the whole image.
      background: variant === 'full' ? t.color.scrim : 'transparent',
      // PRD §6.1a `theme pattern`: the site's shape, drawn in the accent at a
      // contrast-proven strength (theme PATTERN_MAX_ALPHA). `full` keeps its
      // scrim; over a backdrop the veil's shorthand covers the pattern.
      ...(t.pattern && variant !== 'full'
        ? { backgroundImage: t.pattern.image, backgroundSize: t.pattern.size, backgroundPosition: t.pattern.position }
        : {}),
      color: variant === 'full' ? t.color['on-scrim'] : t.color.text,
      // A 3D `full` hero is the positioning context for its visual, and its
      // own stacking context, so the visual sits under the type, not over it.
      position: threeD && behind ? 'relative' : undefined,
      isolation: threeD && behind ? 'isolate' : undefined,
    },
    // §8: while the canvas draws behind a `full` hero, the flat scrim clears
    // so the scene shows; the scrim layer over the visual is its gradient —
    // never a flat layer that dims it whole.
    states: {
      ...(threeD && behind ? { live: { background: 'transparent' } } : {}),
      // scene-spec §6.5: over a page's backdrop, type never sits on the live
      // surface — every variant but `full` (already on its scrim) takes the veil.
      ...(variant === 'full' ? {} : { overBackdrop: { background: t.color.veil } }),
    },
    // `glass`: the veil under the type, blurred (nav-spec §3's mechanism). The
    // only thing behind a hero's type is the page's backdrop, so glass is the
    // backdrop state's surface; `full` already sets its type on the scrim,
    // where glass does nothing (warning AZ2123).
    translucent: block.modifiers.includes('glass') && variant !== 'full'
      ? { states: { overBackdrop: glassSurface(t) } }
      : undefined,
    // §10: under 768px `split` restacks to `stack` — text above, media
    // below, which is already the source order. center, stack and minimal
    // are unchanged; full keeps its focal point (`focus`), and its scrim
    // already holds over any pixel at every width (SCRIM).
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
