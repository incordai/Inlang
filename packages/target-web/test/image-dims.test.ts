/**
 * Image width/height at build — gallery-block-spec §7 rule 1, for every word
 * that ships an <img> through the asset sandbox.
 *
 * The emitted tree is checked directly (sizeImages) and through a whole
 * build (emitProject with a reader): the attributes appear with a reader and
 * are absent without one, an unreadable file is a warning and no attribute,
 * and an img whose CSS fixes only its height is not stretched by them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emitProject } from '../src/emit.ts';
import { imageSizes, sizeImages } from '../src/image-dims.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';
import type { EmittedNode } from '../../core/src/emit-contract.ts';

/** A PNG header for w×h: signature, IHDR length and type, then the size. */
function png(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(b);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

const walk = (n: EmittedNode | string): EmittedNode[] =>
  typeof n === 'string' ? [] : [n, ...(n.children ?? []).flatMap(walk)];

/* ---- the tree ---------------------------------------------------------------- */

test('an img the sandbox resolved gets its width and height; others are left alone', () => {
  const sizeOf = (src: string) => (src === '/assets/a.png' ? { width: 640, height: 427 } : null);
  const tree: EmittedNode = {
    tag: 'figure',
    children: [
      { tag: 'img', attrs: { src: '/assets/a.png', alt: '' }, style: { width: '100%', height: 'auto' } },
      { tag: 'img', attrs: { src: '{row.photo}', alt: '' } },
      'caption',
    ],
  };
  const [, sized, unknown] = walk(sizeImages(tree, sizeOf));
  assert.deepEqual(sized.attrs, { src: '/assets/a.png', alt: '', width: '640', height: '427' });
  assert.deepEqual(sized.style, { width: '100%', height: 'auto' }, 'the style is not touched when CSS sets the width');
  assert.deepEqual(unknown.attrs, { src: '{row.photo}', alt: '' });
});

test('an img whose CSS fixes only its height gets width auto, or the attribute would stretch it', () => {
  const sizeOf = () => ({ width: 400, height: 100 });
  const logo = (style: EmittedNode['style'], extra: Partial<EmittedNode> = {}) =>
    sizeImages({ tag: 'img', attrs: { src: '/l.svg', alt: '' }, style, ...extra }, sizeOf);
  assert.equal(logo({ display: 'block', height: '32px' }).style?.width, 'auto');
  assert.equal(logo({ maxHeight: '60vh' }).style?.width, 'auto');
  assert.equal(logo({ display: 'block' }, { states: { shrunk: { height: '24px' } } }).style?.width, 'auto', 'a state height counts');
  assert.equal(logo({ display: 'block', height: 'auto' }).style?.width, undefined, 'CONTROL: height auto keeps the ratio by itself');
  assert.equal(logo({ width: '100%', height: '100%' }).style?.width, '100%', 'CONTROL: CSS sets both — nothing added');
});

test('an author\'s own width or height is never replaced', () => {
  const out = sizeImages({ tag: 'img', attrs: { src: '/a.png', width: '10' } }, () => ({ width: 640, height: 427 }));
  assert.deepEqual(out.attrs, { src: '/a.png', width: '10' });
});

test('imageSizes: one read per file; unreadable is a warning, missing is not', () => {
  const reads: string[] = [];
  const files: Record<string, Uint8Array> = { 'a.png': png(64, 32), 'b.bin': Buffer.from('not an image'), 'c.svg': Buffer.from('<svg/>') };
  const warnings: string[] = [];
  const srcs = new Map([['/a.png', 'a.png'], ['/b.bin', 'b.bin'], ['/c.svg', 'c.svg'], ['/gone.png', 'gone.png']]);
  const sizeOf = imageSizes((p) => { reads.push(p); return files[p] ?? null; }, srcs, warnings)!;
  assert.deepEqual(sizeOf('/a.png'), { width: 64, height: 32 });
  assert.deepEqual(sizeOf('/a.png'), { width: 64, height: 32 });
  assert.equal(sizeOf('/b.bin'), null);
  assert.equal(sizeOf('/c.svg'), null);
  assert.equal(sizeOf('/gone.png'), null);
  assert.equal(sizeOf('/never-resolved.png'), null);
  assert.deepEqual(reads, ['a.png', 'b.bin', 'c.svg', 'gone.png']);
  assert.deepEqual(warnings, [
    "image: can't read the size of './b.bin' — the page will shift as it loads; export it as WebP, AVIF, JPEG, PNG or GIF",
    "image: './c.svg' has no size the browser can use — give its <svg> a viewBox, or width and height in px",
  ]);
  assert.equal(imageSizes(undefined, srcs, warnings), undefined, 'no reader, no sizing');
});

/* ---- a whole build -------------------------------------------------------------- */

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}

const SOURCE = `az 1
site "Bench"

page /
  nav bar
    logo ./assets/logo.png
  gallery grid
    columns 2
    ratio 3:2
    image ./assets/one.png
      alt "One"
    image ./assets/two.png
      alt "Two"
  feature rows
    item "Oak"
      media ./assets/one.png
      body "Forty pairs a month."
    item "Ash"
      media ./assets/two.png
      body "Each by hand."
`;

function build(readBytes?: (path: string) => Uint8Array | null) {
  const r = compile(SOURCE, { manifests });
  assert.ok(r.spec, r.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  const p = emitProject(r.spec, { emitters: WEB_EMITTERS, readBytes });
  return { ...p, app: p.files.find((f) => f.path === 'src/App.tsx')!.content };
}

/** Every emitted element with a `src` in App.tsx (here only <img>) as { src, width, height }. */
function imgs(app: string): { src: string; width?: string; height?: string }[] {
  const out: { src: string; width?: string; height?: string }[] = [];
  for (const m of app.matchAll(/"attrs": ?(\{[^{}]*\})/g)) {
    const a = JSON.parse(m[1]) as Record<string, string>;
    if (a.src !== undefined) out.push({ src: a.src, width: a.width, height: a.height });
  }
  return out;
}

test('build: every sandboxed <img> carries its file\'s width and height', () => {
  const sizes: Record<string, Uint8Array> = {
    'assets/logo.png': png(240, 64), 'assets/one.png': png(1200, 800), 'assets/two.png': png(800, 1200),
  };
  const read: string[] = [];
  const p = build((path) => { read.push(path); return sizes[path] ?? null; });
  const found = imgs(p.app);
  assert.ok(found.length >= 5, JSON.stringify(found));
  for (const img of found) {
    const want = { '/assets/logo.png': ['240', '64'], '/assets/one.png': ['1200', '800'], '/assets/two.png': ['800', '1200'] }[img.src];
    assert.ok(want, `unexpected src ${img.src}`);
    assert.deepEqual([img.width, img.height], want, img.src);
  }
  assert.deepEqual([...read].sort(), ['assets/logo.png', 'assets/one.png', 'assets/two.png'], 'each file read once');
  assert.deepEqual(p.warnings, []);
});

test('CONTROL: without a reader no img has a width or height (the old output)', () => {
  for (const img of imgs(build().app)) assert.deepEqual([img.width, img.height], [undefined, undefined], img.src);
});

test('build: a file the reader cannot size ships without them, and says so', () => {
  const p = build((path) => (path === 'assets/two.png' ? Buffer.from('GIF89a') : png(10, 10)));
  assert.ok(imgs(p.app).filter((i) => i.src === '/assets/two.png').every((i) => i.width === undefined));
  assert.deepEqual(p.warnings, ["image: can't read the size of './assets/two.png' — the page will shift as it loads; export it as WebP, AVIF, JPEG, PNG or GIF"]);
});
