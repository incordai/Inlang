/**
 * Background patterns — SHAPES, not recipes.
 *
 * A reference library shipped 206 distinct gradient strings. Classified, they
 * are six shapes whose only real variation is position, angle, scale and
 * colour. Shipping 206 hardcoded strings would hardcode 206 colours with them,
 * which CONVENTIONS §4 forbids under `words/` and `target-*` and which would
 * make every pattern unthemeable — change the theme and the background would
 * still be someone else's purple.
 *
 * So: the SHAPE is the option, the COLOUR comes from the theme. Six shapes
 * across nine hues and eleven steps is a larger space than 206 fixed strings,
 * and every combination stays on-theme by construction.
 */

export type PatternShape =
  | 'none'
  | 'glow'       // light blooming from one edge — the most common by far
  | 'spotlight'  // a soft circle of light at a point
  | 'ramp'       // directional fade, no focal point
  | 'grid'       // perpendicular hairlines
  | 'hatch'      // diagonal hairlines
  | 'dots';      // dot lattice

export const PATTERN_SHAPES: readonly PatternShape[] =
  ['none', 'glow', 'spotlight', 'ramp', 'grid', 'hatch', 'dots'] as const;

export type PatternOrigin = 'top' | 'bottom' | 'left' | 'right' | 'center';

export interface PatternOptions {
  readonly shape: PatternShape;
  readonly origin?: PatternOrigin;
  /** 0–1. Scales opacity; the shape's own alphas are relative to this. */
  readonly intensity?: number;
  /** Lattice pitch in px for `grid` / `hatch` / `dots`. */
  readonly scale?: number;
  /** Degrees, `hatch` only. */
  readonly angle?: number;
}

export interface PatternCss {
  readonly backgroundImage: string;
  readonly backgroundSize: string;
  readonly backgroundPosition: string;
}

/** Where the light sits, per origin, as a CSS position pair. */
const ORIGIN_AT: Record<PatternOrigin, string> = {
  top: '50% 8%',
  bottom: '50% 92%',
  left: '8% 50%',
  right: '92% 50%',
  center: '50% 50%',
};

/** Direction a `ramp` travels, per origin. */
const ORIGIN_TO: Record<PatternOrigin, string> = {
  top: 'to bottom',
  bottom: 'to top',
  left: 'to right',
  right: 'to left',
  center: 'to bottom',
};

const EMPTY: PatternCss = {
  backgroundImage: 'none',
  backgroundSize: 'auto',
  backgroundPosition: '0 0',
};

/**
 * Colours are read from CSS custom properties, never literals.
 *
 * `--pattern-ink` is the pattern's own colour and `--pattern-ground` the
 * surface it sits on; both are set from theme tokens by the consumer. That
 * indirection is the entire reason these are themeable.
 */
const INK = 'var(--pattern-ink, currentColor)';
const GROUND = 'var(--pattern-ground, transparent)';

const alpha = (base: number, intensity: number) =>
  Math.round(Math.min(1, Math.max(0, base * intensity)) * 1000) / 1000;

/**
 * Build the CSS for a shape.
 *
 * `color-mix` carries the alpha rather than an rgba() literal, because the ink
 * arrives as a token whose channels are unknown here — which is precisely what
 * lets the same shape work in any theme.
 */
export function patternCss(opts: PatternOptions): PatternCss {
  const {
    shape,
    origin = 'top',
    intensity = 1,
    scale = 32,
    angle = 45,
  } = opts;

  if (shape === 'none' || intensity <= 0) return EMPTY;

  const ink = (a: number) =>
    `color-mix(in oklab, ${INK} ${alpha(a, intensity) * 100}%, transparent)`;

  switch (shape) {
    case 'glow':
      // The dominant family: a wide ellipse anchored to one edge, ground at
      // the centre falling to ink at the rim.
      return {
        backgroundImage:
          `radial-gradient(125% 125% at ${ORIGIN_AT[origin]}, ${GROUND} 38%, ${ink(0.55)} 100%)`,
        backgroundSize: 'cover',
        backgroundPosition: '0 0',
      };

    case 'spotlight':
      return {
        backgroundImage:
          `radial-gradient(60% 55% at ${ORIGIN_AT[origin]}, ${ink(0.4)} 0%, transparent 72%)`,
        backgroundSize: 'cover',
        backgroundPosition: '0 0',
      };

    case 'ramp':
      return {
        backgroundImage:
          `linear-gradient(${ORIGIN_TO[origin]}, ${ink(0.32)} 0%, transparent 68%)`,
        backgroundSize: 'cover',
        backgroundPosition: '0 0',
      };

    case 'grid':
      // Two perpendicular hairline sets. Hairlines are 1px regardless of
      // pitch — scaling the line with the cell turns a grid into stripes.
      return {
        backgroundImage:
          `linear-gradient(0deg, ${ink(0.09)} 0 1px, transparent 1px 100%), ` +
          `linear-gradient(90deg, ${ink(0.09)} 0 1px, transparent 1px 100%)`,
        backgroundSize: `${scale}px ${scale}px, ${scale}px ${scale}px`,
        backgroundPosition: '0 0, 0 0',
      };

    case 'hatch':
      return {
        backgroundImage:
          `repeating-linear-gradient(${angle}deg, ${ink(0.08)} 0 1px, transparent 1px ${scale}px)`,
        backgroundSize: 'auto',
        backgroundPosition: '0 0',
      };

    case 'dots':
      return {
        backgroundImage:
          `radial-gradient(circle at 50% 50%, ${ink(0.16)} 0 1.2px, transparent 1.4px)`,
        backgroundSize: `${scale}px ${scale}px`,
        backgroundPosition: '0 0',
      };
  }
}

const isShape = (v: string | null): v is PatternShape =>
  v !== null && (PATTERN_SHAPES as readonly string[]).includes(v);
const isOrigin = (v: string | null): v is PatternOrigin =>
  v !== null && Object.prototype.hasOwnProperty.call(ORIGIN_AT, v);

/** Read pattern options from the URL, falling back rather than throwing. */
export function resolvePattern(
  search: string = typeof window === 'undefined' ? '' : window.location.search,
): PatternOptions {
  const q = new URLSearchParams(search);
  const rawShape = q.get('pattern');
  const rawOrigin = q.get('origin');
  const rawIntensity = Number(q.get('intensity'));
  const rawScale = Number(q.get('scale'));
  return {
    shape: isShape(rawShape) ? rawShape : 'glow',
    origin: isOrigin(rawOrigin) ? rawOrigin : 'top',
    intensity: Number.isFinite(rawIntensity) && rawIntensity > 0 ? Math.min(2, rawIntensity) : 1,
    scale: Number.isFinite(rawScale) && rawScale >= 4 ? Math.min(200, rawScale) : 32,
  };
}
