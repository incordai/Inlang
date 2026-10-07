/**
 * The home-screen ("touch") icon through the real build (GRAMMAR §4.4):
 * a square PNG `site icon` over 180px is resized by the build's resizer to a
 * 180×180 PNG, content-hash named, declared on every page; exactly 180 ships
 * as it is; an SVG, a smaller or a non-square PNG gives none and warns
 * (AZ1422); no resizer, or one that cannot run, gives none. Never upscaled,
 * no metadata, byte-identical from two cold caches.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { build } from '../src/az.ts';
import { TOUCH_ENCODING, VARIANT_DIR } from '../src/images.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');

const SECRET = 'AZ-SECRET-ICON-COMMENT';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12"/></svg>\n';

/** A PNG with a disc, carrying EXIF that must never reach the touch icon. */
const png = (width: number, height = width) => sharp({
  create: { width, height, channels: 4, background: { r: 20, g: 120, b: 90, alpha: 1 } },
}).composite([{ input: Buffer.from(`<svg width="${width}" height="${height}"><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 3}" fill="#fff"/></svg>`) }])
  .png().withMetadata().withExif({ IFD0: { ImageDescription: SECRET } }).toBuffer();

async function project(icon: string, file: Uint8Array | string) {
  const dir = mkdtempSync(join(tmpdir(), 'az-touch-icon-'));
  writeFileSync(join(dir, 'site.az'), `az 1\nsite aurora\n  icon ./brand/${icon}\npage /\npage /about\n`, 'utf8');
  mkdirSync(join(dir, 'brand'), { recursive: true });
  writeFileSync(join(dir, 'brand', icon), file);
  return dir;
}

const run = (dir: string, out: string, imageCache: string | null) =>
  build({ source: join(dir, 'site.az'), outDir: join(dir, out), wordsDir: WORDS, imageCache });

const PAGES = ['index.html', 'about/index.html'];
const touchOf = (html: string) => /<link rel="apple-touch-icon" href="([^"]+)" \/>/.exec(html)?.[1] ?? null;
const pageOf = (dir: string, out: string, page = 'index.html') => readFileSync(join(dir, out, page), 'utf8');
const variantsIn = (dir: string, out: string) => {
  const at = join(dir, out, 'public', VARIANT_DIR);
  return existsSync(at) ? readdirSync(at).sort() : [];
};

/** The chunk types of a PNG, in order. */
function chunks(bytes: Buffer): string[] {
  const out: string[] = [];
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = bytes.readUInt32BE(at);
    out.push(bytes.toString('latin1', at + 4, at + 8));
    at += 12 + length;
  }
  return out;
}

test('a square PNG over 180px gives a 180×180 PNG touch icon, content-hash named, on every page', async () => {
  const dir = await project('icon.png', await png(512));
  const r = run(dir, 'out', join(dir, 'cache'));
  assert.equal(r.ok, true, r.report);
  assert.doesNotMatch(r.report, /AZ1422|home-screen/, 'a usable icon warns nothing');
  const hrefs = PAGES.map((page) => touchOf(pageOf(dir, 'out', page)));
  assert.match(hrefs[0] ?? '', new RegExp(`^/${VARIANT_DIR}/[0-9a-f]{16}-180\\.png$`));
  assert.deepEqual(hrefs, [hrefs[0], hrefs[0]], 'every page declares the same file');
  assert.match(pageOf(dir, 'out'), /<link rel="icon" type="image\/png" href="\/brand\/icon\.png" \/>\n {4}<link rel="apple-touch-icon"/,
    'declared right after the icon');
  const file = readFileSync(join(dir, 'out/public', hrefs[0]!));
  const meta = await sharp(file).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height], ['png', 180, 180]);
  assert.ok(readFileSync(join(dir, 'brand/icon.png')).includes(SECRET), 'CONTROL: the source carries metadata');
  assert.ok(!file.includes(SECRET), 'no metadata reaches the touch icon');
  // pHYs, the pixel density the writer always states, is the one ancillary
  // chunk: no text, time, EXIF, colour profile or palette.
  assert.deepEqual(chunks(file).filter((c) => c !== 'IDAT'), ['IHDR', 'pHYs', 'IEND'], 'no metadata chunk');
  assert.deepEqual(variantsIn(dir, 'out'), [hrefs[0]!.split('/').pop()], 'the one file ships under the variant folder');
});

