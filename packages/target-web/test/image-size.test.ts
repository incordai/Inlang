/**
 * imageSize — gallery-block-spec §7 rule 1: the displayed size from the header.
 *
 * Real files encoded by the vetted image library (the server's; test-only
 * here), hand-built headers for what an encoder will not write (an AVIF
 * rotation, a VP8X canvas), and a hostile corpus: every prefix of every file,
 * random bytes, and headers that lie. None may throw; none may return a
 * size the file does not have.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { bytesSource, imageSize, imageSizeOf, HEAD_BYTES, MAX_DIMENSION, MAX_READ_BYTES, type ByteSource } from '../src/image-size.ts';
import { jpegClaiming, phoneJpeg, pngClaiming } from '../../backend/test/image-fixtures.ts';

const base = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });

/* ---- real files ---------------------------------------------------------- */

test('PNG, GIF, JPEG, WebP (lossy and lossless) and AVIF: the encoded size', async () => {
  const cases: [string, Buffer][] = [
    ['png', await base(48, 24).png().toBuffer()],
    ['gif', await base(37, 19).gif().toBuffer()],
    ['jpeg', await base(640, 427).jpeg().toBuffer()],
    ['progressive jpeg', await base(300, 200).jpeg({ progressive: true }).toBuffer()],
    ['webp lossy', await base(321, 123).webp().toBuffer()],
    ['webp lossless', await base(1001, 7).webp({ lossless: true }).toBuffer()],
    ['webp with alpha (VP8X)', await base(64, 40).ensureAlpha(0.5).webp().toBuffer()],
    ['avif', await base(120, 80).avif().toBuffer()],
  ];
  const expected: Record<string, [number, number]> = {
    png: [48, 24], gif: [37, 19], jpeg: [640, 427], 'progressive jpeg': [300, 200],
    'webp lossy': [321, 123], 'webp lossless': [1001, 7], 'webp with alpha (VP8X)': [64, 40], avif: [120, 80],
  };
  for (const [name, bytes] of cases) {
    const [width, height] = expected[name];
    assert.deepEqual(imageSize(bytes), { width, height }, name);
  }
});

test('a phone JPEG turned by EXIF orientation 6 reports its upright size', async () => {
  assert.deepEqual(imageSize(await phoneJpeg(64, 32, 6)), { width: 32, height: 64 });
  assert.deepEqual(imageSize(await phoneJpeg(64, 32, 1)), { width: 64, height: 32 }, 'CONTROL: orientation 1');
  assert.deepEqual(imageSize(await phoneJpeg(64, 32, 3)), { width: 64, height: 32 }, 'CONTROL: a half turn keeps the sides');
});

test('the repository\'s own fixture images', () => {
  const at = (p: string) => readFileSync(fileURLToPath(new URL(`../../${p}`, import.meta.url)));
  assert.deepEqual(imageSize(at('core/test/fixture-assets/assets/orbit.webp')), { width: 1, height: 1 });
  const logo = imageSize(at('core/test/fixture-assets/assets/logo.svg'));
  assert.ok(logo && logo.width > 0 && logo.height > 0, JSON.stringify(logo));
});

/* ---- SVG ------------------------------------------------------------------ */

test('SVG: width/height, else the viewBox, a single side scaled by it', () => {
  const svg = (attrs: string) => Buffer.from(`<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}><rect/></svg>`);
  assert.deepEqual(imageSize(svg('width="96" height="32"')), { width: 96, height: 32 });
  assert.deepEqual(imageSize(svg('width="96px" height="32px"')), { width: 96, height: 32 });
  assert.deepEqual(imageSize(svg('viewBox="0 0 24 12"')), { width: 24, height: 12 });
  assert.deepEqual(imageSize(svg('width="48" viewBox="0 0 24 12"')), { width: 48, height: 24 });
  assert.deepEqual(imageSize(svg('width="100%" height="100%" viewBox="0, 0, 300, 100"')), { width: 300, height: 100 });
  const doctype = '﻿<?xml version="1.0"?><!-- Generator: an editor --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [ <!ENTITY ns "x"> ]>\n<svg width="40" height="20"></svg>';
  assert.deepEqual(imageSize(Buffer.from(doctype)), { width: 40, height: 20 }, 'an exported file: BOM, declaration, comment, doctype with a subset');
  assert.equal(imageSize(svg('width="2em" height="1em"')), null, 'units it cannot convert give no size');
  assert.equal(imageSize(svg('')), null, 'no size at all');
  assert.equal(imageSize(Buffer.from('<html><svg width="1" height="1"></svg></html>')), null, 'the root must be <svg>');
});

/* ---- AVIF/HEIF built by hand: rotation and the primary item -------------- */

