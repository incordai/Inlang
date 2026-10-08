/**
 * @az module images
 * Purpose: the build's image resizer: content-hashed WebP variants, and the PNG home-screen icon, from a cache outside the build output, encoded by a bounded child process.
 * Spec: docs/gallery-block-spec.md §7 rule 3 · docs/GRAMMAR.md §4.4 (touch icon) · docs/stack-evaluation.md §16
 * Exports: createResizer, Resizer, ENCODING, TOUCH_ENCODING, VARIANT_DIR, imageCacheDir, imageId, touchIconId, variantName, VariantFormat, VariantMode, entryName, CacheEntry, EncodeJob
 * Edit guide: a cache entry is used only when every file is there with its recorded hash; the image library runs only in the child (image-encode.ts).
 * Tests: packages/cli/test/images.test.ts, packages/cli/test/touch-icon.test.ts
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
 * their first bytes); SVG and GIF never are. Line art is written lossless,
 * photographs lossy (ENCODING), and a variant larger than its source file
 * is not shipped: the page names only the widths the entry records.
 *
 * The home-screen ("touch") icon (GRAMMAR §4.4) goes the same way: a square
 * PNG `site icon` larger than TOUCH_ICON_SIZE is resized down to it, as a
 * PNG — the format a phone takes — named by its own hash (TOUCH_ENCODING),
 * cached and encoded with the variants. One exactly that size is the touch
 * icon as it is; a smaller, non-square or SVG icon gives none (compile()
 * warns, AZ1422), and nothing is ever upscaled.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_LIMITS, sniffImage } from '../../backend/src/server/data-images.ts';
import { TOUCH_ICON_SIZE, pngSize } from '../../core/src/index.ts';
import type { TouchIcon } from '../../target-web/src/head.ts';
import type { Resize, Variant } from '../../target-web/src/image-srcset.ts';

/** The WebP writer's options every mode shares. */
const WEBP_COMMON = { alphaQuality: 100, effort: 4, smartSubsample: false, smartDeblock: false, preset: 'default', exact: false } as const;

/**
 * Everything that decides a variant's bytes, pinned — and hashed into every
 * name. The library and codec versions are checked by the child against the
 * library it loads, so a name always means these exact versions. The decode
 * limits are the backend upload pipeline's (data-spec §8).
 *
 * The mode is chosen once per source (image-encode.ts, gallery-spec §7
 * rule 3): a JPEG is a photograph — `lossy`. Any other source is `lossless`
 * when it is a palette image, when its alpha channel is in use, or when a
 * `choose.sample`-sided nearest-neighbour copy of it (source pixels only,
 * none blended) holds at most `choose.fewColours` distinct colours — line
 * art, a logo, a screenshot; else it is a photograph too. A lossless
 * variant larger than the source file is written `nearLossless` instead;
 * and a variant of any mode larger than the source file is not shipped.
 * Scheme 2 is this rule: every name of scheme 1 (lossy only) is retired.
 */
export const ENCODING = {
  scheme: 2,
  versions: { library: '0.35.5', core: '8.18.7', webp: '1.6.0' },
  decode: { limitInputPixels: IMAGE_LIMITS.maxPixels, failOn: 'error', sequentialRead: true },
  maxSide: IMAGE_LIMITS.maxSide,
  resize: { kernel: 'lanczos3', withoutEnlargement: true },
  choose: { lossyFormats: ['jpeg'], sample: { side: 256, kernel: 'nearest' }, fewColours: 4096 },
  webp: { ...WEBP_COMMON, quality: IMAGE_LIMITS.quality, lossless: false, nearLossless: false },
  lossless: { ...WEBP_COMMON, quality: 80, lossless: true, nearLossless: false },
  nearLossless: { ...WEBP_COMMON, quality: 60, lossless: false, nearLossless: true },
} as const;

/** How one variant was written: ENCODING's `webp`, `lossless` or `nearLossless` options. */
export type VariantMode = 'lossy' | 'lossless' | 'near-lossless';

/**
 * Everything that decides the touch icon's bytes, pinned and hashed into its
 * name like ENCODING — a separate key, so adding it renamed no WebP variant.
 * The PNG writer's options leave nothing to chance: a fixed zlib level, no
 * adaptive filtering, no palette quantisation (which would search colours),
 * no interlace; and, as for every variant, no metadata is kept.
 */
