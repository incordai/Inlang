/**
 * Responsive images — gallery-block-spec §7 rule 3, the target's half.
 *
 * The target decides the widths (never upscaling), writes `srcset` beside
 * the `sizes` a word gave, and removes that `sizes` whenever there is no
 * srcset — so with no resizer (the playground, these tests) a page is what
 * it was before the rule. A `from` row's image is the exception: it keeps its
 * `sizes` for the rows runtime (data-spec §8). The resizer here is a fake: the CLI's real one is
 * tested in packages/cli/test/images.test.ts.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { SITE_WIDTHS } from '../../core/src/link.ts';
import { emitProject } from '../src/emit.ts';
import { COVER_ATTR, SRCSET_WIDTHS, coverSizes, srcsetImages, srcsetWidths, type Resize } from '../src/image-srcset.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';
import { contentShare, framePx, fromMark, type EmittedNode, type ThemeLike } from '../../core/src/emit-contract.ts';

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
  const wrong: Resize = (_path, widths) => widths.map((width) => ({ url: `/x-${width}.webp`, width: width + 1 }));
  assert.deepEqual(srcsetImages(img('/assets/big.jpg'), srcs, sizeOf, wrong).attrs, plain,
    'variants that are not the widths asked for are not used');
  const backwards: Resize = (_path, widths) => [...widths].reverse().map((width) => ({ url: `/x-${width}.webp`, width }));
  assert.deepEqual(srcsetImages(img('/assets/big.jpg'), srcs, sizeOf, backwards).attrs, plain, 'nor out of their order');
  const twice: Resize = (_path, widths) => [widths[0], widths[0]].map((width) => ({ url: `/x-${width}.webp`, width }));
  assert.deepEqual(srcsetImages(img('/assets/big.jpg'), srcs, sizeOf, twice).attrs, plain, 'nor one width twice');
  assert.deepEqual(srcsetImages(img('/assets/big.jpg'), srcs, sizeOf, () => []).attrs, plain, 'no variant shipped: no srcset');
});

test('a width the resizer did not ship (larger than the original) is left out; the original stands in for the widest', () => {
  // The widest variants came out larger than the file: only 480 and 768 ship.
  const firstTwo: Resize = (path, widths) => fakeResize()(path, widths)!.slice(0, 2);
  const big = srcsetImages(img('/assets/big.jpg'), srcs, sizeOf, firstTwo);
  assert.equal(big.attrs?.srcset,
    '/az-img/assets_big_jpg-480.webp 480w, /az-img/assets_big_jpg-768.webp 768w, /assets/big.jpg 2400w',
    'past 1800 too: the original is the candidate for what the 1800 variant would have been');
  // A middle width dropped: the widest still ships and tops the set.
  const noMiddle: Resize = (path, widths) => fakeResize()(path, widths)!.filter((v) => v.width !== 768);
  assert.equal(srcsetImages(img('/assets/big.jpg'), srcs, sizeOf, noMiddle).attrs?.srcset,
    '/az-img/assets_big_jpg-480.webp 480w, /az-img/assets_big_jpg-1200.webp 1200w, /az-img/assets_big_jpg-1800.webp 1800w');
  const cover = srcsetImages(img('/assets/big.jpg', { sizes: SIZES, [COVER_ATTR]: '1 / 1' }), srcs, sizeOf, firstTwo);
  assert.equal(cover.attrs?.sizes, '(width < 768px) 75vw, min(51vw, 2400px)', 'a cover crop is capped at the largest candidate: the original');
});

test('a `from` row\'s image keeps its sizes and cover hint for the rows runtime, with or without a resizer, and gets no srcset at build', () => {
  const asked: [string, readonly number[]][] = [];
  const row = img(fromMark('src'), { sizes: SIZES, [COVER_ATTR]: '4 / 3' });
  for (const resize of [fakeResize(asked), undefined]) {
    assert.deepEqual(srcsetImages(row, srcs, sizeOf, resize).attrs, { src: fromMark('src'), alt: '', sizes: SIZES, [COVER_ATTR]: '4 / 3' },
      'sizes and the cover hint kept: only the runtime knows the file\'s shape');
  }
  assert.deepEqual(asked, [], 'nothing is resized for a row: its file is the server\'s');
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

const gallery = (head: string, width?: string) => `az 1
site "Bench"
${width === undefined ? '' : `  width ${width}\n`}
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
  'assets/three.png': png(400, 300), 'assets/four.png': png(1800, 1200), 'assets/square.png': png(1200, 1200),
};

function build(head: string, resize?: Resize, width?: string) {
  return buildSource(gallery(head, width), resize);
}

function buildSource(source: string, resize?: Resize) {
  const r = compile(source, { manifests });
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
  assert.equal(one[0].sizes, '(width < 768px) 50vw, (width < 1024px) 34vw, min(25vw, 360px)',
    'four columns: 2 / 3 / 4 per row, the last capped by a quarter of the 1440px frame');
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
  assert.equal(sizesOf('gallery grid\n    columns 3'), '(width < 768px) 50vw, min(34vw, 480px)',
    'three columns: md draws them as the desktop does');
  assert.equal(sizesOf('gallery grid\n    columns 2'), '(width < 768px) 50vw, min(50vw, 720px)');
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

/* ---- the site frame caps `sizes` ------------------------------------------- */

