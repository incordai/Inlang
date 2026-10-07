/**
 * @az server data-images
 * Purpose: image fields' bytes: magic-byte sniff, the vetted decode/re-encode pipeline, a bounded queue, disk storage, orphan sweep.
 * Spec: docs/data-spec.md §8 · docs/stack-evaluation.md (image library vetting)
 * Exports: createImages, sniffImage, ImageError, IMAGE_LIMITS, IMAGE_DECODERS, Images, StoredImage
 * Edit guide: the order is the defence — sniff, then a header-only size check, then decode with the loader allow-list,
 *   then re-encode without metadata. Never keepMetadata/withMetadata/withExif; never decode SVG; names are always generated.
 * Tests: packages/backend/test/data-images.test.ts, packages/backend/test/data-api.test.ts
 */

/**
 * An uploaded photo is untrusted bytes from a stranger. What is stored is
 * never those bytes: the file is sniffed by its magic bytes (the request's
 * Content-Type and file name are ignored), its header is read to refuse a
 * decompression bomb before any pixel is decoded, and the pixels are
 * re-encoded to WebP — which carries no EXIF, GPS, XMP, ICC or comment, so a
 * phone photo's location never reaches the site (data-spec §8, §16 Q6).
 *
 * The image library (sharp 0.35.5, libvips) is loaded only by a server whose
 * tables have an image field; it is configured once here: its cache off, one
 * worker thread, and every loader blocked but JPEG, PNG, WebP and HEIF (which
 * decodes AVIF). A small queue runs one image at a time, so memory stays near
 * one image's worth (about 150 MB for 40 megapixels, measured) however many
 * uploads arrive together.
 *
 * Copied into a generated server only when the site declares data; imports
 * only its siblings, node built-ins and, lazily, the image library.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadDriver } from './drivers.ts';

/** data-spec §8 — what an upload may be, and what is stored. */
export const IMAGE_LIMITS = {
  /** Each side of the decoded image, px. */
  maxSide: 8000,
  /** Width × height, so a small file cannot decode to gigabytes. */
  maxPixels: 40_000_000,
  /** The stored image fits inside this square; smaller images keep their size. */
  storedMax: 2048,
  /** WebP quality of the stored image. */
  quality: 80,
  /** Uploads waiting behind the one being processed; beyond it, 429. */
  queueMax: 8,
  /** A temporary or unreferenced file younger than this is never swept: its row may still be being written. */
  sweepGraceMs: 60 * 60 * 1000,
} as const;

/**
 * The decoder allow-list: every loader is blocked, then only these are
 * unblocked — without it the library would also decode SVG (script), TIFF,
 * GIF and more. HEIF covers AVIF; HEIC itself fails (no HEVC). The build's
 * resizer (gallery-spec §7 rule 3) applies the same list.
 */
export const IMAGE_DECODERS = {
  blocked: ['VipsForeignLoad'],
  allowed: ['VipsForeignLoadJpeg', 'VipsForeignLoadPng', 'VipsForeignLoadWebp', 'VipsForeignLoadHeif'],
} as const;

/** The stored format: always WebP, re-encoded, whatever was uploaded. */
const STORED_EXT = '.webp';
/** `<uuid>.webp` — the only names this module creates or serves. */
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
const TMP_DIR = '.tmp';

export type ImageProblem = 'unsupported_type' | 'too_large' | 'rate_limited';

/** A refusal with its closed code (data-spec §5.3). */
export class ImageError extends Error {
  readonly code: ImageProblem;
  constructor(code: ImageProblem) {
    super(code);
    this.code = code;
  }
}

/** The bytes read to sniff: enough for an `ftyp` box with its compatible brands. */
const SNIFF_BYTES = 64;
const HEIF_BRANDS = new Set(['heic', 'heix', 'mif1', 'msf1', 'heim', 'heis', 'hevc', 'hevx']);

/**
 * The upload's real type from its first bytes — the only types accepted
 * (data-spec §8). An ISO media file is AVIF when its major or a compatible
 * brand says so; another HEIF-family file is recognised as HEIC so it can be
 * refused by name — the library has no HEVC decoder (patents). SVG, text,
 * HTML, GIF and TIFF match nothing here.
 */
export function sniffImage(b: Uint8Array): 'jpeg' | 'png' | 'webp' | 'avif' | 'heic' | null {
  const s = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && s(1, 8) === 'PNG\r\n\u001a\n') return 'png';
  if (b.length >= 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'webp';
  if (b.length >= 12 && s(4, 8) === 'ftyp') {
    // major brand at 8, minor version at 12, compatible brands from 16 to the box's end.
    const end = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
    const brands = [s(8, 12)];
    for (let i = 16; i + 4 <= end; i += 4) brands.push(s(i, i + 4));
    if (brands.some((x) => x === 'avif' || x === 'avis')) return 'avif';
    if (brands.some((x) => HEIF_BRANDS.has(x))) return 'heic';
  }
  return null;
}

export interface StoredImage { readonly key: string; readonly width: number; readonly height: number }

export interface Images {
  /** A fresh temporary path inside the files directory, for an upload to stream into. */
  tempPath(): string;
  /** Sniff, check, re-encode and store the file at `temp` (always removed); the new key and size, or ImageError. */
  store(temp: string): Promise<StoredImage>;
  /** The stored file for a key, or null when the key is not one this module made. */
  pathOf(key: string): string | null;
  /** Remove a stored file; a missing one is not an error. */
  remove(key: string | null | undefined): Promise<void>;
  /** Remove files no row names, older than the grace period; returns how many. */
  sweep(inUse: ReadonlySet<string>, now?: number): Promise<number>;
  /** Uploads processing or waiting — for tests and the log. */
  pending(): number;
}

