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
import { ENCODING, VARIANT_DIR } from '../src/images.ts';
import { imageSize } from '../../target-web/src/image-size.ts';

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
