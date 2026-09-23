/**
 * Emitted styles become one generated stylesheet — ARCHITECTURE §4.3.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compileStyles, StyleValueError } from '../src/stylesheet.ts';
import { emit } from '../src/emit.ts';
import { compile, type Manifest } from '../../core/src/index.ts';
import { COMPONENT_TAG, type EmittedNode } from '../../core/src/emit-contract.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const BP = { xs: 480, sm: 768, md: 1024, lg: 1440 } as const;
const one = (node: EmittedNode) => compileStyles([node], (ns, rw) => ns.map(rw), BP);
const cls = (n: EmittedNode) => n.attrs?.class?.split(' ').find((c) => c.startsWith('az-s-'));

test('a styled node gets a class and loses its inline style', () => {
  const { value: [out], css } = one({ tag: 'p', attrs: { class: 'az-x' }, style: { color: 'var(--az-color-text)' } });
  assert.equal(out.style, undefined);
  assert.match(out.attrs?.class ?? '', /^az-x az-s-[0-9a-z]+$/, 'the word\'s own class stays first');
  assert.ok(css.includes(`.${cls(out)} { color: var(--az-color-text); }`), css);
});

test('CONTROL: an unstyled node and a component node are left alone', () => {
  const { value: [plain], css } = one({ tag: 'p', children: ['x'] });
  assert.deepEqual(plain, { tag: 'p', children: ['x'] });
  assert.equal(css, '');
  const component: EmittedNode = { tag: COMPONENT_TAG, attrs: { src: 'a.tsx' } };
  assert.deepEqual(one(component).value[0], component);
});

test('numbers get px exactly where React would add it', () => {
  const { css } = one({ tag: 'p', style: { zIndex: 700, lineHeight: 1.2, opacity: 0.5, gap: 16, margin: 0, fontWeight: 600 } });
  assert.match(css, /gap: 16px;/);
  assert.match(css, /margin: 0;/);
  assert.match(css, /z-index: 700;/);
  assert.match(css, /line-height: 1\.2;/);
  assert.match(css, /opacity: 0\.5;/);
  assert.match(css, /font-weight: 600;/);
});

test('identical styles share one class; different styles do not', () => {
  const s = { color: 'var(--az-color-text)', margin: 0 };
  const nodes: EmittedNode[] = [
    { tag: 'p', style: s },
    { tag: 'span', style: { margin: 0, color: 'var(--az-color-text)' } },
    { tag: 'p', style: { margin: '4px' } },
  ];
  const { value } = compileStyles(nodes, (ns, rw) => ns.map(rw), BP);
  assert.equal(cls(value[0]), cls(value[1]), 'key order does not matter');
  assert.notEqual(cls(value[0]), cls(value[2]));
});

test('many distinct styles never share a class', () => {
  const nodes = Array.from({ length: 3000 }, (_, i): EmittedNode => ({ tag: 'p', style: { marginTop: `${i}px` } }));
  const { value } = compileStyles(nodes, (ns, rw) => ns.map(rw), BP);
  assert.equal(new Set(value.map(cls)).size, 3000);
});

test('below: one media block per breakpoint, widest first, so the narrower wins', () => {
  const { css } = one({ tag: 'div', style: { display: 'grid' }, below: { sm: { display: 'block' }, lg: { gap: '8px' } } });
  const lg = css.indexOf('@media (width < 1440px)');
  const sm = css.indexOf('@media (width < 768px)');
  assert.ok(lg > 0 && sm > lg, css);
  assert.ok(css.indexOf('display: grid') < lg, 'base rules come first');
});

test('states: fixed order, hover only where hover exists, disabled by attribute too', () => {
  const { value: [n], css } = one({ tag: 'a', style: { color: 'x' }, states: {
    current: { color: 'c' }, hover: { color: 'h' }, focusVisible: { outline: '2px solid x' }, disabled: { opacity: 0.5 },
  } });
  const c = `.${cls(n)}`;
  assert.ok(css.includes(`@media (hover: hover) {\n  ${c}:hover { color: h; }\n}`), css);
  assert.ok(css.includes(`${c}:focus-visible { outline: 2px solid x; }`));
  assert.ok(css.includes(`${c}:disabled, ${c}[aria-disabled="true"] { opacity: 0.5; }`));
  const order = ['(hover: hover)', ':focus-visible', ':disabled', 'aria-current'].map((s) => css.indexOf(s));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'hover, focus, disabled, current');
});

test('reduced motion comes last', () => {
  const { css } = one({ tag: 'p', style: { transition: 'transform 200ms' }, states: { hover: { color: 'h' } },
    reducedMotion: { transition: 'none' } });
  assert.ok(css.lastIndexOf('@media (prefers-reduced-motion: reduce)') > css.indexOf('(hover: hover)'));
});

test('only the contract\'s breakpoints and states exist', () => {
  assert.throws(() => one({ tag: 'p', below: { phone: { color: 'x' } } as never }), StyleValueError);
  assert.throws(() => one({ tag: 'p', states: { visited: { color: 'x' } } as never }), StyleValueError);
  // A nested object would be a state inside a breakpoint: not expressible in v1.
  assert.throws(() => one({ tag: 'p', below: { sm: { hover: { color: 'x' } } } as never }), StyleValueError);
});

test('SECURITY: a value cannot break out of its rule', () => {
  for (const hostile of ['red} body { display: none', 'top; background: url(x)', '1px /* x', 'a</style><script>', 'x\\7d']) {
    assert.throws(() => one({ tag: 'img', style: { objectPosition: hostile } }), StyleValueError, hostile);
  }
  assert.throws(() => one({ tag: 'p', style: { 'color}body{x': 'red' } }), StyleValueError);
  assert.doesNotThrow(() => one({ tag: 'img', style: { objectPosition: 'top', aspectRatio: '3 / 2' } }), 'CONTROL');
});

test('DETERMINISM: the same trees give the same bytes', () => {
  const tree: EmittedNode = { tag: 'div', style: { b: '1', a: '2' }, below: { sm: { a: '3' } }, children: [{ tag: 'p', style: { c: '4' } }] };
  assert.equal(one(tree).css, one(structuredClone(tree)).css);
});

/* ---- wired into the web target ------------------------------------------- */

