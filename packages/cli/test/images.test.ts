/**
 * Responsive images through the real build — gallery-block-spec §7 rule 3
 * and the §11 image budget, the CLI's half.
 *
 * Real files, the real image library in its child process, a cache in a
 * temporary folder: srcset on the shipped page, variant files of the right
 * widths in public/, never upscaled, turned upright and stripped of
 * metadata, byte-identical from a cold cache, nothing encoded from a warm
 * one, a tampered cache entry never trusted, an undecodable or oversized
 * file a warning and its original only — and with no resizer, the build of
 * before.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { build } from '../src/az.ts';
import { BACKEND_PINS } from '../../backend/src/emit.ts';
import { ENCODING, VARIANT_DIR, imageId } from '../src/images.ts';
import { imageSize } from '../../target-web/src/image-size.ts';
import { phoneJpeg } from '../../backend/test/image-fixtures.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');

/** A flat photo-like image with a disc, so it compresses small and decodes fast. */
const photo = (width: number, height: number) => sharp({
  create: { width, height, channels: 3, background: { r: 120, g: 60, b: 30 } },
}).composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 3}" fill="#fff"/></svg>`) }]);

const SITE = `az 1
site "Bench"

page /
  nav bar
    logo ./assets/logo.png
  gallery grid lightbox
    columns 3
    image ./assets/big.jpg
      alt "Big"
    image ./assets/turned.jpg
      alt "Turned"
    image ./assets/mid.png
      alt "Mid"
    image ./assets/small.webp
      alt "Small"
    image ./assets/broken.jpg
      alt "Broken"
    image ./assets/huge.png
      alt "Huge"
`;

/** EXIF a phone writes: a quarter turn, and a location that must never ship. */
const SECRET = 'AZ-SECRET-LOCATION-51.5';

async function fixtures(dir: string) {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  await photo(2400, 1600).jpeg({ quality: 85 }).toFile(join(dir, 'assets/big.jpg'));
  // Stored 2000×1200, orientation 6: the browser draws it 1200×2000.
  await photo(2000, 1200).jpeg().withMetadata({ orientation: 6 }).withExif({ IFD0: { ImageDescription: SECRET, Copyright: SECRET } })
    .toFile(join(dir, 'assets/turned.jpg'));
  await photo(1000, 667).png().toFile(join(dir, 'assets/mid.png'));
  await photo(400, 300).webp().toFile(join(dir, 'assets/small.webp'));
  await photo(2000, 500).png().toFile(join(dir, 'assets/logo.png'));
  // A header that parses — the size is readable — over data that does not decode.
  const whole = await photo(900, 600).jpeg().toBuffer();
  writeFileSync(join(dir, 'assets/broken.jpg'), whole.subarray(0, 700));
  // Past the 8000px side limit: refused from the header, before any decode.
  await sharp({ create: { width: 8200, height: 16, channels: 3, background: '#808080' } }).png().toFile(join(dir, 'assets/huge.png'));
}

async function project(source = SITE) {
  const dir = mkdtempSync(join(tmpdir(), 'az-images-'));
  writeFileSync(join(dir, 'site.az'), source, 'utf8');
  await fixtures(dir);
  return { dir, file: join(dir, 'site.az') };
}

const run = (p: { dir: string; file: string }, out: string, imageCache: string | null) =>
  build({ source: p.file, outDir: join(p.dir, out), wordsDir: WORDS, imageCache });

/** Every <img>'s attributes in App.tsx. */
const imgs = (app: string) => [...app.matchAll(/"attrs": ?(\{[^{}]*\})/g)]
  .map((m) => JSON.parse(m[1]) as Record<string, string>)
  .filter((a) => a.src !== undefined);
