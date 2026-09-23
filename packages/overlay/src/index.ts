/**
 * The overlay presets — overlays-spec §2 and §3 — as style.
 *
 * A word asks for a preset and spreads the result into the node it emits;
 * the behaviour runtime (./runtime) enforces the preset's policy on the same
 * node. Every value is a theme token (A7). Structural types rather than an
 * import from core: the dependency arrow is `overlay → theme` only
 * (ARCHITECTURE §2).
 *
 * The motion is overlays-spec §3 read literally: `transform` + `opacity`
 * only, exit faster than enter, and the `open` state carries the enter
 * transition so the base style's is the exit. Reduced motion needs nothing
 * here — the target's net limits every transition to opacity (theme §9.3).
 *
 * No `display` is ever set on an overlay: the closed state is the element's
 * own (`<dialog>` without `open`, a list with `hidden`), and a generated
 * class would outrank it.
 */

import { POLICY, type Preset } from './runtime/policy.ts';

export { POLICY, PRESETS, isPreset, type Policy, type Preset } from './runtime/policy.ts';

/** The theme groups the presets read; ThemeLike satisfies it. */
export interface OverlayTheme {
  readonly color: Readonly<Record<string, string>>;
  readonly size: Readonly<Record<string, number>>;
  readonly space: Readonly<Record<string, number>>;
  readonly radius: Readonly<Record<string, number>>;
  readonly shadow: Readonly<Record<string, string>>;
  readonly motion: Readonly<Record<string, string | number>>;
  readonly layer: Readonly<Record<string, number>>;
}

type Style = Readonly<Record<string, string | number | undefined>>;

export interface OverlayStyle {
  readonly attrs: Readonly<Record<string, string>>;
  readonly style: Style;
  readonly states: { readonly open: Style };
}

const px = (n: number) => `${n}px`;
const ms = (t: OverlayTheme, key: string) => `${t.motion[key]}ms`;
const transition = (t: OverlayTheme, duration: string, easing: string, props: readonly string[]) =>
  props.map((p) => `${p} ${ms(t, duration)} ${t.motion[easing]}`).join(', ');

/** The attributes the runtime reads, plus the preset's ARIA (§2). */
function attrsFor(preset: Preset, label?: string): Record<string, string> {
  const attrs: Record<string, string> = { 'data-az-overlay': preset };
  if (POLICY[preset].modal) {
    // A <dialog> shown modally is role=dialog + aria-modal natively.
    attrs['data-az-behaviour'] = 'dialog';
    if (label) attrs['aria-label'] = label;
  }
  return attrs;
}

/**
 * `dropdown` — anchored below its trigger, above the page, not modal.
 * Enter 160ms emphasis curve from 6px up; exit 120ms ease-in (§3).
 */
export function dropdown(t: OverlayTheme): OverlayStyle {
  return {
    attrs: attrsFor('dropdown'),
    style: {
      position: 'absolute',
      top: '100%',
      insetInlineStart: 0,
      zIndex: t.layer.dropdown,
      minWidth: 'max-content',
      margin: 0,
      padding: px(t.space[8]),
      listStyle: 'none',
      background: t.color.surface,
      color: t.color.text,
      border: `1px solid ${t.color.border}`,
      borderRadius: px(t.radius.md),
      boxShadow: t.shadow.md,
      opacity: 0,
      // §3 enters from `motion.slide` above. Its exit returns there rather
      // than to the spec's 4px: without @starting-style one base style is
      // both the enter start and the exit end — a 2px difference.
      transform: `translateY(-${px(Number(t.motion.slide))})`,
      transition: transition(t, 'fast', 'easeIn', ['opacity', 'transform']),
    },
    states: {
      open: {
        opacity: 1,
        transform: 'none',
        transition: transition(t, 'normal', 'ease', ['opacity', 'transform']),
      },
    },
  };
}

/** `drawer` — slides in from the inline start edge; 240ms ease-out (§3). */
export function drawer(t: OverlayTheme, label: string): OverlayStyle {
  return {
    attrs: attrsFor('drawer', label),
    style: {
      position: 'fixed',
      insetBlock: 0,
      insetInlineStart: 0,
      insetInlineEnd: 'auto',
      margin: 0,
      width: px(t.size['nav-side']),
      maxWidth: '85vw',
      height: '100%',
      maxHeight: '100%',
      padding: px(t.space[24]),
      border: 0,
      background: t.color.surface,
      color: t.color.text,
      boxShadow: t.shadow.lg,
      transform: 'translateX(-100%)',
      transition: transition(t, 'fast', 'easeIn', ['transform']),
    },
    states: {
      open: { transform: 'none', transition: transition(t, 'slow', 'easeOut', ['transform']) },
    },
  };
}

/** `popup` — centred, scales from .96; 200ms, backdrop leading (§3). */
export function popup(t: OverlayTheme, label: string): OverlayStyle {
  return {
    attrs: attrsFor('popup', label),
    style: {
      width: `min(90vw, ${px(t.size.container)})`,
      maxWidth: '90vw',
      padding: px(t.space[16]),
      border: 0,
      borderRadius: px(t.radius.md),
      background: t.color.surface,
      color: t.color.text,
      boxShadow: t.shadow.lg,
      opacity: 0,
      transform: 'scale(0.96)',
      transition: transition(t, 'fast', 'easeIn', ['opacity', 'transform']),
    },
    states: {
      open: {
        opacity: 1,
        transform: 'none',
        transition: transition(t, 'emphasis', 'ease', ['opacity', 'transform']),
      },
    },
  };
}

/**
 * The close control every modal preset carries (§2 dismiss: "X"), 44px
 * (nav §7), labelled for a screen reader. The glyph is two strokes.
 */
export function closeButton(t: OverlayTheme, label: string): {
  readonly attrs: Readonly<Record<string, string>>;
  readonly style: Style;
  readonly states: { readonly focusVisible: Style };
  readonly icon: { readonly viewBox: string; readonly d: string };
} {
  return {
    attrs: { type: 'button', 'data-az-close': '', 'aria-label': label, class: 'az-overlay-close' },
    style: {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: px(t.size.tap),
      minHeight: px(t.size.tap),
      marginInlineStart: 'auto',
      padding: 0,
      background: 'transparent',
      border: 0,
      color: t.color.text,
      cursor: 'pointer',
    },
    states: {
      focusVisible: {
        outline: `${px(t.size.ring)} solid ${t.color.focus}`,
        outlineOffset: px(t.size['ring-offset']),
      },
    },
    icon: { viewBox: '0 0 24 24', d: 'M6 6l12 12M18 6L6 18' },
  };
}