test('the frame in px is the --az-frame the target writes, for every site width', () => {
  const theme = emitProject(compile(gallery('gallery grid'), { manifests }).spec!, { emitters: WEB_EMITTERS })
    .files.find((f) => f.path === 'src/theme.css')!.content;
  const T = { size: { container: 1440, 'gutter-lg': 64 }, breakpoint: { md: 1024 } } as unknown as ThemeLike;
  const css = (width: string) => new RegExp(
    width === 'default' ? String.raw`\.az-site \{ --az-frame: ([^;]+);` : String.raw`\.az-site\[data-width="${width}"\] \{ --az-frame: ([^;]+);`,
  ).exec(theme)?.[1];
  for (const width of Object.keys(SITE_WIDTHS)) {
    const frame = framePx(width, T);
    assert.equal(frame === undefined ? undefined : `${frame}px`, /px$/.test(css(width) ?? '') ? css(width) : undefined, width);
  }
  assert.equal(framePx('full', T), undefined, 'full has no frame');
  assert.equal(framePx('reading', T), undefined, 'reading is a measure in ch, not px');
});

test('contentShare: a share of the viewport, capped by the frame only where the frame can bite', () => {
  assert.equal(contentShare(3, undefined), '34vw', 'no frame: the viewport alone');
  assert.equal(contentShare(3, 1440), 'min(34vw, 480px)');
  assert.equal(contentShare(2, 1568), 'min(50vw, 784px)');
  assert.equal(contentShare(3, 1000), 'min(34vw, 334px)', 'rounded up: never too small a file');
  assert.equal(contentShare(1, 1440, 768), '100vw', 'under 768px a 1440px frame never caps');
  assert.equal(contentShare(2, 1024, 1024), '50vw', 'a frame as wide as the clause\'s bound never caps');
  assert.equal(contentShare(2, 900, 1024), 'min(50vw, 450px)');
});

test('build: each site width caps the gallery\'s sizes by its own frame', () => {
  const sizesAt = (width: string) => imgs(build('gallery grid\n    columns 3', fakeResize(), width))
    .find((a) => a.src === '/assets/one.png')!.sizes;
  assert.equal(sizesAt('default'), '(width < 768px) 50vw, min(34vw, 480px)', 'the 1440px container');
  assert.equal(sizesAt('wide'), '(width < 768px) 50vw, min(34vw, 523px)', 'the container and both 64px gutters');
  assert.equal(sizesAt('narrow'), '(width < 768px) 50vw, min(34vw, 342px)', 'breakpoint md');
  assert.equal(sizesAt('full'), '(width < 768px) 50vw, 34vw', 'no frame');
  assert.equal(sizesAt('reading'), '(width < 768px) 50vw, 34vw', 'a measure in ch: no px to cap with');
});

