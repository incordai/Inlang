/**
 * @az module stylesheet
 * Purpose: every node style (base, below, states, reducedMotion) → one generated az.css with hashed classes.
 * Spec: docs/ARCHITECTURE.md §4.3
 * Exports: compileStyles, declarations, StyleValueError
 * Edit guide: rule order is fixed (base, breakpoints wide→narrow, states, reduced motion); unsafe values throw.
 * Tests: packages/target-web/test/stylesheet.test.ts
 */

/**
 * Emitted styles to one generated stylesheet.
 *
 * Words describe style as data — a base `style` plus `below`, `states` and
 * `reducedMotion` variants (ARCHITECTURE §4.3). Inline styles cannot express
 * any of those variants, and a stylesheet rule cannot override an inline
 * declaration, so EVERY styled node's declarations move into one generated
 * class and the inline style is removed. One class per node is also what
 * makes sorted output safe: no two generated classes ever style the same
 * element, so rule order cannot change which one wins.
 *
 * Deterministic (CONVENTIONS §6): the class name is a hash of the node's
 * canonical style, rules are sorted, and nothing depends on traversal order.
 */

import {
  BREAKPOINT_NAMES, COMPONENT_TAG, INTERACTION_STATES,
  type BreakpointName, type EmittedNode, type InteractionState, type StyleMap,
} from '../../core/src/emit-contract.ts';

/**
 * Properties React leaves unitless when given a number. Every other numeric
 * value gets `px`, as React's inline styles did, so moving a style into a
 * class changes nothing on screen.
 */
const UNITLESS = new Set([
  'animationIterationCount', 'aspectRatio', 'borderImageOutset', 'borderImageSlice',
  'borderImageWidth', 'boxFlex', 'boxFlexGroup', 'boxOrdinalGroup', 'columnCount', 'columns',
  'flex', 'flexGrow', 'flexPositive', 'flexShrink', 'flexNegative', 'flexOrder', 'gridArea',
  'gridRow', 'gridRowEnd', 'gridRowSpan', 'gridRowStart', 'gridColumn', 'gridColumnEnd',
  'gridColumnSpan', 'gridColumnStart', 'fontWeight', 'lineClamp', 'lineHeight', 'opacity',
  'order', 'orphans', 'scale', 'tabSize', 'widows', 'zIndex', 'zoom', 'fillOpacity',
  'floodOpacity', 'stopOpacity', 'strokeDasharray', 'strokeDashoffset', 'strokeMiterlimit',
  'strokeOpacity', 'strokeWidth',
]);

/**
 * How each state is detected. Fixed order — later states win a conflict, so
 * `disabled` beats `hover` and `current` marks a link whatever else is true.
 * Hover sits inside `(hover: hover)` so a tap does not leave a touch device
 * stuck in the hover style.
 */
const STATE_SELECTOR: Record<InteractionState, (cls: string) => string> = {
  hover: (c) => `${c}:hover`,
  focusVisible: (c) => `${c}:focus-visible`,
  focusWithin: (c) => `${c}:focus-within`,
  active: (c) => `${c}:active`,
  disabled: (c) => `${c}:disabled, ${c}[aria-disabled="true"]`,
  loading: (c) => `${c}[aria-busy="true"]`,
  expanded: (c) => `${c}[aria-expanded="true"]`,
  open: (c) => `${c}[data-state="open"]`,
  scrolled: (c) => `${c}[data-scrolled="true"]`,
  shrunk: (c) => `${c}[data-shrunk="true"]`,
  retracted: (c) => `${c}[data-retracted="true"]`,
  // The page holds a live-or-poster backdrop view (scene-spec §6.5).
  overBackdrop: (c) => `.az-page:has([data-az-3d][data-az-variant="backdrop"]) ${c}`,
  live: (c) => `${c}[data-live="true"]`,
  current: (c) => `${c}[aria-current="page"]`,
};

