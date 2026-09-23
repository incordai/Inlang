/**
 * @az module emit-contract
 * Purpose: the word-emitter contract: EmittedNode, EmitContext, style variants, helpers.
 * Spec: docs/ARCHITECTURE.md §4.3
 * Exports: EmittedNode, EmitContext, ThemeLike, px, visuallyHidden, componentNode
 * Edit guide: a contract change touches every emitter and target-web; update ARCHITECTURE §4.3 in the same commit.
 * Tests: packages/target-web/test/stylesheet.test.ts, packages/words/test/words.test.ts
 */

/**
 * The word-emitter contract — ARCHITECTURE §4.3.
 *
 * A word emits a small serialisable TREE, not a string of JSX. Two reasons,
 * both load-bearing:
 *
 *   1. A word may never string-concatenate user content into code
 *      (CONVENTIONS §6). If a word returns a tree, escaping happens once in
 *      the target where it can be tested, instead of in eleven places where it
 *      cannot.
 *   2. `words/* → core, theme, overlay — never a target directly`
 *      (ARCHITECTURE §2). A word that emitted JSX would be importing a
 *      target's idea of a component. A tree keeps the dependency arrow
 *      pointing the right way.
 */

import type { SpecBlock } from './spec-block.ts';

/** A set of style declarations: camelCase property to value; `undefined` is "not set". */
export type StyleMap = Readonly<Record<string, string | number | undefined>>;

/**
 * The breakpoints a style may change at — theme-spec §1.9. A closed set: a
 * word names a breakpoint, never a pixel width, and the target turns the
 * name into a condition. The theme's BREAKPOINT table must have exactly
 * these keys (a theme test holds the two together).
 */
export const BREAKPOINT_NAMES = ['xs', 'sm', 'md', 'lg'] as const;
export type BreakpointName = (typeof BREAKPOINT_NAMES)[number];

/**
 * The interaction states a style may change in. Named by meaning, not by
 * selector: `focusVisible` is keyboard focus, `loading` is a busy control,
 * `current` the link to the page being viewed. The target decides how each
 * is detected (buttons-and-sections-spec §1: six states per button).
 *
 * `focusWithin` is focus anywhere inside the element — how a group of
 * controls hidden on a phone shows itself when one of them is reached by
 * keyboard (gallery-spec §6's carousel arrows).
 *
 * Four belong to the behaviour runtime rather than to the pointer: `open` is
 * an overlay that is showing (overlays-spec §3 — it animates in from its
 * base style), `scrolled` is a `solid` nav past its threshold
 * (nav-block-spec §4), `shrunk` a `shrink` nav past its threshold, and
 * `retracted` a `hide` nav moved out of view while the reader scrolls down
 * (nav-block-spec §3). The runtime sets them; the stylesheet styles them.
 *
 * `overBackdrop` is structural, not interactive: the element's page carries a
 * `scene backdrop` (scene-spec §6), so a block with no surface of its own
 * must resolve one (§6.5) — the backdrop may show any colour on any frame.
 *
 * `live` belongs to the 3D runtime: the page's shared canvas is drawing in
 * this element's box (scene-spec §5), so the element steps aside — its
 * background clears and the poster hides — until the stage tears down.
 */
export const INTERACTION_STATES = [
  'hover', 'focusVisible', 'focusWithin', 'active', 'disabled', 'loading', 'expanded', 'open', 'scrolled', 'shrunk',
  'retracted', 'overBackdrop', 'live', 'current',
] as const;
export type InteractionState = (typeof INTERACTION_STATES)[number];

/**
 * How much visual weight an action carries — buttons-and-sections-spec §1.2.
 * `primary` is filled and at most one per section; `secondary` is outlined;
 * `ghost` has no border until hovered; `link` is text. An author picks one
 * with `as` (`cta "Reserve" /reserve as ghost`); otherwise the first `cta` is
 * primary and everything else secondary.
 */
export const HIERARCHIES = ['primary', 'secondary', 'ghost', 'link'] as const;
export type Hierarchy = (typeof HIERARCHIES)[number];

/** How a word asks for its actions; the target decides the markup. */
export interface ActionOptions {
  /** Overrides the default hierarchy (and an author's `as`). */
  readonly hierarchy?: Hierarchy;
  /**
   * The surface an action sits on: the page (default), an accent surface
   * (`inverted`, cta `band`), or the dark scrim a full-bleed hero sets its
   * type on (`scrim`, hero `full`) — where page ink is the scrim's own colour.
   */
  readonly tone?: 'page' | 'inverted' | 'scrim';
  /** `sm` for dense bars (nav). The 44px tap target holds at every size. */
  readonly size?: 'md' | 'sm';
  /** Fill the container's width — a card's action (pricing). */
  readonly fill?: boolean;
  /**
   * Below this breakpoint the primary fills the row and a secondary becomes
   * a text link — hero-spec §5 ("on <480px, primary goes full-width;
   * secondary stays a text link").
   */
  readonly compactBelow?: BreakpointName;
  /** Below this breakpoint the primary fills the row; secondaries keep their look. */
  readonly fullWidthBelow?: BreakpointName;
}

