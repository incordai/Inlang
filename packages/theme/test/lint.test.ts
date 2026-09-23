/**
 * A7 — "theme compliance is mechanically enforceable".
 *
 * ROADMAP M2 exit criterion: `az lint` fails a deliberately non-compliant
 * word. This is the test that settles the assumption, so the non-compliant
 * word is written out in full rather than reduced to a snippet: a rule that
 * only fires on a contrived one-liner has not been shown to work on source.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSource, formatFindings } from '../src/lint.ts';

/** A word that breaks every rule — the fixture A7 asks for. */
const BAD_WORD = `
import type { BlockNode, EmitContext } from '@az/core';

export function emit(node: BlockNode, ctx: EmitContext) {
  return {
    tag: 'section',
    style: {
      background: '#3b82f6',
      color: rgba(20, 20, 20, 0.8),
      padding: '13px',
      marginTop: '17px',
      fontFamily: 'Helvetica, sans-serif',
      zIndex: 9999,
    },
    children: node.children,
  };
}
`;

/** The same word written correctly — every value through a token. */
const GOOD_WORD = `
import type { BlockNode, EmitContext } from '@az/core';

export function emit(node: BlockNode, ctx: EmitContext) {
  return {
    tag: 'section',
    style: {
      background: ctx.theme.color.surface,
      color: ctx.theme.color.text,
      padding: ctx.theme.space[12],
      marginTop: ctx.theme.space[16],
      fontFamily: ctx.theme.type.body,
      zIndex: ctx.theme.layer.raised,
      borderTop: '1px solid ' + ctx.theme.color.border,
    },
    children: node.children,
  };
}
`;

test('A7: lint FAILS a deliberately non-compliant word', () => {
  const findings = lintSource('words/bad/emit.web.ts', BAD_WORD);
  assert.ok(findings.length > 0, 'the bad word must be rejected');

  const rules = new Set(findings.map((f) => f.rule));
  for (const expected of ['no-hex', 'no-colour-function', 'no-off-scale-px',
                          'no-font-family', 'no-raw-z-index']) {
    assert.ok(rules.has(expected), `rule '${expected}' did not fire\n${formatFindings(findings)}`);
  }
});

test('A7 CONTROL: lint PASSES the same word written correctly', () => {
  // Without this, a lint that rejects everything would satisfy the test above
  // while making the language unusable.
  const findings = lintSource('words/good/emit.web.ts', GOOD_WORD);
  assert.deepEqual(findings, [], formatFindings(findings));
});

test('every finding names a file, a line and a column', () => {
  for (const f of lintSource('words/bad/emit.web.ts', BAD_WORD)) {
    assert.ok(f.line > 0 && f.col > 0, `${f.rule} has no position`);
    assert.equal(f.file, 'words/bad/emit.web.ts');
  }
});

test('every finding names the FIX, not just the problem — CONVENTIONS §5', () => {
  for (const f of lintSource('words/bad/emit.web.ts', BAD_WORD)) {
    assert.match(f.message, /use |e\.g\./,
      `'${f.rule}' complains without naming a fix: ${f.message}`);
  }
});

/* ---------------- the rules individually ---------------- */

test('on-scale px is allowed; off-scale px is not', () => {
  assert.equal(lintSource('f.ts', 'padding: "24px"').length, 0, '24 is on the scale');
  assert.equal(lintSource('f.ts', 'padding: "25px"').length, 1, '25 is not');
});

test('a 1px hairline is allowed', () => {
  // theme-spec §6.1 makes the hairline load-bearing; banning it would force
  // authors into a worse workaround.
  assert.deepEqual(lintSource('f.ts', 'border: "1px solid"'), []);
});

test('color-mix is allowed — it composes tokens rather than naming a colour', () => {
  assert.deepEqual(
    lintSource('f.ts', 'background: colorMix(theme.color.bg, 40)'),
    [],
  );
});

