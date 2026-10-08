/**
 * @az module image-size
 * Purpose: an image's displayed width and height from its header bytes — PNG, GIF, JPEG, WebP, AVIF/HEIF, SVG.
 * Spec: docs/gallery-block-spec.md §7
 * Exports: imageSize, imageSizeOf, bytesSource, ByteSource, ImageSize, MAX_DIMENSION, HEAD_BYTES, MAX_READ_BYTES
 * Edit guide: never throws and never guesses: anything unreadable or out of bounds is null; every read is bounds-checked.
 * Tests: packages/target-web/test/image-size.test.ts
 */

/**
 * Intrinsic image size from the file's header — gallery-block-spec §7 rule 1.
 *
 * The build writes `width` and `height` on every image it ships so the
 * browser reserves the box before the bytes arrive, which is the whole of
 * Cumulative Layout Shift for images. Only the header is read: no pixel is
 * decoded, so a file claiming a huge canvas costs nothing here.
 *
 * Rules that make it safe on any input:
 *   - every multi-byte read checks its bounds first; a short or malformed
 *     file is null, never an exception and never a partly-read number
 *   - loops over segments and boxes are capped (MAX_STEPS), so a file that
 *     points back at itself ends
 *   - a JPEG is walked through its file (imageSizeOf), not its first bytes:
 *     each segment's length leads to the next, an APPn block is skipped
 *     unread, so a frame header behind megabytes of EXIF or XMP is found;
 *     the walk reads at most MAX_READ_BYTES in all and never past the
 *     file's end, and running out of either is null
 *   - a width or height of 0, or over MAX_DIMENSION, is null: wrong
 *     dimensions would distort the page, missing ones only let it shift
 *   - the size returned is the one the browser DISPLAYS: a JPEG whose EXIF
 *     orientation turns it, or an AVIF/HEIF rotated by `irot`, has its two
 *     sides swapped, as the browser draws it upright by default
 */

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Random access to one file's bytes: the CLI's, through its asset sandbox,
 * or bytes already in memory (bytesSource). `read` returns up to `length`
 * bytes from `offset` — fewer only at the end of the file — and may throw
 * (a file removed mid-build), which reads as "no size". `close` releases
 * the file; the caller calls it once, when done.
 */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Uint8Array;
  close(): void;
}

/** Bytes in memory as a ByteSource. */
export const bytesSource = (bytes: Uint8Array): ByteSource => ({
  size: bytes.length,
  read: (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)),
  close: () => {},
});

/** Larger than any image a site should ship; beyond it the header is not trusted. */
export const MAX_DIMENSION = 100_000;

/** Segments, chunks or boxes walked before giving up on a file. */
const MAX_STEPS = 4096;

/**
 * What imageSizeOf reads of a file that is not a JPEG: its first bytes,
 * past any metadata box an AVIF or an SVG prolog carries before its size.
 */
export const HEAD_BYTES = 1024 * 1024;

/**
 * The most a JPEG walk reads of one file, in all: segments are followed by
 * their lengths and skipped unread, so this is spent only on segment
 * headers and EXIF; past it the size is unknown (null), never guessed.
 */
export const MAX_READ_BYTES = 16 * 1024 * 1024;

/** What one read of a JPEG walk fetches: a few segment headers at a time. */
const WINDOW = 4096;

/** The bytes the format sniff needs. */
const SNIFF = 16;

/** How much of an SVG is read to find its root element. */
const SVG_HEAD_BYTES = 64 * 1024;

const u16be = (b: Uint8Array, i: number) => (i + 2 <= b.length ? (b[i] << 8) | b[i + 1] : -1);
const u16le = (b: Uint8Array, i: number) => (i + 2 <= b.length ? b[i] | (b[i + 1] << 8) : -1);
const u24le = (b: Uint8Array, i: number) => (i + 3 <= b.length ? b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) : -1);
const u32be = (b: Uint8Array, i: number) =>
  (i + 4 <= b.length ? ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) : -1);
const ascii = (b: Uint8Array, i: number, n: number) =>
  (i + n <= b.length ? String.fromCharCode(...b.subarray(i, i + n)) : '');

/** A size the page can use, or null. */
function sized(width: number, height: number, swap = false): ImageSize | null {
  if (!Number.isInteger(width) || !Number.isInteger(height)) return null;
  if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return swap ? { width: height, height: width } : { width, height };
}

