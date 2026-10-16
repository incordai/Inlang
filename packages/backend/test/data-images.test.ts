/**
 * The image pipeline (data-images.ts) against data-spec §8 and §13: only
 * JPEG, PNG, WebP and AVIF by their first bytes; SVG, HTML, text, GIF, TIFF
 * and HEIC refused whatever they are called; decompression bombs and
 * over-side images refused from the header; nothing of a phone photo's EXIF,
 * GPS, XMP, ICC profile or comments in the stored file; the orientation
 * applied to the pixels; the queue bounded; memory bounded while many large
 * uploads arrive at once; generated names only; the orphan sweep. Width
 * copies (data-spec §8): 480, 768 and 1200 beside the stored file, only
 * narrower ones, placed with their key or not at all, removed with it, swept
 * with it, and given to keys stored before them by the backfill. Each
 * refusal has a CONTROL that the same path accepts a real image.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
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

/** The module's own folders in a files directory: its temporaries and its leases (data-lease.ts). */
const FOLDERS = new Set(['.tmp', '.leases']);

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
  // Timed by this process's CPU (decoding would run on its thread pool),
  // not the wall clock, which also counts whatever else the machine is running.
  for (const [what, b] of cases) {
    const t0 = process.cpuUsage();
    assert.equal(await refusal(images, b), 'too_large', what);
    const used = process.cpuUsage(t0);
    assert.ok((used.user + used.system) / 1000 < 1000, `${what}: refused without decoding`);
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

test('names are generated: <uuid>.full.webp (and <uuid>.webp from before copies); pathOf refuses anything else (no traversal)', async () => {
  const s = await store(images, await plainJpeg(8, 8));
  assert.match(s.key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.full\.webp$/);
  assert.equal(images.pathOf(s.key), join(dir, s.key));
  const legacy = `${randomUUID()}.webp`;
  assert.equal(images.pathOf(legacy), join(dir, legacy), 'CONTROL: a key stored before width copies is still served');
  const uuid = s.key.slice(0, 36);
  for (const bad of ['../etc/passwd', `../${s.key}`, `${s.key}/..`, '.tmp', `x${s.key}`, s.key.toUpperCase(), `${s.key}\0`, '',
    `${uuid}.480.webp`, `${uuid}.full.webp.part`, `${uuid}.full.png`]) {
    assert.equal(images.pathOf(bad), null, bad);
  }
  await images.remove('../../outside');
  await images.remove(s.key);
  assert.equal(existsSync(join(dir, s.key)), false);
});

/* ---- width copies (data-spec §8, gallery-spec §7 rule 3) --------------- */

/** The files a key's UUID has in the folder, by suffix, with each one's size. */
async function setOf(d: string, key: string): Promise<Record<string, [number, number]>> {
  const uuid = key.slice(0, 36);
  const out: Record<string, [number, number]> = {};
  for (const name of readdirSync(d).filter((n) => n.startsWith(uuid)).sort()) {
    const m = await sharp(readFileSync(join(d, name))).metadata();
    out[name.slice(37)] = [m.width!, m.height!];
  }
  return out;
}

test('width copies: an upload is stored at its fitted size and at 480, 768 and 1200 — only the narrower ones, never upscaled', async () => {
  const { dir: d, images: q } = await fresh();
  const big = await store(q, await plainJpeg(3000, 2000));
  assert.deepEqual([big.width, big.height], [2048, 1365]);
  assert.deepEqual(await setOf(d, big.key), {
    '1200.webp': [1200, 800], '480.webp': [480, 320], '768.webp': [768, 512], 'full.webp': [2048, 1365],
  });
  const mid = await store(q, await plainJpeg(1000, 600));
  assert.deepEqual(await setOf(d, mid.key), { '480.webp': [480, 288], '768.webp': [768, 461], 'full.webp': [1000, 600] }, 'no 1200 copy of a 1000 px image');
  const tall = await store(q, await plainJpeg(900, 3000));
  assert.deepEqual(await setOf(d, tall.key), { '480.webp': [480, 1601], 'full.webp': [614, 2048] }, 'a portrait fitted to 2048 tall is 614 wide: only the 480 copy');
  for (const [w, h] of [[480, 300], [300, 200]]) {
    const small = await store(q, await plainJpeg(w, h));
    assert.deepEqual(await setOf(d, small.key), { 'full.webp': [w, h] }, `${w} px wide: no copy at or above its own width`);
  }
  for (const [w, path] of [[480, q.pathOf(big.key, 480)], [768, q.pathOf(big.key, 768)], [1200, q.pathOf(big.key, 1200)]] as const) {
    assert.equal(path, join(d, `${big.key.slice(0, 36)}.${w}.webp`));
  }
  // Transparency survives into every copy (four channels through the shared pixels).
  const clear = await sharp({ create: { width: 1000, height: 500, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0.5 } } }).png().toBuffer();
  const alpha = await store(q, clear);
  for (const name of Object.keys(await setOf(d, alpha.key))) {
    assert.equal((await sharp(readFileSync(join(d, `${alpha.key.slice(0, 36)}.${name}`))).metadata()).hasAlpha, true, name);
  }
  for (const w of [0, 479, 481, 1024, 2048, Number.NaN]) assert.equal(q.pathOf(big.key, w), null, `width ${w}`);
  assert.equal(q.pathOf(`${randomUUID()}.webp`, 480), null, 'a key from before copies has none');
  assert.deepEqual(readdirSync(join(d, '.tmp')), [], 'no part left');
});

