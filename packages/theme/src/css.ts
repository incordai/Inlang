/**
 * @az module theme-css
 * Purpose: colour schemes as CSS custom properties: default scheme, OS preference, data-scheme.
 * Spec: docs/theme-spec.md §3
 * Exports: schemeCss, scopedSchemeCss, schemeReferences, colorProperty, patternCss, PATTERN_REFERENCES, gradientCss, GRADIENT_REFERENCES
 * Edit guide: words read var(--az-color-*) references; declarations are generated here only.
 *   Gradients are declared here too (theme-spec §13) — in the stylesheet, never inline.
 *   A scope other than `:root` is for a page that shows several themes at once (az palette).
 * Tests: packages/theme/test/css.test.ts
 */

/**
 * Colour schemes as CSS custom properties — theme-spec §3.
 *
 * Words never see a colour. `ctx.theme.color.accent` is the string
 * `var(--az-color-accent)`, and this file writes the declarations those
 * references resolve to, once per site. The browser picks the scheme, so
 * dark mode is free for every word and the emitted tree is byte-identical
 * whatever the author's OS is set to (§3.3, CONVENTIONS §6).
 *
 * The three states of §3.2: the theme's default scheme on bare `:root`; the
 * other scheme when the OS prefers it and the visitor has not chosen; and an
 * explicit `data-scheme` choice winning in both directions.
 */

import { VEIL_PERCENT, type ColorTokens, type Scheme, type ShadowTokens, type Theme } from './tokens.ts';
import type { PatternLayers } from './pattern.ts';
import { GRADIENT_FALLBACK_STOPS } from './gradient.ts';
import { GRADIENT_DIRECTION } from './tokens.ts';

/** The per-scheme token groups — the only ones that change with the scheme. */
const SCHEMED = ['color', 'shadow'] as const;
type Schemed = (typeof SCHEMED)[number];

const property = (group: Schemed, key: string) => `--az-${group}-${key}`;

/** The custom property a colour token is declared as — for a value built on other tokens (chat-tint.ts). */
export const colorProperty = (key: string): string => property('color', key);

/** `{ accent: "var(--az-color-accent)", … }` for one group, keys sorted. */
function references<T extends object>(group: Schemed, tokens: T): Record<keyof T, string> {
  const out = {} as Record<keyof T, string>;
  for (const key of Object.keys(tokens).sort() as (keyof T & string)[]) {
    out[key] = `var(${property(group, key)})`;
  }
  return out;
}

/** The one derived colour: see VEIL_PERCENT. Defined once, after the schemes. */
const VEIL = property('color', 'veil');
/** Its value: built on var(), so it follows whichever scheme declares the ground. */
const VEIL_VALUE = `color-mix(in srgb, var(${property('color', 'bg')}) ${VEIL_PERCENT}%, transparent)`;

/** What a word reads for the scheme-dependent groups — the role tokens plus `veil`. */
export function schemeReferences(theme: Theme): { color: ColorTokens & { veil: string }; shadow: ShadowTokens } {
  return {
    color: { ...references('color', theme.color.light), veil: `var(${VEIL})` },
    shadow: references('shadow', theme.shadow.light),
  };
}

/**
 * Every custom property for one scheme, one declaration per line, sorted —
 * or, with `only`, just those colour tokens (and no shadow).
 */
function declarations(theme: Theme, scheme: Scheme, indent: string, only?: ReadonlySet<string>): string {
  const lines: string[] = [];
  for (const group of SCHEMED) {
    if (only && group !== 'color') continue;
    const tokens = theme[group][scheme] as unknown as Record<string, string>;
    for (const key of Object.keys(tokens).sort()) {
      if (only && !only.has(key)) continue;
      lines.push(`${indent}${property(group, key)}: ${tokens[key]};`);
    }
  }
  return lines.join('\n');
}

/** The stylesheet that defines every scheme-dependent token for `theme`. */
export function schemeCss(theme: Theme): string {
  const base: Scheme = theme.defaultScheme ?? 'light';
  const other: Scheme = base === 'light' ? 'dark' : 'light';
  return [
    `/* ${theme.name}: ${base} by default, ${other} on request — theme-spec §3.2 */`,
    `:root {\n${declarations(theme, base, '  ')}\n}`,
    `@media (prefers-color-scheme: ${other}) {\n  :root:not([data-scheme="${base}"]) {\n${declarations(theme, other, '    ')}\n  }\n}`,
    `:root[data-scheme="${other}"] {\n${declarations(theme, other, '  ')}\n}`,
    // §3.2: a transparent body borrows whatever the host paints behind it.
    `body { background: var(${property('color', 'bg')}); color: var(${property('color', 'text')}); }`,
    // scene-spec §6.5: a block over a live backdrop resolves its own surface.
    // Built on var(), so it follows the scheme without a copy per scheme.
    `:root { ${VEIL}: ${VEIL_VALUE}; }`,
  ].join('\n\n') + '\n';
}