function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
const full = (version = 0) => Buffer.from([version, 0, 0, 0]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };

/** An AVIF header: primary item 1 → ispe w×h (+ irot), item 2 a thumbnail → ispe 16×16. */
function avif(w: number, h: number, rotation: number | null, primary = 1) {
  const props = [
    box('ispe', full(), u32(16), u32(16)),         // index 1: the thumbnail's
    box('ispe', full(), u32(w), u32(h)),           // index 2: the primary's
    ...(rotation === null ? [] : [box('irot', Buffer.from([rotation]))]),  // index 3
  ];
  const primaryProps = rotation === null ? [0x02] : [0x02, 0x83];
  const ipma = box('ipma', full(), u32(2),
    u16(2), Buffer.from([1, 0x01]),
    u16(1), Buffer.from([primaryProps.length, ...primaryProps]));
  return Buffer.concat([
    box('ftyp', Buffer.from('avif'), u32(0), Buffer.from('mif1avif')),
    box('meta', full(), box('hdlr', full(), u32(0), Buffer.from('pict'), Buffer.alloc(13)),
      box('pitm', full(), u16(primary)),
      box('iprp', box('ipco', ...props), ipma)),
  ]);
}

test('AVIF: the PRIMARY item\'s ispe, turned by its irot', () => {
  assert.deepEqual(imageSize(avif(400, 300, null)), { width: 400, height: 300 });
  assert.deepEqual(imageSize(avif(400, 300, 1)), { width: 300, height: 400 }, 'a quarter turn swaps the sides');
  assert.deepEqual(imageSize(avif(400, 300, 2)), { width: 400, height: 300 }, 'CONTROL: a half turn does not');
  assert.deepEqual(imageSize(avif(400, 300, null, 2)), { width: 16, height: 16 }, 'pitm decides which ispe');
});

/* ---- hostile corpus -------------------------------------------------------- */

test('HOSTILE: every truncation of every file is null or the true size — never a throw, never a wrong size', async () => {
  const files: [Buffer, { width: number; height: number }][] = [
    [await base(48, 24).png().toBuffer(), { width: 48, height: 24 }],
    [await base(37, 19).gif().toBuffer(), { width: 37, height: 19 }],
    [await phoneJpeg(64, 32, 6), { width: 32, height: 64 }],
    [await base(321, 123).webp().toBuffer(), { width: 321, height: 123 }],
    [await base(1001, 7).webp({ lossless: true }).toBuffer(), { width: 1001, height: 7 }],
    [await base(64, 40).ensureAlpha(0.5).webp().toBuffer(), { width: 64, height: 40 }],
    [avif(400, 300, 1), { width: 300, height: 400 }],
  ];
  for (const [bytes, truth] of files) {
    for (let n = 0; n <= Math.min(bytes.length, 4096); n++) {
      const got = imageSize(bytes.subarray(0, n));
      if (got !== null) assert.deepEqual(got, truth, `prefix ${n}: ${JSON.stringify(got)}`);
    }
  }
});

test('HOSTILE: random bytes and random headers never throw', () => {
  let seed = 0x5eed;
  const rand = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 24; };
  const prefixes = [
    [0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8], [...Buffer.from('RIFF')], [...Buffer.from('GIF89a')],
    [0, 0, 0, 0x18, ...Buffer.from('ftypavif')], [...Buffer.from('<svg ')],
  ];
  for (let k = 0; k < 3000; k++) {
    const head = prefixes[k % prefixes.length];
    const bytes = Buffer.from([...head, ...Array.from({ length: rand() * 2 }, rand)]);
    const got = imageSize(bytes);
    if (got) assert.ok(got.width > 0 && got.height > 0 && got.width <= MAX_DIMENSION && got.height <= MAX_DIMENSION);
  }
});

test('HOSTILE: headers that lie about an absurd size give no size; plausible ones are read', async () => {
  assert.equal(imageSize(await pngClaiming(1_000_000, 10)), null, 'over MAX_DIMENSION');
  assert.equal(imageSize(await pngClaiming(0, 10)), null, 'zero');
  assert.deepEqual(imageSize(await pngClaiming(8000, 5000)), { width: 8000, height: 5000 }, 'CONTROL: a big but real header');
  assert.deepEqual(imageSize(await jpegClaiming(65000, 65000)), { width: 65000, height: 65000 });
});

