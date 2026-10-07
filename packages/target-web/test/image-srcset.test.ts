/**
 * Responsive images — gallery-block-spec §7 rule 3, the target's half.
 *
 * The target decides the widths (never upscaling), writes `srcset` beside
 * the `sizes` a word gave, and removes that `sizes` whenever there is no
 * srcset — so with no resizer (the playground, these tests) a page is what
 * it was before the rule. The resizer here is a fake: the CLI's real one is
 * tested in packages/cli/test/images.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { emitProject } from '../src/emit.ts';
import { SRCSET_WIDTHS, srcsetImages, srcsetWidths, type Resize } from '../src/image-srcset.ts';
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

/** A resizer that names each width after the file, and records what it was asked. */
function fakeResize(asked: [string, readonly number[]][] = []): Resize {
  return (path, widths) => {
    asked.push([path, widths]);
    return widths.map((width) => ({ url: `/az-img/${path.replace(/\W/g, '_')}-${width}.webp`, width }));
  };
}

/* ---- the widths ------------------------------------------------------------- */

test('the fixed widths are the spec\'s four', () => {
  assert.deepEqual(SRCSET_WIDTHS, [480, 768, 1200, 1800]);
});

test('never upscaled: only widths narrower than the original are asked for', () => {
  assert.deepEqual(srcsetWidths(2400), [480, 768, 1200, 1800]);
  assert.deepEqual(srcsetWidths(1800), [480, 768, 1200], 'a width equal to the original is the original');
  assert.deepEqual(srcsetWidths(1000), [480, 768]);
  assert.deepEqual(srcsetWidths(481), [480]);
  assert.deepEqual(srcsetWidths(480), []);
  assert.deepEqual(srcsetWidths(64), []);
});

/* ---- the tree ---------------------------------------------------------------- */

const SIZES = '(width < 768px) 50vw, 34vw';
const img = (src: string, extra: Record<string, string> = { sizes: SIZES }): EmittedNode =>
  ({ tag: 'img', attrs: { src, alt: '', ...extra } });
const srcs = new Map([['/assets/big.jpg', 'assets/big.jpg'], ['/assets/mid.png', 'assets/mid.png'], ['/assets/tiny.png', 'assets/tiny.png']]);
const SIZE: Record<string, { width: number; height: number }> = {
  '/assets/big.jpg': { width: 2400, height: 1600 },
  '/assets/mid.png': { width: 1000, height: 667 },
  '/assets/tiny.png': { width: 300, height: 200 },
};
const sizeOf = (src: string) => SIZE[src] ?? null;

test('srcset: every narrower width, and the original while it is no wider than 1800', () => {
  const big = srcsetImages(img('/assets/big.jpg'), srcs, sizeOf, fakeResize());
  assert.equal(big.attrs?.srcset,
    '/az-img/assets_big_jpg-480.webp 480w, /az-img/assets_big_jpg-768.webp 768w, '
    + '/az-img/assets_big_jpg-1200.webp 1200w, /az-img/assets_big_jpg-1800.webp 1800w',
    'past 1800 the largest variant tops the set; the original is only the fallback');
  assert.equal(big.attrs?.src, '/assets/big.jpg', 'the original stays the src');
  assert.equal(big.attrs?.sizes, SIZES, 'the word\'s sizes stays beside it');
  const mid = srcsetImages(img('/assets/mid.png'), srcs, sizeOf, fakeResize());
  assert.equal(mid.attrs?.srcset,
    '/az-img/assets_mid_png-480.webp 480w, /az-img/assets_mid_png-768.webp 768w, /assets/mid.png 1000w');
});

test('no srcset: the sizes hint is removed and nothing else changes', () => {
  const plain = { src: '/assets/big.jpg', alt: '' };
  assert.deepEqual(srcsetImages(img('/assets/big.jpg'), srcs, sizeOf, undefined).attrs, plain, 'no resizer');
  assert.deepEqual(srcsetImages(img('/assets/big.jpg'), srcs, undefined, fakeResize()).attrs, plain, 'no sizes known');
  assert.deepEqual(srcsetImages(img('/assets/big.jpg'), srcs, sizeOf, () => null).attrs, plain, 'the resizer declined');
  assert.deepEqual(srcsetImages(img('/assets/tiny.png'), srcs, sizeOf, fakeResize()).attrs,
    { src: '/assets/tiny.png', alt: '' }, 'no width to make: an original of 480 or less');
  assert.deepEqual(srcsetImages(img('{row.photo}'), srcs, sizeOf, fakeResize()).attrs,
    { src: '{row.photo}', alt: '' }, 'a row\'s URL has no file at build');
  const wrong: Resize = (_path, widths) => widths.slice(1).map((width) => ({ url: `/x-${width}.webp`, width }));
  assert.deepEqual(srcsetImages(img('/assets/big.jpg'), srcs, sizeOf, wrong).attrs, plain,
    'variants that are not the widths asked for are not used');
});

test('an img without a sizes hint is never resized — the word did not ask', () => {
  const asked: [string, readonly number[]][] = [];
  const logo = img('/assets/big.jpg', {});
  assert.deepEqual(srcsetImages(logo, srcs, sizeOf, fakeResize(asked)), logo);
  assert.deepEqual(asked, []);
});