/* ---- feature and cta -------------------------------------------------------- */

const page = (block: string, width?: string) => `az 1
site "Bench"
${width === undefined ? '' : `  width ${width}\n`}
page /
  ${block}
`;

const featureSource = (variant: string, extra = '') => page(`feature ${variant}${extra}
    item "One"
      media ./assets/one.png
    item "Two"
      media ./assets/two.png
    item "Three"
      media ./assets/three.png
    item "Four"
      media ./assets/four.png`);

const ctaSplit = (width?: string) => page(`cta split
    title "Reserve"
    media ./assets/one.png
    cta "Reserve a pair" /reserve`, width) + '\npage /reserve\n';

test('build: feature rows media is the whole content below sm, then half the row, capped by the frame', () => {
  const all = imgs(buildSource(featureSource('rows'), fakeResize()));
  const one = all.find((a) => a.src === '/assets/one.png')!;
  assert.equal(one.sizes, '(width < 768px) 100vw, min(50vw, 720px)');
  assert.match(one.srcset, /-480\.webp 480w, .*-1800\.webp 1800w$/);
  assert.equal(one.width, '2400', 'width and height stay the original\'s');
  assert.match(all.find((a) => a.src === '/assets/two.png')!.srcset, /768w, \/assets\/two\.png 1000w$/, 'never upscaled');
  const three = all.find((a) => a.src === '/assets/three.png')!;
  assert.equal(three.srcset, undefined, 'a 400px original is not resized');
  assert.equal(three.sizes, undefined);
});

test('build: feature bento media follows its tracks — one, then two under md, then columns', () => {
  const sizesOf = (extra: string) => imgs(buildSource(featureSource('bento', extra), fakeResize()))
    .find((a) => a.src === '/assets/one.png')!.sizes;
  assert.equal(sizesOf(''), '(width < 768px) 100vw, (width < 1024px) 50vw, min(34vw, 480px)', 'three columns by default');
  assert.equal(sizesOf('\n    columns 2'), '(width < 768px) 100vw, min(50vw, 720px)', 'two columns: md is the desktop');
});

test('build: feature grid shows no media, so it asks for no sizes', () => {
  assert.doesNotMatch(buildSource(featureSource('grid'), fakeResize()), /"sizes"/);
});

test('build: cta split media is the whole content below sm, then its column, capped by the frame', () => {
  const one = imgs(buildSource(ctaSplit(), fakeResize())).find((a) => a.src === '/assets/one.png')!;
  assert.equal(one.sizes, '(width < 768px) 100vw, min(50vw, 720px)');
  assert.match(one.srcset, /-480\.webp 480w, .*-1800\.webp 1800w$/);
  const full = imgs(buildSource(ctaSplit('full'), fakeResize())).find((a) => a.src === '/assets/one.png')!;
  assert.equal(full.sizes, '(width < 768px) 100vw, 50vw', 'a full site has no frame to cap with');
});

/* ---- hero poster --------------------------------------------------------------- */

const heroPoster = (variant: string, width?: string, poster = 'one.png') => page(`hero ${variant} 3d
    title "Built in the dark"
    poster ./assets/${poster}
    describe "A boot on a bench"
    focus top`, width);

const posterOf = (source: string, resize?: Resize) =>
  imgs(buildSource(source, resize)).find((a) => (a.class ?? '').split(' ').includes('az-hero-poster'))!;