/** A form's submit control — the one action that is not a slot fill. */
export interface SubmitOptions extends ActionOptions {
  /** Posted with the form, so the handler knows which submit was pressed. */
  readonly name?: string;
  readonly value?: string;
  /** Skip the form's own validation — an alternative that needs fewer fields. */
  readonly noValidate?: boolean;
}

/** A node in the emitted tree. Deliberately close to HTML, but not HTML. */
export interface EmittedNode {
  readonly tag: string;
  /** Attributes. Values are plain strings; the TARGET escapes them. */
  readonly attrs?: Readonly<Record<string, string>>;
  /**
   * Style values, already resolved from theme tokens.
   *
   * A word never writes a colour or an off-scale length here — `az lint`
   * (theme/lint.ts) rejects that statically, which is assumption A7.
   *
   * `undefined` means "not set", and is DROPPED rather than emitted. The
   * renderer already filtered it; the type said otherwise, which forced words
   * into building style objects conditionally to express "no value here".
   */
  readonly style?: StyleMap;
  /**
   * Overrides BELOW a breakpoint: `below.sm` applies at widths under
   * `breakpoint.sm`. Desktop-first, because every block spec's responsive
   * table is written as "<768px" (e.g. hero-spec §10).
   */
  readonly below?: Readonly<Partial<Record<BreakpointName, StyleMap>>>;
  /** Overrides while the element is in an interaction state. */
  readonly states?: Readonly<Partial<Record<InteractionState, StyleMap>>>;
  /**
   * Overrides when the visitor asks for reduced motion. Opacity-only or
   * instant, never "slower" (theme-spec §9.3).
   */
  readonly reducedMotion?: StyleMap;
  /**
   * Overrides where the page can be blurred through the element — `glass`
   * (nav-spec §3, cta-spec §5): the browser supports `backdrop-filter` and the
   * visitor has not asked for reduced transparency. The base style is the
   * solid fallback and must pass contrast on its own; this only makes it
   * translucent. `states` overrides apply the same way to a state's style
   * (a `solid` nav turns glass, not solid, once scrolled).
   */
  readonly translucent?: {
    readonly style?: StyleMap;
    readonly states?: Readonly<Partial<Record<InteractionState, StyleMap>>>;
  };
  readonly children?: readonly (EmittedNode | string)[];
}

/** Everything a word is allowed to know at emit time. */
export interface EmitContext {
  /** The ONLY source of colour, space, type and layer values. */
  readonly theme: ThemeLike;
  readonly target: string;
  /**
   * The site this block belongs to. A word needs its name wherever the page
   * must say what the site is without an image to say it — nav-spec §7: the
   * logo link carries the site name as text, or it is an unlabelled link.
   */
  readonly site: { readonly name: string };
  /** Children filling a named slot — `hero`'s `cta`, `footer`'s `link`. */
  readonly slot: (name: string) => EmittedNode[];
  /**
   * Resolve an asset path.
   *
   * Sandboxed: throws outside the project root. The link stage already
   * rejects an escaping path (AZ1210), so this is the second gate rather than
   * the only one — a word may construct a path the author never typed.
   */
  readonly asset: (path: string) => string;
  /**
   * An SVG file inlined as a sanitised node tree (feature-spec §7): no
   * script, no outside references, paint as currentColor, decorative.
   * Absent when the caller has no files to read — a unit test, a future
   * in-browser playground — and a word then shows the file as an <img>,
   * which cannot run script either.
   */
  readonly inlineSvg?: (path: string) => EmittedNode;
  /**
   * A `text` body file (.md) rendered to nodes at build time (text-spec §5):
   * CommonMark plus tables and strikethrough, raw HTML stripped, headings
   * shifted below the block's own (`titled`: it has a title h2). Absent when
   * the caller has no files to read; a word then shows the path as text.
   */
  readonly markdown?: (path: string, options: { readonly titled: boolean }) => EmittedNode[];
  /**
   * One slot fill (`cta "Reserve a pair" /reserve`) rendered as an action —
   * a link or a button, chosen by its destination (buttons §1.3–1.4), with
   * all six states (§1.5). The target owns the markup; a word asks.
   */
  readonly action: (fill: SpecBlock, options?: ActionOptions) => EmittedNode;
  /**
   * A block's actions from the named slots, in that order, each in an <li>
   * for the word's <ul>. Default hierarchy: the first `cta` is primary,
   * every other fill secondary; an author's `as` overrides it.
   */
  readonly actions: (block: SpecBlock, slots: readonly string[], options?: ActionOptions) => EmittedNode[];
  /** A form submit button styled as an action of the given hierarchy. */
  readonly submit: (label: string, options?: SubmitOptions) => EmittedNode;
}

