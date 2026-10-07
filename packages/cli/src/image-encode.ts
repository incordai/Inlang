/**
 * @az module image-encode
 * Purpose: the resizer's child process: decodes each image under the upload pipeline's limits and writes its WebP variants and cache entry.
 * Spec: docs/gallery-block-spec.md §7 rule 3 · docs/stack-evaluation.md §16
 * Exports: (none — a child process images.ts runs, one JSON job on stdin)
 * Edit guide: the order is the defence — decoder allow-list, header-only size check, bounded decode; never keep metadata; the entry is written last.
 * Tests: packages/cli/test/images.test.ts
 */

/**
 * Only this process loads the image library, so the compiler stays pure
 * and a decoder fault ends this child, not the build. It reads one JSON job
 * on stdin — `{ cacheDir, jobs: [{ id, file, widths }] }` — and for each
 * image writes its variants, then its cache entry (images.ts CacheEntry):
 *
 *   1. the library is the pinned one (ENCODING.versions) or nothing is
 *      encoded — a name must always mean the same encoder;
 *   2. every decoder is blocked but JPEG, PNG, WebP and HEIF (AVIF), the
 *      upload pipeline's allow-list (data-images.ts IMAGE_DECODERS);
 *   3. the header alone is read first: over 8000px a side or 40 megapixels
 *      is refused before any pixel is decoded;
 *   4. the decode is bounded by the same pixel limit and fails on any error;
 *      autoOrient turns the pixels upright, so a variant is drawn the way
 *      the browser draws the original;
 *   5. each width is fitted without enlarging and encoded to WebP with the
 *      pinned options; no metadata is kept — EXIF, GPS, XMP and comments
 *      never reach a variant;
 *   6. a file whose bytes no longer hash to its id is skipped: it changed
 *      after the build read it, and an entry would lie.
 *
 * Files are written beside their place and renamed, so a cache never holds
 * a half-written variant; the entry goes last, so an entry means complete.
 * Exit 0 when every job was handled (a failure is an entry, not an exit);
 * exit 2, with a line `az-image: <why>` on stderr, when nothing could be.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMAGE_DECODERS } from '../../backend/src/server/data-images.ts';
import { ENCODING, entryName, imageId, variantName, type CacheEntry, type EncodeJob } from './images.ts';

/** The exit code for "nothing could be encoded" — read by images.ts with the stderr line. */
const EXIT_UNAVAILABLE = 2;

function unavailable(why: string): never {
  process.stderr.write(`az-image: ${why}\n`);
  process.exit(EXIT_UNAVAILABLE);
}

/** Write `bytes` to `file` through a temporary name, so the file is whole or absent. */
function writeWhole(file: string, bytes: Uint8Array | string): void {
  const part = `${file}.${process.pid}.part`;
  writeFileSync(part, bytes, { mode: 0o600 });
  renameSync(part, file);
}

type Library = typeof import('sharp').default;

async function encodeOne(sharp: Library, cacheDir: string, job: EncodeJob, bytes: Buffer): Promise<CacheEntry> {
  let width: number;
  let height: number;
  try {
    // Header only — no pixel is decoded — so the pixel limit is lifted for
    // this read and a huge claim reaches the size check as "too large".
    const meta = await sharp(bytes, { ...ENCODING.decode, limitInputPixels: false }).metadata();
    width = meta.autoOrient.width;
    height = meta.autoOrient.height;
  } catch {
    return { failed: 'undecodable' };
  }
  if (!(width >= 1 && height >= 1)) return { failed: 'undecodable' };
  if (width > ENCODING.maxSide || height > ENCODING.maxSide || width * height > ENCODING.decode.limitInputPixels) {
    return { failed: 'too-large', width, height };
  }
  // Never upscale: every width asked for is narrower than the pixels. The
  // target asked from the header; pixels that disagree are not this image.
  if (job.widths.some((w) => !Number.isInteger(w) || w < 1 || w >= width)) return { failed: 'undecodable' };
  const written: string[] = [];
  const sums: Record<string, string> = {};
  try {
    for (const w of job.widths) {
      const out = await sharp(bytes, ENCODING.decode)
        .autoOrient()
        .resize({ width: w, ...ENCODING.resize })
        .webp(ENCODING.webp)
        .toBuffer();
      const file = join(cacheDir, variantName(job.id, w));
      writeWhole(file, out);
      written.push(file);
      sums[String(w)] = createHash('sha256').update(out).digest('hex');
    }
  } catch {
    for (const file of written) rmSync(file, { force: true });
    return { failed: 'undecodable' };
  }
  return { widths: [...job.widths], sha256: sums };
}

async function main(): Promise<void> {
  let input: { cacheDir: string; jobs: EncodeJob[] };
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as typeof input;
  } catch {
    unavailable('the job on stdin is not JSON');
  }
  let sharp: Library;
  try {
    sharp = (await import('sharp')).default;
  } catch (e) {
    unavailable(`the image library is not installed for this platform (${(e as Error).message.split('\n')[0]})`);
  }
  const v = sharp.versions;
  const want = ENCODING.versions;
  if (v.sharp !== want.library || v.vips !== want.core || v.webp !== want.webp) {
    unavailable(`the image library is ${v.sharp} (core ${v.vips}, webp ${v.webp}); the build pins ${want.library} (core ${want.core}, webp ${want.webp})`);
  }
  sharp.cache(false);
  sharp.concurrency(1);
  sharp.block({ operation: [...IMAGE_DECODERS.blocked] });
  sharp.unblock({ operation: [...IMAGE_DECODERS.allowed] });
  try {
    mkdirSync(input.cacheDir, { recursive: true, mode: 0o700 });
  } catch (e) {
    unavailable(`the cache folder ${input.cacheDir} can't be written (${(e as NodeJS.ErrnoException).code ?? (e as Error).message})`);
  }
  for (const job of input.jobs) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(job.file);
    } catch {
      continue;
    }
    if (imageId(bytes) !== job.id) continue;
    const entry = await encodeOne(sharp, input.cacheDir, job, bytes);
    writeWhole(join(input.cacheDir, entryName(job.id)), JSON.stringify(entry));
  }
}

await main();