test('build: hero full\'s poster is edge to edge — 100vw on every site width, never capped by the frame', () => {
  for (const width of [undefined, ...Object.keys(SITE_WIDTHS)]) {
    const poster = posterOf(heroPoster('full', width), fakeResize());
    assert.equal(poster.sizes, 'max(100vw, min(128vh, 1800px))',
      `site width ${width ?? 'default'}: the box, or the 3:2 file cropped to 85vh tall`);
    assert.match(poster.srcset, /-480\.webp 480w, .*-1800\.webp 1800w$/, 'past 1800 the largest variant tops the set');
    assert.equal(poster.src, '/assets/one.png', 'the original stays the src');
    assert.equal(poster.width, '2400', 'width and height stay the original\'s');
  }
});

test('build: hero split\'s poster is the whole content below sm, then its column, capped by the frame', () => {
  // The 3:2 file is cropped into the 4:3 column: drawn 1.125× its box.
  assert.equal(posterOf(heroPoster('split'), fakeResize()).sizes, '(width < 768px) 113vw, min(57vw, 810px)');
  assert.equal(posterOf(heroPoster('split', 'narrow'), fakeResize()).sizes, '(width < 768px) 113vw, min(57vw, 576px)');
  assert.equal(posterOf(heroPoster('split', 'full'), fakeResize()).sizes, '(width < 768px) 113vw, min(57vw, 1800px)',
    'a full site has no frame to cap with: the largest file caps the widened share');
});

test('build: hero center, stack and minimal draw the poster the content\'s width, capped by the frame', () => {
  for (const variant of ['center', 'stack', 'minimal']) {
    assert.equal(posterOf(heroPoster(variant), fakeResize()).sizes, 'min(100vw, 1440px)', variant);
    assert.equal(posterOf(heroPoster(variant, 'full'), fakeResize()).sizes, '100vw', `${variant} on a full site`);
  }
});

test('build: hero\'s poster is never upscaled — a 1000px original gets 480 and 768, then itself', () => {
  const asked: [string, readonly number[]][] = [];
  const poster = posterOf(heroPoster('full', undefined, 'two.png'), fakeResize(asked));
  assert.match(poster.srcset, /-480\.webp 480w, .*-768\.webp 768w, \/assets\/two\.png 1000w$/);
  assert.deepEqual(asked, [['assets/two.png', [480, 768]]]);
  assert.equal(posterOf(heroPoster('full', undefined, 'three.png'), fakeResize()).sizes, undefined,
    'a 400px original is not resized, and keeps no sizes');
});

test('build: the srcset leaves the poster\'s loading, alt and live part as they were', () => {
  for (const variant of ['full', 'split']) {
    const plain = posterOf(heroPoster(variant));
    const sized = posterOf(heroPoster(variant), fakeResize());
    const { srcset, sizes, ...rest } = sized;
    assert.ok(srcset && sizes, variant);
    assert.deepEqual(rest, plain, `${variant}: only srcset and sizes are added`);
    assert.equal(rest.loading, undefined, 'never lazy: it is in the first viewport');
    assert.equal(rest.fetchpriority, undefined, 'no priority hint: the text is the LCP element');
  }
});

test('build: feature, cta and hero with no resizer ship no srcset and no sizes — as before the rule', () => {
  for (const source of [featureSource('rows'), featureSource('bento'), ctaSplit(), heroPoster('full'), heroPoster('split')]) {
    assert.doesNotMatch(buildSource(source), /"srcset"|"sizes"/);
  }
});

/* ---- cover crops widen `sizes` ---------------------------------------------- */

test('coverSizes: a box as wide as the file, or wider, leaves sizes exactly as it was', () => {
  const sizes = '(width < 768px) 50vw, min(34vw, 480px)';
  assert.equal(coverSizes(sizes, '3 / 2', 1.5, 1800), sizes, 'the file matches its box');
  assert.equal(coverSizes(sizes, '16 / 9', 1.5, 1800), sizes, 'the box is wider: cover scales to its width');
  assert.equal(coverSizes(sizes, '4 / 3', 1, 1800), sizes, 'a square file in a 4:3 tile is drawn the tile\'s width');
});

