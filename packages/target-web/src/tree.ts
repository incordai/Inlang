/**
 * @az module tree
 * Purpose: Spec blocks → emitted trees: runs each word's emitter, builds its EmitContext.
 * Spec: docs/ARCHITECTURE.md §4.3
 * Exports: emitPages, emitBlock, defaultChild, fillLevel
 * Edit guide: the EmitContext every word sees is built here (contextFor); emitters are injected, never imported.
 * Tests: packages/target-web/test/render.test.ts, packages/target-web/test/landmarks.test.ts
 */

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

import { actionsFor } from './actions.ts';
import { blocksFor, type Spec, type SpecBlock } from '../../core/src/index.ts';
import type { EmitContext, EmittedNode, ThemeLike, WordEmitter }
  from '../../core/src/emit-contract.ts';
import { componentNode, framePx, px } from '../../core/src/emit-contract.ts';

export type EmitterMap = Readonly<Record<string, WordEmitter>>;

/** Resolves an author's asset path to the URL the page uses. Sandboxed. */
export type AssetResolver = (path: string) => string;

/** Reads and sanitises an SVG the author named; absent without file access. */
export type InlineSvg = (path: string) => EmittedNode;
export type MarkdownRender = NonNullable<EmitContext['markdown']>;

export type SiteInfo = EmitContext['site'];

/**
 * Resolves a `raw` / `slot` component path to the module id the page imports
 * (PRD §6.6). Sandboxed like assets; the caller records what it resolved.
 */
export type ComponentResolver = (path: string) => string;

/** For callers that place no custom code: naming one is a loud error, never a silent drop. */
const noComponents: ComponentResolver = (path) => {
  throw new Error(`component '${path}': this caller cannot place custom components`);
};

/** A `raw` or `slot` statement's component, as a node. Its path is the last argument. */
const custom = (c: SpecBlock, component: ComponentResolver): EmittedNode =>
  componentNode(component(c.args[c.args.length - 1]?.value ?? ''));

/** The escape-hatch statements are placed by the target, never rendered as content. */
const isEscapeHatch = (c: SpecBlock) => c.word === 'raw' || c.word === 'slot';

/** `slot before|after <path>`: components beside the block, in source order. */
function injected(block: SpecBlock, point: string, component: ComponentResolver): EmittedNode[] {
  return block.children
    .filter((c) => c.word === 'slot' && c.args[0]?.value === point)
    .map((c) => custom(c, component));
}

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
/**
 * The heading level a fill's label takes: one below the section's own title,
 * so the outline never skips a level (feature-spec §10). A section with a
 * `title` has an <h2>, so its fills are <h3>; without one they are <h2>.
 */
export const fillLevel = (section: SpecBlock): number => (section.props.title ? 3 : 2);

export function defaultChild(block: SpecBlock, ctx: EmitContext, level = 3): EmittedNode {
  const t = ctx.theme;
  const label = block.args[0]?.value ?? '';
  const dest = block.args[1];
  // A file destination ships through the asset sandbox, root-relative.
  const href = dest ? (dest.kind === 'path' ? ctx.asset(dest.value) : dest.value) : null;

  const kids: (EmittedNode | string)[] = [];

  // A destination makes it a link; without one it is a heading for its body.
  if (label) {
    kids.push(href
      ? { tag: 'a', attrs: { class: 'az-child-label', href }, children: [label] }
      : {
          tag: `h${Math.min(level, 6)}`,
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

  // A fill's own children (an item's `link`) sit inside the item. They are
  // not list items: an <li> directly inside an <li> is invalid HTML.
  for (const c of block.children) {
    kids.push({ tag: 'div', attrs: { class: `az-child-nested az-child--${c.word}` },
      children: defaultChild(c, ctx, level + 1).children });
  }

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
    // The fallback section has no heading of its own, so its fills are <h2>.
    children: block.children.filter((c) => !isEscapeHatch(c)).map((c) => defaultChild(c, ctx, 2)),
  };
}

/** Build the context one block sees. */
function contextFor(
  block: SpecBlock, theme: ThemeLike, asset: AssetResolver, site: SiteInfo, component: ComponentResolver,
  inline?: InlineSvg, markdown?: MarkdownRender, embed?: (b: SpecBlock) => EmittedNode,
): EmitContext {
  return {
    theme,
    target: 'web',
    site,
    // A slot is filled by children whose word IS the slot's name — the same
    // rule the linker uses, so what validated is what renders — and by any
    // `slot <name> <path>` component naming it, in source order, as a list
    // item like the fills around it.
    slot: (name) => block.children.flatMap((c): EmittedNode[] => {
      if (c.word === name) return [defaultChild(c, contextFor(c, theme, asset, site, component, inline, markdown, embed), fillLevel(block))];
      if (c.word === 'slot' && c.args[0]?.value === name) {
        return [{
          tag: 'li',
          attrs: { class: 'az-child az-child--custom' },
          style: { listStyle: 'none' },
          children: [custom(c, component)],
        }];
      }
      return [];
    }),
    asset,
    ...(inline ? { inlineSvg: inline } : {}),
    ...(markdown ? { markdown } : {}),
    ...(embed ? { embed } : {}),
    ...actionsFor(theme, { asset, component: (c) => custom(c, component) }),
  };
}

/** One block, through its word's emitter or the fallback. */
export function emitBlock(
  block: SpecBlock, theme: ThemeLike, emitters: EmitterMap, asset: AssetResolver, site: SiteInfo,
  component: ComponentResolver = noComponents, inline?: InlineSvg, markdown?: MarkdownRender,
): EmittedNode {
  // A page-level `raw` is a component in the page's flow.
  if (block.word === 'raw') return custom(block, component);
  // Another block by its own word's emitter (chat-block-spec §5.4): the same emitters, theme and site.
  const embed = (b: SpecBlock) => emitBlock(b, theme, emitters, asset, site, component, inline, markdown);
  const ctx = contextFor(block, theme, asset, site, component, inline, markdown, embed);
  const word = emitters[block.word];
  const node = word ? word.emit(block, ctx) : fallback(block, ctx);
  // `raw` inside a block renders inside it, after the word's own content.
  const inner = block.children.filter((c) => c.word === 'raw').map((c) => custom(c, component));
  return inner.length > 0 ? { ...node, children: [...(node.children ?? []), ...inner] } : node;
}

/** Every page, with the site's inherited blocks in front of each page's own. */
export function emitPages(
  spec: Spec, theme: ThemeLike, emitters: EmitterMap, asset: AssetResolver, component: ComponentResolver,
  inline?: InlineSvg, markdown?: MarkdownRender,
): { route: string; nodes: EmittedNode[] }[] {
  // The frame is the site's, so every word sizing an image caps it alike.
  const frame = framePx(spec.site.width, theme);
  const site: SiteInfo = { name: spec.site.name, ...(frame === undefined ? {} : { frame }) };
  return spec.pages.map((page) => ({
    route: page.route,
    // blocksFor resolves inheritance: overrides, `none` suppression, and the
    // nav-first/footer-last placement. Concatenating the two lists here put
    // the footer above the page content and rendered a suppressed nav twice.
    nodes: blocksFor(spec, page).flatMap((b) => [
      ...injected(b, 'before', component),
      emitBlock(b, theme, emitters, asset, site, component, inline, markdown),
      ...injected(b, 'after', component),
    ]),
  }));
}
