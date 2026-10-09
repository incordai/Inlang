/**
 * @az word gallery
 * Purpose: a set of images in a chosen layout, optionally opening in a lightbox.
 * Spec: docs/gallery-block-spec.md · terms: az explain gallery
 * Renders: section.az-gallery.az-gallery--{variant}[data-az-behaviour] > h2.az-gallery-title? · p.az-gallery-sub? ·
 *   (orbit) div.az-gallery-orbit[data-az-3d=orbit] > img.az-gallery-poster? ·
 *   ul.az-gallery-items[data-az-track] > li.az-gallery-item >
 *     img.az-gallery-img | figure.az-gallery-figure > img + figcaption.az-gallery-caption ;
 *     with lightbox: button.az-gallery-open[data-az-index] around the image ·
 *   (carousel) div.az-gallery-carousel > div.az-gallery-controls > button.az-gallery-step ×2 ·
 *   (lightbox) dialog.az-gallery-lightbox > p.az-gallery-counter · figure > img.az-gallery-lightbox-img +
 *     figcaption.az-gallery-lightbox-caption · ul.az-gallery-actions? > li > a|button
 * Variants: grid — uniform crops in columns · masonry — uncropped, column-major · carousel — snapping row
 *   with step buttons · orbit — 3D ring of the images (poster first), carousel below sm.
 * Modifiers: lightbox — images become buttons opening the dialog · reveal — data-az-reveal on the block, data-az-reveal-item on images; the overlay runtime hides by script, once.
 * Props: title → h2 · sub → p · columns → grid tracks · ratio → aspect-ratio (ASPECT table) ·
 *   poster → orbit's still image · image src/alt/caption/focus → img, alt, figcaption, object-position ·
 *   from → grid and masonry fill from a table after the page (data-spec §10): src ← image, alt/caption ← text;
 *   div.az-from (core fromShell) in place of the list. orbit, carousel and lightbox with from: AZ1214 at compile.
 * Styling: theme tokens only; responsive tracks via below; focus rings via states; lazy images after row one.
 * Behaviour: packages/overlay runtime (carousel steps, lightbox); 3D ring by packages/scene-runtime.
 * Edit guide: one image → galleryImage(); carousel → carousel(); lightbox → lightboxDialog().
 *   Keep: an image is never a CTA; alt is not the caption; never fetchpriority (the hero owns LCP).
 * Tests: packages/words/test/props.test.ts, packages/words/test/variants.test.ts, packages/words/test/structure.test.ts, packages/words/test/gallery-images.test.ts, packages/words/test/gallery-poster.test.ts, packages/words/test/gallery-lightbox.test.ts
 */

/**
 * `gallery` — web emitter.
 *
 * gallery-block-spec.md is the specification; this implements its structural
 * core. Every design value arrives through `ctx.theme` — `az lint` proves
 * it (assumption A7), and a test walks the emitted tree to prove the OUTPUT
 * stays inside the token set too.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import {
  contentShare, framed, fromFill, fromShell, isFromMark, px, revealed, visuallyHidden, type EmitContext, type EmittedNode,
} from '../../core/src/emit-contract.ts';
import { closeButton, popup } from '../../overlay/src/index.ts';

/** The track's name when the gallery has no title to lend it. */
const GALLERY_LABEL = 'Gallery';

/** An `auto` ratio has no single box; the ring's canvas takes a square one. */
const ORBIT_FALLBACK_RATIO = '1 / 1';

/** A CSS aspect ratio (`3 / 2`) as the number the ring's planes are cut to. */
function ratioNumber(css: string | undefined): number {
  const [w, h] = (css ?? ORBIT_FALLBACK_RATIO).split('/').map((n) => Number(n.trim()));
  return w > 0 && h > 0 ? w / h : 1;
}

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

/** §6: between sm and md, grid and masonry cap at this many columns. */
const MD_MAX_COLUMNS = 3;

/** §6: below sm, grid and masonry are two columns, not one. */
const SM_COLUMNS = 2;

/** §7 rule 2: the first row loads eagerly; `columns` is that row's length. */
const DEFAULT_COLUMNS = 3;

/**
 * §7 rule 3: how wide one image is drawn at each viewport — the `sizes` the
 * target writes beside the srcset it builds. It follows the tracks below:
 * two columns under sm, at most three under md, then `columns`; a masonry
 * column is narrower than two minimum columns and a gap, or one more would
 * fit; a carousel slide is one minimum column, all but the peek under sm.
 * Each value is an upper bound — gaps and gutters only make the box smaller
 * — and a share of the viewport is capped by the same share of the site
 * frame, which the content never exceeds. `orbit` gets none: its ring textures are the originals, and a resized copy
 * for the hidden list would be a second download of every image.
 */