const manifests = new Map<string, Manifest>();
const wordsDir = new URL('../../words/', import.meta.url);
for (const n of readdirSync(wordsDir)) {
  try {
    const m = JSON.parse(readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8')) as Manifest;
    manifests.set(m.name, m);
  } catch { /* not a word */ }
}

test('the project ships az.css, main imports it, and no page carries inline style', () => {
  const files = emit(compile('az 1\nsite aurora\npage /\n  hero split\n    title "Built in the dark"\n', { manifests }).spec!,
    { emitters: WEB_EMITTERS });
  const file = (p: string) => files.find((f) => f.path === p)!.content;
  assert.match(file('src/az.css'), /^\/\* GENERATED BY AZ/);
  assert.match(file('src/az.css'), /\.az-s-[0-9a-z]+ \{ /);
  assert.match(file('src/main.tsx'), /import "\.\/theme\.css";\nimport "\.\/az\.css";/);
  assert.doesNotMatch(file('src/App.tsx'), /"style":/, 'styles live in az.css, not inline');
});

test('SECURITY: an unbalanced quote or parenthesis cannot swallow the next rule', () => {
  // An open string or `(` runs on past the `;` into the rest of az.css.
  for (const value of ['"Inter, sans', "'x", 'calc(1px + 2px', 'url(a', 'a)b']) {
    assert.throws(() => one({ tag: 'p', style: { fontFamily: value } }), StyleValueError, value);
  }
});

test('CONTROL: balanced quotes and parentheses pass', () => {
  const { css } = one({ tag: 'p', style: { fontFamily: '"Inter", \'Geist\', system-ui', width: 'min(calc(100% - 2rem), 40ch)' } });
  assert.match(css, /font-family: "Inter", 'Geist', system-ui;/);
  assert.match(css, /width: min\(calc\(100% - 2rem\), 40ch\);/);
});

test('a hash collision between two styles gets a distinct class, never an error', () => {
  // These two canonical style keys share an FNV-1a hash (found by search):
  // the author can do nothing about a collision, so the compiler resolves it.
  const pair = (): EmittedNode[] => [{ tag: 'p', style: { width: 'v447599' } }, { tag: 'p', style: { width: 'v1048144' } }];
  const { value: [a, b], css } = compileStyles(pair(), (ns, rw) => ns.map(rw), BP);
  assert.notEqual(cls(a), cls(b));
  assert.ok(css.includes(`.${cls(a)} { width: v447599; }`), css);
  assert.ok(css.includes(`.${cls(b)} { width: v1048144; }`), css);
  // Deterministic: the same input gives the same names.
  const again = compileStyles(pair(), (ns, rw) => ns.map(rw), BP);
  assert.deepEqual(again.value.map(cls), [cls(a), cls(b)]);
});