test('HOSTILE: self-referencing and overflowing structures end', () => {
  // A JPEG whose segments all claim length 2: walks MAX_STEPS times, then null.
  const loop = Buffer.concat([Buffer.from([0xff, 0xd8]), ...Array.from({ length: 6000 }, () => Buffer.from([0xff, 0xe2, 0x00, 0x02]))]);
  assert.equal(imageSize(loop), null);
  // An ISO box claiming a size past the file, and one claiming 64-bit size.
  const past = Buffer.concat([u32(24), Buffer.from('ftypavif'), u32(0), Buffer.from('avif'), u32(4_000_000_000), Buffer.from('meta')]);
  assert.equal(imageSize(past), null);
  const huge = Buffer.concat([u32(1), Buffer.from('ftyp'), u32(1), u32(0)]);
  assert.equal(imageSize(huge), null);
  // An EXIF IFD pointing past its segment.
  const exif = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]), Buffer.from('Exif\0\0II*\0'), u32(0xffffff00).reverse()]);
  assert.equal(imageSize(exif), null);
  assert.equal(imageSize(new Uint8Array(0)), null);
});

/* ---- a JPEG walked through its file: the frame header past megabytes of metadata ---- */

const MB = 1024 * 1024;

/** An APPn segment of `bytes` payload bytes (at most 65533): an id, then zeros. */
function appSegment(marker: number, id: string, bytes: number): Buffer {
  const s = Buffer.alloc(4 + bytes);
  s[0] = 0xff;
  s[1] = marker;
  s.writeUInt16BE(bytes + 2, 2);
  s.write(id, 4, 'latin1');
  return s;
}

/** About `total` bytes of extended-XMP-style APP1 segments, each as long as a segment can be. */
function metadataRun(total: number): Buffer {
  const out: Buffer[] = [];
  for (let left = total; left > 0; left -= 65537) out.push(appSegment(0xe1, 'http://ns.example/extension\0', Math.min(65533, Math.max(32, left - 4))));
  return Buffer.concat(out);
}

/** A ByteSource over `bytes` (claiming `size`) that counts what it hands out. */
function counting(bytes: Uint8Array, size = bytes.length) {
  const seen = { reads: 0, bytes: 0, closed: false };
  const inner = bytesSource(bytes);
  const source: ByteSource = {
    size,
    read: (offset, length) => {
      const got = inner.read(offset, length);
      seen.reads++;
      seen.bytes += got.length;
      return got;
    },
    close: () => { seen.closed = true; },
  };
  return { source, seen };
}

/** A phone JPEG (64×32 stored, EXIF orientation 6) with `run` inserted after its EXIF, or before it. */
async function buriedJpeg(run: Buffer, where: 'after-exif' | 'before-exif' = 'after-exif'): Promise<Buffer> {
  const phone = await phoneJpeg(64, 32, 6);
  const exifEnd = 4 + phone.readUInt16BE(4);
  return where === 'after-exif'
    ? Buffer.concat([phone.subarray(0, exifEnd), run, phone.subarray(exifEnd)])
    : Buffer.concat([phone.subarray(0, 2), run, phone.subarray(2)]);
}

test('a JPEG with 2MB of APP1 before its frame header: the walk finds the size, reading the headers only', async () => {
  const file = await buriedJpeg(metadataRun(2 * MB));
  const meta = await sharp(file).metadata();
  assert.deepEqual([meta.width, meta.height, meta.orientation], [64, 32, 6], 'CONTROL: the library decodes it, a quarter turn');
  assert.ok(file.indexOf(Buffer.from([0xff, 0xc0]), 4) > 2 * MB, 'CONTROL: the frame header lies past 2MB');
  // The old read: the first 1MB through the sandbox — no size, and the build warned.
  assert.equal(imageSize(file.subarray(0, HEAD_BYTES)), null, 'CONTROL: the first 1MB holds no frame header');
  const { source, seen } = counting(file);
  assert.deepEqual(imageSizeOf(source), { width: 32, height: 64 }, 'the displayed size: turned by its EXIF');
  assert.ok(seen.bytes < 256 * 1024, `the metadata is skipped unread: ${seen.bytes} of ${file.length} bytes read in ${seen.reads} reads`);
  assert.equal(seen.closed, false, 'imageSizeOf leaves closing to its caller');
  // Its EXIF behind the run: still read, still turned.
  assert.deepEqual(imageSizeOf(bytesSource(await buriedJpeg(metadataRun(2 * MB), 'before-exif'))), { width: 32, height: 64 });
  assert.deepEqual(imageSize(file), { width: 32, height: 64 }, 'the same walk over bytes in memory');
});

