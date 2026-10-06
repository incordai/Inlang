/**
 * The image pipeline (data-images.ts) against data-spec §8 and §13: only
 * JPEG, PNG, WebP and AVIF by their first bytes; SVG, HTML, text, GIF, TIFF
 * and HEIC refused whatever they are called; decompression bombs and
 * over-side images refused from the header; nothing of a phone photo's EXIF,
 * GPS, XMP, ICC profile or comments in the stored file; the orientation
 * applied to the pixels; the queue bounded; memory bounded while many large
 * uploads arrive at once; generated names only; the orphan sweep. Each
 * refusal has a CONTROL that the same path accepts a real image.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { createImages, IMAGE_LIMITS, ImageError, sniffImage, type Images } from '../src/server/data-images.ts';
import {
  HEIC, HTML, jpegClaiming, metadataFindings, phoneJpeg, plainAvif, plainGif, plainJpeg, plainTiff, plainWebp,
  pngClaiming, polyglotJpeg, SVG, taggedPng, TEXT, webpChunks,
} from './image-fixtures.ts';

const fresh = async (): Promise<{ dir: string; images: Images }> => {
  const dir = mkdtempSync(join(tmpdir(), 'az-images-'));
  return { dir, images: await createImages({ dir }) };
};

/** Write bytes where an upload would stream them, then store. */
async function store(images: Images, bytes: Buffer) {
  const temp = images.tempPath();
  writeFileSync(temp, bytes);
  return images.store(temp);
}

async function refusal(images: Images, bytes: Buffer): Promise<string> {
  try {
    await store(images, bytes);
  } catch (e) {
    if (e instanceof ImageError) return e.code;
    throw e;
  }
  return 'accepted';
}

const { images, dir } = await fresh();

test('sniff: the four types by their first bytes; HEIC named; everything else nothing', async () => {
  assert.equal(sniffImage(await plainJpeg(4, 4)), 'jpeg');
  assert.equal(sniffImage(await taggedPng()), 'png');
  assert.equal(sniffImage(await plainWebp(4, 4)), 'webp');
  assert.equal(sniffImage(await plainAvif(4, 4)), 'avif');
  assert.equal(sniffImage(HEIC), 'heic');
  for (const b of [SVG, HTML, TEXT, await plainGif(4, 4), await plainTiff(4, 4), Buffer.alloc(0), Buffer.from([0xff, 0xd8])]) {
    assert.equal(sniffImage(b), null);
  }
});

test('refused by content, whatever the name: SVG, HTML, text, GIF, TIFF (415) — CONTROL: a JPEG is stored', async () => {
  for (const b of [SVG, HTML, TEXT, await plainGif(8, 8), await plainTiff(8, 8)]) {
    assert.equal(await refusal(images, b), 'unsupported_type');
  }
  assert.equal(await refusal(images, await plainJpeg(8, 8)), 'accepted');
});

test('HEIC is refused with its own clear code path (415), not decoded', async () => {
  assert.equal(await refusal(images, HEIC), 'unsupported_type');
});

test('the sniff is the gate, not only the decoder: a file branded HEIC is refused though the library would decode it', async () => {
  const avif = Buffer.from(await plainAvif(16, 16));
  // Every brand in its ftyp box renamed from AVIF to HEIC: the pixels stay AV1.
  const end = avif.readUInt32BE(0);
  const branded = Buffer.from(avif);
  for (let i = 8; i + 4 <= end; i += 4) if (i !== 12 && /^avi[fs]$/.test(branded.toString('latin1', i, i + 4))) branded.write('heic', i, 'latin1');
  assert.equal((await sharp(branded).metadata()).width, 16, 'CONTROL: the allowed HEIF loader would decode it');
  assert.equal(sniffImage(branded), 'heic');
  assert.equal(await refusal(images, branded), 'unsupported_type');
  // AVIF with a generic major brand and avif among the compatible ones is AVIF.
  const generic = Buffer.from(avif);
  generic.write('mif1', 8, 'latin1');
  assert.equal(sniffImage(generic), 'avif');
  assert.equal(await refusal(images, generic), 'accepted', 'CONTROL: a generic major brand with avif compatible is AVIF');
  assert.equal(await refusal(images, avif), 'accepted', 'CONTROL: the same image branded avif is stored');
});