const appOf = (dir: string, out: string) => readFileSync(join(dir, out, 'src/App.tsx'), 'utf8');
const variantsIn = (dir: string, out: string) => {
  const at = join(dir, out, 'public', VARIANT_DIR);
  return existsSync(at) ? readdirSync(at).sort() : [];
};
const candidates = (srcset: string) => srcset.split(', ').map((c) => { const [url, w] = c.split(' '); return { url, width: Number(w.slice(0, -1)) }; });

test('build: srcset on the gallery, variants of the right widths in public/, never upscaled', async () => {
  const p = await project();
  const cache = join(p.dir, 'cache');
  const r = run(p, 'out', cache);
  assert.equal(r.ok, true, r.report);
  const all = imgs(appOf(p.dir, 'out'));
  const byName = (name: string) => all.find((a) => a.src === `/assets/${name}`)!;

  const big = byName('big.jpg');
  assert.equal(big.sizes, '(width < 768px) 50vw, min(34vw, 480px)', 'three columns, capped by a third of the frame');
  assert.deepEqual(candidates(big.srcset).map((c) => c.width), [480, 768, 1200, 1800]);
  assert.equal(big.width, '2400', 'the original keeps its width and height');
  const mid = byName('mid.png');
  assert.deepEqual(candidates(mid.srcset).map((c) => c.width), [480, 768, 1000], 'two variants, then the 1000px original');
  assert.equal(candidates(mid.srcset).at(-1)!.url, '/assets/mid.png');
  for (const name of ['small.webp', 'broken.jpg', 'huge.png', 'logo.png']) {
    assert.equal(byName(name).srcset, undefined, `${name}: no srcset`);
    assert.equal(byName(name).sizes, undefined, `${name}: no sizes without one`);
  }

  // Every candidate a page names is a file in the build, exactly that wide.
  const shipped = new Set(variantsIn(p.dir, 'out'));
  for (const a of all.filter((x) => x.srcset)) {
    for (const c of candidates(a.srcset).filter((x) => x.url.startsWith(`/${VARIANT_DIR}/`))) {
      const file = join(p.dir, 'out/public', c.url);
      assert.ok(shipped.has(c.url.split('/').pop()!), `${c.url} ships`);
      const size = imageSize(readFileSync(file));
      assert.equal(size?.width, c.width, `${c.url} is ${c.width}px wide`);
      assert.ok(c.width < Number(a.width), `${c.url} is narrower than its ${a.width}px original`);
    }
  }
  assert.equal(shipped.size, 4 + 2 + 2, 'big ×4, turned ×2 (drawn 1200 wide), mid ×2 — the lightbox reuses the same files');

  // Turned upright: stored landscape, drawn portrait — the variant is portrait too.
  const turned = byName('turned.jpg');
  assert.ok(readFileSync(join(p.dir, 'assets/turned.jpg')).includes(SECRET), 'CONTROL: the original carries the metadata');
  assert.equal(turned.width, '1200', 'the header size is the one the browser draws');
  assert.deepEqual(candidates(turned.srcset).map((c) => c.width), [480, 768, 1200]);
  const first = candidates(turned.srcset)[0];
  const meta = await sharp(join(p.dir, 'out/public', first.url)).metadata();
  assert.deepEqual([meta.width, meta.height], [480, 800], 'autoOrient: the pixels are upright');
  assert.equal(meta.exif, undefined, 'no EXIF in a variant');
  assert.equal(meta.orientation, undefined);
  for (const name of shipped) {
    assert.ok(!readFileSync(join(p.dir, 'out/public', VARIANT_DIR, name)).includes(SECRET), `${name} carries no metadata`);
  }

  assert.match(r.report, /warning: image: can't resize '\.\/assets\/broken\.jpg' — it does not decode; it ships at its own size only, with no srcset/);
  assert.match(r.report, /warning: image: '\.\/assets\/huge\.png' is 8200×16 — over the resize limit \(8000px a side, 40 megapixels\); it ships at its own size only, with no srcset/);
  assert.doesNotMatch(r.report, /small\.webp|logo\.png/, 'a small original and a logo are not failures');
});

test('determinism: two cold caches give the same bytes; a warm one encodes nothing', async () => {
  const p = await project();
  const a = run(p, 'a', join(p.dir, 'cache-a'));
  const b = run(p, 'b', join(p.dir, 'cache-b'));
  assert.equal(a.ok && b.ok, true, `${a.report}\n${b.report}`);
  assert.equal(appOf(p.dir, 'a'), appOf(p.dir, 'b'));
  const names = variantsIn(p.dir, 'a');
  assert.deepEqual(variantsIn(p.dir, 'b'), names);
  for (const n of names) {
    assert.ok(readFileSync(join(p.dir, 'a/public', VARIANT_DIR, n)).equals(readFileSync(join(p.dir, 'b/public', VARIANT_DIR, n))), `${n} is byte-identical`);
  }
  // Warm: the cache's files are not rewritten — nothing was encoded.
  const cache = join(p.dir, 'cache-a');
  const before = new Map(readdirSync(cache).map((f) => [f, statSync(join(cache, f)).mtimeMs]));
  const c = run(p, 'c', cache);
  assert.equal(c.ok, true, c.report);
  assert.equal(appOf(p.dir, 'c'), appOf(p.dir, 'a'));
  for (const [f, t] of before) assert.equal(statSync(join(cache, f)).mtimeMs, t, `${f} untouched`);
  assert.deepEqual(readdirSync(cache).sort(), [...before.keys()].sort(), 'no new cache files');
});

test('a tampered cache file is never shipped: it is encoded again', async () => {
  const p = await project();
  const cache = join(p.dir, 'cache');
  assert.equal(run(p, 'a', cache).ok, true);
  const victim = readdirSync(cache).find((f) => f.endsWith('-480.webp'))!;
  const good = readFileSync(join(cache, victim));
  writeFileSync(join(cache, victim), Buffer.from('not the variant'));
  const r = run(p, 'b', cache);
  assert.equal(r.ok, true, r.report);
  assert.ok(readFileSync(join(p.dir, 'b/public', VARIANT_DIR, victim)).equals(good), 'the shipped file is the real variant');
  assert.ok(readFileSync(join(cache, victim)).equals(good), 'and the cache is repaired');
});

test('an entry without the shipped widths (the lossy-only scheme\'s shape) is never trusted: it is encoded again', async () => {
  const p = await project();
  const cache = join(p.dir, 'cache');
  assert.equal(run(p, 'a', cache).ok, true);
  const id = imageId(readFileSync(join(p.dir, 'assets/big.jpg')));
  const entry = JSON.parse(readFileSync(join(cache, `${id}.json`), 'utf8')) as { widths: number[]; sha256: Record<string, string> };
  writeFileSync(join(cache, `${id}.json`), JSON.stringify({ widths: entry.widths, sha256: entry.sha256 }));
  const r = run(p, 'b', cache);
  assert.equal(r.ok, true, r.report);
  assert.deepEqual((JSON.parse(readFileSync(join(cache, `${id}.json`), 'utf8')) as { shipped: number[] }).shipped, [480, 768, 1200, 1800], 'rewritten whole');
  assert.equal(appOf(p.dir, 'b'), appOf(p.dir, 'a'));
});

test('with no resizer the build is exactly as before: no srcset, no sizes, no variants', async () => {
  const p = await project();
  const r = run(p, 'out', null);
  assert.equal(r.ok, true, r.report);
  const app = appOf(p.dir, 'out');
  assert.doesNotMatch(app, /"srcset"|"sizes"/);
  assert.deepEqual(variantsIn(p.dir, 'out'), []);
  assert.doesNotMatch(r.report, /can't resize|resize limit/, 'nothing is decoded, so nothing is reported');
});

test('a resizer that cannot run is one warning, and the build ships the originals', async () => {
  const p = await project();
  // The cache path runs through a file: the child cannot make it.
  writeFileSync(join(p.dir, 'not-a-folder'), '');
  const r = run(p, 'out', join(p.dir, 'not-a-folder', 'cache'));
  assert.equal(r.ok, true, r.report);
  assert.match(r.report, /warning: image: the resizer could not run \(the cache folder .* can't be written \(ENOTDIR\)\) — 5 images ship as the original only, with no srcset; build again to retry/);
  const app = appOf(p.dir, 'out');
  assert.doesNotMatch(app, /"srcset"|"sizes"/, 'the page names no file that was not made');
  assert.deepEqual(variantsIn(p.dir, 'out'), []);
});

test('§11: a gallery image over 500KB is a warning in the spec\'s words; under it is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'az-budget-'));
  mkdirSync(join(dir, 'assets'));
  // Noise does not compress: 600×400 RGB is ~720KB as PNG.
  await sharp(randomBytes(600 * 400 * 3), { raw: { width: 600, height: 400, channels: 3 } }).png().toFile(join(dir, 'assets/bench.png'));
  await photo(600, 400).png().toFile(join(dir, 'assets/lasts.png'));
  await sharp(randomBytes(600 * 400 * 3), { raw: { width: 600, height: 400, channels: 3 } }).png().toFile(join(dir, 'assets/hero.png'));
  writeFileSync(join(dir, 'site.az'), `az 1
site "Bench"

page /
  feature rows
    item "Oak"
      media ./assets/hero.png
      text "Forty pairs a month."
    item "Ash"
      text "Each by hand."
  gallery grid
    image ./assets/bench.png
      alt "Bench"
    image ./assets/lasts.png
      alt "Lasts"
`, 'utf8');
  const kb = Math.round(statSync(join(dir, 'assets/bench.png')).size / 1024);
  assert.ok(kb > 500, `CONTROL: the noise file is over budget (${kb}KB)`);
  const r = build({ source: join(dir, 'site.az'), outDir: join(dir, 'out'), wordsDir: WORDS, imageCache: join(dir, 'cache') });
  assert.equal(r.ok, true, r.report);
  assert.match(r.report, new RegExp(`warning: gallery: 'bench\\.png' is ${kb}KB — export it under 500KB or the gallery blocks the page`));
  assert.doesNotMatch(r.report, /'lasts\.png' is/);
  assert.doesNotMatch(r.report, /'hero\.png' is/, 'the budget is the gallery\'s: a feature image is not checked');
});

/* ---- the mode: line art lossless, photographs lossy (ENCODING) ------------------- */

/** Line art: flat shapes and a hard stroke on white — a few hundred colours, all at edges. */
const lineArt = (width: number, height: number) => sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/>` +
  `<circle cx="${width * 0.3}" cy="${height * 0.45}" r="${height * 0.3}" fill="#1d4ed8"/>` +
  `<path d="M${width * 0.05} ${height * 0.92} L${width * 0.95} ${height * 0.08}" stroke="#111" stroke-width="9"/>` +
  `<rect x="${width * 0.6}" y="${height * 0.55}" width="${width * 0.3}" height="${height * 0.3}" fill="#f59e0b"/></svg>`));

/** Concentric rings, a hard stroke each: line art whose resized edges hold many colours. */
const rings = (width: number, height: number, count: number) => sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#fff"/>` +
  Array.from({ length: count }, (_, k) => `<circle cx="${width / 2}" cy="${height / 2}" r="${((k + 1) * Math.min(width, height)) / 2 / (count + 1)}" ` +
    `fill="none" stroke="${k % 2 ? '#1d4ed8' : '#111'}" stroke-width="3"/>`).join('') + '</svg>'));

/** A photograph's statistics: a smooth gradient under sensor noise, from a fixed seed. */
function noisyPhoto(width: number, height: number) {
  const raw = Buffer.alloc(width * height * 3);
  let seed = 7;
  const next = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const noise = (next() - 0.5) * 12;
      raw[i] = clamp(40 + (x / width) * 180 + noise);
      raw[i + 1] = clamp(90 + (y / height) * 120 + noise);
      raw[i + 2] = clamp(160 - (x / width) * 100 + noise);
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } });
}