test('coverSizes: a file wider than its box widens every clause by fileAspect / boxAspect', () => {
  assert.equal(coverSizes('(width < 768px) 50vw, min(34vw, 480px)', '1 / 1', 1.5, 1800),
    '(width < 768px) 75vw, min(51vw, 720px)');
  assert.equal(coverSizes('(width < 768px) 50vw, min(34vw, 480px)', '4 / 5', 1, 1800),
    '(width < 768px) 63vw, min(43vw, 600px)', 'rounded up, never too small');
  assert.equal(coverSizes('(width < 768px) 100vw, 240px', '1 / 1', 1.5, 1800), '(width < 768px) 150vw, 360px');
  assert.equal(coverSizes('(width < 768px) 100vw', '1 / 1', 1.1, 1800), '(width < 768px) 110vw',
    'a product a hair over a whole number is that number');
});

test('coverSizes: never wider than the largest file', () => {
  assert.equal(coverSizes('(width < 768px) 100vw, 50vw', '1 / 1', 2, 1000),
    '(width < 768px) min(200vw, 1000px), min(100vw, 1000px)', 'a share that can pass the largest file is capped');
  assert.equal(coverSizes('(width < 768px) 50vw', '1 / 1', 2, 1800), '(width < 768px) 100vw',
    'under 768px, 100vw is at most 768px: no cap to add');
  assert.equal(coverSizes('min(34vw, 480px)', '1 / 1', 3, 1000), 'min(102vw, 1000px)', 'a px term past it becomes it');
  assert.equal(coverSizes('240px', '1 / 1', 3, 600), '600px');
});

test('coverSizes: a box height draws the file at least height × its aspect, capped by the largest file', () => {
  assert.equal(coverSizes('100vw', '85vh', 1.5, 1800), 'max(100vw, min(128vh, 1800px))');
  assert.equal(coverSizes('100vw', '70vh', 2400 / 1600, 1000), 'max(100vw, min(105vh, 1000px))');
  assert.equal(coverSizes('(width < 768px) 100vw, 50vw', '100vh', 0.5, 1800),
    '(width < 768px) max(100vw, min(50vh, 1800px)), max(50vw, min(50vh, 1800px))');
});