test('width copies carry no metadata either: a phone photo\'s copies are rotated and clean', async () => {
  const { dir: d, images: q } = await fresh();
  const s = await store(q, await phoneJpeg(1600, 800, 6));
  assert.deepEqual(await setOf(d, s.key), { '480.webp': [480, 960], '768.webp': [768, 1536], 'full.webp': [800, 1600] });
  for (const name of readdirSync(d).filter((n) => n.startsWith(s.key.slice(0, 36)))) {
    const bytes = readFileSync(join(d, name));
    assert.deepEqual(metadataFindings(bytes), [], name);
    const m = await sharp(bytes).metadata();
    assert.deepEqual([m.orientation, m.exif, m.icc, m.xmp], [undefined, undefined, undefined, undefined], name);
  }
});

test('width copies are written with their key or not at all: a failed placement leaves nothing', async () => {
  const { dir: d, images: q } = await fresh();
  // Renaming into the folder fails (read-only): every encoded part is removed.
  chmodSync(d, 0o500);
  try {
    await assert.rejects(store(q, await plainJpeg(1600, 1000)), { code: 'EACCES' });
  } finally {
    chmodSync(d, 0o700);
  }
  assert.deepEqual(readdirSync(d).filter((n) => !FOLDERS.has(n)), []);
  assert.deepEqual(readdirSync(join(d, '.tmp')), []);
  // The key's own rename fails after the copies are in: they are taken out again.
  const legacy = `${randomUUID()}.webp`;
  writeFileSync(join(d, legacy), await plainWebp(1600, 900));
  const blocker = join(d, `${legacy.slice(0, 36)}.full.webp`);
  mkdirSync(blocker);
  writeFileSync(join(blocker, 'x'), 'occupied');
  await assert.rejects(q.addWidths(legacy));
  assert.deepEqual(readdirSync(d).filter((n) => !FOLDERS.has(n)).sort(), [legacy, `${legacy.slice(0, 36)}.full.webp`].sort(), 'no copy outlived the failure');
  assert.deepEqual(readdirSync(join(d, '.tmp')), []);
  rmSync(blocker, { recursive: true });
  // CONTROL: the same backfill with the way clear places all four.
  const done = await q.addWidths(legacy);
  assert.equal(done?.key, `${legacy.slice(0, 36)}.full.webp`);
  assert.deepEqual(Object.keys(await setOf(d, legacy)).sort(), ['1200.webp', '480.webp', '768.webp', 'full.webp', 'webp']);
});

test('remove takes a key\'s file and every copy; a key from before copies, its one file', async () => {
  const { dir: d, images: q } = await fresh();
  const s = await store(q, await plainJpeg(1600, 1000));
  const other = await store(q, await plainJpeg(1600, 1000));
  assert.equal(Object.keys(await setOf(d, s.key)).length, 4, 'CONTROL: four files');
  await q.remove(s.key);
  assert.deepEqual(await setOf(d, s.key), {});
  assert.equal(Object.keys(await setOf(d, other.key)).length, 4, 'another key\'s files are untouched');
  const legacy = `${randomUUID()}.webp`;
  writeFileSync(join(d, legacy), await plainWebp(64, 64));
  await q.remove(legacy);
  assert.equal(existsSync(join(d, legacy)), false);
  // A copy's name is not a key: removing by it removes nothing.
  await q.remove(`${other.key.slice(0, 36)}.480.webp`);
  assert.equal(Object.keys(await setOf(d, other.key)).length, 4);
});

