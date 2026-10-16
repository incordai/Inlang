/**
 * @az module tokens
 * Purpose: the closed token schema: space, motion, layer, breakpoints, type sizes; resolve().
 * Spec: docs/theme-spec.md §1
 * Exports: resolve, tokenPaths, SPACE, MOTION, LAYER, BREAKPOINT, TYPE_SIZE, Theme, GRADIENT_DIRECTION
 * Edit guide: raw values are legal here and in themes.ts only; a new token needs the spec row first.
 * Tests: packages/theme/test/contrast.test.ts
 */

/**
 * The token schema — the closed set a word may read.
 *
 * theme-spec.md §1. Categories split two ways, and the split is load-bearing:
 *
 *   GLOBAL   space, motion, layer, breakpoint — defined once, and a theme may
 *            NOT override them. This is what lets a word be dropped into any
 *            theme and still lay out correctly: the geometry and the timing
 *            are the contract; only the palette is the theme's to choose.
 *
 *   PER-THEME  color, size, type, radius, shadow — and of these, only the
 *            colour-bearing ones resolve per scheme. A theme that changed its
 *            spacing between light and dark would be two themes in one name.
 */

/** Colour scheme. Every colour-bearing token resolves per scheme. */
export type Scheme = 'light' | 'dark';

/* ---------------- global: a theme may not override these ---------------- */

/**
 * PRD §7.3 — one scale, no arbitrary values.
 *
 * Keyed by VALUE, not by index. `space.4` is 4px because the scale IS the set
 * of legal values, so a key that is not on the scale is self-evidently wrong.
 */
export const SPACE = {
  0: 0, 4: 4, 8: 8, 12: 12, 16: 16, 24: 24,
  32: 32, 48: 48, 64: 64, 96: 96, 128: 128,
} as const;
export type SpaceStep = keyof typeof SPACE;

/** overlays-spec §3 fixes these. Themes do not get to be slower. */
export const MOTION = {
  /** theme-spec §1.7 — tooltip fade, and the ceiling for any reduced-motion change. */
  snap: 100,
  /**
   * theme-spec §9.3's `motion.reduced`, flattened: the ThemeLike contract
   * keeps `motion` a flat map, so this is the duration and the properties are
   * fixed — opacity only, enforced by the target's reduced-motion net.
   */
  reduced: 100,
  fast: 120,
  normal: 160,
  /** overlays-spec §3 — popup enter. */
  emphasis: 200,
  slow: 240,
  spring: 280,
  /** theme-spec §1.7 `motion.spring.sheet` = { stiffness 300, damping 30,
   *  mass 1 }, flattened like `reduced`: the sheet's enter curve (§9.2). */
  springStiffness: 300,
  springDamping: 30,
  ease: 'cubic-bezier(0.16, 1, 0.3, 1)',
  easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
  /** overlays-spec §3 — the dropdown's enter offset, in px. A distance the
   *  motion owns, not spacing, so it is not a space-scale step. */
  slide: 6,
  /** theme-spec §1.7 `motion.ease.out` — the CSS ease-out curve; the drawer's. */
  easeOut: 'cubic-bezier(0, 0, 0.58, 1)',
} as const;

/**
 * How opaque `color.veil` is: the page background a block puts under its
 * text when it sits over a live `scene backdrop` (scene-spec §6.5). The
 * backdrop can show ANY colour on any frame, so contrast must hold against
 * pure white and pure black behind the veil. 90 is the smallest whole
 * percent at which every theme and scheme keeps text, muted and accent at
 * 4.5:1 and border-strong at 3:1 (midnight and paper light sit exactly on
 * a floor there); 92 leaves two points for the browser's own compositing.
 * theme/test/contrast.test.ts proves both the pass and the edge.
 */
export const VEIL_PERCENT = 92;

/**
 * `theme pattern` (PRD §6.1a): the background SHAPE; its colour is the accent.
 * Geometry is data, so raw values live here (theme-spec §4).
 *
 * Every shape's peak ink is at most PATTERN_MAX_ALPHA. The hero's text sits on
 * the pattern, so the cap is set by contrast, not taste: 12% is the largest
 * whole percent at which text, muted and accent (4.5:1) and border-strong
 * (3:1) hold over accent-on-bg for every theme × accent × scheme; 10 keeps
 * the veil's two-point margin. theme/test/pattern.test.ts proves both, and
 * that the spike's original 55% glow fails.
 */
export const PATTERN_MAX_ALPHA = 0.1;

/**
 * Which way an accent pair's gradient runs (theme-spec §13): the first hue
 * at the start, the second at the end. One direction for every surface, so
 * a button and a highlighted plan read as the same pair.
 */
export const GRADIENT_DIRECTION = 'to right';

export const PATTERN_SHAPES = ['none', 'glow', 'spotlight', 'ramp', 'grid', 'hatch', 'dots'] as const;
export type PatternShape = (typeof PATTERN_SHAPES)[number];

export const PATTERN_ORIGINS = ['top', 'bottom', 'left', 'right', 'center'] as const;
export type PatternOrigin = (typeof PATTERN_ORIGINS)[number];

