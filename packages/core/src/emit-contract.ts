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
  readonly style?: Readonly<Record<string, string | number | undefined>>;
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
  readonly breakpoint: Readonly<Record<string, number>>;
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
