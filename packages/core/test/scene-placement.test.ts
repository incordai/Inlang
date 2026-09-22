/**
 * Only `scene backdrop` is inherited and placed like nav — scene-spec §6.
 * `scene inline` and `scene full` are page content, in the order written.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { blocksFor, compile, formatDiagnostics, type Manifest } from '../src/index.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  const file = new URL(`${n}/word.json`, wordsDir);
  if (!existsSync(file)) continue;
  const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

const SCENE = (variant: string) =>
  `  scene ${variant} 3d\n    poster ./p.webp\n    alt "A shoe"\n`;

function order(src: string) {
  const r = compile(src, { manifests });
  assert.ok(r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  return blocksFor(r.spec, r.spec.pages[0]).map((b) => `${b.word}${b.variant ? ' ' + b.variant : ''}`);
}

test('an inline scene stays where the page wrote it', () => {
  const src = `az 1\nsite a\npage /\n  hero split\n    title "x"\n${SCENE('inline')}`;
  assert.deepEqual(order(src), ['hero split', 'scene inline']);
});

test('a page-level inline scene does not replace the inherited backdrop', () => {
  const src = `az 1\nsite a\n  scene backdrop 3d\n    poster ./b.webp\n    alt "Fog"\npage /\n  hero split\n    title "x"\n${SCENE('inline')}`;
  assert.deepEqual(order(src), ['scene backdrop', 'hero split', 'scene inline']);
});

test('CONTROL: `scene none` still opts a page out of the backdrop', () => {
  const src = `az 1\nsite a\n  scene backdrop 3d\n    poster ./b.webp\n    alt "Fog"\npage /\n  scene none\n  hero split\n    title "x"\n`;
  assert.deepEqual(order(src), ['hero split']);
});