export const PATTERN = {
  /** Peak ink per shape, a fraction of the accent; each ≤ PATTERN_MAX_ALPHA. */
  alpha: { glow: 0.1, spotlight: 0.1, ramp: 0.1, grid: 0.09, hatch: 0.08, dots: 0.1 },
  /** Where the light sits, per origin — a CSS position. */
  at: { top: '50% 8%', bottom: '50% 92%', left: '8% 50%', right: '92% 50%', center: '50% 50%' },
  /** Which way a `ramp` travels, per origin. */
  toward: { top: 'to bottom', bottom: 'to top', left: 'to right', right: 'to left', center: 'to bottom' },
  /** Lattice pitch for grid / hatch / dots, and the line and dot weights. */
  pitch: '32px',
  hairline: '1px',
  dot: '1.2px',
  dotFade: '1.4px',
  hatchAngle: '45deg',
  /** Where each radial or linear fade reaches clear ground. */
  glowEllipse: '125% 125%',
  glowStart: '38%',
  spotEllipse: '60% 55%',
  spotEnd: '72%',
  rampEnd: '68%',
  /**
   * Where the second hue of an accent pair (theme-spec §13) takes over in the
   * focal shapes: halfway along each fade, so the two hues share the ink.
   */
  glowMid: '69%',
  spotMid: '36%',
  rampMid: '34%',
} as const;

/** CONVENTIONS §4 bans raw z-index; overlays-spec §1 needs a layer manager. */
export const LAYER = {
  behind: -1, base: 0, raised: 10, scrim: 20, sticky: 100, dropdown: 200,
  backdrop: 300, modal: 400, toast: 500, tooltip: 600, skip: 700,
} as const;

/**
 * theme-spec §1.9. A raw `768px` in a media query is an off-scale px, i.e. a
 * lint error. `md` is the band where three columns lose their measure —
 * feature, gallery and text all need it (their specs' open question 6).
 */
export const BREAKPOINT = { xs: 480, sm: 768, md: 1024, lg: 1440 } as const;

/** The 6-step type scale plus the display steps — global, per theme-spec §1.5. */
export const TYPE_SIZE = {
  xs: 'clamp(0.75rem, 0.72rem + 0.15vw, 0.82rem)',
  sm: 'clamp(0.875rem, 0.84rem + 0.18vw, 0.95rem)',
  base: 'clamp(1rem, 0.96rem + 0.2vw, 1.08rem)',
  lg: 'clamp(1.125rem, 1.05rem + 0.36vw, 1.35rem)',
  xl: 'clamp(1.5rem, 1.32rem + 0.9vw, 2rem)',
  '2xl': 'clamp(2rem, 1.7rem + 1.5vw, 2.75rem)',
  display: 'clamp(2.5rem, 1.9rem + 3vw, 5.5rem)',
  'display-lg': 'clamp(3rem, 2rem + 5vw, 7rem)',
} as const;

/**
 * What a `font` role's family resolves to — theme-spec §8.1, overriding the
 * theme's `type.display` / `type.body` / `type.mono`. System faces only, each
 * ending in a generic family: nothing is downloaded, so builds stay offline
 * and no face licence is involved. Keys match core's FONT_FAMILIES (tested).
 */
export const FONT_STACKS = {
  sans: 'system-ui, sans-serif',
  serif: 'ui-serif, serif',
  mono: 'ui-monospace, monospace',
  rounded: 'ui-rounded, system-ui, sans-serif',
} as const;

/* ---------------- per theme ---------------- */

/** The colour roles. Named by ROLE, never by appearance — theme-spec §2. */
export interface ColorTokens {
  readonly bg: string;
  readonly surface: string;
  readonly 'surface-alt': string;
  readonly text: string;
  readonly muted: string;
  readonly border: string;
  /** A border that must clear 3:1 — a visible edge, not a hairline. */
  readonly 'border-strong': string;
  readonly accent: string;
  readonly 'accent-hover': string;
  readonly 'accent-contrast': string;
  readonly focus: string;
  readonly danger: string;
  readonly 'danger-contrast': string;
  readonly scrim: string;
  /** Text drawn OVER a scrim. Light in BOTH schemes, because a scrim is dark
   *  in both — the fix theme-spec §6.1 forced when contrast came out 1.00:1. */
  readonly 'on-scrim': string;
  /** The modal backdrop. Distinct from `scrim`, which sits over media. */
  readonly overlay: string;
  /**
   * Present only when `theme accent <hue> <hue2>` names a pair (theme-spec
   * §13): the second hue's accent and hover, chosen by the same floors as
   * `accent`, and the label drawn on the gradient between the two. No theme
   * defines them, so a one-hue site declares exactly what it did before.
   */
  readonly accent2?: string;
  readonly 'accent2-hover'?: string;
  readonly 'on-gradient'?: string;
  /**
   * Present only on a site whose chat may draw charts (chat-block-spec
   * §20.4): six categorical colours derived from the theme by series.ts,
   * each 3:1 on bg, surface and surface-alt. No theme defines them, so every
   * other site declares exactly what it did before.
   */
  readonly 'series-1'?: string;
  readonly 'series-2'?: string;
  readonly 'series-3'?: string;
  readonly 'series-4'?: string;
  readonly 'series-5'?: string;
  readonly 'series-6'?: string;
}

