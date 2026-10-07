/**
 * @az module images
 * Purpose: the build's image resizer: content-hashed WebP variants from a cache outside the build output, encoded by a bounded child process.
 * Spec: docs/gallery-block-spec.md §7 rule 3 · docs/stack-evaluation.md §16
 * Exports: createResizer, Resizer, ENCODING, VARIANT_DIR, imageCacheDir, imageId, variantName, entryName, CacheEntry, EncodeJob
 * Edit guide: a cache entry is used only when every file is there with its recorded hash; the image library runs only in the child (image-encode.ts).
 * Tests: packages/cli/test/images.test.ts
 */

/**
 * Responsive images at build — gallery-block-spec §7 rule 3, owner option A.
 *
 * The target decides WHICH widths an image gets (image-srcset.ts); this
 * makes them. Each variant is named by a hash of the input file's bytes and
 * of ENCODING — every option that decides its bytes — so the same file
 * always gives the same names and bytes (CONVENTIONS §6), and a changed
 * option gives new names instead of a stale file under an old one.
 *
 * Encoding is the slow part (about a second for a 24-megapixel photo's four
 * widths), so results live in a cache outside the build output, keyed by
 * that hash: a rebuild — every `az dev` save — reads the cache and encodes
 * nothing. A miss is encoded after the page is emitted, by a child process
 * (image-encode.ts) that is killed at its deadline: the compiler never waits
 * unbounded, and a decoder crash takes the child down, not the build.
 *
 * What the child records is what the build uses: a variant set, or a
 * failure (a file that does not decode, one over the size limits). A failure
 * is a warning, and that image ships as its original only — as before this
 * rule existed. Only raster formats are resized (JPEG, PNG, WebP, AVIF, by
 * their first bytes); SVG and GIF never are.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_LIMITS, sniffImage } from '../../backend/src/server/data-images.ts';
import type { Resize, Variant } from '../../target-web/src/image-srcset.ts';

/**
 * Everything that decides a variant's bytes, pinned — and hashed into every
 * name. The library and codec versions are checked by the child against the
 * library it loads, so a name always means these exact versions. The decode
 * limits are the backend upload pipeline's (data-spec §8).
 */
export const ENCODING = {
  scheme: 1,
  versions: { library: '0.35.5', core: '8.18.7', webp: '1.6.0' },
  decode: { limitInputPixels: IMAGE_LIMITS.maxPixels, failOn: 'error', sequentialRead: true },
  maxSide: IMAGE_LIMITS.maxSide,
  resize: { kernel: 'lanczos3', withoutEnlargement: true },
  webp: {
    quality: IMAGE_LIMITS.quality, alphaQuality: 100, effort: 4, lossless: false, nearLossless: false,
    smartSubsample: false, smartDeblock: false, preset: 'default', exact: false,
  },
} as const;

/** Where variants are served from: `public/az-img/…` in the generated project, `/az-img/…` on the page. */
export const VARIANT_DIR = 'az-img';

/** Hex characters of the hash kept in a name: 64 bits, far past any project's image count. */
const ID_CHARS = 16;

/** The bytes the first-bytes sniff needs. */
const SNIFF_BYTES = 64;

/** Images per child process, so one deadline never covers a whole 200-image gallery. */
const CHUNK = 8;

/**
 * Each child's deadline: its start and the library's load (about 0.1s
 * measured), plus per image ten times the slowest measured — 24 MP of
 * noise, all four widths, 1.2s.
 */
const CHILD_BASE_MS = 10_000;
const CHILD_PER_IMAGE_MS = 20_000;

/** The child's report is a line or two; more is a fault, cut off. */
const CHILD_OUTPUT_BYTES = 64 * 1024;

const ENCODER = fileURLToPath(new URL('./image-encode.ts', import.meta.url));

/** The cache key of an image file: its bytes and ENCODING. */
export function imageId(bytes: Uint8Array): string {
  return createHash('sha256')
    .update(`az-image\0${JSON.stringify(ENCODING)}\0`)
    .update(bytes)
    .digest('hex')
    .slice(0, ID_CHARS);
}

/** A variant's file name, in the cache and under VARIANT_DIR alike. */
export const variantName = (id: string, width: number): string => `${id}-${width}.webp`;

/** The cache entry's file name for an image id. */
export const entryName = (id: string): string => `${id}.json`;

/** The cache's record of one image: its variants with each file's hash, or why it has none. */
export type CacheEntry =
  | { readonly widths: number[]; readonly sha256: Record<string, string> }
  | { readonly failed: 'undecodable' | 'too-large'; readonly width?: number; readonly height?: number };

/** One image for the child to encode. */
export interface EncodeJob {
  readonly id: string;
  /** The real path, already through the asset sandbox. */
  readonly file: string;
  readonly widths: number[];
}

/**
 * The cache directory: `AZ_IMAGE_CACHE`, else the user's cache folder —
 * never inside a build's output, which a build may clear.
 */
export function imageCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AZ_IMAGE_CACHE) return env.AZ_IMAGE_CACHE;
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'az', 'images');
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The cache's entry for `id`, or null when there is none it can trust for these widths. */
function cached(cacheDir: string, id: string, widths: readonly number[]): CacheEntry | null {
  let entry: CacheEntry;
  try {
    entry = JSON.parse(readFileSync(join(cacheDir, entryName(id)), 'utf8')) as CacheEntry;
  } catch {
    return null;
  }
  if ('failed' in entry) return entry.failed === 'undecodable' || entry.failed === 'too-large' ? entry : null;
  if (!Array.isArray(entry.widths) || entry.widths.join() !== widths.join()) return null;
  for (const w of widths) {
    const file = join(cacheDir, variantName(id, w));
    if (!existsSync(file) || sha256(readFileSync(file)) !== entry.sha256?.[String(w)]) return null;
  }
  return entry;
}