/**
 * One scheme of `theme`, declared on `selector` instead of `:root`, so a
 * page can show several themes and both schemes side by side (az palette).
 * The same declarations schemeCss writes, plus the veil; with `only`, just
 * those colour tokens — what an accent or a pair changes over the theme.
 */
export function scopedSchemeCss(theme: Theme, scheme: Scheme, selector: string, only?: readonly (keyof ColorTokens)[]): string {
  if (only) return `${selector} {\n${declarations(theme, scheme, '  ', new Set<string>(only))}\n}\n`;
  return `${selector} {\n${declarations(theme, scheme, '  ')}\n  ${VEIL}: ${VEIL_VALUE};\n}\n`;
}

/** The pattern's three properties (PRD §6.1a), set once per site. */
const PATTERN_PROPERTY = {
  image: '--az-pattern-image',
  size: '--az-pattern-size',
  position: '--az-pattern-position',
} as const;

/** What a word reads to paint the site's pattern: references, never the gradient. */
export const PATTERN_REFERENCES: PatternLayers = {
  image: `var(${PATTERN_PROPERTY.image})`,
  size: `var(${PATTERN_PROPERTY.size})`,
  position: `var(${PATTERN_PROPERTY.position})`,
};

/**
 * The declarations behind PATTERN_REFERENCES, or nothing when the site has no
 * pattern — then no word paints one, so a site without `pattern` is unchanged.
 */
export function patternCss(layers: PatternLayers | null, scope = ':root'): string {
  if (layers === null) return '';
  return [
    '/* theme pattern — PRD §6.1a; ink is the accent token */',
    `${scope} {`,
    `  ${PATTERN_PROPERTY.image}: ${layers.image};`,
    `  ${PATTERN_PROPERTY.position}: ${layers.position};`,
    `  ${PATTERN_PROPERTY.size}: ${layers.size};`,
    '}',
  ].join('\n') + '\n';
}

/** The accent-pair gradients (theme-spec §13): what each runs between, by colour token. */
const GRADIENTS = {
  accent: ['accent', 'accent2'],
  'accent-hover': ['accent-hover', 'accent2-hover'],
} as const;
type GradientName = keyof typeof GRADIENTS;

const gradientProperty = (name: GradientName) => `--az-gradient-${name}`;

/** What a word reads to paint a pair's gradient — references, present only on a pair site. */
export const GRADIENT_REFERENCES: Readonly<Record<GradientName, string>> = {
  accent: `var(${gradientProperty('accent')})`,
  'accent-hover': `var(${gradientProperty('accent-hover')})`,
};

/** One `scope` block declaring every gradient, each built by `build` from its two colour properties. */
function gradientBlock(scope: string, indent: string, build: (from: string, to: string) => string): string {
  const lines = (Object.keys(GRADIENTS) as GradientName[]).map((name) => {
    const [from, to] = GRADIENTS[name];
    return `${indent}  ${gradientProperty(name)}: ${build(`var(${property('color', from)})`, `var(${property('color', to)})`)};`;
  });
  return `${indent}${scope} {\n${lines.join('\n')}\n${indent}}`;
}

/**
 * The declarations behind GRADIENT_REFERENCES, or nothing on a one-hue site
 * — then no word paints a gradient and the site is byte-identical to before.
 *
 * Three tiers, each always valid where it applies, so a var() never turns a
 * background invalid: plain sRGB between the two ends for any engine; a stop
 * list of `color-mix(in oklch, …)` points where color-mix exists; and
 * `linear-gradient(in oklch, …)` where gradients interpolate in OKLCH.
 * gradient.ts proves every floor along all three (theme-spec §13).
 */
export function gradientCss(paired: boolean, scope = ':root'): string {
  if (!paired) return '';
  const stops = (from: string, to: string) => GRADIENT_FALLBACK_STOPS.map((t) => {
    if (t === 0) return from;
    if (t === 1) return to;
    return `color-mix(in oklch, ${from} ${Math.round((1 - t) * 100)}%, ${to})`;
  }).join(', ');
  return [
    '/* theme accent pair — theme-spec §13; OKLCH, else OKLCH stops, else sRGB */',
    gradientBlock(scope, '', (from, to) => `linear-gradient(${GRADIENT_DIRECTION}, ${from}, ${to})`),
    `@supports (color: color-mix(in oklch, transparent, transparent)) {\n${
      gradientBlock(scope, '  ', (from, to) => `linear-gradient(${GRADIENT_DIRECTION}, ${stops(from, to)})`)}\n}`,
    `@supports (background-image: linear-gradient(in oklch, transparent, transparent)) {\n${
      gradientBlock(scope, '  ', (from, to) => `linear-gradient(${GRADIENT_DIRECTION} in oklch, ${from}, ${to})`)}\n}`,
  ].join('\n') + '\n';
}
