/**
 * Every word ships its docs page and a preview that compiles — CONVENTIONS §3,
 * word-quality-gate §1 item 11.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocksFor, compile, formatDiagnostics, type Manifest } from '../../core/src/index.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');
const words = readdirSync(WORDS).filter((d) => existsSync(join(WORDS, d, 'word.json')));

const manifests = new Map<string, Manifest>();
for (const w of words) {
  const m = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

test('CONTROL: the word list is the eleven blocks', () => {
  assert.equal(words.length, 11);
});

for (const w of words) {
  test(`${w}: README.md links its spec, and preview.az compiles without errors`, () => {
    const readme = join(WORDS, w, 'README.md');
    const preview = join(WORDS, w, 'preview.az');
    assert.ok(existsSync(readme), 'README.md is the docs page');
    assert.ok(existsSync(preview), 'preview.az drives snapshots and thumbnails');
    assert.ok(readFileSync(readme, 'utf8').includes(`docs/${w}-block-spec.md`), 'the spec is the authority');
    const r = compile(readFileSync(preview, 'utf8'), { manifests });
    assert.ok(r.ok, formatDiagnostics(r.diagnostics, `${w}/preview.az`));
    // Through blocksFor, so a site-level nav or footer counts on every page.
    const spec = r.spec;
    assert.ok(spec?.pages.some((p) => blocksFor(spec, p).some((b) => b.word === w)),
      `the preview must actually use ${w}`);
  });
}

/*
 * Extra previews (preview.<name>.az, used by test:visual) compile too. The
 * name is what the preview exists to show: a variant, a modifier, or an enum
 * value the block sets (nav `mobile sheet`) — and the block must really use it.
 */
for (const w of words) {
  for (const f of readdirSync(join(WORDS, w)).filter((f) => /^preview\.[a-z]+\.az$/.test(f))) {
    test(`${w}/${f}: compiles without errors and shows what it is named for`, () => {
      const name = f.split('.')[1];
      const r = compile(readFileSync(join(WORDS, w, f), 'utf8'), { manifests });
      assert.ok(r.ok, formatDiagnostics(r.diagnostics, `${w}/${f}`));
      const spec = r.spec;
      assert.ok(spec?.pages.some((p) => blocksFor(spec, p).some((b) => b.word === w
        && (b.variant === name || b.modifiers.includes(name) || Object.values(b.props).includes(name)))),
        `${f} must render ${w} with ${name}`);
    });
  }
}

/*
 * Each block spec's example manifest shows the word's real themeReads list.
 * `az lint` holds word.json to the code; this holds the spec to word.json.
 */
const SPEC_READS = /^ *"themeReads": (\[[^\]]*\])/gm;

/** The example themeReads lists in a spec, in order. */
function specReads(spec: string): string[][] {
  return [...spec.matchAll(SPEC_READS)].map((m) => JSON.parse(m[1]) as string[]);
}

test('CONTROL: the spec parser finds a list, and a stale one differs from word.json', () => {
  const stale = '```jsonc\n{\n  "themeReads": [\n    "color.text", "space.*"\n  ],\n}\n```\n';
  assert.deepEqual(specReads(stale), [['color.text', 'space.*']]);
  assert.notDeepEqual(specReads(stale)[0], ['color.text']);
  assert.deepEqual(specReads('no manifest here'), []);
});

for (const w of words) {
  test(`${w}: the spec's example themeReads equals word.json's`, () => {
    const spec = readFileSync(join(WORDS, '..', '..', 'docs', `${w}-block-spec.md`), 'utf8');
    const manifest = JSON.parse(readFileSync(join(WORDS, w, 'word.json'), 'utf8')) as { themeReads: string[] };
    const found = specReads(spec);
    assert.equal(found.length, 1, `docs/${w}-block-spec.md shows exactly one themeReads list`);
    assert.deepEqual(found[0], manifest.themeReads);
  });
}