test('determinism: two cold caches give the same name and bytes', async () => {
  const dir = await project('icon.png', await png(400));
  const a = run(dir, 'a', join(dir, 'cache-a'));
  const b = run(dir, 'b', join(dir, 'cache-b'));
  assert.equal(a.ok && b.ok, true, `${a.report}\n${b.report}`);
  for (const page of PAGES) assert.equal(pageOf(dir, 'a', page), pageOf(dir, 'b', page), page);
  const href = touchOf(pageOf(dir, 'a'))!;
  assert.ok(readFileSync(join(dir, 'a/public', href)).equals(readFileSync(join(dir, 'b/public', href))), 'byte-identical');
});

test('exactly 180×180: the icon itself is the touch icon, not re-encoded', async () => {
  const dir = await project('icon.png', await png(180));
  const r = run(dir, 'out', join(dir, 'cache'));
  assert.equal(r.ok, true, r.report);
  for (const page of PAGES) assert.equal(touchOf(pageOf(dir, 'out', page)), '/brand/icon.png', page);
  assert.deepEqual(variantsIn(dir, 'out'), [], 'nothing encoded');
  assert.ok(readFileSync(join(dir, 'out/public/brand/icon.png')).equals(readFileSync(join(dir, 'brand/icon.png'))));
});

test('AZ1422 and no touch icon: an SVG, a PNG under 180px, a PNG that is not square — never upscaled', async () => {
  const cases: [string, Uint8Array | string, RegExp][] = [
    ['icon.svg', SVG, /site\.az:3:8 warning AZ1422 {2}site: icon '\.\/brand\/icon\.svg' is an SVG, and a home-screen icon must be a PNG — the site has none; use a square PNG of 180×180 or more for one/],
    ['icon.png', await png(64), /site\.az:3:8 warning AZ1422 {2}site: icon '\.\/brand\/icon\.png' is 64×64, and a home-screen icon needs a square PNG of 180×180 or more — the site has none; it is never upscaled/],
    ['icon.png', await png(179), /AZ1422 {2}site: icon '\.\/brand\/icon\.png' is 179×179/],
    ['icon.png', await png(400, 300), /AZ1422 {2}site: icon '\.\/brand\/icon\.png' is 400×300/],
  ];
  for (const [icon, file, message] of cases) {
    const dir = await project(icon, file);
    const r = run(dir, 'out', join(dir, 'cache'));
    assert.equal(r.ok, true, `${icon}: a warning never blocks — ${r.report}`);
    assert.match(r.report, message, r.report);
    for (const page of PAGES) assert.equal(touchOf(pageOf(dir, 'out', page)), null, `${icon} ${page}`);
    assert.deepEqual(variantsIn(dir, 'out'), [], 'nothing encoded');
    assert.ok(!existsSync(join(dir, 'cache')) || readdirSync(join(dir, 'cache')).length === 0, 'the resizer never ran');
  }
});

test('with no resizer the pages are exactly as before: no touch icon, nothing encoded', async () => {
  const dir = await project('icon.png', await png(512));
  const r = run(dir, 'out', null);
  assert.equal(r.ok, true, r.report);
  for (const page of PAGES) {
    const html = pageOf(dir, 'out', page);
    assert.equal(touchOf(html), null, page);
    assert.match(html, /<link rel="icon" type="image\/png" href="\/brand\/icon\.png" \/>\n {4}<title>/, 'the icon line, then the title, as before');
  }
  assert.deepEqual(variantsIn(dir, 'out'), []);
});

test('a resizer that cannot run is one warning, and no page names a file that was not made', async () => {
  const dir = await project('icon.png', await png(512));
  writeFileSync(join(dir, 'not-a-folder'), '');
  const r = run(dir, 'out', join(dir, 'not-a-folder', 'cache'));
  assert.equal(r.ok, true, r.report);
  assert.match(r.report, /warning: icon: the resizer could not run \(the cache folder .* can't be written \(ENOTDIR\)\) — the site has none this build; build again to retry/);
  assert.doesNotMatch(r.report, /images? ships? as the original/, 'no image was counted');
  for (const page of PAGES) assert.equal(touchOf(pageOf(dir, 'out', page)), null, page);
  assert.deepEqual(variantsIn(dir, 'out'), []);
});

test('the touch icon pins the installed PNG writer', () => {
  assert.deepEqual(
    { png: sharp.versions.png, zlib: sharp.versions['zlib-ng'] },
    { png: TOUCH_ENCODING.versions.png, zlib: TOUCH_ENCODING.versions.zlib });
  assert.equal(TOUCH_ENCODING.size, 180);
});