/** Largest first, so the rule for the narrower screen comes later and wins. */
const BREAKPOINTS_DESCENDING: readonly BreakpointName[] = [...BREAKPOINT_NAMES].reverse();

export class StyleValueError extends Error {}

/**
 * Characters that could end a declaration or a rule, or open a comment.
 * Author text reaches some values (a gallery's `focus`, a `ratio`); in a
 * stylesheet, `red} body{display:none` would be an injection. This is the
 * CSS twin of the `</script>` test, so it refuses rather than escapes: no
 * legitimate token value contains any of these.
 */
const UNSAFE_VALUE = /[{};<>\\]|\/\*|\*\//;
const SAFE_PROPERTY = /^(?:[a-zA-Z]+|--[a-z0-9-]+)$/;

const kebab = (s: string) => (s.startsWith('--') ? s : s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));

function cssValue(property: string, value: string | number): string {
  const text = typeof value === 'number'
    ? (value === 0 || UNITLESS.has(property) || property.startsWith('--') ? String(value) : `${value}px`)
    : value;
  if (UNSAFE_VALUE.test(text) || !balanced(text)) {
    throw new StyleValueError(`style: ${property} value ${JSON.stringify(text)} could break out of its rule`);
  }
  return text;
}

/**
 * Quotes closed and parentheses matched. An open string or `(` makes the CSS
 * parser consume past the `;` and `}` into the following rules — the same
 * injection UNSAFE_VALUE stops, reached without any of its characters.
 */
function balanced(text: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth < 0) return false;
  }
  return quote === null && depth === 0;
}

/** A style map's declarations, sorted, `undefined` and empty dropped. */
export function declarations(style: StyleMap | undefined): [string, string][] {
  if (!style) return [];
  const out: [string, string][] = [];
  for (const key of Object.keys(style).sort()) {
    const value = style[key];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' && typeof value !== 'number') {
      // A nested object would be a state inside a breakpoint, or similar — not
      // expressible in v1, and silently dropping it would lose styling.
      throw new StyleValueError(`style: ${key} must be a string or number, got ${typeof value}`);
    }
    if (!SAFE_PROPERTY.test(key)) throw new StyleValueError(`style: '${key}' is not a CSS property name`);
    out.push([kebab(key), cssValue(key, value)]);
  }
  return out;
}

/** Everything that styles one node, canonical: sorted, empty parts omitted. */
interface Canonical {
  readonly base: [string, string][];
  readonly below: [BreakpointName, [string, string][]][];
  readonly states: [InteractionState, [string, string][]][];
  readonly reducedMotion: [string, string][];
}

function canonical(node: EmittedNode): Canonical | null {
  for (const key of Object.keys(node.below ?? {})) {
    if (!(BREAKPOINT_NAMES as readonly string[]).includes(key)) {
      throw new StyleValueError(`style: '${key}' is not a breakpoint — use ${BREAKPOINT_NAMES.join(', ')}`);
    }
  }
  for (const key of Object.keys(node.states ?? {})) {
    if (!(INTERACTION_STATES as readonly string[]).includes(key)) {
      throw new StyleValueError(`style: '${key}' is not a state — use ${INTERACTION_STATES.join(', ')}`);
    }
  }
  const c: Canonical = {
    base: declarations(node.style),
    below: BREAKPOINT_NAMES
      .map((b) => [b, declarations(node.below?.[b])] as [BreakpointName, [string, string][]])
      .filter(([, d]) => d.length > 0),
    states: INTERACTION_STATES
      .map((s) => [s, declarations(node.states?.[s])] as [InteractionState, [string, string][]])
      .filter(([, d]) => d.length > 0),
    reducedMotion: declarations(node.reducedMotion),
  };
  const empty = c.base.length + c.below.length + c.states.length + c.reducedMotion.length === 0;
  return empty ? null : c;
}

