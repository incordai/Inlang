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
 * Two belong to the behaviour runtime rather than to the pointer: `open` is
 * an overlay that is showing (overlays-spec §3 — it animates in from its
 * base style), and `scrolled` is a `solid` nav past its threshold
 * (nav-block-spec §4). The runtime sets them; the stylesheet styles them.
 */
export const INTERACTION_STATES = [
  'hover', 'focusVisible', 'active', 'disabled', 'loading', 'expanded', 'open', 'scrolled', 'current',
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
  /** `inverted` for an action sitting on an accent surface (cta `band`). */
  readonly tone?: 'page' | 'inverted';
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