/**
 * The displayed size of an image file, read from `source` as far as its
 * header needs: a JPEG segment by segment (any distance into the file, up
 * to MAX_READ_BYTES read), any other format from its first HEAD_BYTES. Null
 * when it cannot be read with certainty. Does not close `source`.
 */
export function imageSizeOf(source: ByteSource): ImageSize | null {
  try {
    const sniff = source.read(0, Math.min(source.size, SNIFF));
    if (sniff[0] === 0xff && sniff[1] === 0xd8) return jpeg(new Walk(source));
    return imageSize(source.read(0, Math.min(source.size, HEAD_BYTES)));
  } catch {
    // A read that failed, or a bounds-checked parse's last guard: no size.
    return null;
  }
}

/** The displayed size of an image file in memory, or null when it cannot be read with certainty. */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  try {
    if (bytes.length >= 24 && ascii(bytes, 1, 3) === 'PNG' && bytes[0] === 0x89) return png(bytes);
    if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return sized(u16le(bytes, 6), u16le(bytes, 8));
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpeg(new Walk(bytesSource(bytes)));
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return webp(bytes);
    if (ascii(bytes, 4, 4) === 'ftyp') return isobmff(bytes);
    return svg(bytes);
  } catch {
    // Every read above is bounds-checked; this is the last guard, not a path.
    return null;
  }
}

/* ---- PNG: IHDR is the first chunk ---------------------------------------- */

function png(b: Uint8Array): ImageSize | null {
  if (b[0] !== 0x89 || ascii(b, 12, 4) !== 'IHDR') return null;
  return sized(u32be(b, 16), u32be(b, 20));
}

/* ---- JPEG: the first SOFn segment, turned by the EXIF orientation -------- */

/** Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) do not. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * A JPEG walk's view of its source: one window of bytes at a time, each
 * read counted, and nothing past the file's end or MAX_READ_BYTES in all —
 * both read as the end (-1, null), so a walk that runs out ends as null.
 */
class Walk {
  private start = 0;
  private window: Uint8Array = new Uint8Array(0);
  private spent = 0;
  private readonly source: ByteSource;

  constructor(source: ByteSource) {
    this.source = source;
  }

  get size(): number {
    return this.source.size;
  }

  /** The byte at `i`, or -1. */
  byte(i: number): number {
    if (i < this.start || i >= this.start + this.window.length) {
      if (!this.load(i, WINDOW)) return -1;
    }
    return i - this.start < this.window.length ? this.window[i - this.start] : -1;
  }

  /** A big-endian u16 at `i`, or -1. */
  u16(i: number): number {
    const hi = this.byte(i);
    const lo = this.byte(i + 1);
    return hi < 0 || lo < 0 ? -1 : (hi << 8) | lo;
  }

  /** Exactly the `n` bytes at `i`, or null. */
  bytes(i: number, n: number): Uint8Array | null {
    if (i < this.start || i + n > this.start + this.window.length) {
      if (!this.load(i, n)) return null;
    }
    return i + n <= this.start + this.window.length ? this.window.subarray(i - this.start, i - this.start + n) : null;
  }

  private load(i: number, n: number): boolean {
    if (i < 0 || n < 1 || i >= this.source.size) return false;
    const want = Math.min(n, this.source.size - i);
    if (this.spent + want > MAX_READ_BYTES) return false;
    this.spent += want;
    this.window = this.source.read(i, want);
    this.start = i;
    return this.window.length > 0;
  }
}

/** The bytes after an APP1 segment's length that say what it holds. */
const EXIF_ID = 'Exif\0\0';

