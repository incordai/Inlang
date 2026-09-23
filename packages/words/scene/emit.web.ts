/**
 * @az word scene
 * Purpose: a standalone 3D scene with a poster fallback, inline, full-bleed or as a page backdrop.
 * Spec: docs/scene-block-spec.md · docs/motion-tiers-spec.md · terms: az explain scene
 * Renders: section.az-scene.az-scene--{variant}[data-az-3d-host] > figure.az-scene-viewport >
 *   div.az-scene-view[data-az-3d][data-az-variant][data-az-camera][data-az-model?] > img.az-scene-poster ·
 *   figcaption? · (none) div.az-scene.az-scene--none[hidden]
 * Variants: inline — capped at the text measure · full — full-bleed section · backdrop — fixed layer behind the
 *   page · none — opts a page out of the site's backdrop.
 * Modifiers: 3d — required; marks the view for the renderer · scroll / parallax — set data-az-camera.
 * Props: model → data-az-model via ctx.asset · poster → img.az-scene-poster · alt → the poster's alt ·
 *   ratio → aspect-ratio · caption → figcaption · camera → data-az-camera (fixed, orbit, scroll).
 * Styling: theme tokens only; backdrop fixed at layer.behind; below.sm inline goes full width and full 1:1 → 4:3;
 *   states.live hides the poster once the canvas draws.
 * Behaviour: packages/scene-runtime draws every view into the page's one renderer.
 * Edit guide: the view's data attributes are the runtime contract — change them with scene-runtime.
 *   Keep: poster always present (static tier, loading, eviction); alt names the scene.
 * Tests: packages/words/test/props.test.ts, packages/words/test/variants.test.ts, packages/words/test/structure.test.ts, packages/words/test/scene-poster.test.ts, packages/target-web/test/three.test.ts
 */

/**
 * `scene` — web emitter.
 *
 * scene-block-spec.md is the specification; this implements its structural
 * core. Every design value arrives through `ctx.theme` — `az lint` proves
 * it (assumption A7), and a test walks the emitted tree to prove the OUTPUT
 * stays inside the token set too.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { framed, px, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/** The manifest default (scene-spec §12), for a block built without one. */