function slotSizes(variant: string, columns: number, ctx: EmitContext): string | undefined {
  const t = ctx.theme;
  const frame = ctx.site.frame;
  const sm = `(width < ${px(t.breakpoint.sm)})`;
  const smShare = (n: number) => `${sm} ${contentShare(n, frame, t.breakpoint.sm)}`;
  const mdColumns = Math.min(columns, MD_MAX_COLUMNS);
  const md = `(width < ${px(t.breakpoint.md)}) ${contentShare(mdColumns, frame, t.breakpoint.md)}`;
  if (variant === 'grid') {
    // Up to three columns, md draws them as wide as the desktop does: no condition of its own.
    return [smShare(SM_COLUMNS), ...(mdColumns === columns ? [] : [md]), contentShare(columns, frame)].join(', ');
  }
  if (variant === 'masonry') return `${smShare(SM_COLUMNS)}, ${md}, ${px(2 * t.size['column-min'] + t.space[16])}`;
  if (variant === 'carousel') return `${smShare(1)}, ${px(t.size['column-min'])}`;
  return undefined;
}

/** The block's `columns`: the grid's track count, and the length of its first row. */
const columnsOf = (block: SpecBlock): number => Number(block.props.columns ?? DEFAULT_COLUMNS);

/** Chevron paths for the previous/next controls (§10: real buttons, real names). */
const CHEVRON = { '-1': 'M15 6l-6 6 6 6', '1': 'M9 6l6 6-6 6' } as const;

/**
 * §8: the enlarged image fits the viewport's height with room for the
 * counter and controls, whatever its shape.
 */
const LIGHTBOX_MAX_HEIGHT = '75vh';

/** A stroke icon, decorative: the control carries its own name. */
const glyph = (d: string): EmittedNode => ({
  tag: 'svg',
  attrs: {
    'aria-hidden': 'true', focusable: 'false', viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round',
  },
  style: { width: '1.5em', height: '1.5em' },
  children: [{ tag: 'path', attrs: { d } }],
});

