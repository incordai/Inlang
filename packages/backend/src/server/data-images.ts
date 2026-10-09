/**
 * @az server data-images
 * Purpose: image fields' bytes: magic-byte sniff, the vetted decode/re-encode pipeline, width copies, a bounded queue, disk storage, orphan sweep.
 * Spec: docs/data-spec.md §8 · docs/stack-evaluation.md (image library vetting)
 * Exports: createImages, sniffImage, ImageError, IMAGE_LIMITS, IMAGE_DECODERS, IMAGE_WIDTHS, hasWidths, imageWidths, Images, StoredImage
 * Edit guide: the order is the defence — sniff, then a header-only size check, then decode with the loader allow-list,
 *   then re-encode without metadata. Never keepMetadata/withMetadata/withExif; never decode SVG; names are always generated.
 *   A key's files appear together or not at all (copies first, the key last); every removal takes all of them.
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
 * Width copies (data-spec §8, gallery-spec §7 rule 3). The decoded pixels,
 * fitted inside the stored max, are held once in memory and encoded to the
 * stored file and to each of IMAGE_WIDTHS narrower than it — never wider, so
 * nothing is upscaled — in the same queued job: the large original is
 * decoded once. Such an upload's key is `<uuid>.full.webp`, its copies
 * `<uuid>.<width>.webp`. A key stored before copies existed is `<uuid>.webp`
 * and has none until `addWidths` (the backfill, `az backend images`) gives
 * it them under the same UUID, so its URL and cached copies stay valid.
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
import { copyFile, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
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

/**
 * data-spec §8: the widths, px, an upload is also stored at beside its
 * stored-max file — the build's widths (gallery-spec §7 rule 3) below the
 * stored max. Served as `?w=<width>`; no other value names a file.
 */
export const IMAGE_WIDTHS: readonly number[] = [480, 768, 1200];

/** Stored files are always WebP, re-encoded, whatever was uploaded. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** `<uuid>.full.webp` — the key of an upload stored with its width copies. */
const KEY = new RegExp(`^${UUID}\\.full\\.webp$`);
/** `<uuid>.webp` — a key stored before width copies existed; it has none. */
const LEGACY_KEY = new RegExp(`^${UUID}\\.webp$`);
/** A key's file or one of its copies (`<uuid>.<width>.webp`): the names the sweep may remove. */
const NAME = new RegExp(`^${UUID}\\.(?:full|${IMAGE_WIDTHS.join('|')})\\.webp$`);
const TMP_DIR = '.tmp';

/** Whether a stored key has width copies beside it (a key from before them has none). */
export const hasWidths = (key: string): boolean => KEY.test(key);
/** The widths a stored key has copies at, for its stored image `width` px wide: only narrower ones, never upscaled. */
export const imageWidths = (key: string, width: number): number[] =>
  hasWidths(key) ? IMAGE_WIDTHS.filter((w) => w < width) : [];
const isKey = (key: string): boolean => KEY.test(key) || LEGACY_KEY.test(key);
const uuidOf = (key: string): string => key.slice(0, key.indexOf('.'));
/** A copy's file name: its key's UUID and the width. */
const widthName = (key: string, width: number): string => `${uuidOf(key)}.${width}.webp`;
/** Every file a key can have; a copy its image is too narrow for does not exist. */
const filesOf = (key: string): string[] => (hasWidths(key) ? [key, ...IMAGE_WIDTHS.map((w) => widthName(key, w))] : [key]);

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
  /**
   * The stored file for a key, or with `width` its copy at that width — null
   * when the key is not one this module made, or when `width` is not one of
   * IMAGE_WIDTHS for a key with copies.
   */
  pathOf(key: string, width?: number): string | null;
  /** Remove a key's file and every copy of it; a missing one is not an error. */
  remove(key: string | null | undefined): Promise<void>;
  /**
   * The backfill: a key stored before width copies existed, given them —
   * its file copied byte for byte to `<uuid>.full.webp` (the same UUID, so
   * the same URL) with a copy at each narrower width, through the same
   * queue. The old key's file stays for the caller to drop once no row
   * names it. Null when `key` is not such a key or its file is gone.
   */
  addWidths(key: string): Promise<StoredImage | null>;
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

