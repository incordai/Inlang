/**
 * `scene` — web emitter.
 *
 * scene-block-spec.md is the specification; this implements its structural
 * core. Every design value arrives through `ctx.theme` — `az lint` proves
 * it (assumption A7), and a test walks the emitted tree to prove the OUTPUT
 * stays inside the token set too.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { px, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

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

  children.push({
    tag: 'figure',
    attrs: {
      class: 'az-scene-viewport',
      'data-variant': variant,
      'data-poster': block.props.poster ?? '',
      role: 'img',
      'aria-label': block.props.alt ?? '',
    },
    style: {
      margin: 0,
      // Reserve the box before anything loads, or arrival shifts the page.
      aspectRatio: block.props.ratio ?? '16 / 9',
      background: t.color['surface-alt'],

      // §2/§6, three different relationships to the page:
      //   inline    sits next to the copy describing it, capped at the content
      //             measure or it fights the text column
      //   full      the object IS the section: full-bleed, square corners,
      //             its own breathing room
      //   backdrop  behind the whole document, not in the flow at all — the
      //             content scrolls over it
      maxWidth: variant === 'inline' ? `${t.size['measure-body']}ch` : undefined,
      borderRadius: variant === 'inline' ? px(t.radius.md) : undefined,
      position: variant === 'backdrop' ? 'fixed' : undefined,
      inset: variant === 'backdrop' ? '0' : undefined,
      zIndex: variant === 'backdrop' ? t.layer.backdrop : undefined,
      // A backdrop must never intercept clicks meant for the content above it.
      pointerEvents: variant === 'backdrop' ? 'none' : undefined,
      height: variant === 'backdrop' ? '100svh' : undefined,
    },
    children: block.props.caption
      ? [{
          tag: 'figcaption',
          style: {
            fontSize: t.typeSize.xs,
            color: t.color.muted,
            marginTop: px(t.space[12]),
          },
          children: [block.props.caption],
        }]
      : [],
  });

  return {
    tag: 'section',
    attrs: { class: `az-scene az-scene--${variant}` },
    style: {
      paddingBlock: px(t.space[64]),
      paddingInline: px(t.size['gutter-lg']),
      background: t.color.bg,
      color: t.color.text,
    },
    children,
  };
}