function jpeg(b: Walk): ImageSize | null {
  let i = 2;
  let turned = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (b.byte(i) !== 0xff) return null;
    while (b.byte(i) === 0xff) i++;                   // fill bytes before a marker
    const marker = b.byte(i);
    if (marker < 0) return null;
    i++;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) return null;   // end, or scan data before any frame
    const length = b.u16(i);
    if (length < 2 || i + length > b.size) return null;
    if (marker === 0xe1) {
      // Only an EXIF segment is read whole (at most 64KB, a u16 length); any
      // other APPn — XMP, ICC, a maker's preview — is skipped unread.
      const id = b.bytes(i + 2, EXIF_ID.length);
      if (id !== null && ascii(id, 0, EXIF_ID.length) === EXIF_ID) {
        const segment = b.bytes(i, length);
        if (segment === null) return null;
        turned = exifTurned(segment, 2 + EXIF_ID.length, length);
      }
    }
    if (SOF.has(marker)) {
      if (length < 7) return null;
      const height = b.u16(i + 3);
      const width = b.u16(i + 5);
      if (height < 0 || width < 0) return null;
      return sized(width, height, turned);
    }
    i += length;
  }
  return null;
}

/**
 * True when the EXIF orientation (tag 0x0112 in IFD0) is 5–8, a quarter turn:
 * the browser draws the image upright, so its displayed sides are swapped.
 * Reads only inside [start, end), the APP1 segment.
 */
function exifTurned(b: Uint8Array, start: number, end: number): boolean {
  const order = ascii(b, start, 2);
  if (order !== 'II' && order !== 'MM') return false;
  const le = order === 'II';
  const u16 = (i: number) => (i + 2 <= end ? (le ? u16le(b, i) : u16be(b, i)) : -1);
  const u32 = (i: number) => {
    if (i + 4 > end) return -1;
    return le ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + (b[i + 3] << 24 >>> 0) : u32be(b, i);
  };
  if (u16(start + 2) !== 42) return false;
  const ifd = u32(start + 4);
  if (ifd < 8) return false;
  const at = start + ifd;
  const count = u16(at);
  if (count < 0 || count > 1000) return false;
  for (let n = 0; n < count; n++) {
    const entry = at + 2 + n * 12;
    if (entry + 12 > end) return false;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 5 && value <= 8;
    }
  }
  return false;
}

/* ---- WebP: VP8 (lossy), VP8L (lossless) or VP8X (extended) ---------------- */

function webp(b: Uint8Array): ImageSize | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    // A key frame: 3 bytes of frame tag, then the start code 9d 01 2a.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    const w = u16le(b, 26);
    const h = u16le(b, 28);
    if (w < 0 || h < 0) return null;
    return sized(w & 0x3fff, h & 0x3fff);
  }
  if (chunk === 'VP8L') {
    if (b.length < 25 || b[20] !== 0x2f) return null;
    const width = 1 + (((b[22] & 0x3f) << 8) | b[21]);
    const height = 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6));
    return sized(width, height);
  }
  if (chunk === 'VP8X') {
    const w = u24le(b, 24);
    const h = u24le(b, 27);
    if (w < 0 || h < 0) return null;
    return sized(w + 1, h + 1);
  }
  return null;
}

/* ---- AVIF / HEIF: the primary item's ispe, turned by its irot ------------- */

interface Box { readonly type: string; readonly start: number; readonly end: number }

/** The boxes directly inside [start, end); null when one runs past its parent. */
function boxes(b: Uint8Array, start: number, end: number): Box[] | null {
  const out: Box[] = [];
  let i = start;
  while (i < end) {
    if (out.length >= MAX_STEPS) return null;
    let size = u32be(b, i);
    const type = ascii(b, i + 4, 4);
    if (size < 0 || type.length !== 4) return null;
    let header = 8;
    if (size === 1) {
      // A 64-bit size: only the low half can be real inside a file we read.
      const high = u32be(b, i + 8);
      size = u32be(b, i + 12);
      if (high !== 0 || size < 0) return null;
      header = 16;
    } else if (size === 0) {
      size = end - i;
    }
    if (size < header || i + size > end) return null;
    out.push({ type, start: i + header, end: i + size });
    i += size;
  }
  return out;
}

const child = (list: Box[] | null, type: string) => list?.find((x) => x.type === type) ?? null;