export const TOUCH_ENCODING = {
  scheme: 1,
  versions: { ...ENCODING.versions, png: '1.6.58', zlib: '2.3.3' },
  decode: ENCODING.decode,
  size: TOUCH_ICON_SIZE,
  resize: ENCODING.resize,
  png: { compressionLevel: 9, adaptiveFiltering: false, palette: false, progressive: false },
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

/** The child process that loads the image library — the resizer's, and az doctor's probe of it. */
export const ENCODER = fileURLToPath(new URL('./image-encode.ts', import.meta.url));

/** The cache key of an image file: its bytes and ENCODING. */
export function imageId(bytes: Uint8Array): string {
  return createHash('sha256')
    .update(`az-image\0${JSON.stringify(ENCODING)}\0`)
    .update(bytes)
    .digest('hex')
    .slice(0, ID_CHARS);
}

/** The cache key of a touch icon's source file: its bytes and TOUCH_ENCODING. */
export function touchIconId(bytes: Uint8Array): string {
  return createHash('sha256')
    .update(`az-touch-icon\0${JSON.stringify(TOUCH_ENCODING)}\0`)
    .update(bytes)
    .digest('hex')
    .slice(0, ID_CHARS);
}

/** What a variant is written as: WebP for a srcset, PNG for the touch icon. */
export type VariantFormat = 'webp' | 'png';

/** A variant's file name, in the cache and under VARIANT_DIR alike. */
export const variantName = (id: string, width: number, format: VariantFormat = 'webp'): string => `${id}-${width}.${format}`;

/** The cache entry's file name for an image id. */
export const entryName = (id: string): string => `${id}.json`;

/**
 * The cache's record of one image: the widths asked for, the ones shipped
 * (a variant larger than its source is not — ENCODING), each shipped
 * file's hash and mode; or why it has none.
 */
export type CacheEntry =
  | {
    readonly widths: number[];
    readonly shipped: number[];
    readonly sha256: Record<string, string>;
    readonly modes: Record<string, VariantMode>;
  }
  | { readonly failed: 'undecodable' | 'too-large'; readonly width?: number; readonly height?: number };

/**
 * az doctor's job for the child: load the library — resolved from `from`'s
 * node_modules (a built server/), else the CLI's own — check its pinned
 * versions, and write nothing.
 */
export interface ProbeJob {
  readonly probe: true;
  readonly from?: string;
}

/** One image for the child to encode. */
export interface EncodeJob {
  readonly id: string;
  /** The real path, already through the asset sandbox. */
  readonly file: string;
  readonly widths: number[];
  /** Absent for a srcset's WebP variants; 'png' for the touch icon (one square width). */
  readonly format?: VariantFormat;
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
function cached(cacheDir: string, id: string, widths: readonly number[], format: VariantFormat = 'webp'): CacheEntry | null {
  let entry: CacheEntry;
  try {
    entry = JSON.parse(readFileSync(join(cacheDir, entryName(id)), 'utf8')) as CacheEntry;
  } catch {
    return null;
  }
  if ('failed' in entry) return entry.failed === 'undecodable' || entry.failed === 'too-large' ? entry : null;
  if (!Array.isArray(entry.widths) || entry.widths.join() !== widths.join()) return null;
  // The shipped widths are some of the asked ones, in their order.
  if (!Array.isArray(entry.shipped) || entry.shipped.join() !== widths.filter((w) => entry.shipped.includes(w)).join()) return null;
  for (const w of entry.shipped) {
    const file = join(cacheDir, variantName(id, w, format));
    if (!existsSync(file) || sha256(readFileSync(file)) !== entry.sha256?.[String(w)]) return null;
  }
  return entry;
}

/** The build's resizer, for one build: emitProject's `resize`, then the encode and the copy list. */
export interface Resizer {
  /** For EmitOptions.resize. A cache miss is planned (its names are known) and encoded by `encode`. */
  readonly resize: Resize;
  /** For EmitOptions.touchIcon. A cache miss is planned and encoded by `encode`, like a variant. */
  readonly touchIcon: TouchIcon;
  /**
   * Encode every planned miss in bounded child processes. True when some
   * image got no variants after all, or fewer than planned (one larger than
   * its source is not shipped) — the page must be emitted again, and that
   * image's `resize` now answers null, or the widths it shipped.
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
  /** Per project path: the touch icon's source, its id, and whether it is already the size; null when it gives none. */
  const touchKnown = new Map<string, { file: string; id: string; exact: boolean } | null>();
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

  const report = (path: string, entry: CacheEntry, format: VariantFormat = 'webp') => {
    if (!('failed' in entry)) return;
    if (format === 'png') {
      warn(`touch:${path}`, entry.failed === 'too-large'
        ? `icon: './${path}' is ${entry.width}×${entry.height} — over the resize limit (${IMAGE_LIMITS.maxSide}px a side); the site has no home-screen icon`
        : `icon: can't resize './${path}' — it does not decode; the site has no home-screen icon`);
      return;
    }
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
    // A miss plans every width: encode() says when some were not shipped, and the page is emitted again.
    if (!entry) pending.set(image.id, { id: image.id, file: image.file, widths: [...widths], path });
    const variants: Variant[] = (entry ? entry.shipped : widths).map((width) => {
      const name = variantName(image.id, width);
      used.set(`${VARIANT_DIR}/${name}`, join(cacheDir, name));
      return { url: `/${VARIANT_DIR}/${name}`, width };
    });
    return variants;
  };

  /** A square PNG at least TOUCH_ICON_SIZE a side, by its own header; anything else gives none (compile() warned). */
  const touchSource = (path: string) => {
    if (touchKnown.has(path)) return touchKnown.get(path)!;
    const file = locate(path);
    let found: { file: string; id: string; exact: boolean } | null = null;
    if (file !== null) {
      const bytes = readFileSync(file);
      const size = pngSize(bytes);
      if (size !== null && size.width === size.height && size.width >= TOUCH_ICON_SIZE) {
        found = { file, id: touchIconId(bytes), exact: size.width === TOUCH_ICON_SIZE };
      }
    }
    touchKnown.set(path, found);
    return found;
  };

  const touchIcon: TouchIcon = (path) => {
    const source = touchSource(path);
    if (!source || without.has(source.id)) return null;
    // Already the size: the icon file the page ships is the touch icon too.
    if (source.exact) return `/${path}`;
    const widths = [TOUCH_ICON_SIZE];
    const entry = cached(cacheDir, source.id, widths, 'png');
    if (entry && 'failed' in entry) {
      report(path, entry, 'png');
      return null;
    }
    if (!entry) pending.set(source.id, { id: source.id, file: source.file, widths, format: 'png', path });
    const name = variantName(source.id, TOUCH_ICON_SIZE, 'png');
    used.set(`${VARIANT_DIR}/${name}`, join(cacheDir, name));
    return `/${VARIANT_DIR}/${name}`;
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
        input: JSON.stringify({ cacheDir, jobs: chunk.map(({ id, file, widths, format }) => ({ id, file, widths, format })) }),
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
    let touchless = false;
    let fewer = false;
    for (const job of jobs) {
      const entry = cached(cacheDir, job.id, job.widths, job.format);
      if (entry && !('failed' in entry)) {
        fewer ||= entry.shipped.length !== job.widths.length;
        continue;
      }
      without.add(job.id);
      if (entry) report(job.path, entry, job.format);
      else if (job.format === 'png') touchless = true;
      else incomplete++;
    }
    if (incomplete > 0) {
      const count = incomplete === 1 ? '1 image ships' : `${incomplete} images ship`;
      warn('resizer', `image: ${stopped ?? 'the resizer wrote no variants'} — ${count} as the original only, with no srcset; build again to retry`);
    }
    if (touchless) {
      warn('resizer-touch', `icon: ${stopped ?? 'the resizer wrote no home-screen icon'} — the site has none this build; build again to retry`);
    }
    return fewer || jobs.some((job) => without.has(job.id));
  };

  return {
    resize,
    touchIcon,
    encode,
    restart: () => used.clear(),
    files: () => [...used].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, copyFrom]) => ({ path, copyFrom })),
    warnings,
  };
}