test('the walk is bounded: a frame header past 20MB of skipped metadata is found; past 16MB of EXIF read it is not', async () => {
  const far = counting(await buriedJpeg(metadataRun(20 * MB)));
  assert.deepEqual(imageSizeOf(far.source), { width: 32, height: 64 }, 'skipping costs a window per segment, not the segment');
  assert.ok(far.seen.bytes < 2 * MB, `${far.seen.bytes} bytes read`);
  // Every one of 300 EXIF segments is read whole (the orientation lives there): past MAX_READ_BYTES, no size.
  const exifRun = Buffer.concat(Array.from({ length: 300 }, () => appSegment(0xe1, 'Exif\0\0', 65533)));
  const spent = counting(await buriedJpeg(exifRun));
  assert.equal(imageSizeOf(spent.source), null, 'the budget ran out: unknown, never guessed');
  assert.ok(spent.seen.bytes <= MAX_READ_BYTES, `${spent.seen.bytes} bytes read, at most ${MAX_READ_BYTES}`);
  // 20MB of fill bytes: the budget ends the walk.
  const filled = counting(Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(20 * MB, 0xff)]));
  assert.equal(imageSizeOf(filled.source), null);
  assert.ok(filled.seen.bytes <= MAX_READ_BYTES + 16, `${filled.seen.bytes} bytes read`);
});

test('HOSTILE: the walk never throws and never returns a wrong size — truncated, lying about its size, failing reads', async () => {
  const file = await buriedJpeg(metadataRun(2 * MB));
  const truth = { width: 32, height: 64 };
  const frame = file.indexOf(Buffer.from([0xff, 0xc0]), 4);
  // Every prefix of the first headers, a stride through the metadata, every prefix around the frame.
  const cuts = [
    ...Array.from({ length: 4096 }, (_, n) => n),
    ...Array.from({ length: 2200 }, (_, k) => 4096 + k * 997),
    ...Array.from({ length: 2048 }, (_, n) => frame - 1024 + n),
  ].filter((n) => n <= file.length);
  for (const n of cuts) {
    const got = imageSizeOf(bytesSource(file.subarray(0, n)));
    if (got !== null) assert.deepEqual(got, truth, `prefix ${n}: ${JSON.stringify(got)}`);
  }
  const frameEnd = frame + 2 + file.readUInt16BE(frame + 2);
  assert.deepEqual(imageSizeOf(bytesSource(file.subarray(0, frameEnd))), truth, 'CONTROL: a cut at the end of the frame header is read');
  assert.equal(imageSizeOf(bytesSource(file.subarray(0, frameEnd - 1))), null, 'CONTROL: a byte short of it is not');
  // A source claiming more than it holds: its reads come back short, which is the end.
  assert.equal(imageSizeOf(counting(file.subarray(0, frame), file.length).source), null, 'a file that shrank under the walk');
  // A read that throws: no size, no throw.
  const failing: ByteSource = {
    size: file.length,
    read: (offset, length) => {
      if (offset > MB) throw new Error('EIO');
      return file.subarray(offset, offset + length);
    },
    close: () => {},
  };
  assert.equal(imageSizeOf(failing), null);
  // Random segment chains after SOI — markers, lengths that lie, EXIF ids — from a fixed seed.
  let seed = 0xbeef;
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed >>> 8) % n; };
  const markers = [0xe0, 0xe1, 0xe2, 0xed, 0xfe, 0xdb, 0xc4, 0xc0, 0xc2, 0x01, 0xd0];
  for (let k = 0; k < 2000; k++) {
    const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
    for (let s = rand(12); s > 0; s--) {
      const marker = markers[rand(markers.length)];
      const body = Buffer.from(Array.from({ length: rand(64) }, () => rand(256)));
      if (marker === 0xe1 && rand(2) === 0) Buffer.from('Exif\0\0II*\0').copy(body, 0, 0, Math.min(10, body.length));
      const head = Buffer.from([0xff, marker, 0, 0]);
      head.writeUInt16BE(rand(4) === 0 ? rand(65536) : body.length + 2, 2);
      parts.push(head, body);
    }
    const bytes = Buffer.concat(parts);
    const got = imageSizeOf(bytesSource(bytes));
    assert.deepEqual(got, imageSize(bytes), `chain ${k}: the file walk and the memory walk agree`);
    if (got) assert.ok(got.width > 0 && got.height > 0 && got.width <= MAX_DIMENSION && got.height <= MAX_DIMENSION);
  }
});

test('imageSizeOf: every other format is read from its first HEAD_BYTES, as imageSize reads it', async () => {
  const files = [
    await base(48, 24).png().toBuffer(), await base(37, 19).gif().toBuffer(), await base(321, 123).webp().toBuffer(),
    avif(400, 300, 1), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 12"></svg>'),
  ];
  for (const bytes of files) {
    const { source, seen } = counting(bytes);
    const got = imageSizeOf(source);
    assert.ok(got !== null, 'CONTROL: each has a size');
    assert.deepEqual(got, imageSize(bytes));
    assert.ok(seen.reads <= 2, 'a sniff and the head');
  }
  assert.equal(imageSizeOf(bytesSource(new Uint8Array(0))), null);
});
