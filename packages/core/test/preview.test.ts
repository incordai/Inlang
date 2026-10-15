/**
 * `az dev`'s preview of a partial file (docs/partial-preview.md): the longest
 * prefix of whole blocks that compiles. Driven over every truncation of the
 * GRAMMAR §8 fixture, the way an author writing it top to bottom saves it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest, type Spec, type SpecPage } from '../src/index.ts';
import { blockStarts, compilePreview, PREVIEW_ATTEMPTS } from '../src/preview.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const d of readdirSync(wordsDir, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  try {
    const m = JSON.parse(readFileSync(new URL(`${d.name}/word.json`, wordsDir), 'utf8')) as Manifest;
    manifests.set(m.name, m);
  } catch {
    // A folder without a word.json (test/) is not a word.
  }
}
const FIXTURE = readFileSync(new URL('./fixture-site.az', import.meta.url), 'utf8');
const LINES = FIXTURE.split('\n');
const FINAL = compile(FIXTURE, { manifests });

/** The first `n` whole lines of the fixture, as a save after line n. */
const linePrefix = (n: number) => LINES.slice(0, n).join('\n') + '\n';

/** What a preview renders: pages, their blocks, and the inherited site blocks. */
const blocksOf = (spec: Spec) =>
  spec.pages.length + spec.pages.reduce((n, p) => n + p.blocks.length, 0) + spec.site.inherited.length;

/** The spec a save renders: the strict one when it compiles, else the preview's. */
function rendered(source: string): { spec: Spec | null; cutLine: number | null } {
  const r = compilePreview(source, { manifests });
  if (r.strict.ok) return { spec: r.strict.spec, cutLine: null };
  return { spec: r.preview?.result.spec ?? null, cutLine: r.preview?.cutLine ?? null };
}

/** Every rendered block is the complete file's block, value for value — none half-read or guessed. */
function assertWhole(spec: Spec, label: string) {
  assert.ok(FINAL.ok && FINAL.spec, 'CONTROL: the complete fixture compiles');
  const json = (v: unknown) => JSON.stringify(v);
  spec.site.inherited.forEach((b, i) =>
    assert.equal(json(b), json(FINAL.spec!.site.inherited[i]), `${label}: inherited block ${i} is whole`));
  for (const page of spec.pages) {
    const whole: SpecPage | undefined = FINAL.spec!.pages.find((p) => p.route === page.route);
    assert.ok(whole, `${label}: page ${page.route} is in the complete file`);
    const blocks = whole.blocks;
    page.blocks.forEach((b, i) =>
      assert.equal(json(b), json(blocks[i]), `${label}: ${page.route} block ${i} (${b.word}) is whole`));
  }
}

test('every line-prefix of the GRAMMAR fixture: no throw, only whole valid blocks, monotonic growth', () => {
  const starts = new Set(blockStarts(FIXTURE).map((s) => s.line));
  let last = 0;
  let previews = 0;
  for (let n = 1; n <= LINES.length; n++) {
    const source = linePrefix(n);
    const r = compilePreview(source, { manifests });
    // The strict half is exactly what `az build` and `az check` get.
    const plain = compile(source, { manifests });
    assert.deepEqual(r.strict, plain, `line ${n}: the strict compile is the plain compile`);
    if (r.strict.ok) {
      assert.equal(r.preview, null, `line ${n}: a file that compiles is not a preview`);
    } else if (r.preview) {
      previews++;
      assert.ok(r.preview.result.ok, `line ${n}: a preview compiles`);
      assert.ok(source.startsWith(r.preview.source), `line ${n}: a preview is a prefix of the author's text`);
      assert.ok(starts.has(r.preview.cutLine), `line ${n}: the cut is at a block start`);
      assert.ok(r.preview.cutLine <= n, `line ${n}: the cut is inside the file`);
      assert.equal(r.preview.source.split('\n').length, r.preview.cutLine, `line ${n}: the prefix stops before the cut line`);
    }
    const { spec } = rendered(source);
    if (spec) assertWhole(spec, `line ${n}`);
    const count = spec ? blocksOf(spec) : 0;
    assert.ok(count >= last, `line ${n}: ${count} blocks after ${last} — the preview must only grow`);
    last = count;
  }
  assert.ok(previews > 30, `CONTROL: most saves are previews (${previews})`);
  assert.equal(last, blocksOf(FINAL.spec!), 'the last save renders the whole file');
});