test('comments are not linted', () => {
  assert.deepEqual(lintSource('f.ts', '// avoid #3b82f6 here'), []);
  assert.deepEqual(lintSource('f.ts', ' * padding: 13px is wrong'), []);
});

test('CONTROL: the same value outside a comment IS caught', () => {
  // Otherwise the exemption above could be hiding real violations.
  assert.equal(lintSource('f.ts', 'color: "#3b82f6"').length, 1);
});

test('the theme package itself is exempt by policy, not by accident', () => {
  // theme-spec §4: raw values are legal in packages/theme and nowhere else.
  // The linter does not know that — the CALLER decides which files to lint,
  // and this test records that the boundary is the caller's job so nobody
  // later "fixes" the linter into ignoring hex everywhere.
  const findings = lintSource('packages/theme/src/themes.ts', 'bg: "hsl(230 30% 7%)"');
  assert.equal(findings.length, 1,
    'the rule still fires here; scope is enforced by what the caller lints');
});

test('no-font-family fires on a LITERAL but not on a token', () => {
  // The distinction that made every real emitter fail until it was drawn.
  assert.equal(lintSource('f.ts', "fontFamily: 'Helvetica, sans-serif',").length, 1);
  assert.deepEqual(lintSource('f.ts', 'fontFamily: t.type.display,'), []);
});

/* ---- no-raw-condition: words name conditions, the target writes them ---- */

const CONDITIONAL_WORD = `
export function emit(node, ctx) {
  return {
    tag: 'a',
    style: { color: ctx.theme.color.text },
    css: '@media (max-width: 768px) { a { display: none } }',
    hoverRule: 'a:hover { color: red }',
    reduced: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}
`;

const CONTRACT_WORD = `
export function emit(node, ctx) {
  return {
    tag: 'a',
    style: { color: ctx.theme.color.text },
    below: { sm: { display: 'block' } },
    states: { hover: { color: ctx.theme.color.accent }, focusVisible: { outline: ctx.theme.color.focus } },
    reducedMotion: { transition: 'none' },
  };
}
`;

test('no-raw-condition: media queries, pseudo-classes and matchMedia in a word fail', () => {
  const rules = lintSource('words/x/emit.web.ts', CONDITIONAL_WORD).map((f) => f.rule);
  assert.equal(rules.filter((r) => r === 'no-raw-condition').length, 4, rules.join(', '));
});

test('CONTROL: the same conditions through the contract pass', () => {
  assert.deepEqual(lintSource('words/x/emit.web.ts', CONTRACT_WORD), []);
});

test('the compiler\'s own source may write conditions; the value rules still hold', () => {
  const rules = lintSource('target-web/src/x.ts', CONDITIONAL_WORD, 'package').map((f) => f.rule);
  assert.ok(!rules.includes('no-raw-condition'), rules.join(', '));
  assert.ok(rules.includes('no-off-scale-px'), 'CONTROL: the raw 768px is still a value violation');
  assert.equal(lintSource('target-web/src/x.ts', "color: '#ff0000'", 'package')[0]?.rule, 'no-hex');
});

test('theme-spec §3.4: the literal WebGL colour API outside a three file is refused', () => {
  const css = "import { hex } from './colours.ts';\nexport const bg = hex(document, 'bg');\n";
  const [f] = lintSource('words/bad/emit.web.ts', css);
  assert.equal(f?.rule, 'webgl-colour-outside-scene');
  assert.equal(f?.line, 1);
  assert.equal(lintSource('x.ts', 'const c = theme.value("color.accent");')[0]?.rule, 'webgl-colour-outside-scene');
});

test('CONTROL: the same API in a file that imports three is its intended use', () => {
  const scene = "import * as THREE from 'three';\nimport { hex } from './colours.ts';\nnew THREE.Color(hex(document, 'accent'));\n";
  assert.deepEqual(lintSource('scene-runtime/stage.ts', scene, 'package'), []);
});
