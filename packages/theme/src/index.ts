/**
 * @az module theme
 * Purpose: the theme package's public surface.
 * Spec: docs/theme-spec.md
 * Exports: (re-exports tokens, themes, lint, css, colour maths, accents, ramps, patterns, gradients and chart series)
 * Edit guide: add a file here only if words or targets need it.
 * Tests: packages/theme/test/css.test.ts
 */

/** The theme package's public surface. */
export * from './tokens.ts';
export * from './themes.ts';
export * from './lint.ts';
export * from './css.ts';
export * from './color.ts';
export * from './ramps.ts';
export * from './accent.ts';
export * from './pattern.ts';
export * from './gradient.ts';
export * from './series.ts';