test('the walk reaches nested images and leaves text alone', () => {
  const tree: EmittedNode = { tag: 'figure', children: [{ tag: 'button', children: [img('/assets/mid.png')] }, 'caption'] };
  const out = srcsetImages(tree, srcs, sizeOf, fakeResize());
  const inner = (out.children?.[0] as EmittedNode).children?.[0] as EmittedNode;
  assert.match(inner.attrs?.srcset ?? '', /768w/);
  assert.equal(out.children?.[1], 'caption');
});

/* ---- a whole build ------------------------------------------------------------ */

const wordsDir = new URL('../../words/', import.meta.url);
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(wordsDir)) {
  let raw: string;
  try { raw = readFileSync(new URL(`${n}/word.json`, wordsDir), 'utf8'); } catch { continue; }
  const m = JSON.parse(raw) as Manifest;
  manifests.set(m.name, m);
}

const gallery = (head: string) => `az 1
site "Bench"

page /
  nav bar
    logo ./assets/logo.png
  ${head}
    image ./assets/one.png
      alt "One"
    image ./assets/two.png
      alt "Two"
    image ./assets/three.png
      alt "Three"
    image ./assets/four.png
      alt "Four"
`;

const FILES: Record<string, Uint8Array> = {
  'assets/logo.png': png(2000, 500), 'assets/one.png': png(2400, 1600), 'assets/two.png': png(1000, 1500),
  'assets/three.png': png(400, 300), 'assets/four.png': png(1800, 1200),
};

function build(head: string, resize?: Resize) {
  const r = compile(gallery(head), { manifests });
  assert.ok(r.spec, r.diagnostics.map((d) => `${d.code} ${d.message}`).join('\n'));
  const p = emitProject(r.spec, { emitters: WEB_EMITTERS, readBytes: (path) => FILES[path] ?? null, resize });
  return p.files.find((f) => f.path === 'src/App.tsx')!.content;
}

/** Every emitted <img>'s attributes in App.tsx. */
const imgs = (app: string) => [...app.matchAll(/"attrs": ?(\{[^{}]*\})/g)]
  .map((m) => JSON.parse(m[1]) as Record<string, string>)
  .filter((a) => a.src !== undefined);

test('build: the gallery\'s images get a srcset and the layout\'s sizes; the logo does not', () => {
  const asked: [string, readonly number[]][] = [];
  const app = build('gallery grid lightbox\n    columns 4', fakeResize(asked));
  const all = imgs(app);
  const logo = all.find((a) => a.src === '/assets/logo.png')!;
  assert.equal(logo.srcset, undefined, 'a nav logo has no sizes hint: not resized');
  assert.equal(logo.sizes, undefined);
  const one = all.filter((a) => a.src === '/assets/one.png');
  assert.equal(one.length, 2, 'the thumbnail and the lightbox\'s first image');
  assert.equal(one[0].sizes, '(width < 768px) 50vw, (width < 1024px) 34vw, 25vw', 'four columns: 2 / 3 / 4 per row');
  assert.equal(one[1].sizes, 'min(90vw, 1440px)', 'the lightbox is drawn at the dialog\'s width');
  for (const a of one) assert.match(a.srcset, /-480\.webp 480w, .*-1800\.webp 1800w$/);
  assert.equal(one[0].width, '2400', 'width and height stay the original\'s');
  const two = all.find((a) => a.src === '/assets/two.png')!;
  assert.match(two.srcset, /768w, \/assets\/two\.png 1000w$/);
  const three = all.find((a) => a.src === '/assets/three.png')!;
  assert.equal(three.srcset, undefined, 'a 400px original is not resized');
  assert.equal(three.sizes, undefined, 'and keeps no sizes without a srcset');
  const four = all.find((a) => a.src === '/assets/four.png')!;
  assert.match(four.srcset, /1200w, \/assets\/four\.png 1800w$/, 'an 1800 original tops its own set');
  assert.ok(asked.every(([, widths]) => widths.length > 0), 'nothing is asked for an image that needs no width');
  assert.ok(!asked.some(([path]) => path === 'assets/logo.png'));
});

test('build: each layout gives its own sizes', () => {
  const sizesOf = (head: string) => imgs(build(head, fakeResize())).find((a) => a.src === '/assets/one.png')!.sizes;
  assert.equal(sizesOf('gallery grid\n    columns 3'), '(width < 768px) 50vw, 34vw', 'three columns: md draws them as the desktop does');
  assert.equal(sizesOf('gallery grid\n    columns 2'), '(width < 768px) 50vw, 50vw');
  assert.equal(sizesOf('gallery masonry\n    ratio auto'), '(width < 768px) 50vw, (width < 1024px) 34vw, 496px');
  assert.equal(sizesOf('gallery carousel'), '(width < 768px) 100vw, 240px');
  assert.equal(sizesOf('gallery orbit\n    poster ./assets/one.png'), undefined, 'orbit: the ring uses the originals');
});

test('build: with no resizer the page has no srcset and no sizes at all — as before the rule', () => {
  const app = build('gallery grid lightbox\n    columns 4');
  assert.doesNotMatch(app, /"srcset"|"sizes"/);
  const sized = imgs(app).find((a) => a.src === '/assets/one.png')!;
  assert.deepEqual(Object.keys(sized).sort(), ['alt', 'class', 'decoding', 'height', 'loading', 'src', 'width']);
});
