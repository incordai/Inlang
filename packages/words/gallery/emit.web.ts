/**
 * `gallery` — web emitter.
 *
 * gallery-block-spec.md is the specification; this implements its structural
 * core. Every design value arrives through `ctx.theme` — `az lint` proves
 * it (assumption A7), and a test walks the emitted tree to prove the OUTPUT
 * stays inside the token set too.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { px, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/** §2 — orbit "caps at 16 images". Past that it is a cost, not a gallery. */
const ORBIT_MAX = 16;

/**
 * The manifest's `ratio` words as CSS `aspect-ratio` values.
 *
 * `3:2` is how an author writes a ratio and is not valid CSS — the browser
 * drops `aspect-ratio: 3:2` silently and the box collapses to the image's own
 * shape. `portrait` is 4:5, the common portrait crop; the spec names it
 * without a number. `auto` keeps each image's intrinsic shape (§7 rule 1).
 */
const ASPECT: Record<string, string | undefined> = {
  square: '1 / 1', '4:3': '4 / 3', '3:2': '3 / 2', '16:9': '16 / 9',
  portrait: '4 / 5', auto: undefined,
};

/** The manifest default, for a block built without one (direct emitter calls). */
const DEFAULT_RATIO = '3:2';

/** §7 rule 2: the first row loads eagerly; `columns` is that row's length. */
const DEFAULT_COLUMNS = 3;

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'grid';
  const aspect = ASPECT[block.props.ratio ?? DEFAULT_RATIO];
  const children: EmittedNode[] = [];

  // A section heading is an <h2>: the hero owns the page's only <h1>
  // (hero-spec §4), so the outline stays valid at exactly one level down.
  if (block.props.title) {
    children.push({
      tag: 'h2',
      attrs: { class: 'az-gallery-title' },
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
      attrs: { class: 'az-gallery-sub' },
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

  // §9 — `orbit`'s poster is what the static tier, reduced motion and the
  // loading state show in place of the ring. It occupies the canvas box, so
  // the box is reserved at the same ratio before either one loads. The
  // poster's alt is empty: it is a composite of the images below, which stay
  // in the DOM as the real, labelled content — naming it again would make a
  // screen reader announce the set twice. Lazy and without a priority hint,
  // per §7: fetchpriority belongs to the hero's LCP element, never a gallery.
  if (variant === 'orbit' && block.props.poster) {
    children.push({
      tag: 'img',
      attrs: {
        src: ctx.asset(block.props.poster),
        alt: '',
        class: 'az-gallery-poster',
        loading: 'lazy',
        decoding: 'async',
      },
      style: {
        display: 'block',
        width: '100%',
        aspectRatio: aspect,
        objectFit: 'cover',
        borderRadius: px(t.radius.md),
        margin: `0 0 ${px(t.space[16])}`,
      },
    });
  }

  const sources = block.children.filter((c) => c.word === 'image');
  const shown = variant === 'orbit' ? sources.slice(0, ORBIT_MAX) : sources;
  // §10: <figure> + <figcaption> when captions exist; a plain list when not.
  const captioned = shown.some((c) => c.props.caption);
  const firstRow = Number(block.props.columns ?? DEFAULT_COLUMNS);
  const images = shown.map((c, i) => galleryImage(c, i < firstRow, captioned, aspect, variant, ctx));
  if (images.length > 0) {
    children.push({
      tag: 'ul',
      attrs: {
        class: 'az-gallery-items',
        'data-ratio': block.props.ratio ?? DEFAULT_RATIO,
        // `orbit` is the only variant that costs a 3D context. Declaring it
        // here is what lets the runtime load that machinery for this page and
        // nowhere else — scene-spec §5, one renderer per page.
        ...(variant === 'orbit' ? { 'data-az-runtime': '3d' } : {}),
      },
      style: {
        // §2, four genuinely different jobs:
        //   grid      a set of peers, one uniform crop
        //   masonry   mixed ratios you refuse to crop; column-major, so it is
        //             wrong for anything sequential
        //   carousel  a SEQUENCE with a beginning, in one screen of vertical
        //             space — a scrolling row that snaps, not a grid
        //   orbit     a small theatrical set; the most expensive thing in the
        //             spec, capped at 16 images and pulling the 3D runtime
        display: variant === 'carousel' ? 'flex' : 'grid',
        gridTemplateColumns: variant === 'grid'
          ? `repeat(${block.props.columns ?? '3'}, minmax(0, 1fr))`
          : variant === 'masonry'
            ? `repeat(auto-fill, minmax(${px(t.size['column-min'])}, 1fr))`
            : undefined,
        // A carousel scrolls horizontally and snaps; without the snap it is a
        // row that stops between slides, which is worse than a grid.
        overflowX: variant === 'carousel' ? 'auto' : undefined,
        scrollSnapType: variant === 'carousel' ? 'x mandatory' : undefined,
        gap: px(t.space[16]),
        listStyle: 'none', padding: 0, margin: 0,
      },
      children: images,
    });
  }

  return {
    tag: 'section',
    attrs: { class: `az-gallery az-gallery--${variant}` },
    style: {
      paddingBlock: px(t.space[96]),
      paddingInline: px(t.size['gutter-lg']),
      background: t.color.bg,
      color: t.color.text,
    },
    children,
  };
}

/**
 * One image of the set.
 *
 * `alt` is the author's (§10: it says what is visible, and is not the
 * caption); absent, the image is decorative — correct only when a caption
 * says it, which is what the spec's missing-alt warning is for. `focus` moves
 * the crop's focal point so a `ratio` crop does not behead people (§7).
 */
function galleryImage(
  image: SpecBlock, eager: boolean, captioned: boolean, aspect: string | undefined,
  variant: string, ctx: EmitContext,
): EmittedNode {
  const t = ctx.theme;
  const img: EmittedNode = {
    tag: 'img',
    attrs: {
      src: ctx.asset(image.args[0]?.value ?? ''),
      alt: image.props.alt ?? '',
      class: 'az-gallery-img',
      // §7 rule 2: eager first row, lazy after, and never fetchpriority.
      loading: eager ? 'eager' : 'lazy',
      decoding: 'async',
    },
    style: {
      display: 'block',
      width: '100%',
      height: aspect ? '100%' : 'auto',
      aspectRatio: aspect,
      objectFit: aspect ? 'cover' : undefined,
      objectPosition: image.props.focus && image.props.focus !== 'center' ? image.props.focus : undefined,
      borderRadius: px(t.radius.md),
    },
  };

  const content: EmittedNode = captioned
    ? {
        tag: 'figure',
        attrs: { class: 'az-gallery-figure' },
        style: { margin: 0 },
        children: [
          img,
          ...(image.props.caption
            ? [{
                tag: 'figcaption',
                attrs: { class: 'az-gallery-caption' },
                style: {
                  fontSize: t.typeSize.sm,
                  color: t.color.muted,
                  marginTop: px(t.space[8]),
                },
                children: [image.props.caption],
              } satisfies EmittedNode]
            : []),
        ],
      }
    : img;

  return {
    tag: 'li',
    attrs: { class: 'az-gallery-item' },
    style: {
      listStyle: 'none',
      // A carousel item is a fixed-width slide that snaps; in a grid it fills
      // its track.
      flex: variant === 'carousel' ? `0 0 ${px(t.size['column-min'])}` : undefined,
      scrollSnapAlign: variant === 'carousel' ? 'start' : undefined,
    },
    children: [content],
  };
}