test('a save cut mid-line never throws and never renders the cut block', () => {
  for (let n = 1; n < LINES.length; n++) {
    const line = LINES[n];
    if (line.trim().length < 2) continue;
    const source = `${linePrefix(n)}${line.slice(0, Math.ceil(line.length / 2))}`;
    const r = compilePreview(source, { manifests });
    if (!r.preview) continue;
    assert.ok(r.preview.result.ok, `cut in line ${n + 1}: a preview compiles`);
    assert.ok(r.preview.cutLine <= n + 1, `cut in line ${n + 1}: the half line is never rendered`);
    assertWhole(r.preview.result.spec!, `cut in line ${n + 1}`);
  }
});

const PAGE = 'az 1\nsite a\n  footer\n    link "Later" /later\n\npage /\n  hero center\n    title "First"\n';

test('a trailing unfinished block is dropped: missing value, half indent, unterminated string', () => {
  const tails = {
    'a prop with no value': '  text\n    title\n',
    'an indentation half-way': '  text\n   ',
    'an unterminated string': '  text\n    title "Made to be',
    'a word cut off': '  te',
  };
  for (const [label, tail] of Object.entries(tails)) {
    const r = compilePreview(PAGE + tail, { manifests });
    assert.equal(r.strict.ok, false, `CONTROL: ${label} fails the strict compile`);
    assert.ok(r.preview, `${label}: previews`);
    assert.equal(r.preview.cutLine, 9, `${label}: stops before the unfinished block`);
    assert.deepEqual(r.preview.result.spec!.pages[0].blocks.map((b) => b.word), ['hero'], label);
  }
});

test('an error in the middle previews everything before its block, and the strict compile names its line', () => {
  const source = `${PAGE}\n  hero center split\n    title "Broken"\n\n  text\n    title "After"\n    body "Fine."\n`;
  const r = compilePreview(source, { manifests });
  assert.ok(r.strict.diagnostics.some((d) => d.code === 'AZ1202' && d.pos.line === 10), 'the error is reported at its line');
  assert.ok(r.preview);
  assert.equal(r.preview.cutLine, 10);
  assert.deepEqual(r.preview.result.spec!.pages[0].blocks.map((b) => b.word), ['hero'],
    'the valid block AFTER the error is not rendered either: only a prefix renders');
});

test('a link to a page not written yet does not stop the preview, and the strict compile still refuses it', () => {
  const source = `${PAGE}\n  text\n    title "Second"\n    body "Fine."\n`;
  const strict = compile(source, { manifests });
  assert.ok(strict.diagnostics.some((d) => d.code === 'AZ2081'), 'CONTROL: az build refuses the forward link');
  const r = compilePreview(source, { manifests });
  assert.ok(r.preview, 'the preview opens the routes');
  assert.ok(r.preview.result.ok);
  // The last block is never a cut's: it may still be being written.
  assert.deepEqual(r.preview.result.spec!.pages[0].blocks.map((b) => b.word), ['hero']);
  assert.equal(compile(r.preview.source, { manifests }).ok, false, 'CONTROL: without open routes the prefix fails');
});

test('a complete file is not a preview', () => {
  const r = compilePreview(FIXTURE, { manifests });
  assert.equal(r.strict.ok, true);
  assert.equal(r.preview, null);
});

test('no page yet, or a broken site, has no preview', () => {
  assert.equal(compilePreview(linePrefix(29), { manifests }).preview, null, 'the site alone renders nothing');
  const r = compilePreview(FIXTURE.replace('theme midnight', 'theme nonsense'), { manifests });
  assert.equal(r.strict.ok, false);
  assert.equal(r.preview, null, 'every page comes after the broken site block');
});

test('an error early in a long file still previews, in a bounded number of compiles', () => {
  const sections = Array.from({ length: PREVIEW_ATTEMPTS * 3 }, (_, i) => `  text\n    title "S${i}"\n    body "B${i}"\n`).join('');
  const source = `az 1\nsite a\npage /\n  hero center\n    title "First"\n  hero center split\n    title "Broken"\n${sections}`;
  const started = performance.now();
  const r = compilePreview(source, { manifests });
  const ms = performance.now() - started;
  assert.ok(r.preview, 'the search starts at the error, not at the end');
  assert.equal(r.preview.cutLine, 6);
  assert.ok(ms < 5_000, `bounded: ${ms.toFixed(0)}ms`);
});

test('block starts: column 0 and one indent in; never blank, comment, deeper or CRLF-blank lines', () => {
  const source = 'az 1\r\n\r\n# note\r\nsite a\r\n  nav bar\r\n    link "W" /w\r\n   odd\r\npage /\r\n';
  assert.deepEqual(blockStarts(source).map((s) => s.line), [4, 5, 8]);
  for (const s of blockStarts(source)) assert.ok(/^[ a-z]/.test(source.slice(s.offset)), 'an offset is a line start');
});
