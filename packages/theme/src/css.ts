/**
 * @az module theme-css
 * Purpose: colour schemes as CSS custom properties: default scheme, OS preference, data-scheme.
 * Spec: docs/theme-spec.md §3
 * Exports: schemeCss, schemeReferences
 * Edit guide: words read var(--az-color-*) references; declarations are generated here only.
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

/** The per-scheme token groups — the only ones that change with the scheme. */
const SCHEMED = ['color', 'shadow'] as const;
type Schemed = (typeof SCHEMED)[number];

const property = (group: Schemed, key: string) => `--az-${group}-${key}`;

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

/** What a word reads for the scheme-dependent groups — the role tokens plus `veil`. */
export function schemeReferences(theme: Theme): { color: ColorTokens & { veil: string }; shadow: ShadowTokens } {
  return {
    color: { ...references('color', theme.color.light), veil: `var(${VEIL})` },
    shadow: references('shadow', theme.shadow.light),
  };
}

/** Every custom property for one scheme, one declaration per line, sorted. */
function declarations(theme: Theme, scheme: Scheme, indent: string): string {
  const lines: string[] = [];
  for (const group of SCHEMED) {
    const tokens = theme[group][scheme] as unknown as Record<string, string>;
    for (const key of Object.keys(tokens).sort()) {
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
    `:root { ${VEIL}: color-mix(in srgb, var(${property('color', 'bg')}) ${VEIL_PERCENT}%, transparent); }`,
  ].join('\n\n') + '\n';
}