/** FNV-1a, 32-bit, as base36 — short, stable, and no dependency on node:crypto. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * The class for one canonical style: its hash, or — when a DIFFERENT style
 * already holds that hash — the hash salted with a counter until free. The
 * author cannot act on a 32-bit collision, so it is resolved, not reported;
 * the walk order is fixed, so the same site always gets the same names.
 */
function classFor(key: string, rules: ReadonlyMap<string, { key: string }>): string {
  for (let salt = 0; ; salt++) {
    const cls = `az-s-${fnv1a(salt === 0 ? key : `${salt}:${key}`)}`;
    const seen = rules.get(cls);
    if (!seen || seen.key === key) return cls;
  }
}

const block = (selector: string, decls: [string, string][], indent = '') =>
  `${indent}${selector} { ${decls.map(([p, v]) => `${p}: ${v};`).join(' ')} }`;

export interface CompiledStyles<T> {
  /** The input with every styled node given its class and stripped of inline style. */
  readonly value: T;
  /** The generated stylesheet body (no header). Empty when nothing is styled. */
  readonly css: string;
}

/**
 * Move every node's styles into generated classes.
 *
 * `map` walks the caller's structure and hands each root node to `rewrite`,
 * so pages, arrays or single trees all compile through one sheet — one site,
 * one stylesheet, shared by every page.
 */
export function compileStyles<T>(
  input: T,
  map: (input: T, rewrite: (node: EmittedNode) => EmittedNode) => T,
  breakpoint: Readonly<Record<BreakpointName, number>>,
): CompiledStyles<T> {
  const rules = new Map<string, { key: string; c: Canonical }>();

  const rewrite = (node: EmittedNode): EmittedNode => {
    const children = node.children?.map((c) => (typeof c === 'string' ? c : rewrite(c)));
    // A component node is the author's own code: it styles itself.
    if (node.tag === COMPONENT_TAG) return node;
    const c = canonical(node);
    const { style: _style, below: _below, states: _states, reducedMotion: _rm, ...rest } = node;
    if (!c) return { ...rest, ...(children ? { children } : {}) };
    const key = JSON.stringify(c);
    const cls = classFor(key, rules);
    rules.set(cls, { key, c });
    const existing = node.attrs?.class;
    return {
      ...rest,
      attrs: { ...node.attrs, class: existing ? `${existing} ${cls}` : cls },
      ...(children ? { children } : {}),
    };
  };

  const value = map(input, rewrite);
  const names = [...rules.keys()].sort();
  const sel = (cls: string) => `.${cls}`;
  const out: string[] = [];

  for (const cls of names) {
    const { base } = rules.get(cls)!.c;
    if (base.length) out.push(block(sel(cls), base));
  }
  for (const bp of BREAKPOINTS_DESCENDING) {
    const inside = names
      .map((cls) => [cls, rules.get(cls)!.c.below.find(([b]) => b === bp)?.[1]] as const)
      .filter(([, d]) => d)
      .map(([cls, d]) => block(sel(cls), d!, '  '));
    if (inside.length) out.push(`@media (width < ${breakpoint[bp]}px) {\n${inside.join('\n')}\n}`);
  }
  for (const state of INTERACTION_STATES) {
    const lines = names
      .map((cls) => [cls, rules.get(cls)!.c.states.find(([s]) => s === state)?.[1]] as const)
      .filter(([, d]) => d)
      .map(([cls, d]) => block(STATE_SELECTOR[state](sel(cls)), d!, state === 'hover' ? '  ' : ''));
    if (!lines.length) continue;
    out.push(state === 'hover' ? `@media (hover: hover) {\n${lines.join('\n')}\n}` : lines.join('\n'));
  }
  const reduced = names
    .map((cls) => [cls, rules.get(cls)!.c.reducedMotion] as const)
    .filter(([, d]) => d.length)
    .map(([cls, d]) => block(sel(cls), d, '  '));
  if (reduced.length) out.push(`@media (prefers-reduced-motion: reduce) {\n${reduced.join('\n')}\n}`);

  return { value, css: out.length ? `${out.join('\n\n')}\n` : '' };
}