/** A previous/next control: a 44px button with a chevron and a real name. */
function stepButton(ctx: EmitContext, step: '-1' | '1', name: string, atEnd: boolean): EmittedNode {
  const t = ctx.theme;
  return {
    tag: 'button',
    attrs: { type: 'button', class: 'az-gallery-step', 'data-az-step': step, 'aria-disabled': String(atEnd) },
    style: {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      minWidth: px(t.size.tap), minHeight: px(t.size.tap), padding: 0,
      background: t.color.surface, color: t.color.text,
      border: `1px solid ${t.color.border}`, borderRadius: px(t.radius.full), cursor: 'pointer',
    },
    states: {
      hover: { background: t.color['surface-alt'] },
      focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) },
      // No wrap (§8) and no scrolling past an end: the end control says so.
      disabled: { color: t.color.muted, cursor: 'default', background: t.color.surface },
    },
    children: [glyph(CHEVRON[step]), visuallyHidden(name)],
  };
}

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

  // §9 — `orbit` is a ring of the section's own images, drawn by the page's
  // one renderer (scene-spec §5) into this view. The view reserves the
  // canvas box at the gallery ratio before anything loads; inside it, the
  // poster is what the static tier, reduced motion and the loading state
  // show. The view is aria-hidden and the poster's alt empty: the images
  // below stay in the DOM as the real, labelled content, and naming the
  // ring again would make a screen reader announce the set twice. Lazy and
  // without a priority hint, per §7: fetchpriority belongs to the hero.
  if (variant === 'orbit') {
    children.push({
      tag: 'div',
      attrs: {
        class: 'az-gallery-orbit',
        'data-az-3d': 'orbit',
        'data-az-aspect': String(ratioNumber(aspect)),
        'aria-hidden': 'true',
      },
      style: {
        position: 'relative',
        width: '100%',
        aspectRatio: aspect ?? ORBIT_FALLBACK_RATIO,
        overflow: 'hidden',
        borderRadius: px(t.radius.md),
        margin: `0 0 ${px(t.space[16])}`,
      },
      // §6: below sm the ring is not mounted — the carousel replaces it —
      // so its box goes too, and the renderer skips an empty rectangle.
      below: { sm: { display: 'none' } },
      children: block.props.poster
        ? [{
            tag: 'img',
            attrs: {
              src: ctx.asset(block.props.poster),
              alt: '',
              class: 'az-gallery-poster',
              loading: 'lazy',
              decoding: 'async',
              'data-az-live-part': '',
            },
            style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' },
            states: { live: { visibility: 'hidden' } },
          }]
        : [],
    });
  }

  if (block.from) {
    // data-spec §10: images load from a table after the page (grid and
    // masonry; core refuses the rest with from). The template is one image
    // rendered by galleryImage() itself, so a row is an image of the set.
    const template = galleryImage(fromFill(block.from), 0, false, Object.hasOwn(block.from.map, 'caption'), aspect, variant, columnsOf(block), false, ctx);
    children.push(fromShell(block.from, galleryList(block, variant, false, [template], ctx), skeletonImage(aspect, ctx), ctx));
  }

  const sources = block.children.filter((c) => c.word === 'image');
  const shown = variant === 'orbit' ? sources.slice(0, ORBIT_MAX) : sources;
  // §10: <figure> + <figcaption> when captions exist; a plain list when not.
  const captioned = shown.some((c) => c.props.caption);
  const firstRow = columnsOf(block);
  // §8: `lightbox` turns each image into a button that opens it enlarged.
  // `orbit` opens its own viewer, which the validator warns about (§11).
  const lightbox = block.modifiers.includes('lightbox') && variant !== 'orbit';
  const images = shown.map((c, i) => galleryImage(c, i, i < firstRow, captioned, aspect, variant, firstRow, lightbox, ctx));
  // §6/§10: a carousel — and orbit's phone fallback — steps with real buttons.
  const steps = variant === 'carousel' || variant === 'orbit';
  if (images.length > 0) {
    const track = galleryList(block, variant, steps, images, ctx);
    children.push(steps ? carousel(track, variant, shown.length, ctx) : track);
    if (lightbox) children.push(lightboxDialog(shown, block.props.title ?? GALLERY_LABEL, ctx));
  }

  // Section actions (spec §5/§6): the button primitive — one primary `cta`,
  // one `alt` — after the section's content, never inside an item.
  const actions = ctx.actions(block, ['cta', 'alt']);
  if (actions.length > 0) {
    children.push({
      tag: 'ul',
      attrs: { class: 'az-gallery-actions' },
      style: {
        display: 'flex', flexWrap: 'wrap', gap: px(t.space[16]),
        listStyle: 'none', padding: 0, margin: `${px(t.space[48])} 0 0`,
      },
      children: actions,
    });
  }

  return revealed(block, t, {
    tag: 'section',
    attrs: {
      class: `az-gallery az-gallery--${variant}`,
      ...(lightbox && shown.length > 0 ? { 'data-az-behaviour': 'lightbox' } : {}),
      ...(variant === 'orbit' ? { 'data-az-3d-host': '' } : {}),
    },
    style: {
      paddingBlock: px(t.space[96]),
      paddingInline: framed(t),
      background: t.color.bg,
      color: t.color.text,
    },
    // The section clears while the ring draws: the page's canvas sits under
    // every block (scene-spec §6.1), so an opaque band would hide it.
    states: variant === 'orbit' ? { live: { background: 'transparent' } } : undefined,
    // The mobile gutter below sm (theme-spec §1).
    below: { sm: { paddingInline: px(t.size['gutter-sm']) } },
    children,
  }, block.from ? undefined : 'az-gallery-item');
}

/**
 * The list of images: the static set's, or a `from` block's template and
 * skeleton (fromShell) — one list node, so rows look like the images.
 */
