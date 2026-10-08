/**
 * @az module image-encode
 * Purpose: the resizer's child process: decodes each image under the upload pipeline's limits and writes its WebP variants (or PNG touch icon) and cache entry.
 * Spec: docs/gallery-block-spec.md §7 rule 3 · docs/stack-evaluation.md §16
 * Exports: (none — a child process images.ts runs, one JSON job on stdin)
 * Edit guide: the order is the defence — decoder allow-list, header-only size check, bounded decode; never keep metadata; the entry is written last.
 * Tests: packages/cli/test/images.test.ts, packages/cli/test/touch-icon.test.ts
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
 *   5. the source's mode is chosen once (chooseMode, ENCODING's rule): a
 *      photograph lossy, line art lossless, near-lossless where lossless
 *      outgrows the source; each width is fitted without enlarging and
 *      encoded to WebP with the pinned options of its mode, and a width
 *      whose every attempt is larger than the source file is not written
 *      (the entry's `shipped` leaves it out) — or, for a touch icon
 *      (`format: 'png'`), a square
 *      source is fitted to its one size and encoded to PNG with
 *      TOUCH_ENCODING's; no metadata is kept — EXIF, GPS, XMP and comments
 *      never reach a variant;
 *   6. a file whose bytes no longer hash to its id is skipped: it changed
 *      after the build read it, and an entry would lie.
 *
 * Files are written beside their place and renamed, so a cache never holds
 * a half-written variant; the entry goes last, so an entry means complete.
 * Exit 0 when every job was handled (a failure is an entry, not an exit);
 * exit 2, with a line `az-image: <why>` on stderr, when nothing could be.
 *
 * A probe (`{ probe: true, from? }`, az doctor) stops after step 1: the
 * library loads (and, the CLI's own, is the pinned one), a line
 * `az-image-ok: <version>` on stdout, nothing written.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IMAGE_DECODERS } from '../../backend/src/server/data-images.ts';
import type { WebpOptions } from 'sharp';
import {
  ENCODING, TOUCH_ENCODING, entryName, imageId, touchIconId, variantName, type CacheEntry, type EncodeJob, type ProbeJob, type VariantMode,
} from './images.ts';

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

/** What the header says the mode needs: the decoder's format name, a palette, an alpha channel. */
interface Header { readonly format: string; readonly palette: boolean; readonly alpha: boolean }

/**
 * ENCODING's rule: one mode for every variant of a source. A JPEG is lossy;
 * any other source is lossless when it is a palette image, its alpha is in
 * use (one pixel not fully opaque), or a nearest-neighbour sample — source
 * colours only, none blended — holds few distinct colours. Every input is
 * the pinned library's, so the same bytes always choose the same mode.
 */
