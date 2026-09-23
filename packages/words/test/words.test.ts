/**
 * The word gate — CONVENTIONS §3 and word-quality-gate §1.
 *
 * The first assertion is the one that matters: the emitters I wrote must pass
 * the lint I wrote. A7 is only settled if the rule holds against real source,
 * not against a contrived fixture — a linter that passes its own test file and
 * fails every real word would be worthless.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSource, formatFindings } from '../../theme/src/lint.ts';
import { resolve, THEMES } from '../../theme/src/index.ts';
import type { SpecBlock } from '../../core/src/spec.ts';
import type { EmitContext, EmittedNode } from '../../core/src/emit-contract.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');

const wordDirs = readdirSync(WORDS).filter((d) =>
  statSync(join(WORDS, d)).isDirectory() && existsSync(join(WORDS, d, 'word.json')));

const withEmitter = wordDirs.filter((d) => existsSync(join(WORDS, d, 'emit.web.ts')));

test('CONTROL: words and emitters were actually found', () => {
  // An empty list would make every check below pass on nothing.
  assert.equal(wordDirs.length, 11, wordDirs.join(','));
  assert.ok(withEmitter.length > 0, 'no emitters found to lint');
});

test('A7 IN PRACTICE: every real emitter passes the theme lint', () => {
  const problems: string[] = [];
  for (const w of withEmitter) {
    const file = join(WORDS, w, 'emit.web.ts');
    const findings = lintSource(`words/${w}/emit.web.ts`, readFileSync(file, 'utf8'));
    if (findings.length) problems.push(formatFindings(findings));
  }
  assert.deepEqual(problems, [], '\n' + problems.join('\n'));
});

test('every manifest names itself correctly — the graph is built from it', () => {
  for (const w of wordDirs) {
    const m = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8')) as { name: string };
    assert.equal(m.name, w, `${w}/word.json declares name '${m.name}'`);
  }
});

/* ---------------- the emitters actually run ---------------- */

function context(): EmitContext {
  const t = resolve(THEMES.midnight, 'dark');
  return {
    theme: {
      color: t.color as unknown as Record<string, string>,
      size: t.size as unknown as Record<string, number>,
      type: t.type as unknown as Record<string, string | number>,
      radius: t.radius as unknown as Record<string, number>,
      shadow: t.shadow as unknown as Record<string, string>,
      space: t.space as unknown as Record<string, number>,
      motion: t.motion as unknown as Record<string, string | number>,
      layer: t.layer as unknown as Record<string, number>,
      breakpoint: t.breakpoint,
      typeSize: t.typeSize as unknown as Record<string, string>,
    },
    target: 'web',
    site: { name: 'aurora' },
    slot: () => [],
    asset: (p) => p,
  };
}

const blockOf = (over: Partial<SpecBlock> = {}): SpecBlock => ({
  word: 'hero', variant: null, modifiers: [], args: [], props: {},
  as: null, children: [], ...over,
});

/** Walk every style value in an emitted tree. */
function styleValues(node: EmittedNode): string[] {
  const out: string[] = [];
  const walk = (n: EmittedNode | string) => {
    if (typeof n === 'string') return;
    for (const v of Object.values(n.style ?? {})) out.push(String(v));
    for (const c of n.children ?? []) walk(c);
  };
  walk(node);
  return out;
}

test('emitted style values contain no raw colours or off-scale px', async () => {
  // The lint checks SOURCE. This checks the OUTPUT — a word could compute a
  // bad value at runtime from legal-looking source, and only this would see it.
  const { emit } = await import('../hero/emit.web.ts');
  const node = emit(blockOf({
    props: { title: 'Built in the dark', sub: 'Handmade.', eyebrow: 'Limited run', height: 'peek' },
  }), context());

  for (const v of styleValues(node)) {
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(v), `raw hex in output: ${v}`);
    const m = v.match(/\b(\d+)px\b/);
    if (m) {
      const n = Number(m[1]);
      assert.ok([0, 1, 4, 8, 12, 16, 24, 32, 48, 64, 96, 128].includes(n),
        `off-scale px in output: ${v}`);
    }
  }
});

test('hero honours the height WORD, and the emitter supplies the unit', async () => {
  const { emit } = await import('../hero/emit.web.ts');
  const ctx = context();
  const peek = emit(blockOf({ props: { title: 'x', height: 'peek' } }), ctx);
  const tall = emit(blockOf({ props: { title: 'x', height: 'tall' } }), ctx);
  assert.equal(peek.style!.minHeight, '85svh', 'svh, not vh — hero-spec §6');
  assert.equal(tall.style!.minHeight, '92svh');
  assert.notEqual(peek.style!.minHeight, tall.style!.minHeight, 'the word must matter');
});

test('the measure is on the TEXT, not the container — hero-spec §3', async () => {
  const { emit } = await import('../hero/emit.web.ts');
  const node = emit(blockOf({ props: { title: 'x', sub: 'y' } }), context());
  assert.equal(node.style!.maxWidth, undefined, 'the container must NOT carry a measure');
  const title = node.children!.find((c) => typeof c !== 'string' && c.tag === 'h1') as EmittedNode;
  const sub = node.children!.find((c) => typeof c !== 'string' && c.tag === 'p' && c.attrs?.class === 'az-hero-sub') as EmittedNode;
  assert.match(String(title.style!.maxWidth), /ch$/, 'the headline carries its own measure');
  assert.match(String(sub.style!.maxWidth), /ch$/, 'and so does the sub');
  assert.notEqual(title.style!.maxWidth, sub.style!.maxWidth,
    'display and body measures differ — 20–28ch vs 45–65ch');
});

test('the eyebrow is NOT a heading — hero-spec §4', async () => {
  const { emit } = await import('../hero/emit.web.ts');
  const node = emit(blockOf({ props: { title: 'x', eyebrow: 'Limited run' } }), context());
  const eyebrow = node.children!.find(
    (c) => typeof c !== 'string' && c.attrs?.class === 'az-hero-eyebrow') as EmittedNode;
  assert.equal(eyebrow.tag, 'p', 'an eyebrow marked as a heading breaks the outline');
});

test('text emitter runs and stays inside the token set', async () => {
  const { emit } = await import('../text/emit.web.ts');
  const node = emit(blockOf({ word: 'text', variant: 'prose', props: { title: 'T', body: 'B' } }), context());
  assert.equal(node.tag, 'section');
  for (const v of styleValues(node)) {
    assert.ok(!/#[0-9a-fA-F]{3,6}\b/.test(v), `raw hex: ${v}`);
  }
});
