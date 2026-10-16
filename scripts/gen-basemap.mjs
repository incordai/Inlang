/**
 * The default world basemap (chat-block-spec §19.15, issue #4): the archive
 * `az build` copies into a map site's server when the operator names no
 * world archive of their own (AZ_MAP_WORLD), so a map is never a blank box.
 *
 *     node scripts/gen-basemap.mjs [--cache dir] [--out file]   write it
 *     node scripts/gen-basemap.mjs --check [--cache dir]         regenerate in memory; exit 1 unless byte-identical
 *
 * Inputs: scripts/basemap/sources.json — public-domain land, lake and
 * country-border data at two scales, pinned by release and SHA-256,
 * downloaded once into the cache (the only network use; a mismatched hash
 * stops the run). Output: packages/backend/assets/basemap/world.pmtiles —
 * vector tiles, zoom 0 to MAX_ZOOM, in the layers the map runtime's basemap
 * style reads (`earth`, `water`, `boundaries`), each tile clipped with a
 * small buffer and simplified to under a pixel, equal tiles stored once,
 * nothing compressed, so no compression library's version changes the
 * bytes; `--check` proves a regeneration is byte-identical
 * (scripts/lib/vector-tiles.mjs). No labels: place names need glyph files,
 * which the operator adds with their own archive (docs/self-hosting.md §9).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXTENT, clipLine, clipRing, layer, pmtiles, project, ringArea, rounded, simplify } from './lib/vector-tiles.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCES = JSON.parse(readFileSync(join(ROOT, 'scripts/basemap/sources.json'), 'utf8'));
/** The deepest zoom — the map runtime's own cap without a regional extract (chat-map-gl.ts MAP_GL.worldZoom). */
export const MAX_ZOOM = 6;
/** Zooms up to this read the coarse data; deeper ones the finer. */
const COARSE_UNTIL = 2;
/** Tile units drawn past each edge, so a polygon's clipped edge and a line's join never show at the seam. */
const BUFFER = 64;
/** Simplification in tile units: EXTENT is 512 screen pixels, so 4 units is half a pixel. */
const TOLERANCE = 4;
const DOWNLOAD_MS = 120_000;
const OUT = join(ROOT, 'packages/backend/assets/basemap/world.pmtiles');

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const checkOnly = args.includes('--check');
const cache = flag('--cache') ?? join(tmpdir(), `az-basemap-${SOURCES.release}`);
const out = flag('--out') ?? OUT;

/** A source file's bytes: from the cache, else downloaded once; refused unless its SHA-256 is the pinned one. */
async function source(name) {
  const { file, sha256 } = SOURCES.files[name];
  const path = join(cache, file);
  if (!existsSync(path)) {
    mkdirSync(cache, { recursive: true });
    const r = await fetch(`${SOURCES.base}${file}`, { signal: AbortSignal.timeout(DOWNLOAD_MS), redirect: 'error' });
    if (!r.ok) throw new Error(`${file}: download answered ${r.status}`);
    writeFileSync(path, Buffer.from(await r.arrayBuffer()));
  }
  const bytes = readFileSync(path);
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha256) throw new Error(`${file}: SHA-256 is ${got}, not the pinned ${sha256} — delete ${path} and run again, or update sources.json knowingly`);
  return JSON.parse(bytes.toString('utf8'));
}

/** Every polygon of a collection as rings of [lon, lat] (the closing point dropped), outer ring first. */
const polygonsOf = (fc) => fc.features.flatMap((f) => {
  const g = f.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  return polys.map((rings) => rings.map((r) => r.slice(0, -1)));
});
/** Every line of a collection as [lon, lat] points. */
const linesOf = (fc) => fc.features.flatMap((f) => {
  const g = f.geometry;
  return g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
});

const boxOf = (pts) => {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
};

/** Polygons and lines in world coordinates at zoom `z`, simplified, each with its bounding box. */
function prepare(z, polys, lines) {
  const ring = (r) => simplify(r.map(([lon, lat]) => project(lon, lat, z)), TOLERANCE);
  return {
    polys: polys.map((rings) => rings.map(ring)).filter((rings) => rings[0].length >= 3).map((rings) => ({ rings, box: boxOf(rings[0]) })),
    lines: lines.map((l) => simplify(l.map(([lon, lat]) => project(lon, lat, z)), TOLERANCE)).filter((l) => l.length >= 2).map((pts) => ({ pts, box: boxOf(pts) })),
  };
}

const overlaps = (b, x0, y0, x1, y1) => b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1;

