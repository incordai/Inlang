/**
 * The web target's 3D wiring — scene-spec §5, hero-spec §8.
 *
 * A 3D site gets the dependency, the canvas rule and a lazily loading entry;
 * a site without a 3D view gets none of it, byte for byte.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, formatDiagnostics, type Manifest } from '../../core/src/index.ts';
import { emitProject, PathEscapeError, PINS } from '../src/emit.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}

function project(src: string) {
  const r = compile(src, { manifests });
  assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
  return emitProject(r.spec, { emitters: WEB_EMITTERS });
}
const file = (p: ReturnType<typeof project>, path: string) => p.files.find((f) => f.path === path)?.content ?? '';

const THREE_D = (site = 'aurora') => `az 1\nsite ${site}\npage /\n  hero split 3d scroll\n    title "Grown"\n    describe "Strands"\n` +
  `  text prose\n    title "Between"\n    body "Copy."\n  scene inline 3d\n    poster ./p.webp\n    alt "A turn"\n    camera orbit\n`;
const FLAT = 'az 1\nsite aurora\npage /\n  hero split\n    title "Grown"\n';

test('a 3D site depends on three at the verified pin, and knows it is 3D', () => {
  const p = project(THREE_D());
  assert.equal(p.three, true);
  assert.equal(JSON.parse(file(p, 'package.json')).dependencies.three, PINS.three);
});

test('the entry paints the page first, then loads 3D only through the gate', () => {
  const main = file(project(THREE_D()), 'src/main.tsx');
  // Pre-rendered markup is already painted; without it, a synchronous render.
  assert.match(main, /el\.firstElementChild\s*\? hydrateRoot\(el, app\)\s*: flushSync\(\(\) => createRoot\(el\)\.render\(app\)\)/);
  // The gate decides once the page has a view — at once, or when a
  // protected page's content renders after its session check.
  assert.match(main, /whenViews\(document, \(\) => \{\n  const start = decide3d\(window\);\n  if \(!start\) return;\n  import\("\.\/az3d\/index\.ts"\)/);
  assert.doesNotMatch(main, /import .* from "\.\/az3d\/index\.ts"/, 'the 3D chunk is never a static import');
});

test('§6.1: the canvas sits under every block and never takes the pointer', () => {
  const css = file(project(THREE_D()), 'src/theme.css');
  assert.match(css, /\.az-3d-canvas \{ position: fixed; inset: 0;[^}]*z-index: -1; pointer-events: none; \}/);
});

test('§11.1: each view has its seed — stable per build, different per view, owned by the site', () => {
  const seeds = (p: ReturnType<typeof project>) => [...file(p, 'src/App.tsx').matchAll(/"data-az-seed": "(\d+)"/g)].map((m) => m[1]);
  const a = seeds(project(THREE_D()));
  assert.equal(a.length, 2);
  assert.notEqual(a[0], a[1], 'two views on one page grow different scenes');
  assert.deepEqual(seeds(project(THREE_D())), a, 'the same site grows the same scenes');
  assert.notDeepEqual(seeds(project(THREE_D('northfield'))), a, 'CONTROL: another site grows others');
});

test('a site without a 3D view carries none of it', () => {
  const p = project(FLAT);
  assert.equal(p.three, false);
  assert.equal(JSON.parse(file(p, 'package.json')).dependencies.three, undefined);
  assert.doesNotMatch(file(p, 'src/main.tsx'), /az3d|flushSync/);
  assert.doesNotMatch(file(p, 'src/theme.css'), /az-3d-canvas/);
  assert.ok(!p.files.some((f) => f.path.includes('az3d')));
});

test('SECURITY: a model path cannot leave the project', () => {
  const r = compile('az 1\nsite a\npage /\n  hero split 3d\n    title "x"\n    model ./ok.glb\n', { manifests });
  assert.ok(r.spec);
  const spec = { ...r.spec, pages: r.spec.pages.map((pg) => ({ ...pg, blocks: pg.blocks.map((b) =>
    b.word === 'hero' ? { ...b, props: { ...b.props, model: '../../../etc/shoe.glb' } } : b) })) };
  assert.throws(() => emitProject(spec, { emitters: WEB_EMITTERS }), PathEscapeError);
});