const MODES_SITE = `az 1
site "Modes"

page /
  gallery grid
    columns 3
    image ./assets/diagram.png
      alt "Diagram"
    image ./assets/photo.png
      alt "Photo"
    image ./assets/photo.jpg
      alt "Photo JPEG"
    image ./assets/lean.png
      alt "Lean"
`;

/** Each image's cache entry, by its file. */
const entryOf = (dir: string, cache: string, name: string) =>
  JSON.parse(readFileSync(join(cache, `${imageId(readFileSync(join(dir, 'assets', name)))}.json`), 'utf8')) as
    { widths: number[]; shipped: number[]; modes: Record<string, string> };

/** The first chunk of a WebP: 'VP8L' is lossless (near-lossless too), 'VP8 ' lossy. */
const webpChunk = (bytes: Buffer) => bytes.toString('latin1', 12, 16);

async function modesProject() {
  const dir = mkdtempSync(join(tmpdir(), 'az-modes-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'site.az'), MODES_SITE, 'utf8');
  await lineArt(2000, 1300).png().toFile(join(dir, 'assets/diagram.png'));
  await noisyPhoto(1300, 900).png().toFile(join(dir, 'assets/photo.png'));
  await noisyPhoto(1300, 900).jpeg({ quality: 90 }).toFile(join(dir, 'assets/photo.jpg'));
  // Rings squeezed into a 16-colour palette: a resize blends their edges back
  // into many colours, so lossless outgrows the file from 768px, near-lossless from 1200px.
  await rings(2000, 1300, 20).png({ palette: true, colours: 16, compressionLevel: 9 }).toFile(join(dir, 'assets/lean.png'));
  return { dir, file: join(dir, 'site.az') };
}

test('line art: a flat-colour PNG gives lossless variants whose pixels are exactly a straight resize', async () => {
  const p = await modesProject();
  const cache = join(p.dir, 'cache');
  const r = run(p, 'out', cache);
  assert.equal(r.ok, true, r.report);
  const entry = entryOf(p.dir, cache, 'diagram.png');
  assert.deepEqual(entry.shipped, [480, 768, 1200, 1800], 'every width ships: each is smaller than the source');
  assert.deepEqual(Object.values(entry.modes), ['lossless', 'lossless', 'lossless', 'lossless']);
  const source = join(p.dir, 'assets/diagram.png');
  const diagram = imgs(appOf(p.dir, 'out')).find((a) => a.src === '/assets/diagram.png')!;
  // An exported PNG carries an alpha channel it does not use: the WebP writer drops it, losing nothing.
  const own = await sharp(source).stats();
  assert.equal(own.isOpaque, true, 'CONTROL: the source is opaque');
  for (const c of candidates(diagram.srcset).filter((x) => x.url.startsWith(`/${VARIANT_DIR}/`))) {
    const variant = readFileSync(join(p.dir, 'out/public', c.url));
    assert.equal(webpChunk(variant), 'VP8L', `${c.url} is lossless WebP`);
    assert.ok(variant.length <= statSync(source).size, `${c.url} is no larger than its source`);
    const decoded = await sharp(variant).raw().toBuffer({ resolveWithObject: true });
    const straight = await sharp(source).autoOrient().resize({ width: c.width, ...ENCODING.resize }).removeAlpha().raw()
      .toBuffer({ resolveWithObject: true });
    const shape = (i: { width: number; height: number; channels: number }) => [i.width, i.height, i.channels];
    assert.deepEqual(shape(decoded.info), shape(straight.info), `${c.url}: the same size and channels`);
    assert.ok(decoded.data.equals(straight.data), `${c.url}: every pixel is the straight resize's`);
  }
});

test('photographs stay lossy: a JPEG, and a PNG of many colours', async () => {
  const p = await modesProject();
  const cache = join(p.dir, 'cache');
  const r = run(p, 'out', cache);
  assert.equal(r.ok, true, r.report);
  for (const name of ['photo.png', 'photo.jpg']) {
    const entry = entryOf(p.dir, cache, name);
    assert.deepEqual(entry.shipped, [480, 768, 1200], `${name}: every width ships`);
    assert.deepEqual(Object.values(entry.modes), ['lossy', 'lossy', 'lossy'], `${name}: lossy`);
    const a = imgs(appOf(p.dir, 'out')).find((x) => x.src === `/assets/${name}`)!;
    for (const c of candidates(a.srcset).filter((x) => x.url.startsWith(`/${VARIANT_DIR}/`))) {
      assert.equal(webpChunk(readFileSync(join(p.dir, 'out/public', c.url))), 'VP8 ', `${c.url} is lossy WebP`);
    }
  }
});

test('the size guard: near-lossless where lossless outgrows the source, nothing where both do; the original stands in', async () => {
  const p = await modesProject();
  const cache = join(p.dir, 'cache');
  const r = run(p, 'out', cache);
  assert.equal(r.ok, true, r.report);
  const source = readFileSync(join(p.dir, 'assets/lean.png'));
  const entry = entryOf(p.dir, cache, 'lean.png');
  assert.deepEqual(entry.widths, [480, 768, 1200, 1800]);
  assert.deepEqual(entry.shipped, [480, 768], 'the two widest outgrow the file in every mode');
  const id = imageId(source);
  for (const w of entry.widths) {
    const file = join(cache, `${id}-${w}.webp`);
    if (entry.shipped.includes(w)) {
      assert.ok(statSync(file).size <= source.length, `${w}: shipped, and no larger than the source`);
      assert.equal(webpChunk(readFileSync(file)), 'VP8L', `${w}: lossless WebP (near-lossless is lossless coding of adjusted pixels)`);
      if (entry.modes[String(w)] === 'near-lossless') {
        const lossless = await sharp(source).autoOrient().resize({ width: w, ...ENCODING.resize }).webp(ENCODING.lossless).toBuffer();
        assert.ok(lossless.length > source.length, `${w}: lossless (${lossless.length}B) was larger than the source (${source.length}B)`);
      }
    } else {
      assert.equal(existsSync(file), false, `${w}: not written`);
      // Every mode it would have tried is larger than the source.
      const fitted = () => sharp(source).autoOrient().resize({ width: w, ...ENCODING.resize });
      for (const options of [ENCODING.lossless, ENCODING.nearLossless]) {
        assert.ok((await fitted().webp(options).toBuffer()).length > source.length, `${w}: ${options.nearLossless ? 'near-lossless' : 'lossless'} is larger`);
      }
    }
  }
  assert.deepEqual(entry.modes, { 480: 'lossless', 768: 'near-lossless' }, 'lossless where it fits, near-lossless where only it does');
  const lean = imgs(appOf(p.dir, 'out')).find((a) => a.src === '/assets/lean.png')!;
  const set = candidates(lean.srcset);
  assert.deepEqual(set.map((c) => c.width), [...entry.shipped, 2000], 'the shipped widths, then the 2000px original in the dropped widest\'s place');
  assert.equal(set.at(-1)!.url, '/assets/lean.png');
  const shipped = new Set(variantsIn(p.dir, 'out'));
  for (const c of set.slice(0, -1)) assert.ok(shipped.has(c.url.split('/').pop()!), `${c.url} ships`);
  assert.equal([...shipped].filter((n) => n.startsWith(id)).length, entry.shipped.length, 'no dropped width is in the output');
  // Warm: the same page from the cache, nothing encoded.
  const again = run(p, 'warm', cache);
  assert.equal(again.ok, true, again.report);
  assert.equal(appOf(p.dir, 'warm'), appOf(p.dir, 'out'));
});

test('determinism: the modes and the size guard give the same names and bytes from two cold caches', async () => {
  const p = await modesProject();
  const a = run(p, 'a', join(p.dir, 'cache-a'));
  const b = run(p, 'b', join(p.dir, 'cache-b'));
  assert.equal(a.ok && b.ok, true, `${a.report}\n${b.report}`);
  assert.equal(appOf(p.dir, 'a'), appOf(p.dir, 'b'));
  const names = variantsIn(p.dir, 'a');
  assert.deepEqual(variantsIn(p.dir, 'b'), names);
  for (const n of names) {
    assert.ok(readFileSync(join(p.dir, 'a/public', VARIANT_DIR, n)).equals(readFileSync(join(p.dir, 'b/public', VARIANT_DIR, n))), `${n} is byte-identical`);
  }
  for (const name of ['diagram.png', 'photo.png', 'photo.jpg', 'lean.png']) {
    assert.deepEqual(entryOf(p.dir, join(p.dir, 'cache-a'), name), entryOf(p.dir, join(p.dir, 'cache-b'), name), `${name}: the same entry`);
  }
});

test('rule 1 through the sandbox: a JPEG whose frame header lies past 2MB of APP1 gets its size, and no warning', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'az-buried-'));
  mkdirSync(join(dir, 'assets'));
  const phone = await phoneJpeg(64, 32, 6);
  const exifEnd = 4 + phone.readUInt16BE(4);
  // 33 APP1 segments of 64KB — 2MB of extended XMP, as an editor writes it — between the EXIF and the frame.
  const run = Buffer.concat(Array.from({ length: 33 }, () => {
    const s = Buffer.alloc(4 + 65533);
    s.writeUInt16BE(0xffe1, 0);
    s.writeUInt16BE(65535, 2);
    s.write('http://ns.example/extension\0', 4, 'latin1');
    return s;
  }));
  const file = Buffer.concat([phone.subarray(0, exifEnd), run, phone.subarray(exifEnd)]);
  writeFileSync(join(dir, 'assets/buried.jpg'), file);
  assert.ok(file.indexOf(Buffer.from([0xff, 0xc0]), 4) > 2 * 1024 * 1024, 'CONTROL: the frame header lies past 2MB');
  writeFileSync(join(dir, 'site.az'), `az 1
site "Buried"

page /
  feature rows
    item "Oak"
      media ./assets/buried.jpg
      text "Forty pairs a month."
    item "Ash"
      text "Each by hand."
`, 'utf8');
  const r = build({ source: join(dir, 'site.az'), outDir: join(dir, 'out'), wordsDir: WORDS, imageCache: null });
  assert.equal(r.ok, true, r.report);
  const img = imgs(appOf(dir, 'out')).find((a) => a.src === '/assets/buried.jpg')!;
  assert.deepEqual([img.width, img.height], ['32', '64'], 'the displayed size: 64×32 stored, turned by its EXIF');
  assert.doesNotMatch(r.report, /can't read the size/);
});

test('the pins agree: the CLI\'s library, the backend\'s, and the encoding hashed into every name', () => {
  const cli = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.equal(cli.dependencies.sharp, BACKEND_PINS.sharp, 'the vetted version (stack-evaluation §14)');
  assert.equal(ENCODING.versions.library, cli.dependencies.sharp);
  assert.deepEqual(
    { library: sharp.versions.sharp, core: sharp.versions.vips, webp: sharp.versions.webp },
    ENCODING.versions, 'the installed library is the pinned one');
  const gallery = JSON.parse(readFileSync(join(WORDS, 'gallery/word.json'), 'utf8')) as
    { slots: { image: { props: { src: { maxBytes: number } } } } };
  assert.equal(gallery.slots.image.props.src.maxBytes, 500 * 1024, 'the manifest\'s budget is the warning\'s 500KB');
});