/** A polygon clipped to the tile at (ox, oy) in world units: its rings in tile units, the exterior winding positive, holes negative; null when nothing is left. */
function clipPolygon(rings, ox, oy) {
  const x0 = ox - BUFFER; const y0 = oy - BUFFER; const x1 = ox + EXTENT + BUFFER; const y1 = oy + EXTENT + BUFFER;
  const parts = [];
  for (const [i, r] of rings.entries()) {
    const clipped = rounded(clipRing(r, x0, y0, x1, y1).map(([x, y]) => [x - ox, y - oy]), true);
    const area = clipped.length >= 3 ? ringArea(clipped) : 0;
    if (area === 0) { if (i === 0) return null; continue; }
    // MVT §4.3.4.4: exterior positive (clockwise, y down), interior negative — whatever the source's winding.
    parts.push((i === 0) === (area > 0) ? clipped : clipped.reverse());
  }
  return parts.length > 0 ? parts : null;
}

/** One tile's bytes, or null when it holds nothing (open water). */
function tile(z, x, y, data) {
  const ox = x * EXTENT; const oy = y * EXTENT;
  const x0 = ox - BUFFER; const y0 = oy - BUFFER; const x1 = ox + EXTENT + BUFFER; const y1 = oy + EXTENT + BUFFER;
  const polygons = (set, props) => set.filter((p) => overlaps(p.box, x0, y0, x1, y1))
    .map((p) => clipPolygon(p.rings, ox, oy)).filter((parts) => parts !== null).map((parts) => ({ kind: 'polygon', props, parts }));
  const earth = polygons(data.land.polys, { kind: 'earth' });
  const water = polygons(data.lakes.polys, { kind: 'lake' });
  const borders = data.borders.lines.filter((l) => overlaps(l.box, x0, y0, x1, y1))
    .flatMap((l) => clipLine(l.pts, x0, y0, x1, y1))
    .map((piece) => rounded(piece.map(([px, py]) => [px - ox, py - oy]), false)).filter((piece) => piece.length >= 2)
    .map((piece) => ({ kind: 'line', props: { kind: 'country', kind_detail: 2 }, parts: [piece] }));
  if (earth.length === 0 && water.length === 0 && borders.length === 0) return null;
  return Buffer.from([
    ...(earth.length > 0 ? layer('earth', earth) : []),
    ...(water.length > 0 ? layer('water', water) : []),
    ...(borders.length > 0 ? layer('boundaries', borders) : []),
  ]);
}

const [landCoarse, land, lakesCoarse, lakes, bordersCoarse, borders] = await Promise.all(
  ['land-coarse', 'land', 'lakes-coarse', 'lakes', 'borders-coarse', 'borders'].map(source));
const raw = {
  coarse: { land: polygonsOf(landCoarse), lakes: polygonsOf(lakesCoarse), borders: linesOf(bordersCoarse) },
  fine: { land: polygonsOf(land), lakes: polygonsOf(lakes), borders: linesOf(borders) },
};

const tiles = [];
for (let z = 0; z <= MAX_ZOOM; z++) {
  const r = z <= COARSE_UNTIL ? raw.coarse : raw.fine;
  const data = { land: prepare(z, r.land, []), lakes: prepare(z, r.lakes, []), borders: prepare(z, [], r.borders) };
  const n = 2 ** z;
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      const bytes = tile(z, x, y, data);
      if (bytes) tiles.push({ z, x, y, data: bytes });
    }
  }
}

const metadata = {
  name: 'az default world basemap',
  description: `Land, lakes and country borders, zoom 0–${MAX_ZOOM}, from public-domain data (release ${SOURCES.release}); made by scripts/gen-basemap.mjs`,
  attribution: SOURCES.attribution,
  version: SOURCES.release,
  vector_layers: [
    { id: 'earth', fields: { kind: 'String' }, minzoom: 0, maxzoom: MAX_ZOOM },
    { id: 'water', fields: { kind: 'String' }, minzoom: 0, maxzoom: MAX_ZOOM },
    { id: 'boundaries', fields: { kind: 'String', kind_detail: 'Number' }, minzoom: 0, maxzoom: MAX_ZOOM },
  ],
};
const archive = pmtiles(tiles, { minZoom: 0, maxZoom: MAX_ZOOM, metadata });
const sha = createHash('sha256').update(archive).digest('hex');

if (checkOnly) {
  const committed = existsSync(out) ? readFileSync(out) : null;
  const same = committed !== null && committed.equals(archive);
  console.log(`${same ? 'PASS ' : 'FAIL '} ${out} is ${same ? '' : 'not '}what the pinned sources make (${archive.length} bytes, sha256 ${sha})`);
  process.exitCode = same ? 0 : 1;
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, archive);
  console.log(`wrote ${out}: ${tiles.length} tiles, ${archive.length} bytes, sha256 ${sha}`);
}