function isobmff(b: Uint8Array): ImageSize | null {
  const top = boxes(b, 0, b.length);
  const ftyp = child(top, 'ftyp');
  if (!ftyp) return null;
  const brands = [ascii(b, ftyp.start, 4)];
  for (let i = ftyp.start + 8; i + 4 <= ftyp.end; i += 4) brands.push(ascii(b, i, 4));
  if (!brands.some((x) => ['avif', 'avis', 'heic', 'heix', 'mif1', 'msf1'].includes(x))) return null;
  const meta = child(top, 'meta');
  if (!meta) return null;
  // meta is a full box: 4 bytes of version and flags before its children.
  const inMeta = boxes(b, meta.start + 4, meta.end);
  const pitm = child(inMeta, 'pitm');
  const iprp = child(inMeta, 'iprp');
  if (!pitm || !iprp) return null;
  const pitmVersion = b[pitm.start];
  const primary = pitmVersion === 0 ? u16be(b, pitm.start + 4) : u32be(b, pitm.start + 4);
  if (primary < 0) return null;
  const inIprp = boxes(b, iprp.start, iprp.end);
  const ipco = child(inIprp, 'ipco');
  const ipma = child(inIprp, 'ipma');
  if (!ipco || !ipma) return null;
  const properties = boxes(b, ipco.start, ipco.end);
  if (!properties) return null;
  const indices = associations(b, ipma, primary);
  if (!indices) return null;
  let size: { w: number; h: number } | null = null;
  let turned = false;
  for (const index of indices) {
    const p = properties[index - 1];          // 1-based; 0 means "no property"
    if (!p) continue;
    if (p.type === 'ispe' && !size) {
      const w = u32be(b, p.start + 4);
      const h = u32be(b, p.start + 8);
      if (w < 0 || h < 0) return null;
      size = { w, h };
    }
    if (p.type === 'irot' && p.start < p.end) turned = (b[p.start] & 0x03) % 2 === 1;
  }
  return size ? sized(size.w, size.h, turned) : null;
}

/** The property indices ipma associates with `item`, or null when malformed. */
function associations(b: Uint8Array, ipma: Box, item: number): number[] | null {
  // A full box: version, then 24-bit big-endian flags.
  if (ipma.start + 4 > ipma.end) return null;
  const version = b[ipma.start];
  const wide = (b[ipma.start + 3] & 1) === 1;   // flags & 1: 15-bit indices
  let i = ipma.start + 4;
  const count = u32be(b, i);
  if (count < 0 || count > MAX_STEPS) return null;
  i += 4;
  for (let n = 0; n < count; n++) {
    const id = version < 1 ? u16be(b, i) : u32be(b, i);
    i += version < 1 ? 2 : 4;
    if (id < 0 || i >= ipma.end) return null;
    const each = b[i];
    i += 1;
    const found: number[] = [];
    for (let k = 0; k < each; k++) {
      if (wide) {
        const v = u16be(b, i);
        if (v < 0 || i + 2 > ipma.end) return null;
        found.push(v & 0x7fff);
        i += 2;
      } else {
        if (i >= ipma.end) return null;
        found.push(b[i] & 0x7f);
        i += 1;
      }
    }
    if (id === item) return found;
  }
  return null;
}

/* ---- SVG: the root element's width/height, else its viewBox --------------- */

/** A length in user units or px; percentages and other units are not a size. */
function svgLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  const m = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(px)?\s*$/.exec(value);
  return m ? Number(m[1]) : null;
}

function svg(bytes: Uint8Array): ImageSize | null {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, SVG_HEAD_BYTES));
  // Skip a BOM, then the prolog — XML declaration, processing instructions,
  // comments and a doctype (with its internal subset), in any order; the
  // root after them must be <svg.
  const rest = head.replace(/^﻿/, '')
    .replace(/^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>)*/i, '');
  const open = /^<svg\b([^>]*)>/.exec(rest);
  if (!open) return null;
  const attrs: Record<string, string> = {};
  for (const m of open[1].matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    attrs[m[1]] = m[3] ?? m[4] ?? '';
  }
  const width = svgLength(attrs.width);
  const height = svgLength(attrs.height);
  if (width !== null && height !== null) return sized(Math.round(width), Math.round(height));
  const box = (attrs.viewBox ?? '').trim().split(/[\s,]+/).map(Number);
  if (box.length !== 4 || box.some((n) => !Number.isFinite(n))) return null;
  const [, , w, h] = box;
  if (w <= 0 || h <= 0) return null;
  // Only one side given: the other follows the viewBox's proportions.
  if (width !== null) return sized(Math.round(width), Math.round((width * h) / w));
  if (height !== null) return sized(Math.round((height * w) / h), Math.round(height));
  return sized(Math.round(w), Math.round(h));
}