test('a truncated or corrupt image is refused (failOn error) — never half-stored', async () => {
  const jpeg = await plainJpeg(200, 200);
  const before = readdirSync(dir).filter((n) => n.endsWith('.webp')).length;
  assert.equal(await refusal(images, jpeg.subarray(0, Math.floor(jpeg.length / 2))), 'unsupported_type');
  assert.equal(await refusal(images, Buffer.concat([jpeg.subarray(0, 40), Buffer.alloc(400, 0x55)])), 'unsupported_type');
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.webp')).length, before, 'no stored file');
  assert.deepEqual(readdirSync(join(dir, '.tmp')), [], 'no temporary file left');
});

test('the decoder allow-list holds even past the sniff: SVG, GIF, TIFF cannot be decoded in this process', async () => {
  for (const b of [SVG, await plainGif(4, 4), await plainTiff(4, 4)]) {
    await assert.rejects(sharp(b).metadata(), /blocked|unsupported|not a known/i);
  }
  // CONTROL: an allowed loader still decodes.
  assert.equal((await sharp(await plainJpeg(4, 4)).metadata()).width, 4);
});

test('pixel bombs and over-side images are refused from the header, before decoding (413)', async () => {
  const cases: [string, Buffer][] = [
    ['png 100000²', await pngClaiming(100_000, 100_000)],
    ['png 8001 wide', await pngClaiming(IMAGE_LIMITS.maxSide + 1, 10)],
    ['png 7000² = 49 MP', await pngClaiming(7000, 7000)],
    ['jpeg 60000²', await jpegClaiming(60_000, 60_000)],
    ['jpeg 8001 tall', await jpegClaiming(10, IMAGE_LIMITS.maxSide + 1)],
  ];
  for (const [what, b] of cases) {
    const t0 = performance.now();
    assert.equal(await refusal(images, b), 'too_large', what);
    assert.ok(performance.now() - t0 < 1000, `${what}: refused without decoding`);
  }
});

test('CONTROL: 8000 × 5000 (exactly 40 MP, each side at the cap) is accepted and stored at 2048 × 1280', async () => {
  const s = await store(images, await plainJpeg(8000, 5000));
  assert.deepEqual([s.width, s.height], [2048, 1280]);
});

test('a phone photo: no EXIF, GPS, XMP, ICC or comment survives; the orientation is applied to the pixels', async () => {
  const input = await phoneJpeg(64, 32, 6);
  assert.ok(metadataFindings(input).length >= 5, `CONTROL: the input carries metadata (${metadataFindings(input).join(', ')})`);
  const s = await store(images, input);
  const out = readFileSync(images.pathOf(s.key)!);
  assert.deepEqual(metadataFindings(out), []);
  assert.deepEqual(webpChunks(out).filter((c) => c !== 'VP8 ' && c !== 'VP8L' && c !== 'VP8X' && c !== 'ALPH'), [], 'only image chunks');
  const meta = await sharp(out).metadata();
  assert.deepEqual([meta.format, meta.width, meta.height, meta.orientation, meta.exif, meta.icc, meta.xmp], ['webp', 32, 64, undefined, undefined, undefined, undefined],
    'rotated 90° into a 32 × 64 portrait, with no orientation left to apply twice');
});

test('PNG with eXIf, XMP and a script comment, and a JPEG/HTML polyglot: stored clean', async () => {
  for (const input of [await taggedPng(), await polyglotJpeg()]) {
    assert.ok(metadataFindings(input).length > 0, 'CONTROL: the input is tagged');
    const s = await store(images, input);
    assert.deepEqual(metadataFindings(readFileSync(images.pathOf(s.key)!)), []);
  }
});

