/**
 * The page frame — established BEFORE any section, and never forced.
 *
 * Two INDEPENDENT axes. Conflating them is the mistake this module exists to
 * prevent: the earlier spike hardcoded 1440px on the hero and 46rem on the
 * readout, so the two could not align because there was nothing to align to.
 *
 *   site  — the shell every section aligns to (the website's width)
 *   hero  — how the hero relates to that shell (it may ignore it entirely)
 *
 * A narrow, centred site with a full-bleed hero is a normal, valid pairing.
 * So is a wide site with an inset hero. Neither axis constrains the other.
 */

/**
 * THREE modes, because they are three different behaviours — not three sizes.
 *
 * The earlier version had five "widths" that were all the same behaviour with
 * a different ceiling, and its `full` still carried a 57.6px gutter, so
 * nothing in the system could actually reach the viewport edge. Mode and size
 * are separate questions and are now separate axes.
 */
export type SiteMode = 'full' | 'gap' | 'center';
export type SiteSize = 'wide' | 'default' | 'narrow' | 'reading';
export type HeroWidth = 'bleed' | 'container' | 'inset';

export interface SitePreset {
  /** Container ceiling in px. `null` means no ceiling. */
  readonly maxWidth: number | null;
  /** Does the shell keep a gutter at the viewport edge? */
  readonly gutter: boolean;
  readonly label: string;
}

/** Sizes, used when the mode is `center`. theme-spec `size.container`. */
export const SITE_SIZES: Readonly<Record<SiteSize, number>> = {
  wide: 1440,
  default: 1280,
  narrow: 1024,
  reading: 768,
};

export const DEFAULT_SIZE: SiteSize = 'wide';

/** The three modes. */
export const SITE_MODES: Readonly<Record<SiteMode, { gutter: boolean; capped: boolean; label: string }>> = {
  // Edge to edge. NO gutter — this is the one that was missing.
  full: { gutter: false, capped: false, label: 'edge to edge, no gutter' },
  // Fluid, but held off both edges by an equal gutter.
  gap: { gutter: true, capped: false, label: 'full width with a gutter both sides' },
  // Centred, capped, with a gutter.
  center: { gutter: true, capped: true, label: 'centred within a max width' },
};

export function sitePreset(mode: SiteMode, size: SiteSize = DEFAULT_SIZE): SitePreset {
  const m = SITE_MODES[mode];
  return {
    maxWidth: m.capped ? SITE_SIZES[size] : null,
    gutter: m.gutter,
    label: m.capped ? `${m.label} (${size})` : m.label,
  };
}

export interface HeroPreset {
  /** Fraction of the shell the hero occupies. `null` = ignore the shell. */
  readonly ofContainer: number | null;
  readonly label: string;
}

export const HERO_PRESETS: Readonly<Record<HeroWidth, HeroPreset>> = {
  bleed: { ofContainer: null, label: 'full-bleed, ignores the shell' },
  container: { ofContainer: 1, label: 'matches the shell' },
  inset: { ofContainer: 0.82, label: 'inset within the shell' },
};

/** Gutters, from theme-spec `size.gutter-sm` / `size.gutter-lg`. */
export const GUTTER = { sm: 24, lg: 64 } as const;
/** Below this viewport width the small gutter applies (theme-spec breakpoint). */
export const GUTTER_BREAKPOINT = 768;

export const DEFAULT_SITE: SiteMode = 'center';
export const DEFAULT_HERO: HeroWidth = 'bleed';

const isSite = (v: string | null): v is SiteMode =>
  v !== null && Object.prototype.hasOwnProperty.call(SITE_MODES, v);
const isSize = (v: string | null): v is SiteSize =>
  v !== null && Object.prototype.hasOwnProperty.call(SITE_SIZES, v);
const isHero = (v: string | null): v is HeroWidth =>
  v !== null && Object.prototype.hasOwnProperty.call(HERO_PRESETS, v);

/**
 * Read both axes from the URL. Unknown or absent values fall back to the
 * default rather than throwing — a malformed query must never blank the page.
 */
export function resolveLayout(search: string = typeof window === 'undefined' ? '' : window.location.search) {
  const q = new URLSearchParams(search);
  const rawSite = q.get('site');
  const rawSize = q.get('size');
  const rawHero = q.get('hero');
  return {
    site: isSite(rawSite) ? rawSite : DEFAULT_SITE,
    size: isSize(rawSize) ? rawSize : DEFAULT_SIZE,
    hero: isHero(rawHero) ? rawHero : DEFAULT_HERO,
    siteFallback: rawSite !== null && !isSite(rawSite),
    heroFallback: rawHero !== null && !isHero(rawHero),
  };
}

/**
 * The CSS custom properties the stylesheet consumes.
 *
 * Emitted as variables rather than baked into rules so that every section
 * reads ONE shell. A section that wants a different width states it as a
 * fraction of the shell; it never invents a px value of its own.
 */
export function layoutVars(
  site: SiteMode,
  hero: HeroWidth,
  size: SiteSize = DEFAULT_SIZE,
): Record<string, string> {
  const s = sitePreset(site, size);
  const h = HERO_PRESETS[hero];
  return {
    '--site-max': s.maxWidth === null ? 'none' : `${s.maxWidth}px`,
    // `full` means full: zero gutter, content reaches the viewport edge.
    '--gutter': s.gutter ? `clamp(${GUTTER.sm}px, 4vw, ${GUTTER.lg}px)` : '0px',
    // `bleed` escapes the shell by spanning the viewport; the others are a
    // fraction of it. 100vw is deliberate — the hero is allowed to ignore the
    // container, which is the whole point of the second axis.
    '--hero-max': h.ofContainer === null
      ? '100vw'
      : s.maxWidth === null
        ? 'none'
        : `${Math.round(s.maxWidth * h.ofContainer)}px`,
    '--hero-bleed': h.ofContainer === null ? '1' : '0',
  };
}