/**
 * The shape of a resolved theme, as a word sees it.
 *
 * Structural rather than an import, because `core` must not depend on
 * `packages/theme` — the dependency arrow runs `theme → core` (ARCHITECTURE
 * §2), and reversing it here would create the cycle that rule exists to stop.
 */
export interface ThemeLike {
  readonly color: Readonly<Record<string, string>>;
  readonly size: Readonly<Record<string, number>>;
  readonly type: Readonly<Record<string, string | number>>;
  readonly radius: Readonly<Record<string, number>>;
  readonly shadow: Readonly<Record<string, string>>;
  readonly space: Readonly<Record<string | number, number>>;
  readonly motion: Readonly<Record<string, string | number>>;
  readonly layer: Readonly<Record<string, number>>;
  readonly breakpoint: Readonly<Record<BreakpointName, number>>;
  readonly typeSize: Readonly<Record<string, string>>;
}

/** What every `emit.web.ts` exports. */
export interface WordEmitter {
  emit(block: SpecBlock, ctx: EmitContext): EmittedNode;
}

/** Convenience for emitters: px from a space step, so no word writes `13px`. */
export const px = (n: number): string => `${n}px`;

/**
 * The tag of a component node: a user component named by `raw` or `slot`
 * (PRD §6.6). `attrs.src` is its project-relative source path; the target
 * imports that module and renders it with the same theme a word sees. `#`
 * can never begin an HTML tag, so a component node is never mistaken for
 * markup. Targets create these; words never need to.
 */
export const COMPONENT_TAG = '#component';

export const componentNode = (src: string): EmittedNode => ({ tag: COMPONENT_TAG, attrs: { src } });

/**
 * Text that assistive technology reads and the screen does not show.
 *
 * For a link whose visible content is an image with `alt=""` — the logo link
 * (nav-spec §7, footer-spec §9) — this is its name. Clipped rather than
 * `display: none`, which would hide it from screen readers too.
 */
/**
 * The `glass` surface — the style a word puts under `translucent` (nav-spec
 * §3, cta-spec §5). The page tone as `color.veil` (the 92% veil whose
 * contrast is proven against pure white and pure black behind it, theme-spec
 * §3.3), blurred by the theme's `size.glass-blur`. Text contrast never rests
 * on the blur: the veil alone passes, and the solid fallback is the base.
 */
export const glassSurface = (theme: ThemeLike): StyleMap => {
  const blur = `blur(${px(theme.size['glass-blur'])})`;
  return { background: theme.color.veil, backdropFilter: blur, WebkitBackdropFilter: blur };
};

/**
 * `reveal` — feature-spec §9, the engine every word with the modifier uses
 * (text-spec §9, cta-spec §8, faq, gallery, pricing). The word only marks:
 * the block gets `data-az-reveal` (the rise distance, `space.8`), and each
 * staggered item `data-az-reveal-item` — or the block itself when it reveals
 * as one unit. The behaviour runtime applies the hidden state BY SCRIPT, only
 * below the first viewport, once, and not at all under reduced motion, so
 * nothing is ever hidden by CSS and the page reads with JS off.
 */
export function revealed(
  block: { readonly modifiers: readonly string[] }, theme: ThemeLike, root: EmittedNode, itemClass?: string,
): EmittedNode {
  if (!block.modifiers.includes('reveal')) return root;
  const motion = theme.motion as Readonly<Record<string, string | number>>;
  const transition = `opacity ${motion.slow}ms ${motion.ease}, transform ${motion.slow}ms ${motion.ease}`;
  const animate = (node: EmittedNode, item: boolean): EmittedNode => ({
    ...node,
    attrs: { ...node.attrs, ...(item ? { 'data-az-reveal-item': '' } : {}) },
    style: { ...node.style, transition: node.style?.transition ? `${node.style.transition}, ${transition}` : transition },
    reducedMotion: { ...node.reducedMotion, transition: 'none' },
  });
  const hasClass = (node: EmittedNode) => String(node.attrs?.class ?? '').split(/\s+/).includes(itemClass ?? '');
  let items = 0;
  const walk = (node: EmittedNode): EmittedNode => {
    if (itemClass && hasClass(node)) { items++; return animate(node, true); }
    return { ...node, ...(node.children ? { children: node.children.map((c) => (typeof c === 'string' ? c : walk(c))) } : {}) };
  };
  const marked: EmittedNode = { ...root, attrs: { ...root.attrs, 'data-az-reveal': String(theme.space[8]) } };
  const walked = itemClass ? walk(marked) : marked;
  // No items to stagger (pricing `table`): the block reveals as one unit.
  return items > 0 ? walked : animate(walked, false);
}

export const visuallyHidden = (text: string): EmittedNode => ({
  tag: 'span',
  attrs: { class: 'az-visually-hidden' },
  style: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: '0',
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0 0 0 0)',
    whiteSpace: 'nowrap',
    border: '0',
  },
  children: [text],
});