function galleryList(block: SpecBlock, variant: string, steps: boolean, children: EmittedNode[], ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  return {
    tag: 'ul',
    attrs: {
      class: 'az-gallery-items',
      ...(steps ? { 'data-az-track': '' } : {}),
      'data-ratio': block.props.ratio ?? DEFAULT_RATIO,
      // §9: while the ring draws, the list stays in the DOM for search
      // engines and screen readers — visually hidden, never removed.
      ...(variant === 'orbit' ? { 'data-az-live-part': '' } : {}),
      // §10: a scrolling track is named and the keyboard can reach it —
      // focused, the arrow keys scroll it. `orbit` becomes this carousel
      // below sm (§6). §10 says role="group"; on the <ul> that would strip
      // the list its <li>s need, so the track stays a list with a name.
      ...(variant === 'carousel' || variant === 'orbit'
        ? { 'aria-label': block.props.title ?? GALLERY_LABEL, tabindex: '0' }
        : {}),
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
    // §6. Between sm and md, grid and masonry cap at three columns. Below
    // sm: grid and masonry are TWO columns, not one (full-width photos
    // turn a gallery into a long scroll); carousel keeps its row; orbit
    // falls back to the carousel — a 3D ring is unreadable at 390px.
    below: {
      md: variant === 'grid' || variant === 'masonry'
        ? { gridTemplateColumns: `repeat(${Math.min(Number(block.props.columns ?? DEFAULT_COLUMNS), MD_MAX_COLUMNS)}, minmax(0, 1fr))` }
        : undefined,
      sm: variant === 'grid' || variant === 'masonry'
        ? { gridTemplateColumns: `repeat(${SM_COLUMNS}, minmax(0, 1fr))` }
        : variant === 'orbit'
          ? { display: 'flex', overflowX: 'auto', scrollSnapType: 'x mandatory' }
          : undefined,
    },
    states: variant === 'orbit'
      ? { live: { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } }
      : undefined,
    children,
  };
}

/** A loading image (data-spec §10.3): the image's own box at the gallery's ratio, so rows replace it in place. */
function skeletonImage(aspect: string | undefined, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  return {
    tag: 'li',
    attrs: { class: 'az-gallery-item az-from-skeleton-item' },
    style: { listStyle: 'none' },
    children: [{
      tag: 'span',
      attrs: { class: 'az-from-line' },
      style: { display: 'block', width: '100%', aspectRatio: aspect ?? ORBIT_FALLBACK_RATIO, background: t.color.surface, borderRadius: px(t.radius.md) },
    }],
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
  image: SpecBlock, index: number, eager: boolean, captioned: boolean, aspect: string | undefined,
  variant: string, columns: number, lightbox: boolean, ctx: EmitContext,
): EmittedNode {
  const t = ctx.theme;
  // From a table, the row's image URL fills it after the page (data-spec §10).
  const fromRow = isFromMark(image.args[0]?.value ?? '');
  const sizes = slotSizes(variant, columns, ctx);
  const img: EmittedNode = {
    tag: 'img',
    attrs: {
      src: fromRow ? image.args[0].value : ctx.asset(image.args[0]?.value ?? ''),
      alt: image.props.alt ?? '',
      class: 'az-gallery-img',
      // The textures of `orbit`'s ring are the list's own images (§9).
      ...(variant === 'orbit' ? { 'data-az-ring': '' } : {}),
      // §7 rule 2: eager first row, lazy after, and never fetchpriority.
      loading: eager ? 'eager' : 'lazy',
      decoding: 'async',
      // §7 rule 3: the layout's widths, for the srcset the build writes — or,
      // for a row, the one the rows runtime writes from the server's width
      // copies (data-spec §8). A `ratio` crop is `cover` in a box of exactly
      // that ratio, which the target widens `sizes` by when the file is wider
      // than the box; a row's file is unknown at build, so its `sizes` stays the box's.
      ...(sizes !== undefined ? { sizes, ...(aspect && !fromRow ? { 'data-az-cover': aspect } : {}) } : {}),
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

  // §5/§8: with `lightbox` the image is a real <button> wrapping the <img>,
  // named by the caption, or the alt when there is none — never an <img>
  // with a click handler, which no keyboard or screen reader can use.
  const shownImage: EmittedNode = lightbox
    ? {
        tag: 'button',
        attrs: {
          type: 'button', class: 'az-gallery-open', 'aria-haspopup': 'dialog',
          'data-az-index': String(index),
          'aria-label': image.props.caption || image.props.alt || `Image ${index + 1}`,
          ...(image.props.caption ? { 'data-az-caption': image.props.caption } : {}),
        },
        style: {
          display: 'block', width: '100%', padding: 0, border: 0, background: 'transparent',
          borderRadius: px(t.radius.md), cursor: 'zoom-in',
        },
        // §10: the ring sits OUTSIDE the image box — inside it vanishes on a
        // busy photograph.
        states: { focusVisible: { outline: `${px(t.size.ring)} solid ${t.color.focus}`, outlineOffset: px(t.size['ring-offset']) } },
        children: [img],
      }
    : img;

  const content: EmittedNode = captioned
    ? {
        tag: 'figure',
        attrs: { class: 'az-gallery-figure' },
        style: { margin: 0 },
        children: [
          shownImage,
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
    : shownImage;

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
    // §6 below sm: a slide leaves a `space.24` peek of the next one, which is
    // what says "swipe"; orbit's fallback carousel slides the same way.
    below: variant === 'carousel' || variant === 'orbit'
      ? { sm: { flex: `0 0 calc(100% - ${px(t.space[24])})`, scrollSnapAlign: 'start' } }
      : undefined,
    children: [content],
  };
}

/**
 * A carousel: the track, then its previous/next controls (§10: <button>s
 * with real names). Below sm the controls are "hidden visually but stay in
 * the DOM and focusable" (§6) — clipped until one is reached by keyboard,
 * when the row shows: an invisible focused control fails WCAG 2.4.7. On
 * `orbit` the controls belong to its phone fallback only.
 */
function carousel(track: EmittedNode, variant: string, count: number, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const shown = { position: 'static', width: 'auto', height: 'auto', margin: `${px(t.space[16])} 0 0`, overflow: 'visible', clip: 'auto', whiteSpace: 'normal' };
  const clipped = { position: 'absolute', width: '1px', height: '1px', margin: '-1px', overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' };
  return {
    tag: 'div',
    attrs: { class: 'az-gallery-carousel', 'data-az-behaviour': 'carousel' },
    children: [
      track,
      {
        tag: 'div',
        attrs: { class: 'az-gallery-controls' },
        style: { display: variant === 'orbit' ? 'none' : 'flex', justifyContent: 'flex-end', gap: px(t.space[8]), ...shown },
        below: { sm: { display: 'flex', ...clipped } },
        states: { focusWithin: shown },
        children: [
          stepButton(ctx, '-1', 'Previous image', true),
          stepButton(ctx, '1', 'Next image', count <= 1),
        ],
      },
    ],
  };
}

/**
 * The lightbox (§8): the `popup` preset from the overlay package, not a new
 * overlay — modal, focus trapped, scroll locked, Escape and click-outside
 * close. It holds the enlarged image, its caption, a counter announced
 * politely ("3 of 18"), and previous/next controls that do not wrap. The
 * runtime fills it from the thumbnail chosen; the image loads only then.
 */
function lightboxDialog(images: SpecBlock[], title: string, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const preset = popup(t, `${title}, enlarged`);
  const x = closeButton(t, 'Close');
  const first = images[0];
  return {
    tag: 'dialog',
    attrs: { ...preset.attrs, class: 'az-overlay az-overlay--popup az-gallery-lightbox' },
    style: preset.style,
    states: { open: preset.states.open },
    children: [
      {
        tag: 'div',
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: px(t.space[16]) },
        children: [
          {
            tag: 'p',
            attrs: { class: 'az-gallery-counter', 'data-az-lightbox-counter': '', 'aria-live': 'polite' },
            style: { margin: 0, fontSize: t.typeSize.sm, color: t.color.muted },
            children: [`1 of ${images.length}`],
          },
          { tag: 'button', attrs: x.attrs, style: x.style, states: x.states, children: [glyph(x.icon.d)] },
        ],
      },
      {
        tag: 'figure',
        style: { margin: `${px(t.space[8])} 0` },
        children: [
          {
            tag: 'img',
            attrs: {
              src: ctx.asset(first.args[0]?.value ?? ''), alt: first.props.alt ?? '', class: 'az-gallery-lightbox-img',
              'data-az-lightbox-image': '',
              // Closed, the dialog is not rendered, so a lazy image waits —
              // opening the lightbox must not have cost a download (§7).
              loading: 'lazy', decoding: 'async',
              // §7 rule 3: drawn at the dialog's width; the runtime carries
              // each shown image's srcset and size over from its thumbnail.
              sizes: String(preset.style.width),
            },
            style: { display: 'block', width: '100%', height: 'auto', maxHeight: LIGHTBOX_MAX_HEIGHT, objectFit: 'contain' },
          },
          {
            tag: 'figcaption',
            attrs: { class: 'az-gallery-lightbox-caption', 'data-az-lightbox-caption': '' },
            style: { marginTop: px(t.space[8]), fontSize: t.typeSize.sm, color: t.color.muted },
            children: [first.props.caption ?? ''],
          },
        ],
      },
      {
        tag: 'div',
        style: { display: 'flex', justifyContent: 'flex-end', gap: px(t.space[8]) },
        children: [
          stepButton(ctx, '-1', 'Previous image', true),
          stepButton(ctx, '1', 'Next image', images.length <= 1),
        ],
      },
    ],
  };
}