export interface SizeTokens {
  readonly container: number;
  readonly 'gutter-sm': number;
  readonly 'gutter-lg': number;
  readonly nav: number;
  readonly 'nav-shrink': number;
  readonly tap: number;
  readonly ring: number;
  /** theme-spec §6.1: setting this to 0 reintroduces an invisible focus ring
   *  on a filled accent button. Load-bearing, not decorative. */
  readonly 'ring-offset': number;
  readonly 'measure-display': number;
  readonly 'measure-body': number;
  readonly 'hero-min': number;
  /**
   * Minimum width of an auto-filled column, in px.
   *
   * Proposed by `gallery`'s masonry variant, which needs a floor for
   * `minmax()`. theme-spec §1 is explicit that a word needing a value outside
   * the closed set does not invent one — it proposes the token. This is that.
   */
  readonly 'column-min': number;
  /**
   * Width of an edge that marks emphasis by WEIGHT, in px — pricing-spec
   * §7.3's highlighted plan, which must survive without colour. Proposed
   * rather than written inline (theme-spec §1): `size.hairline` is 1px and
   * the space scale has no 2.
   */
  readonly 'edge-emphasis': number;
  /**
   * Width of a vertical `side` nav, in px.
   *
   * nav-block-spec §2 says a side nav "eats 240-280px of width"; 256 sits
   * inside that range. Proposed rather than written inline, because a second
   * word needing a sidebar must get the SAME width — theme-spec §1.
   */
  readonly 'nav-side': number;
  /**
   * How far `glass` blurs what is behind it, in px (nav-spec §3, cta-spec §5).
   * Per theme, because `signal` draws every edge hard with zero blur
   * (theme-spec §5.3): its glass is translucent and unblurred.
   */
  readonly 'glass-blur': number;
}

export interface TypeTokens {
  readonly display: string;
  readonly body: string;
  readonly mono: string;
  readonly 'leading-display': number;
  readonly 'leading-tight': number;
  readonly 'leading-body': number;
  readonly 'weight-display': number;
  readonly 'weight-body': number;
  readonly 'weight-bold': number;
}

export interface RadiusTokens {
  readonly sm: number;
  readonly md: number;
  readonly lg: number;
  readonly full: number;
}

export interface ShadowTokens {
  readonly sm: string;
  readonly md: string;
  readonly lg: string;
}

export interface Theme {
  readonly name: string;
  readonly description: string;
  /**
   * The scheme written to bare `:root` — what a visitor gets before the OS
   * preference or an explicit choice says otherwise (theme-spec §3.2).
   * Defaults to light; `midnight` is dark-native.
   */
  readonly defaultScheme?: Scheme;
  readonly color: Readonly<Record<Scheme, ColorTokens>>;
  readonly shadow: Readonly<Record<Scheme, ShadowTokens>>;
  readonly size: SizeTokens;
  readonly type: TypeTokens;
  readonly radius: RadiusTokens;
}

/** A theme resolved for one scheme — what an emitter actually reads. */
export interface ResolvedTheme {
  readonly name: string;
  readonly scheme: Scheme;
  readonly color: ColorTokens;
  readonly shadow: ShadowTokens;
  readonly size: SizeTokens;
  readonly type: TypeTokens;
  readonly radius: RadiusTokens;
  readonly space: typeof SPACE;
  readonly motion: typeof MOTION;
  readonly layer: typeof LAYER;
  readonly breakpoint: typeof BREAKPOINT;
  readonly typeSize: typeof TYPE_SIZE;
}

export function resolve(theme: Theme, scheme: Scheme): ResolvedTheme {
  return {
    name: theme.name,
    scheme,
    color: theme.color[scheme],
    shadow: theme.shadow[scheme],
    size: theme.size,
    type: theme.type,
    radius: theme.radius,
    space: SPACE,
    motion: MOTION,
    layer: LAYER,
    breakpoint: BREAKPOINT,
    typeSize: TYPE_SIZE,
  };
}

/** Every legal token path, generated from the schema — the CLOSED set. */
export function tokenPaths(theme: Theme): string[] {
  const out: string[] = [];
  for (const k of Object.keys(theme.color.light)) out.push(`color.${k}`);
  for (const k of Object.keys(theme.shadow.light)) out.push(`shadow.${k}`);
  for (const k of Object.keys(theme.size)) out.push(`size.${k}`);
  for (const k of Object.keys(theme.type)) out.push(`type.${k}`);
  for (const k of Object.keys(theme.radius)) out.push(`radius.${k}`);
  for (const k of Object.keys(SPACE)) out.push(`space.${k}`);
  for (const k of Object.keys(MOTION)) out.push(`motion.${k}`);
  for (const k of Object.keys(LAYER)) out.push(`layer.${k}`);
  for (const k of Object.keys(BREAKPOINT)) out.push(`breakpoint.${k}`);
  for (const k of Object.keys(TYPE_SIZE)) out.push(`type.size.${k}`);
  return out.sort();
}