const DEFAULT_RATIO = '4:3';

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'inline';
  const children: EmittedNode[] = [];

  // NO title/sub here. scene's manifest declares neither — it is a viewport,
  // not a section with a heading. The surrounding `text` or `feature` block
  // owns the words; a scene that grew its own heading would put two competing
  // headings in one band.
  // scene-spec §5: ONE renderer per page, shared by every scene on it. This
  // emitter declares a viewport and a poster; it never creates a context.
  // §6: `none` opts a page out of an inherited backdrop — the same reserved
  // word as nav (GRAMMAR §5.2). Core's blocksFor resolves it, so a target
  // normally never gets here; this makes a direct call safe too.
  if (variant === 'none') {
    return { tag: 'div', attrs: { class: 'az-scene az-scene--none', hidden: 'hidden' }, children: [] };
  }

  // Through the asset sandbox, so the file is copied into the build — a raw
  // path in an attribute left the poster behind.
  const poster = block.props.poster ? ctx.asset(block.props.poster) : null;
  // `4:3` is how an author writes a ratio; CSS needs `4 / 3`, and drops the
  // declaration silently otherwise. The enum admits only `a:b` forms.
  const aspect = (block.props.ratio ?? DEFAULT_RATIO).replace(':', ' / ');

  // §5: the scene never creates a renderer. With `3d` it emits the view the
  // page's one renderer draws into — its box, its camera, its model — and
  // the runtime does the rest. Without `3d` it is the poster alone.
  const threeD = block.modifiers.includes('3d');
  const camera = block.props.camera && block.props.camera !== 'fixed'
    ? block.props.camera
    : block.modifiers.includes('scroll') ? 'scroll'
      : block.modifiers.includes('parallax') ? 'parallax' : 'fixed';
  const orbit = threeD && camera === 'orbit';

  // §2/§6, three different relationships to the page:
  //   inline    sits next to the copy describing it, capped at the content
  //             measure or it fights the text column
  //   full      the object IS the section: full-bleed, square corners,
  //             its own breathing room
  //   backdrop  behind the whole document, not in the flow at all — the
  //             content scrolls over it (§6.1: the bottom of the stack)
  const view: EmittedNode = {
    tag: 'div',
    attrs: {
      class: 'az-scene-view',
      ...(threeD ? {
        'data-az-3d': 'scene',
        'data-az-variant': variant,
        'data-az-camera': camera,
        ...(block.props.model ? { 'data-az-model': ctx.asset(block.props.model) } : {}),
      } : {}),
      // §9: the scene is named by its required `alt`. The shared canvas is
      // not content, so the name sits on the view the canvas draws into.
      role: 'img',
      'aria-label': block.props.alt ?? '',
      // `camera orbit` turns with the arrow keys (§9), so it takes focus.
      ...(orbit ? { tabindex: '0' } : {}),
    },
    style: {
      position: variant === 'backdrop' ? 'fixed' : 'relative',
      inset: variant === 'backdrop' ? '0' : undefined,
      zIndex: variant === 'backdrop' ? t.layer.behind : undefined,
      // A backdrop must never intercept clicks meant for the content above it.
      pointerEvents: variant === 'backdrop' ? 'none' : undefined,
      height: variant === 'backdrop' ? '100svh' : undefined,
      // Reserve the box before anything loads, or arrival shifts the page.
      aspectRatio: variant === 'backdrop' ? undefined : aspect,
      background: t.color['surface-alt'],
      borderRadius: variant === 'inline' ? px(t.radius.md) : undefined,
      overflow: 'hidden',
      // Horizontal drag turns an orbit; vertical drag still scrolls the page.
      touchAction: orbit ? 'pan-y' : undefined,
    },
    states: {
      ...(threeD ? { live: { background: 'transparent' } } : {}),
      ...(orbit ? {
        focusVisible: {
          outline: `${px(t.size.ring)} solid ${t.color.focus}`,
          outlineOffset: px(t.size['ring-offset']),
        },
      } : {}),
    },
    // §10 below sm: `full` stays full-bleed with its ratio clamped to at most
    // 4:3, so 1:1 becomes 4:3.
    below: variant === 'full' && block.props.ratio === '1:1'
      ? { sm: { aspectRatio: '4 / 3' } }
      : undefined,
    // §8: `static` is posters only. §9: the poster carries the same `alt`;
    // role="img" makes its children presentational, so it is named once.
    children: poster
      ? [{
          tag: 'img',
          attrs: {
            src: poster, alt: block.props.alt ?? '', class: 'az-scene-poster', decoding: 'async',
            ...(threeD ? { 'data-az-live-part': '' } : {}),
          },
          style: { display: 'block', width: '100%', height: '100%', objectFit: 'cover' },
          states: threeD ? { live: { visibility: 'hidden' } } : undefined,
        }]
      : [],
  };

  children.push({
    tag: 'figure',
    attrs: { class: 'az-scene-viewport', 'data-variant': variant },
    style: {
      margin: 0,
      maxWidth: variant === 'inline' ? `${t.size['measure-body']}ch` : undefined,
    },
    // §10 below sm: `inline` takes the full content width. Its ratio clamp
    // ("at most 1:1") changes nothing, because every allowed ratio is
    // already at most square.
    below: variant === 'inline' ? { sm: { maxWidth: 'none' } } : undefined,
    children: [
      view,
      ...(block.props.caption
        ? [{
            tag: 'figcaption',
            style: {
              fontSize: t.typeSize.xs,
              color: t.color.muted,
              marginTop: px(t.space[12]),
            },
            children: [block.props.caption],
          }]
        : []),
    ],
  });

  return {
    tag: 'section',
    attrs: {
      class: `az-scene az-scene--${variant}`,
      ...(threeD ? { 'data-az-3d-host': '' } : {}),
    },
    style: {
      // A backdrop is a layer, not a band: it takes no room in the flow.
      paddingBlock: variant === 'backdrop' ? 0 : px(t.space[64]),
      paddingInline: framed(t),
      background: t.color.bg,
      color: t.color.text,
    },
    // The section clears while the canvas draws in its box: the canvas sits
    // under every block (§6.1), so an opaque band would hide it.
    states: threeD ? { live: { background: 'transparent' } } : undefined,
    // The mobile gutter below sm (theme-spec §1).
    below: { sm: { paddingInline: px(t.size['gutter-sm']) } },
    children,
  };
}