/** Decoded pixels, 8 bits a channel, and their size. */
interface Pixels {
  readonly data: Uint8Array;
  readonly info: { readonly width: number; readonly height: number; readonly channels: 1 | 2 | 3 | 4 };
}
/** The part of the image library this module uses (sharp 0.35.5's API). */
interface Pipeline {
  metadata(): Promise<{ width?: number; height?: number }>;
  autoOrient(): Pipeline;
  resize(options: { width: number; height?: number; fit?: 'inside'; withoutEnlargement?: boolean }): Pipeline;
  raw(): Pipeline;
  toBuffer(options: { resolveWithObject: true }): Promise<Pixels>;
  webp(options: { quality: number }): Pipeline;
  toFile(path: string): Promise<{ width: number; height: number }>;
}
interface ImageLibrary {
  (input: string, options: { limitInputPixels: number | false; failOn: 'error'; sequentialRead: boolean }): Pipeline;
  (input: Uint8Array, options: { raw: Pixels['info'] }): Pipeline;
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
    let pixels: Pixels;
    try {
      // autoOrient reads the EXIF orientation and rotates the pixels; raw
      // pixels carry no metadata, and the WebP encodes write none at all:
      // GPS, XMP, ICC, comments gone.
      pixels = await sharp(temp, input)
        .autoOrient()
        .resize({ width: IMAGE_LIMITS.storedMax, height: IMAGE_LIMITS.storedMax, fit: 'inside', withoutEnlargement: true })
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw new ImageError('unsupported_type');
    }
    return place(`${randomUUID()}.full.webp`, pixels);
  }

  /**
   * A key's files from its pixels: the stored file (encoded, or with `full`
   * copied byte for byte from that path) and a copy at each width narrower
   * than it. All are written beside, in the temporary folder; only when each
   * is complete are they renamed in — the copies first, the key last — so a
   * key that exists has all its files, and a failure leaves none of them.
   */
  async function place(key: string, pixels: Pixels, full?: string): Promise<StoredImage> {
    const { width, height } = pixels.info;
    const files: [name: string, width: number | null][] = [
      ...imageWidths(key, width).map((w): [string, number] => [widthName(key, w), w]),
      [key, null],
    ];
    const part = (name: string) => join(tmp, `${name}.part`);
    const placed: string[] = [];
    const undo = () => Promise.all([
      ...files.map(([name]) => rm(part(name), { force: true })),
      ...placed.map((name) => rm(join(dir, name), { force: true })),
    ]);
    try {
      for (const [name, w] of files) {
        if (w === null && full !== undefined) {
          await copyFile(full, part(name));
          continue;
        }
        const pipeline = sharp(pixels.data, { raw: pixels.info });
        try {
          await (w === null ? pipeline : pipeline.resize({ width: w })).webp({ quality: IMAGE_LIMITS.quality }).toFile(part(name));
        } catch {
          throw new ImageError('unsupported_type');
        }
      }
      for (const [name] of files) {
        await rename(part(name), join(dir, name));
        placed.push(name);
      }
    } catch (e) {
      await undo();
      throw e;
    }
    return { key, width, height };
  }

  /** addWidths: a stored WebP this module wrote, decoded under the same allow-list and limits. */
  async function widen(key: string): Promise<StoredImage | null> {
    if (!LEGACY_KEY.test(key)) return null;
    const from = join(dir, key);
    if (!await stat(from).then((s) => s.isFile(), () => false)) return null;
    let pixels: Pixels;
    try {
      pixels = await sharp(from, input).raw().toBuffer({ resolveWithObject: true });
    } catch {
      throw new ImageError('unsupported_type');
    }
    return place(`${uuidOf(key)}.full.webp`, pixels, from);
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
    pathOf(key, width) {
      if (width === undefined) return isKey(key) ? join(dir, key) : null;
      return hasWidths(key) && IMAGE_WIDTHS.includes(width) ? join(dir, widthName(key, width)) : null;
    },
    async remove(key) {
      // The copies first, the key last: stopped part-way, what is left is a
      // set of files no row names, which the sweep takes.
      if (typeof key === 'string' && isKey(key)) for (const name of filesOf(key).reverse()) await rm(join(dir, name), { force: true });
    },
    addWidths: (key) => queue.run(() => widen(key)),
    async sweep(inUse, now = Date.now()) {
      let removed = 0;
      // A file is in use when it is one of an in-use key's files.
      const keep = new Set([...inUse].filter(isKey).flatMap(filesOf));
      const old = async (path: string) => {
        try {
          return now - (await stat(path)).mtimeMs > IMAGE_LIMITS.sweepGraceMs;
        } catch {
          return false;
        }
      };
      for (const name of await readdir(dir)) {
        if (!(NAME.test(name) || LEGACY_KEY.test(name)) || keep.has(name)) continue;
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
