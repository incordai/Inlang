/**
 * Hostile and ordinary images for the upload tests, made in code: a phone
 * photo's EXIF (orientation, camera, GPS), XMP and a script comment written
 * by hand, so no sample file is checked in; headers rewritten to claim
 * decompression-bomb sizes; SVG, HTML and text under an image's name; and
 * scanners that find any metadata left in a stored file. Test-only.
 */

import { crc32 } from 'node:zlib';
import sharp from 'sharp';

/** A TIFF block: IFD0 { Make "VetCam", Orientation, GPSInfo → { N 48°51′24″, E 2°17′40″ } }, little-endian. */
export function exifTiff(orientation: number): Buffer {
  const make = Buffer.from('VetCam\0', 'latin1');
  const ifd0 = 8;
  const ifd0Len = 2 + 3 * 12 + 4;
  const gps = ifd0 + ifd0Len;
  const gpsLen = 2 + 4 * 12 + 4;
  const rational = (pairs: readonly [number, number][]) => {
    const b = Buffer.alloc(pairs.length * 8);
    pairs.forEach(([n, d], i) => { b.writeUInt32LE(n, i * 8); b.writeUInt32LE(d, i * 8 + 4); });
    return b;
  };
  const lat = rational([[48, 1], [51, 1], [2412, 100]]);
  const lon = rational([[2, 1], [17, 1], [4020, 100]]);
  const dataAt = gps + gpsLen;
  const [makeAt, latAt, lonAt] = [dataAt, dataAt + make.length, dataAt + make.length + lat.length];
  const out = Buffer.alloc(lonAt + lon.length);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(ifd0, 4);
  const entry = (base: number, i: number, tag: number, type: number, count: number, value: (p: number) => void) => {
    const p = base + 2 + i * 12;
    out.writeUInt16LE(tag, p);
    out.writeUInt16LE(type, p + 2);
    out.writeUInt32LE(count, p + 4);
    value(p + 8);
  };
  out.writeUInt16LE(3, ifd0);
  entry(ifd0, 0, 0x010f, 2, make.length, (p) => out.writeUInt32LE(makeAt, p));
  entry(ifd0, 1, 0x0112, 3, 1, (p) => out.writeUInt16LE(orientation, p));
  entry(ifd0, 2, 0x8825, 4, 1, (p) => out.writeUInt32LE(gps, p));
  out.writeUInt16LE(4, gps);
  entry(gps, 0, 0x0001, 2, 2, (p) => out.write('N\0', p, 'latin1'));
  entry(gps, 1, 0x0002, 5, 3, (p) => out.writeUInt32LE(latAt, p));
  entry(gps, 2, 0x0003, 2, 2, (p) => out.write('E\0', p, 'latin1'));
  entry(gps, 3, 0x0004, 5, 3, (p) => out.writeUInt32LE(lonAt, p));
  make.copy(out, makeAt);
  lat.copy(out, latAt);
  lon.copy(out, lonAt);
  return out;
}

const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="48,51.40N"/></rdf:RDF></x:xmpmeta>';
const SCRIPT = '<script>alert("polyglot")</script>';

const segment = (marker: number, payload: Buffer) => {
  const h = Buffer.alloc(4);
  h[0] = 0xff;
  h[1] = marker;
  h.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([h, payload]);
};

/** A flat-colour image with a 2:1 shape, so a rotation shows in the stored size. */
const base = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } } });

/**
 * A phone photo: JPEG with an ICC profile, then EXIF (orientation 6 = rotate
 * 90°, camera, GPS), XMP with GPS, and a comment holding a script.
 */
export async function phoneJpeg(width = 64, height = 32, orientation = 6): Promise<Buffer> {
  const jpeg = await base(width, height).withIccProfile('p3').jpeg().toBuffer();
  const exif = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exifTiff(orientation)]));
  const xmp = segment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(XMP, 'utf8')]));
  const com = segment(0xfe, Buffer.from(SCRIPT, 'latin1'));
  return Buffer.concat([jpeg.subarray(0, 2), exif, xmp, com, jpeg.subarray(2)]);
}

const pngChunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};
const IHDR_END = 8 + 8 + 13 + 4;

/** A PNG carrying eXIf (GPS), XMP and a script in a text chunk. */
export async function taggedPng(width = 48, height = 24): Promise<Buffer> {
  const png = await base(width, height).png().toBuffer();
  return Buffer.concat([
    png.subarray(0, IHDR_END),
    pngChunk('eXIf', exifTiff(1)),
    pngChunk('iTXt', Buffer.concat([Buffer.from('XML:com.adobe.xmp\0\0\0\0\0', 'latin1'), Buffer.from(XMP, 'utf8')])),
    pngChunk('tEXt', Buffer.from(`Comment\0${SCRIPT}`, 'latin1')),
    png.subarray(IHDR_END),
  ]);
}

/** A small PNG whose header claims another size (CRC fixed): a decompression bomb by its header. */
export async function pngClaiming(width: number, height: number): Promise<Buffer> {
  const png = Buffer.from(await base(8, 8).png().toBuffer());
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)) >>> 0, 29);
  return png;
}

/** A small JPEG whose frame header claims another size. */
export async function jpegClaiming(width: number, height: number): Promise<Buffer> {
  const jpeg = Buffer.from(await base(8, 8).jpeg().toBuffer());
  for (let p = 2; p + 9 < jpeg.length;) {
    const marker = jpeg[p + 1];
    if (marker >= 0xc0 && marker <= 0xc2) {
      jpeg.writeUInt16BE(height, p + 5);
      jpeg.writeUInt16BE(width, p + 7);
      return jpeg;
    }
    p += 2 + jpeg.readUInt16BE(p + 2);
  }
  throw new Error('no frame header');
}

/** A real image of the given size, compressed: decodes to width × height × 3 bytes. */
export const plainJpeg = (width: number, height: number) => base(width, height).jpeg({ quality: 70 }).toBuffer();
export const plainWebp = (width: number, height: number) => base(width, height).webp().toBuffer();
export const plainAvif = (width: number, height: number) => base(width, height).avif().toBuffer();
export const plainGif = (width: number, height: number) => base(width, height).gif().toBuffer();
export const plainTiff = (width: number, height: number) => base(width, height).tiff().toBuffer();

/** An SVG with a script — refused whatever it is called. */
export const SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10"/></svg>`);
export const HTML = Buffer.from(`<!doctype html><html><body>${SCRIPT}</body></html>`);
export const TEXT = Buffer.from('just some text, named photo.jpg\n');

/** An HEIC file's opening box: `ftyp` brand `heic`, which the library cannot decode (no HEVC). */
export const HEIC = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic', 'latin1'), Buffer.from([0, 0, 0, 0]),
  Buffer.from('mif1heic', 'latin1'), Buffer.alloc(64),
]);

/** A JPEG with HTML after its end: a file that is "both" an image and a page. */
export async function polyglotJpeg(): Promise<Buffer> {
  return Buffer.concat([await phoneJpeg(32, 32, 1), HTML]);
}

/** The WebP's chunk types (RIFF container). */
export function webpChunks(b: Buffer): string[] {
  const out: string[] = [];
  for (let p = 12; p + 8 <= b.length;) {
    const len = b.readUInt32LE(p + 4);
    out.push(b.toString('latin1', p, p + 4));
    p += 8 + len + (len & 1);
  }
  return out;
}

/** Metadata left in a stored file: empty means clean. */
export function metadataFindings(b: Buffer): string[] {
  const text = b.toString('latin1');
  const found = ['Exif\0\0', 'VetCam', 'GPSLat', 'xmpmeta', 'ns.adobe.com', '<script', 'ICC_PROFILE', 'acsp', '<html']
    .filter((needle) => text.includes(needle)).map((n) => `bytes:${JSON.stringify(n)}`);
  if (text.startsWith('RIFF')) found.push(...webpChunks(b).filter((c) => ['EXIF', 'XMP ', 'ICCP'].includes(c)).map((c) => `chunk:${c}`));
  return found;
}