test('WebP and AVIF are accepted and re-encoded to WebP; small images keep their size', async () => {
  for (const b of [await plainWebp(300, 200), await plainAvif(300, 200)]) {
    const s = await store(images, b);
    assert.deepEqual([s.width, s.height], [300, 200]);
    assert.equal((await sharp(readFileSync(images.pathOf(s.key)!)).metadata()).format, 'webp');
  }
});

test('names are generated: <uuid>.webp; pathOf refuses anything else (no traversal)', async () => {
  const s = await store(images, await plainJpeg(8, 8));
  assert.match(s.key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.webp$/);
  assert.equal(images.pathOf(s.key), join(dir, s.key));
  for (const bad of ['../etc/passwd', `../${s.key}`, `${s.key}/..`, '.tmp', `x${s.key}`, s.key.toUpperCase(), `${s.key}\0`, '']) {
    assert.equal(images.pathOf(bad), null, bad);
  }
  await images.remove('../../outside');
  await images.remove(s.key);
  assert.equal(existsSync(join(dir, s.key)), false);
});

test('the queue: one image at a time, a bounded wait, and 429 beyond it', async () => {
  const { images: q } = await fresh();
  const big = await plainJpeg(4000, 3000);
  const jobs = Array.from({ length: IMAGE_LIMITS.queueMax + 4 }, () => store(q, big).then(() => 'ok', (e: unknown) => (e as ImageError).code));
  await new Promise((r) => setImmediate(r));
  assert.ok(q.pending() <= IMAGE_LIMITS.queueMax + 1);
  const results = await Promise.all(jobs);
  assert.equal(results.filter((r) => r === 'ok').length, IMAGE_LIMITS.queueMax + 1, results.join(','));
  assert.ok(results.filter((r) => r === 'rate_limited').length === 3, results.join(','));
  assert.equal(q.pending(), 0);
});

test('memory stays bounded with many large uploads at once — measured in a fresh process, with a CONTROL', () => {
  const run = (mode: 'queue' | 'unbounded') => {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('./image-memory.child.ts', import.meta.url)),
      mode, String(IMAGE_LIMITS.queueMax + 1), '6000', '4000'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout) as { baseMb: number; peakMb: number; ms: number };
  };
  const queued = run('queue');
  const unbounded = run('unbounded');
  const [q, u] = [queued.peakMb - queued.baseMb, unbounded.peakMb - unbounded.baseMb];
  process.stdout.write(`# memory: ${IMAGE_LIMITS.queueMax + 1} × 24 MP at once — queued +${q} MB (${queued.ms} ms), unbounded CONTROL +${u} MB (${unbounded.ms} ms), over ~${queued.baseMb} MB\n`);
  assert.ok(q < 300, `queued growth ${q} MB: one image at a time should stay near one image's worth`);
  assert.ok(u > q * 1.5, `CONTROL: without the queue the same uploads take more (${u} MB vs ${q} MB)`);
});

test('the sweep removes old unreferenced files and stale temporaries; keeps referenced and young ones', async () => {
  const { dir: d, images: q } = await fresh();
  const [kept, orphan, young] = [await store(q, await plainJpeg(8, 8)), await store(q, await plainJpeg(8, 8)), await store(q, await plainJpeg(8, 8))];
  const staleTemp = join(d, '.tmp', 'x.upload');
  writeFileSync(staleTemp, 'partial');
  const old = new Date(Date.now() - IMAGE_LIMITS.sweepGraceMs - 60_000);
  for (const p of [join(d, kept.key), join(d, orphan.key), staleTemp]) utimesSync(p, old, old);
  writeFileSync(join(d, 'not-ours.txt'), 'left alone');
  utimesSync(join(d, 'not-ours.txt'), old, old);
  assert.equal(await q.sweep(new Set([kept.key])), 2);
  assert.deepEqual(readdirSync(d).filter((n) => n !== '.tmp').sort(), [kept.key, 'not-ours.txt', young.key].sort());
  assert.deepEqual(readdirSync(join(d, '.tmp')), []);
});
