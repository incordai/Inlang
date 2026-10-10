/**
 * @az module colour
 * Purpose: the colour step (theme, accent, pattern) as text — the legal values and the .az lines, from the closed tables.
 * Spec: docs/PRD.md §6.1a · docs/theme-spec.md §5, §13
 * Exports: DEFAULT_THEME_NAME, partnersOf, colourChoicesMd, themeLinesAz, ThemeLines
 * Edit guide: every value comes from link.ts, accent-pairs.ts or spec.ts — never list a theme, hue, pair or shape here.
 * Tests: packages/core/test/colour.test.ts, packages/target-web/test/azmd.test.ts, packages/words/test/words-index.test.ts
 */

/**
 * Colour is the first step of every site (PRD §6.1a): theme, accent (one hue
 * or an allowed pair) and pattern are chosen before any section is written.
 * The places an AI starts from — the generated AZ.md and docs/WORDS.md —
 * lead with that step, and both print the legal values from here, so the
 * lists are the compiler's own tables and cannot drift from them.
 */

import { ACCENT_HUES, PATTERN_ORIGIN_NAMES, PATTERN_SHAPE_NAMES, THEME_NAMES } from './link.ts';
import { ACCENT_PAIRS } from './accent-pairs.ts';
import { SITE_DEFAULTS } from './spec.ts';

/** The theme a site without a `theme` line gets. */
export const DEFAULT_THEME_NAME: string = SITE_DEFAULTS.theme;

const code = (s: string): string => `\`${s}\``;

/**
 * The hues `hue` pairs with across `themes`, in ramp order: a partner every
 * one of them allows is named plainly, one only some allow is named with the
 * themes that refuse it — `teal, amber (not signal/volt)`. Empty when none.
 */
export function partnersOf(hue: string, themes: readonly string[] = Object.keys(ACCENT_PAIRS)): string[] {
  const allows = (t: string, h: string): boolean => ACCENT_PAIRS[t]?.[hue]?.includes(h) ?? false;
  return Object.keys(ACCENT_HUES)
    .filter((h) => themes.some((t) => allows(t, h)))
    .map((h) => {
      const refusing = themes.filter((t) => !allows(t, h));
      return refusing.length ? `${h} (not ${refusing.join('/')})` : h;
    });
}

/**
 * The legal colour values as markdown list lines. With a theme, the pairs
 * are that theme's; with null, every theme's, refusals named.
 */
export function colourChoicesMd(theme: string | null): string[] {
  const themes = theme !== null && Object.hasOwn(ACCENT_PAIRS, theme) ? [theme] : Object.keys(ACCENT_PAIRS);
  const where = themes.length === 1 ? ` on ${code(themes[0])}` : '';
  const origins = Object.keys(PATTERN_ORIGIN_NAMES);
  return [
    `- ${code('theme <name>')}, under ${code('site')}; without it the site gets ${code(DEFAULT_THEME_NAME)}:`,
    ...Object.entries(THEME_NAMES).map(([name, text]) => `  - ${code(name)} — ${text}`),
    `- ${code('accent <hue> [<hue2>]')}, under ${code('theme')}; without it the theme keeps its own accent.`
      + ` Hues: ${Object.keys(ACCENT_HUES).map(code).join(' ')}. A second hue makes a gradient,`
      + ` allowed only with these partners${where}:`,
    ...Object.keys(ACCENT_HUES).map((hue) => {
      const partners = partnersOf(hue, themes);
      return `  - ${code(hue)} with ${partners.length ? partners.join(', ') : 'no hue'}`;
    }),
    `- ${code('pattern <shape> [<origin>]')}, under ${code('theme')}; without it there is none.`
      + ` Origins: ${origins.map(code).join(' ')} (default ${code(SITE_DEFAULTS.patternOrigin)}). Shapes:`,
    ...Object.entries(PATTERN_SHAPE_NAMES).map(([name, text]) => `  - ${code(name)} — ${text}`),
  ];
}

/** What a site's colour lines say now. */
export interface ThemeLines {
  readonly site: string;
  readonly theme: string;
  /** null when the theme keeps its own accent. */
  readonly accent: string | null;
  readonly accent2?: string;
  /** "shape origin", or null when the site has no pattern. */
  readonly pattern: string | null;
}

/** The site's colour lines exactly as the .az file writes them, `site` first. */
export function themeLinesAz(t: ThemeLines): string[] {
  return [
    `site ${t.site}`,
    `  theme ${t.theme}`,
    ...(t.accent ? [`    accent ${t.accent}${t.accent2 ? ` ${t.accent2}` : ''}`] : []),
    ...(t.pattern ? [`    pattern ${t.pattern}`] : []),
  ];
}