/** One image at a time; a bounded number may wait. */
function createQueue(max: number) {
  let running = false;
  const waiting: (() => void)[] = [];
  return {
    async run<T>(job: () => Promise<T>): Promise<T> {
      if (running) {
        if (waiting.length >= max) throw new ImageError('rate_limited');
        await new Promise<void>((go) => waiting.push(go));
      }
      running = true;
      try {
        return await job();
      } finally {
        const next = waiting.shift();
        if (next) next();
        else running = false;
      }
    },
    size: () => (running ? 1 : 0) + waiting.length,
  };
}

/** The first bytes of a file, enough to sniff. */
async function head(path: string): Promise<Uint8Array> {
  const f = await open(path, 'r');
  try {
    const buf = new Uint8Array(SNIFF_BYTES);
    const { bytesRead } = await f.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await f.close();
  }
}

/** The part of the image library this module uses (sharp 0.35.5's API). */
interface Pipeline {
  metadata(): Promise<{ width?: number; height?: number }>;
  autoOrient(): Pipeline;
  resize(options: { width: number; height: number; fit: 'inside'; withoutEnlargement: boolean }): Pipeline;
  webp(options: { quality: number }): Pipeline;
  toFile(path: string): Promise<{ width: number; height: number }>;
}
interface ImageLibrary {
  (input: string, options: { limitInputPixels: number | false; failOn: 'error'; sequentialRead: boolean }): Pipeline;
  cache(on: boolean): unknown;
  concurrency(threads: number): unknown;
  block(options: { operation: string[] }): void;
  unblock(options: { operation: string[] }): void;
}

export async function createImages(opts: { readonly dir: string }): Promise<Images> {
  // Loaded only here, so a server without image fields never needs it.
  const { default: sharp } = await loadDriver('sharp') as { default: ImageLibrary };
  sharp.cache(false);
  sharp.concurrency(1);
  sharp.block({ operation: [...IMAGE_DECODERS.blocked] });
  sharp.unblock({ operation: [...IMAGE_DECODERS.allowed] });

  const dir = opts.dir;
  const tmp = join(dir, TMP_DIR);
  await mkdir(tmp, { recursive: true, mode: 0o700 });
  const queue = createQueue(IMAGE_LIMITS.queueMax);
  const input = { limitInputPixels: IMAGE_LIMITS.maxPixels, failOn: 'error' as const, sequentialRead: true };

  async function encode(temp: string): Promise<StoredImage> {
    const type = sniffImage(await head(temp));
    if (type === null || type === 'heic') throw new ImageError('unsupported_type');
    let meta;
    try {
      // Header only — no pixel is decoded here — so the library's own pixel
      // limit is lifted for this read, letting a 100000² claim reach the size
      // check below and be refused as too large, not as unreadable.
      meta = await sharp(temp, { ...input, limitInputPixels: false }).metadata();
    } catch {
      throw new ImageError('unsupported_type');
    }
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (w < 1 || h < 1) throw new ImageError('unsupported_type');
    if (w > IMAGE_LIMITS.maxSide || h > IMAGE_LIMITS.maxSide || w * h > IMAGE_LIMITS.maxPixels) throw new ImageError('too_large');
    const key = `${randomUUID()}${STORED_EXT}`;
    const part = join(tmp, `${key}.part`);
    let info;
    try {
      // autoOrient reads the EXIF orientation, rotates the pixels, and the
      // WebP encode writes no metadata at all: GPS, XMP, ICC, comments gone.
      info = await sharp(temp, input)
        .autoOrient()
        .resize({ width: IMAGE_LIMITS.storedMax, height: IMAGE_LIMITS.storedMax, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: IMAGE_LIMITS.quality })
        .toFile(part);
    } catch {
      await rm(part, { force: true });
      throw new ImageError('unsupported_type');
    }
    // Written beside, then renamed: a stored key is never a half-written file.
    await rename(part, join(dir, key));
    return { key, width: info.width, height: info.height };
  }

  return {
    tempPath: () => join(tmp, `${randomUUID()}.upload`),
    async store(temp) {
      try {
        return await queue.run(() => encode(temp));
      } finally {
        await rm(temp, { force: true });
      }
    },
    pathOf: (key) => (KEY.test(key) ? join(dir, key) : null),
    async remove(key) {
      if (typeof key === 'string' && KEY.test(key)) await rm(join(dir, key), { force: true });
    },
    async sweep(inUse, now = Date.now()) {
      let removed = 0;
      const old = async (path: string) => {
        try {
          return now - (await stat(path)).mtimeMs > IMAGE_LIMITS.sweepGraceMs;
        } catch {
          return false;
        }
      };
      for (const name of await readdir(dir)) {
        if (!KEY.test(name) || inUse.has(name)) continue;
        if (await old(join(dir, name))) { await rm(join(dir, name), { force: true }); removed++; }
      }
      for (const name of await readdir(tmp)) {
        if (await old(join(tmp, name))) { await rm(join(tmp, name), { force: true }); removed++; }
      }
      return removed;
    },
    pending: () => queue.size(),
  };
}