async function chooseMode(sharp: Library, bytes: Buffer, header: Header): Promise<'lossy' | 'lossless'> {
  const rule = ENCODING.choose;
  if ((rule.lossyFormats as readonly string[]).includes(header.format)) return 'lossy';
  if (header.palette) return 'lossless';
  if (header.alpha && !(await sharp(bytes, ENCODING.decode).stats()).isOpaque) return 'lossless';
  const { data } = await sharp(bytes, ENCODING.decode)
    .autoOrient()
    .resize({ width: rule.sample.side, height: rule.sample.side, fit: 'inside', kernel: rule.sample.kernel, withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const colours = new Set<number>();
  for (let i = 0; i + 4 <= data.length && colours.size <= rule.fewColours; i += 4) colours.add(data.readUInt32LE(i));
  return colours.size <= rule.fewColours ? 'lossless' : 'lossy';
}

/** The options each mode tries, in order; the first output no larger than the source ships. */
const ATTEMPTS: Record<'lossy' | 'lossless', readonly { readonly mode: VariantMode; readonly options: WebpOptions }[]> = {
  lossy: [{ mode: 'lossy', options: ENCODING.webp }],
  lossless: [{ mode: 'lossless', options: ENCODING.lossless }, { mode: 'near-lossless', options: ENCODING.nearLossless }],
};

async function encodeOne(sharp: Library, cacheDir: string, job: EncodeJob, bytes: Buffer): Promise<CacheEntry> {
  let width: number;
  let height: number;
  let header: Header;
  try {
    // Header only — no pixel is decoded — so the pixel limit is lifted for
    // this read and a huge claim reaches the size check as "too large".
    const meta = await sharp(bytes, { ...ENCODING.decode, limitInputPixels: false }).metadata();
    width = meta.autoOrient.width;
    height = meta.autoOrient.height;
    header = { format: meta.format, palette: meta.isPalette === true, alpha: meta.hasAlpha === true };
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
  // A touch icon is one square at its one size, from a square source.
  const png = job.format === 'png';
  if (png && (width !== height || job.widths.length !== 1 || job.widths[0] !== TOUCH_ENCODING.size)) return { failed: 'undecodable' };
  const written: string[] = [];
  const shipped: number[] = [];
  const sums: Record<string, string> = {};
  const modes: Record<string, VariantMode> = {};
  try {
    const attempts = png ? [] : ATTEMPTS[await chooseMode(sharp, bytes, header)];
    for (const w of job.widths) {
      const fitted = () => sharp(bytes, ENCODING.decode)
        .autoOrient()
        .resize(png ? { width: w, height: w, ...TOUCH_ENCODING.resize } : { width: w, ...ENCODING.resize });
      let out: Buffer | null = null;
      let mode: VariantMode | null = null;
      if (png) {
        // The touch icon is the site's only one at its size: it always ships.
        out = await fitted().png(TOUCH_ENCODING.png).toBuffer();
      } else {
        for (const attempt of attempts) {
          const candidate = await fitted().webp(attempt.options).toBuffer();
          if (candidate.length <= bytes.length) {
            out = candidate;
            mode = attempt.mode;
            break;
          }
        }
      }
      // Larger than its source in every mode: the source serves this width better.
      if (out === null) continue;
      const file = join(cacheDir, variantName(job.id, w, job.format));
      writeWhole(file, out);
      written.push(file);
      shipped.push(w);
      sums[String(w)] = createHash('sha256').update(out).digest('hex');
      if (mode !== null) modes[String(w)] = mode;
    }
  } catch {
    for (const file of written) rmSync(file, { force: true });
    return { failed: 'undecodable' };
  }
  return { widths: [...job.widths], shipped, sha256: sums, modes };
}

/** The library: the CLI's own, or the copy installed under `from` (a probe of a built server/). */
async function load(from: string | undefined): Promise<Library> {
  if (from === undefined) return (await import('sharp')).default;
  const path = createRequire(join(from, 'package.json')).resolve('sharp');
  return ((await import(pathToFileURL(path).href)) as { default: Library }).default;
}

async function main(): Promise<void> {
  let input: { cacheDir: string; jobs: EncodeJob[]; probe?: undefined } | ProbeJob;
  try {
    input = JSON.parse(readFileSync(0, 'utf8')) as typeof input;
  } catch {
    unavailable('the job on stdin is not JSON');
  }
  // A server's copy is pinned by the server's package.json, not ENCODING:
  // its probe reports the version and the caller compares.
  const from = input.probe === true && typeof input.from === 'string' ? input.from : undefined;
  let sharp: Library;
  try {
    sharp = await load(from);
  } catch (e) {
    unavailable(`the image library is not installed for this platform (${(e as Error).message.split('\n')[0]})`);
  }
  const v = sharp.versions;
  const want = TOUCH_ENCODING.versions;
  if (from === undefined && (v.sharp !== want.library || v.vips !== want.core || v.webp !== want.webp ||
      v.png !== want.png || v['zlib-ng'] !== want.zlib)) {
    unavailable(`the image library is ${v.sharp} (core ${v.vips}, webp ${v.webp}, png ${v.png}, zlib ${v['zlib-ng']}); ` +
      `the build pins ${want.library} (core ${want.core}, webp ${want.webp}, png ${want.png}, zlib ${want.zlib})`);
  }
  if (input.probe === true) {
    process.stdout.write(`az-image-ok: ${v.sharp}\n`);
    return;
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
    if ((job.format === 'png' ? touchIconId(bytes) : imageId(bytes)) !== job.id) continue;
    const entry = await encodeOne(sharp, input.cacheDir, job, bytes);
    writeWhole(join(input.cacheDir, entryName(job.id)), JSON.stringify(entry));
  }
}

await main();