test('coverSizes: a hint or a length it cannot read is the word\'s bug, and says so', () => {
  assert.throws(() => coverSizes('100vw', 'tall', 1.5, 1800), /cover hint 'tall'/);
  assert.throws(() => coverSizes('100vw', '4 / 0', 1.5, 1800), /cover hint '4 \/ 0'/);
  assert.throws(() => coverSizes('calc(100vw - 2rem)', '1 / 1', 1.5, 1800), /can't widen the length/);
});

test('the cover hint is always removed — with a srcset, without one, and without a sizes', () => {
  const cover = { sizes: SIZES, [COVER_ATTR]: '1 / 1' };
  const sized = srcsetImages(img('/assets/big.jpg', cover), srcs, sizeOf, fakeResize());
  assert.equal(sized.attrs?.[COVER_ATTR], undefined);
  assert.equal(sized.attrs?.sizes, '(width < 768px) 75vw, min(51vw, 1800px)', 'an open-ended share is capped');
  assert.deepEqual(srcsetImages(img('/assets/big.jpg', cover), srcs, sizeOf, undefined).attrs,
    { src: '/assets/big.jpg', alt: '' }, 'no resizer: as before the rule');
  assert.deepEqual(srcsetImages(img('/assets/big.jpg', { [COVER_ATTR]: '1 / 1' }), srcs, sizeOf, fakeResize()).attrs,
    { src: '/assets/big.jpg', alt: '' }, 'no sizes: nothing to widen');
});

test('the largest file caps a widened clause: the original when it tops its set', () => {
  const mid = srcsetImages(img('/assets/mid.png', { sizes: '100vw', [COVER_ATTR]: '1 / 1' }), srcs, sizeOf, fakeResize());
  assert.equal(mid.attrs?.sizes, 'min(150vw, 1000px)', 'mid.png tops its set at 1000px');
});

const tiles = (ratio: string, variant = 'grid') => page(`gallery ${variant}
    ratio ${ratio}
    image ./assets/one.png
      alt "Wide"
    image ./assets/square.png
      alt "Square"
    image ./assets/two.png
      alt "Tall"`);

const tile = (source: string, src: string) => imgs(buildSource(source, fakeResize())).find((a) => a.src === src)!;

test('build: a gallery ratio tile widens sizes for a file wider than the tile, and only then', () => {
  assert.equal(tile(tiles('square'), '/assets/one.png').sizes, '(width < 768px) 75vw, min(51vw, 720px)',
    'a 3:2 file in a square tile is drawn 1.5× the tile');
  assert.equal(tile(tiles('square'), '/assets/square.png').sizes, '(width < 768px) 50vw, min(34vw, 480px)',
    'CONTROL: a square file in a square tile');
  assert.equal(tile(tiles('4:3'), '/assets/one.png').sizes, '(width < 768px) 57vw, min(39vw, 540px)');
  assert.equal(tile(tiles('4:3'), '/assets/square.png').sizes, '(width < 768px) 50vw, min(34vw, 480px)',
    'a square file in a 4:3 tile is drawn at the tile\'s width: unchanged');
  assert.equal(tile(tiles('portrait'), '/assets/square.png').sizes, '(width < 768px) 63vw, min(43vw, 600px)');
  assert.equal(tile(tiles('3:2'), '/assets/one.png').sizes, '(width < 768px) 50vw, min(34vw, 480px)',
    'CONTROL: a 3:2 file in a 3:2 tile');
  assert.equal(tile(tiles('square'), '/assets/two.png').sizes, '(width < 768px) 50vw, min(34vw, 480px)',
    'a portrait file is never drawn wider than a square tile');
  assert.equal(tile(tiles('square', 'carousel'), '/assets/one.png').sizes, '(width < 768px) 150vw, 360px');
  assert.equal(tile(tiles('auto', 'masonry'), '/assets/one.png').sizes, '(width < 768px) 50vw, (width < 1024px) 34vw, 496px',
    'auto keeps each file\'s own shape: no crop, nothing to widen');
});

test('build: the lightbox image is contain, not cover — its sizes is never widened', () => {
  const all = imgs(buildSource(tiles('square').replace('gallery grid', 'gallery grid lightbox'), fakeResize()));
  const boxed = all.filter((a) => a.src === '/assets/one.png');
  assert.equal(boxed[1].sizes, 'min(90vw, 1440px)');
});

test('build: hero full\'s box height follows `height`', () => {
  for (const [height, vh] of [['compact', 105], ['peek', 128], ['tall', 138], ['full', 150]] as const) {
    const source = heroPoster('full').replace('    focus top', `    focus top\n    height ${height}`);
    assert.equal(posterOf(source, fakeResize()).sizes, `max(100vw, min(${vh}vh, 1800px))`, height);
  }
  assert.equal(posterOf(heroPoster('full', undefined, 'two.png'), fakeResize()).sizes, 'max(100vw, min(57vh, 1000px))',
    'a portrait file: the box\'s width wins wherever the viewport is wider than 57vh');
});

test('build: hero center, stack and minimal crop into 16:9 — a 3:2 file is narrower, so unchanged', () => {
  for (const variant of ['center', 'stack', 'minimal']) {
    const poster = posterOf(heroPoster(variant), fakeResize());
    assert.equal(poster.sizes, 'min(100vw, 1440px)', variant);
    assert.equal(poster[COVER_ATTR], undefined, 'the hint never reaches the page');
  }
});
