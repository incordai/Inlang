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

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'grid';
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

  const images = ctx.slot('image');
  if (images.length > 0) {
    children.push({
      tag: 'ul',
      attrs: {
        class: 'az-gallery-items',
        'data-ratio': block.props.ratio ?? '4 / 3',
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
      children: variant === 'orbit' ? images.slice(0, ORBIT_MAX) : images,
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
