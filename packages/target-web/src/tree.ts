/**
 * Spec to emitted tree.
 *
 * This is where a word's `emit.web.ts` finally runs. Everything above it is
 * target-agnostic; everything below it is markup.
 *
 * The emitters are passed IN rather than imported: `deps.test.ts` forbids a
 * target from importing a word (ARCHITECTURE §2), and injecting them is also
 * what lets a test run one word in isolation.
 */

import { blocksFor, type Spec, type SpecBlock } from '../../core/src/index.ts';
import type { EmitContext, EmittedNode, ThemeLike, WordEmitter }
  from '../../core/src/emit-contract.ts';
import { px } from '../../core/src/emit-contract.ts';

export type EmitterMap = Readonly<Record<string, WordEmitter>>;

/** Resolves an author's asset path to the URL the page uses. Sandboxed. */
export type AssetResolver = (path: string) => string;

/**
 * A slot child rendered without a word emitter of its own.
 *
 * `item`, `plan`, `link`, `image` and the rest are defined INSIDE their
 * parent's manifest, so there is no `words/item/` to hold their markup. They
 * still have a consistent shape across every spec: a positional label first,
 * an optional destination second, and named values beneath —
 * `cta "Reserve" /reserve`, `image ./photo.webp`, `plan "Studio"`.
 *
 * That shared shape is rendered here, once, rather than in nine emitters.
 */
export function defaultChild(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  const label = block.args[0]?.value ?? '';
  const href = block.args[1]?.value ?? null;

  const kids: (EmittedNode | string)[] = [];

  // A destination makes it a link; without one it is a heading for its body.
  if (label) {
    kids.push(href
      ? { tag: 'a', attrs: { class: 'az-child-label', href }, children: [label] }
      : {
          tag: 'h3',
          attrs: { class: 'az-child-label' },
          style: {
            fontSize: t.typeSize.lg,
            fontFamily: t.type.display,
            lineHeight: t.type['leading-tight'],
            margin: `0 0 ${px(t.space[8])}`,
          },
          children: [label],
        });
  }

  // Named values beneath, in the Spec's stable key order.
  for (const [key, value] of Object.entries(block.props)) {
    if (!value) continue;
    kids.push({
      tag: 'p',
      attrs: { class: `az-child-${key}` },
      style: {
        fontSize: t.typeSize.base,
        lineHeight: t.type['leading-body'],
        color: t.color.muted,
        maxWidth: `${t.size['measure-body']}ch`,
        margin: `0 0 ${px(t.space[8])}`,
      },
      children: [value],
    });
  }

  for (const c of block.children) kids.push(defaultChild(c, ctx));

  return {
    tag: 'li',
    attrs: { class: `az-child az-child--${block.word}` },
    style: { listStyle: 'none' },
    children: kids,
  };
}

/**
 * A block whose word has no emitter yet.
 *
 * Renders the content rather than dropping it. `nav` and `footer` are in this
 * state, and a page that silently lost its footer would look finished.
 * `data-az-unimplemented` marks it so a test — and a person — can tell the
 * difference between "rendered by its word" and "rendered by the fallback".
 */
function fallback(block: SpecBlock, ctx: EmitContext): EmittedNode {
  const t = ctx.theme;
  return {
    tag: 'section',
    attrs: {
      class: `az-${block.word}`,
      'data-az-unimplemented': block.word,
      ...Object.fromEntries(
        Object.entries(block.props)
          .filter(([, v]) => v)
          .map(([k, v]) => [`data-${k.toLowerCase()}`, v])),
    },
    style: {
      paddingBlock: px(t.space[32]),
      paddingInline: px(t.size['gutter-lg']),
      color: t.color.text,
    },
    // Props become ATTRIBUTES, never paragraphs. The fallback cannot tell
    // prose from behaviour — footer's `tagline` reads as text, nav's
    // `mobile drawer` does not — and rendering every prop as a <p> put the
    // literal word "drawer" on the page. Nothing is lost: the values are all
    // still here, and the word's own emitter will place them properly.
    children: block.children.map((c) => defaultChild(c, ctx)),
  };
}

/** Build the context one block sees. */
function contextFor(block: SpecBlock, theme: ThemeLike, asset: AssetResolver): EmitContext {
  return {
    theme,
    target: 'web',
    // A slot is filled by children whose word IS the slot's name — the same
    // rule the linker uses, so what validated is what renders.
    slot: (name) => block.children
      .filter((c) => c.word === name)
      .map((c) => defaultChild(c, contextFor(c, theme, asset))),
    asset,
  };
}

/** One block, through its word's emitter or the fallback. */
export function emitBlock(
  block: SpecBlock, theme: ThemeLike, emitters: EmitterMap, asset: AssetResolver,
): EmittedNode {
  const ctx = contextFor(block, theme, asset);
  const word = emitters[block.word];
  return word ? word.emit(block, ctx) : fallback(block, ctx);
}

/** Every page, with the site's inherited blocks in front of each page's own. */
export function emitPages(
  spec: Spec, theme: ThemeLike, emitters: EmitterMap, asset: AssetResolver,
): { route: string; nodes: EmittedNode[] }[] {
  return spec.pages.map((page) => ({
    route: page.route,
    // blocksFor resolves inheritance: overrides, `none` suppression, and the
    // nav-first/footer-last placement. Concatenating the two lists here put
    // the footer above the page content and rendered a suppressed nav twice.
    nodes: blocksFor(spec, page).map((b) => emitBlock(b, theme, emitters, asset)),
  }));
}