/** The build's resizer, for one build: emitProject's `resize`, then the encode and the copy list. */
export interface Resizer {
  /** For EmitOptions.resize. A cache miss is planned (its names are known) and encoded by `encode`. */
  readonly resize: Resize;
  /**
   * Encode every planned miss in bounded child processes. True when some
   * image got no variants after all — the page must be emitted again, and
   * that image's `resize` now answers null.
   */
  encode(): boolean;
  /** Forget which variants were handed out: a new emit of the page begins. */
  restart(): void;
  /** The variants the last emit used: their output paths and cache files, sorted. */
  files(): { path: string; copyFrom: string }[];
  /** One line per image that ships without variants, and why. */
  readonly warnings: string[];
}

/**
 * A resizer reading and writing `cacheDir`. `locate` turns a project path
 * into its real file through the asset sandbox, or null.
 */
export function createResizer(cacheDir: string, locate: (projectPath: string) => string | null): Resizer {
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (key: string, line: string) => {
    if (warned.has(key)) return;
    warned.add(key);
    warnings.push(line);
  };
  /** Per project path: its real file and id, or null when it is not a format that is resized. */
  const known = new Map<string, { file: string; id: string } | null>();
  const pending = new Map<string, EncodeJob & { path: string }>();
  /** Ids encoded this build that came out with nothing: their pages ship originals only. */
  const without = new Set<string>();
  const used = new Map<string, string>();

  const identify = (path: string) => {
    if (known.has(path)) return known.get(path)!;
    const file = locate(path);
    let found: { file: string; id: string } | null = null;
    if (file !== null) {
      const bytes = readFileSync(file);
      const type = sniffImage(bytes.subarray(0, SNIFF_BYTES));
      if (type !== null && type !== 'heic') found = { file, id: imageId(bytes) };
    }
    known.set(path, found);
    return found;
  };

  const report = (path: string, entry: CacheEntry) => {
    if (!('failed' in entry)) return;
    warn(path, entry.failed === 'too-large'
      ? `image: './${path}' is ${entry.width}×${entry.height} — over the resize limit (${IMAGE_LIMITS.maxSide}px a side, ${IMAGE_LIMITS.maxPixels / 1_000_000} megapixels); it ships at its own size only, with no srcset`
      : `image: can't resize './${path}' — it does not decode; it ships at its own size only, with no srcset`);
  };

  const resize: Resize = (path, widths) => {
    const image = identify(path);
    if (!image || without.has(image.id)) return null;
    const entry = cached(cacheDir, image.id, widths);
    if (entry && 'failed' in entry) {
      report(path, entry);
      return null;
    }
    if (!entry) pending.set(image.id, { id: image.id, file: image.file, widths: [...widths], path });
    const variants: Variant[] = widths.map((width) => {
      const name = variantName(image.id, width);
      used.set(`${VARIANT_DIR}/${name}`, join(cacheDir, name));
      return { url: `/${VARIANT_DIR}/${name}`, width };
    });
    return variants;
  };

  const encode = (): boolean => {
    const jobs = [...pending.values()];
    pending.clear();
    if (jobs.length === 0) return false;
    let stopped: string | null = null;
    for (let at = 0; at < jobs.length && stopped === null; at += CHUNK) {
      const chunk = jobs.slice(at, at + CHUNK);
      const deadline = CHILD_BASE_MS + CHILD_PER_IMAGE_MS * chunk.length;
      const r = spawnSync(process.execPath, ['--experimental-strip-types', ENCODER], {
        input: JSON.stringify({ cacheDir, jobs: chunk.map(({ id, file, widths }) => ({ id, file, widths })) }),
        encoding: 'utf8', timeout: deadline, killSignal: 'SIGKILL', maxBuffer: CHILD_OUTPUT_BYTES,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if ((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
        stopped = `resizing stopped at its ${deadline / 1000}s deadline`;
      } else if (r.error || r.signal) {
        stopped = `the resizer stopped (${r.error?.message ?? r.signal})`;
      } else if (r.status !== 0) {
        const line = (r.stderr ?? '').split('\n').find((l) => l.startsWith('az-image:'));
        stopped = `the resizer could not run (${line ? line.slice('az-image:'.length).trim() : `exit ${r.status}`})`;
      }
    }
    let incomplete = 0;
    for (const job of jobs) {
      const entry = cached(cacheDir, job.id, job.widths);
      if (entry && !('failed' in entry)) continue;
      without.add(job.id);
      if (entry) report(job.path, entry);
      else incomplete++;
    }
    if (incomplete > 0) {
      const count = incomplete === 1 ? '1 image ships' : `${incomplete} images ship`;
      warn('resizer', `image: ${stopped ?? 'the resizer wrote no variants'} — ${count} as the original only, with no srcset; build again to retry`);
    }
    return jobs.some((job) => without.has(job.id));
  };

  return {
    resize,
    encode,
    restart: () => used.clear(),
    files: () => [...used].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, copyFrom]) => ({ path, copyFrom })),
    warnings,
  };
}
