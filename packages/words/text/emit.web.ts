/**
 * @az word text
 * Purpose: a section of written copy — title, body and actions.
 * Spec: docs/text-block-spec.md · terms: az explain text
 * Renders: section.az-text.az-text--{variant} > h2.az-text-title? · div.az-text-body? (the string, or the .md file's nodes) ·
 *   ul.az-text-actions? > li > a|button
 * Variants: prose — body at the reading measure · centered — centred statement ·
 *   columns — two text columns, one below md.
 * Modifiers: reveal — data-az-reveal on the block (revealed as one unit); the overlay runtime hides by script, once.
 * Props: title → h2.az-text-title · body → div.az-text-body: inline text, or a .md file parsed at build
 *   by target-web/src/markdown.ts (headings h2–h4, html stripped, links vetted) — never innerHTML.
 * Styling: theme tokens only; below.sm mobile gutter; below.md single column; states.overBackdrop veil.
 * Behaviour: none; buttons by target-web/src/actions.ts.
 * Edit guide: the body block → the div's style; column count → COLUMN_COUNT.
 *   Keep: text never emits an <h1>; the measure stays the theme's.
 * Tests: packages/target-web/test/markdown.test.ts, packages/words/test/props.test.ts, packages/words/test/variants.test.ts, packages/words/test/structure.test.ts, packages/words/test/responsive.test.ts, packages/target-web/test/backdrop-veil.test.ts
 */

/**
 * `text` — web emitter.
 *
 * text-block-spec.md. The simplest block in the set, which makes it the honest
 * test of whether the emitter contract is actually small: if the shortest word
 * still needs ceremony, the contract is wrong.
 */

import type { SpecBlock } from '../../core/src/spec.ts';
import { framed, px, revealed, type EmitContext, type EmittedNode } from '../../core/src/emit-contract.ts';

/** Columns are a count, so a number is honest here — PRD §6.1a. */
const COLUMN_COUNT = 2;

/** §1: `body` is a file when its value is one path ending `.md`; anything else is inline text. */
const MARKDOWN_FILE = /^[^\s]+\.md$/i;

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
      // §7: `columns` collapses at breakpoint.md, NOT sm — two 38ch columns
      // plus the gap need ~900px; below that it is already prose.
      below: variant === 'columns' ? { md: { columnCount: 1 } } : undefined,
      // §5/§8: a file is parsed at build into nodes, its headings below the
      // title's h2. Without a reader (a bare emit) the path shows as text.
      children: MARKDOWN_FILE.test(block.props.body) && ctx.markdown
        ? ctx.markdown(block.props.body, { titled: Boolean(block.props.title) })
        : [block.props.body],
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

  return revealed(block, t, {
    tag: 'section',
    attrs: { class: `az-text az-text--${variant}` },
    style: {
      paddingBlock: px(t.space[96]),
      paddingInline: framed(t),
      textAlign: variant === 'centered' ? 'center' : 'start',
      marginInline: variant === 'centered' ? 'auto' : undefined,
    },
    // §7: the gutter sets the width on a phone, and it is the page's.
    below: { sm: { paddingInline: px(t.size['gutter-sm']) } },
    // scene-spec §6.5: text has no surface of its own, so over a page's
    // backdrop it takes the veil — contrast then holds on any frame.
    states: { overBackdrop: { background: t.color.veil } },
    children,
  });
}