test('the backfill: a key from before copies gets them under the same UUID, its bytes copied as they are', async () => {
  const { dir: d, images: q } = await fresh();
  const legacy = `${randomUUID()}.webp`;
  const bytes = await plainWebp(1600, 900);
  writeFileSync(join(d, legacy), bytes);
  const s = await q.addWidths(legacy);
  assert.deepEqual(s, { key: `${legacy.slice(0, 36)}.full.webp`, width: 1600, height: 900 });
  assert.deepEqual(await setOf(d, legacy), {
    '1200.webp': [1200, 675], '480.webp': [480, 270], '768.webp': [768, 432], 'full.webp': [1600, 900], webp: [1600, 900],
  }, 'the old file stays until no row names it (the caller drops it)');
  assert.ok(readFileSync(join(d, s!.key)).equals(bytes), 'the stored file is the same bytes: a cached copy of its URL stays right');
  assert.equal(await q.addWidths(s!.key), null, 'a key with copies is not widened again');
  assert.equal(await q.addWidths(`${randomUUID()}.webp`), null, 'a missing file: nothing to do');
  assert.equal(await q.addWidths('../x.webp'), null);
  const corrupt = `${randomUUID()}.webp`;
  writeFileSync(join(d, corrupt), bytes.subarray(0, 60));
  await assert.rejects(q.addWidths(corrupt), (e: unknown) => e instanceof ImageError && e.code === 'unsupported_type');
  assert.deepEqual(readdirSync(d).filter((n) => n.startsWith(corrupt.slice(0, 36))), [corrupt], 'nothing written for a file that does not decode');
});

test('the queue: one image at a time, a bounded wait, and 429 beyond it', async () => {
  const { dir: qdir, images: q } = await fresh();
  const big = await plainJpeg(4000, 3000);
  const jobs = Array.from({ length: IMAGE_LIMITS.queueMax + 4 }, () => store(q, big).then(() => 'ok', (e: unknown) => (e as ImageError).code));
  await new Promise((r) => setImmediate(r));
  assert.ok(q.pending() <= IMAGE_LIMITS.queueMax + 1);
  const results = await Promise.all(jobs);
  assert.equal(results.filter((r) => r === 'ok').length, IMAGE_LIMITS.queueMax + 1, results.join(','));
  assert.ok(results.filter((r) => r === 'rate_limited').length === 3, results.join(','));
  assert.equal(q.pending(), 0);
  // The backfill's work is queued with the uploads: with the queue full it is refused the same way.
  const legacy = `${randomUUID()}.webp`;
  writeFileSync(join(qdir, legacy), await plainWebp(1600, 900));
  const full = Array.from({ length: IMAGE_LIMITS.queueMax + 1 }, () => store(q, big));
  await assert.rejects(q.addWidths(legacy), (e: unknown) => e instanceof ImageError && e.code === 'rate_limited');
  await Promise.all(full);
  assert.equal((await q.addWidths(legacy))?.width, 1600, 'CONTROL: with room in the queue it runs');
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
  // Each with its three width copies; a legacy key in use; a legacy file whose row moved to its widened key.
  const [kept, orphan, young] = [await store(q, await plainJpeg(1600, 1000)), await store(q, await plainJpeg(1600, 1000)), await store(q, await plainJpeg(1600, 1000))];
  const [legacyKept, moved] = [`${randomUUID()}.webp`, `${randomUUID()}.webp`];
  for (const k of [legacyKept, moved]) writeFileSync(join(d, k), await plainWebp(900, 600));
  const widened = (await q.addWidths(moved))!;
  const staleTemp = join(d, '.tmp', 'x.upload');
  writeFileSync(staleTemp, 'partial');
  const old = new Date(Date.now() - IMAGE_LIMITS.sweepGraceMs - 60_000);
  for (const n of readdirSync(d).filter((x) => !x.startsWith(young.key.slice(0, 36)) && x !== '.tmp')) utimesSync(join(d, n), old, old);
  utimesSync(staleTemp, old, old);
  writeFileSync(join(d, 'not-ours.txt'), 'left alone');
  utimesSync(join(d, 'not-ours.txt'), old, old);
  assert.equal(await q.sweep(new Set([kept.key, legacyKept, widened.key])), 4 + 1 + 1, 'the orphan\'s four files, the moved key\'s old file, the stale temporary');
  const files = (k: string) => readdirSync(d).filter((n) => n.startsWith(k.slice(0, 36))).sort();
  assert.deepEqual(files(orphan.key), []);
  assert.equal(files(kept.key).length, 4, 'an in-use key keeps every copy');
  assert.equal(files(young.key).length, 4, 'young files are kept');
  assert.deepEqual(files(legacyKept), [legacyKept]);
  assert.deepEqual(files(moved), [`${moved.slice(0, 36)}.480.webp`, `${moved.slice(0, 36)}.768.webp`, widened.key].sort(), 'the moved key: its new files, not the old one');
  assert.ok(existsSync(join(d, 'not-ours.txt')));
  assert.deepEqual(readdirSync(join(d, '.tmp')), []);
});
