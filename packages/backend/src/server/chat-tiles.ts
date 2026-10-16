/**
 * @az server chat-tiles
 * Purpose: GET /tiles/… — the maps' tile archives with HTTP Range, their glyphs and sprites, and map.json saying what is served; CORS for the site only.
 * Spec: docs/chat-block-spec.md §21.4.3 (Q19e) · RFC 9110 §14 (ranges), §13.1 (preconditions)
 * Exports: TILE_ARCHIVES, ArchiveName, readArchiveHeader, openTiles, createTiles, Tiles, TileFiles, parseRange, ByteRange, ArchiveHeader, TilesProblem
 * Edit guide: a path is matched against closed shapes and joined under the operator's folder only — never a name from the request
 *   used as a path as it came; one range, served from the file as it is; every answer carries its ETag; nothing here reads the database.
 * Tests: packages/backend/test/chat-tiles.test.ts
 */

/**
 * The site's maps draw from this server, never a third party by default
 * (chat-block-spec §21.4.3): a tile reader in the page asks for byte ranges
 * of one archive file, and the map asks for label glyphs and icon sprites.
 *
 *     GET /tiles/map.json                       what this server serves (no-cache)
 *     GET /tiles/world.pmtiles                  Range: bytes=0-16383 → 206
 *     GET /tiles/region.pmtiles                 the operator's regional extract
 *     GET /tiles/glyphs/<font>[,<font>…]/<a>-<b>.pbf    the first font of the stack that has the range
 *     GET /tiles/sprites/<name>[@2x].(json|png)
 *
 * Ranges (RFC 9110 §14): one range, `bytes=a-b`, `bytes=a-` or `bytes=-n`;
 * a last byte past the end is the end. A first byte at or past the end is
 * 416 with a `Content-Range` that gives the size alone; anything else in `Range` — more
 * than one range, another unit, a malformed one — is 416 too: no client of
 * this route sends one, and a whole archive is never sent for a header it
 * did not understand. `If-Match` that names another version is 412 (the
 * tile reader's guard against a file replaced mid-read); `If-None-Match`
 * naming this one is 304. The ETag is strong: the file's size and
 * modification time. The edge — an allowed origin, the CORS that allows
 * `range` and `if-match` and exposes `etag` and `content-range` — is
 * app.ts's.
 *
 * Copied into a generated server with chat; imports only its siblings and node built-ins.
 */

import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import type { MapConfig } from './env.ts';
import { SECURITY_HEADERS } from './http.ts';

/** The archives this route may serve, by name; each is one `.env` key. */
export const TILE_ARCHIVES = { world: 'AZ_MAP_WORLD', region: 'AZ_MAP_REGION' } as const;
export type ArchiveName = keyof typeof TILE_ARCHIVES;


/** What a tile archive's header says of it (PMTiles v3 §3): enough to check it is one, and how deep it goes. */
export interface ArchiveHeader { readonly minZoom: number; readonly maxZoom: number; readonly bounds: readonly [number, number, number, number] }

/** A file this route serves: where it is, its size, its version. */
interface Served { readonly path: string; readonly size: number; readonly etag: string; readonly modified: string }

/** The archives as opened at start-up, with what their headers say. */
export interface TileFiles {
  readonly archives: Readonly<Partial<Record<ArchiveName, Served & { readonly header: ArchiveHeader }>>>;
  readonly glyphs: string | null;
  readonly sprites: string | null;
  readonly attribution: string;
}

/** A start-up refusal, naming the key and never more of its value than the operator wrote. */
export class TilesProblem extends Error {}

/** A cache life for the tile data: a day, revalidated by ETag. map.json is never cached. */
const TILE_CACHE = 'public, max-age=86400';

const HEADER_BYTES = 127;

/** The 127-byte header of a PMTiles v3 archive, or why it is not one. */
export function readArchiveHeader(bytes: Buffer): ArchiveHeader | string {
  if (bytes.length < HEADER_BYTES) return 'is shorter than a tile archive header';
  if (bytes.toString('latin1', 0, 7) !== 'PMTiles') return 'is not a PMTiles archive';
  if (bytes.readUInt8(7) !== 3) return 'is not a version 3 PMTiles archive';
  const minZoom = bytes.readUInt8(100);
  const maxZoom = bytes.readUInt8(101);
  if (maxZoom < minZoom || maxZoom > 24) return 'has zoom levels out of order';
  const e7 = (at: number) => bytes.readInt32LE(at) / 1e7;
  return { minZoom, maxZoom, bounds: [e7(102), e7(106), e7(110), e7(114)] };
}

