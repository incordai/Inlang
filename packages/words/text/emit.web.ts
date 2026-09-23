/**
 * `text` — web emitter.
 *
 * text-block-spec.md. The simplest block in the set, which makes it the honest
 * test of whether the emitter contract is actually small: if the shortest word
 * still needs ceremony, the contract is wrong.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { px, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/** Columns are a count, so a number is honest here — PRD §6.1a. */
const COLUMN_COUNT = 2;

export function emit(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const variant = block.variant ?? 'prose';
  const children: EmittedNode[] = [];

  if (block.props.title) {
    children.push({
      tag: 'h2',
      attrs: { class: 'az-text-title' },
      style: {
        // Not an <h1>: the hero owns the page's only one (hero-spec §4), and
        // the outline stays valid because this block emits exactly one level.
        fontSize: t.typeSize['2xl'],
        lineHeight: t.type['leading-tight'],
        fontFamily: t.type.display,
        fontWeight: t.type['weight-display'],
        color: t.color.text,
        maxWidth: `${t.size['measure-display']}ch`,
        margin: `0 0 ${px(t.space[24])}`,
      },
      children: [block.props.title],
    });
  }

  if (block.props.body) {
    children.push({
      tag: 'div',
      attrs: { class: 'az-text-body' },
      style: {
        fontSize: t.typeSize.base,
        lineHeight: t.type['leading-body'],
        color: t.color.text,
        maxWidth: variant === 'columns' ? 'none' : `${t.size['measure-body']}ch`,
        columnCount: variant === 'columns' ? COLUMN_COUNT : 1,
        columnGap: px(t.space[48]),
      },
      children: [block.props.body],
    });
  }

  // Section actions (spec §5/§6): the button primitive — one primary `cta`,
  // one `alt` — after the section's content, never inside an item.
  const actions = ctx.actions(block, ['cta', 'alt']);
  if (actions.length > 0) {
    children.push({
      tag: 'ul',
      attrs: { class: 'az-text-actions' },
      style: {
        display: 'flex', flexWrap: 'wrap', gap: px(t.space[16]),
        listStyle: 'none', padding: 0, margin: `${px(t.space[48])} 0 0`,
        justifyContent: variant === 'centered' ? 'center' : undefined,
      },
      children: actions,
    });
  }

  return {
    tag: 'section',
    attrs: { class: `az-text az-text--${variant}` },
    style: {
      paddingBlock: px(t.space[96]),
      paddingInline: px(t.size['gutter-lg']),
      textAlign: variant === 'centered' ? 'center' : 'start',
      marginInline: variant === 'centered' ? 'auto' : undefined,
    },
    children,
  };
}