/** A strong validator from the file's size and modification time: it changes whenever the operator replaces the file. */
const etagOf = (size: number, mtimeMs: number) => `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;

/** One file the route may serve, or null when it is not a regular file. */
async function served(path: string): Promise<Served | null> {
  const s = await stat(path).catch(() => null);
  if (!s?.isFile()) return null;
  return { path, size: s.size, etag: etagOf(s.size, s.mtimeMs), modified: s.mtime.toUTCString() };
}

/**
 * The map's files as `.env` names them, checked once at start-up: each
 * archive a readable PMTiles v3 file, each folder a folder. A problem names
 * its key (main.ts refuses to start with it).
 */
export async function openTiles(map: MapConfig): Promise<TileFiles> {
  const archives: Partial<Record<ArchiveName, Served & { header: ArchiveHeader }>> = {};
  for (const [name, key] of Object.entries(TILE_ARCHIVES) as [ArchiveName, string][]) {
    const path = map[name];
    if (path === null) continue;
    const file = await served(path);
    if (!file) throw new TilesProblem(`${key} is not a file this server can read`);
    const fh = await open(path, 'r');
    let header: ArchiveHeader | string;
    try {
      const buf = Buffer.alloc(HEADER_BYTES);
      const { bytesRead } = await fh.read(buf, 0, HEADER_BYTES, 0);
      header = readArchiveHeader(buf.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
    if (typeof header === 'string') throw new TilesProblem(`${key} ${header}`);
    archives[name] = { ...file, header };
  }
  for (const [key, dir] of [['AZ_MAP_GLYPHS', map.glyphs], ['AZ_MAP_SPRITES', map.sprites]] as const) {
    if (dir === null) continue;
    const s = await stat(dir).catch(() => null);
    if (!s?.isDirectory()) throw new TilesProblem(`${key} is not a folder this server can read`);
  }
  return { archives, glyphs: map.glyphs, sprites: map.sprites, attribution: map.attribution };
}

/** One byte range of a file of `size` bytes, inclusive. */
export interface ByteRange { readonly start: number; readonly end: number }

/**
 * `Range` against a file of `size` bytes (RFC 9110 §14.1.2): null when the
 * header is absent (the whole file), the range when it is one satisfiable
 * byte range, 'unsatisfiable' otherwise — see the module's note.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'unsatisfiable' {
  if (header === undefined) return null;
  const m = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'unsatisfiable';
  if (m[1] === '') {
    // A suffix: the last n bytes (all of them when n is past the size); none at all is unsatisfiable.
    const n = Number(m[2]);
    if (n === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const last = m[2] === '' ? size - 1 : Number(m[2]);
  if (last < start || start >= size) return 'unsatisfiable';
  return { start, end: Math.min(last, size - 1) };
}

/** Does an `If-Match` / `If-None-Match` list name `etag` (`*` names any)? Weak validators never match a strong comparison. */
function names(list: string, etag: string, weak: boolean): boolean {
  return list.split(',').map((t) => t.trim()).some((t) => t === '*' || t === etag || (weak && t === `W/${etag}`));
}

/** A font stack's names, each as the glyph folder names it; null when one is not a plain font name. */
function fontStack(raw: string): string[] | null {
  let text: string;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return null;
  }
  const fonts = text.split(',').map((f) => f.trim());
  if (fonts.length < 1 || fonts.length > 4) return null;
  return fonts.every((f) => /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(f)) ? fonts : null;
}

/** A glyph range file name, `<start>-<start + 255>.pbf` on a 256 boundary within the 16-bit range. */
function glyphRange(raw: string): string | null {
  const m = /^(\d{1,5})-(\d{1,5})\.pbf$/.exec(raw);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a % 256 === 0 && b === a + 255 && b <= 65535 ? `${a}-${b}.pbf` : null;
}

export interface Tiles {
  /**
   * Answer `GET`/`HEAD` of `path` — the part after `/tiles/` — with `cors`
   * on every answer; the origin and the method's preflight are app.ts's.
   */
  handle(method: string, path: string, headers: { readonly range?: string; readonly ifMatch?: string; readonly ifNoneMatch?: string }, res: ServerResponse, cors: Record<string, string>): Promise<void>;
}

export function createTiles(files: TileFiles): Tiles {
  const json = (res: ServerResponse, status: number, body: unknown, cors: Record<string, string>, cache = 'no-cache') => {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...SECURITY_HEADERS, ...cors, 'cache-control': cache, 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) });
    res.end(text);
  };
  const missing = (res: ServerResponse, cors: Record<string, string>) => json(res, 404, { error: 'not_found' }, cors, 'no-store');

  /** map.json: the archives by name (never a path), whether glyphs and sprites are served, and the attribution to show. */
  const manifest = {
    archives: (Object.keys(files.archives) as ArchiveName[]).map((name) => ({ name, minzoom: files.archives[name]!.header.minZoom, maxzoom: files.archives[name]!.header.maxZoom })),
    glyphs: files.glyphs !== null,
    sprites: files.sprites !== null,
    attribution: files.attribution,
  };

  /** One file, whole or one range of it, with its validators; `type` its content type. */
  async function serve(method: string, file: Served, type: string, h: Parameters<Tiles['handle']>[2], res: ServerResponse, cors: Record<string, string>): Promise<void> {
    // The version may have changed since start-up: the operator replaced the file. Its validators are read now.
    const now = await served(file.path);
    if (!now) return missing(res, cors);
    const base = {
      ...SECURITY_HEADERS, ...cors,
      'cache-control': TILE_CACHE, etag: now.etag, 'last-modified': now.modified, 'accept-ranges': 'bytes', 'content-type': type,
    };
    if (h.ifMatch !== undefined && !names(h.ifMatch, now.etag, false)) {
      res.writeHead(412, { ...base, 'content-length': '0' });
      res.end();
      return;
    }
    const range = parseRange(h.range, now.size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...base, 'content-range': `bytes */${now.size}`, 'content-length': '0' });
      res.end();
      return;
    }
    if (range === null && h.ifNoneMatch !== undefined && names(h.ifNoneMatch, now.etag, true)) {
      res.writeHead(304, base);
      res.end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: now.size - 1 };
    const length = now.size === 0 ? 0 : end - start + 1;
    res.writeHead(range ? 206 : 200, {
      ...base, 'content-length': String(length), ...(range ? { 'content-range': `bytes ${start}-${end}/${now.size}` } : {}),
    });
    if (method === 'HEAD' || length === 0) { res.end(); return; }
    const fh = await open(now.path, 'r').catch(() => null);
    if (!fh) { res.destroy(); return; }
    try {
      await pipeline(fh.createReadStream({ start, end, autoClose: false }), res);
    } catch {
      // The reader went away mid-file; nothing more can be sent.
      res.destroy();
    } finally {
      await fh.close();
    }
  }

  return {
    async handle(method, rest, h, res, cors) {
      if (rest === 'map.json') return json(res, 200, manifest, cors);
      const archive = /^(world|region)\.pmtiles$/.exec(rest);
      if (archive) {
        const file = files.archives[archive[1] as ArchiveName];
        return file ? serve(method, file, 'application/octet-stream', h, res, cors) : missing(res, cors);
      }
      const glyph = /^glyphs\/([^/]{1,512})\/([^/]{1,32})$/.exec(rest);
      if (glyph) {
        const fonts = files.glyphs === null ? null : fontStack(glyph[1]);
        const range = glyphRange(glyph[2]);
        if (!fonts || !range) return missing(res, cors);
        // The first font of the stack the folder has the range for (the style asks for a stack, a font per fallback).
        for (const font of fonts) {
          const file = await served(join(files.glyphs!, font, range));
          if (file) return serve(method, file, 'application/x-protobuf', h, res, cors);
        }
        return missing(res, cors);
      }
      const sprite = /^sprites\/([a-z0-9][a-z0-9-]{0,31}(?:@2x)?)\.(json|png)$/.exec(rest);
      if (sprite && files.sprites !== null) {
        const file = await served(join(files.sprites, `${sprite[1]}.${sprite[2]}`));
        return file ? serve(method, file, sprite[2] === 'json' ? 'application/json' : 'image/png', h, res, cors) : missing(res, cors);
      }
      return missing(res, cors);
    },
  };
}
