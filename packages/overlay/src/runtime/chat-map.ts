/**
 * @az runtime chat-map
 * Purpose: an answer's map as the page checks it — its closed shape, every cap, every coordinate — and the words it is said and listed in.
 * Spec: docs/chat-block-spec.md §21.4.2, §21.4.4, §21.4.5
 * Exports: MAP_CAPS, MAP_TEXT, MAP_ZOOM, MapData, MapPin, MapRoute, PinSource, validMap, mapBounds, mapSummary, placeWords, pinLabel, mapLabels,
 *   zoomCap, pastTiles
 * Edit guide: no DOM; an event that breaks any cap is refused whole, never repaired; every word the page adds is fixed copy here.
 * Tests: packages/overlay/test/chat-map.test.ts
 */

/**
 * The server read the model's map, or a table's rows, and set each pin's
 * source (backend chat-map.ts, chat-rich.ts); the page checks it again,
 * because it draws it — a forged or damaged event must be inert. A pin is a
 * label and two numbers in range with at most six decimals; a route two to
 * fifty of them. The labels the visitor is shown are fixed copy keyed by the
 * source the server set: "Approximate, AI-placed" for the model's numbers,
 * "Approximate location" for what the operator's geocoder found, the site's
 * own source line for a table's rows — the model can write none of them.
 */

/** chat-block-spec §21.4.2 — the server's MAP_LIMITS (backend chat-map.ts), held again. */
export const MAP_CAPS = {
  title: 80,
  pins: 24,
  label: 40,
  routes: 2,
  routePoints: { min: 2, max: 50 },
  decimals: 6,
} as const;

/** Where a pin's numbers came from: the model, the operator's geocoder, or the site's table. */
export type PinSource = 'model' | 'geocoded' | 'site';

export interface MapPin { readonly label: string; readonly lat: number; readonly lon: number; readonly src: PinSource }
export interface MapRoute { readonly label: string; readonly points: readonly (readonly [number, number])[] }

export interface MapData {
  readonly title: string;
  /** `model`: the model's own pins and routes (and any it placed by address); `site`: a public table's rows, read on `asOf`. */
  readonly src: 'model' | 'site';
  readonly asOf: string | null;
  readonly pins: readonly MapPin[];
  readonly routes: readonly MapRoute[];
}

/** Fixed copy (§21.4.4, §21.4.5): never model text. */
export const MAP_TEXT = {
  ai: 'Approximate, AI-placed',
  geocoded: 'Approximate location',
  /** The table equivalent's toggle, and the note that it is the whole map. */
  list: 'Show the places as a list',
  fallback: 'The map cannot be drawn here, so its places are listed.',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  reset: 'Reset view',
  show: 'Show on the map',
  stop: (n: number) => `Stop ${n}`,
  /** Issue #21: under the map while its view is deeper than its tiles — the places are drawn where they are, the ground behind them has no streets. */
  detail: 'This map has no street detail at this zoom.',
  /** What the map's image is called, and what the status region hears when it is drawn. */
  summary: (title: string, pins: number, routes: number) =>
    `Map: ${title}, ${pins === 1 ? '1 place' : `${pins} places`}${routes > 0 ? `, ${routes === 1 ? '1 route' : `${routes} routes`}` : ''}.`,
  listed: (title: string, pins: number) => `Map: ${title}, ${pins === 1 ? '1 place' : `${pins} places`}, shown as a list.`,
} as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every((k) => keys.includes(k));
/** Labels are counted in code points, as the server clamps them (chat-rich.ts clampText). */
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim() !== '' && !v.includes('\n') && [...v].length <= max;

/** A coordinate the grammar allows: a finite number within ±`max`, with at most six decimals and never written as an exponent. */
function coordinate(v: unknown, max: number): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > max) return false;
  const s = String(v);
  if (/e/i.test(s)) return false;
  const point = s.indexOf('.');
  return point < 0 || s.length - point - 1 <= MAP_CAPS.decimals;
}

const pairOk = (p: unknown): p is [number, number] => Array.isArray(p) && p.length === 2 && coordinate(p[0], 90) && coordinate(p[1], 180);

/**
 * A map event checked: `{ title, src, asOf?, pins, routes }` with 1–24 pins
 * and 0–2 routes of 2–50 points; a model map's pins are `model` or
 * `geocoded` and it has no day; a site map's pins are all `site`, with the
 * day they were read and no route. Anything else is null.
 */
export function validMap(v: unknown): MapData | null {
  if (!isRecord(v) || !only(v, ['title', 'src', 'asOf', 'pins', 'routes'])) return null;
  if (!text(v.title, MAP_CAPS.title)) return null;
  const site = v.src === 'site';
  if (v.src !== 'model' && !site) return null;
  if (site ? !(typeof v.asOf === 'string' && DAY.test(v.asOf)) : v.asOf !== undefined) return null;
  if (!Array.isArray(v.pins) || v.pins.length < 1 || v.pins.length > MAP_CAPS.pins) return null;
  const pins: MapPin[] = [];
  for (const p of v.pins) {
    if (!isRecord(p) || !only(p, ['label', 'lat', 'lon', 'src']) || !text(p.label, MAP_CAPS.label)) return null;
    if (!coordinate(p.lat, 90) || !coordinate(p.lon, 180)) return null;
    const ok = site ? p.src === 'site' : p.src === 'model' || p.src === 'geocoded';
    if (!ok) return null;
    pins.push({ label: p.label, lat: p.lat === 0 ? 0 : p.lat, lon: p.lon === 0 ? 0 : p.lon, src: p.src as PinSource });
  }
  if (!Array.isArray(v.routes) || v.routes.length > (site ? 0 : MAP_CAPS.routes)) return null;
  const routes: MapRoute[] = [];
  for (const r of v.routes) {
    if (!isRecord(r) || !only(r, ['label', 'points']) || !text(r.label, MAP_CAPS.label)) return null;
    if (!Array.isArray(r.points) || r.points.length < MAP_CAPS.routePoints.min || r.points.length > MAP_CAPS.routePoints.max || !r.points.every(pairOk)) return null;
    routes.push({ label: r.label, points: r.points.map((p: [number, number]) => [p[0], p[1]] as const) });
  }
  return { title: v.title, src: site ? 'site' : 'model', asOf: site ? v.asOf as string : null, pins, routes };
}

/**
 * How deep a map may zoom (issue #21): at least `overzoom`, past the tiles'
 * deepest zoom, so places a few hundred metres apart are told apart even on
 * the bundled world basemap (zoom 0–6, about 2 km to a pixel there) — the
 * land, water and borders are drawn larger, and a note says there is no
 * street detail. With a regional extract deeper than that, its own depth.
 */
export const MAP_ZOOM = { overzoom: 14, epsilon: 1e-6 } as const;

/** The deepest zoom the view may reach, given the deepest zoom of the tiles it draws. */
export function zoomCap(deepestTiles: number): number {
  return Math.max(MAP_ZOOM.overzoom, deepestTiles);
}

/** The view is deeper than any tile it draws: the note on street detail shows. */
export function pastTiles(zoom: number, deepestTiles: number): boolean {
  return zoom > deepestTiles + MAP_ZOOM.epsilon;
}

/** The box around every pin and route point: `[west, south, east, north]` — the view the map opens at (the model writes no zoom or centre). */
export function mapBounds(m: MapData): readonly [number, number, number, number] {
  const lats = [...m.pins.map((p) => p.lat), ...m.routes.flatMap((r) => r.points.map((p) => p[0]))];
  const lons = [...m.pins.map((p) => p.lon), ...m.routes.flatMap((r) => r.points.map((p) => p[1]))];
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
}

/** The map's image name and its first announcement: its title, how many places, how many routes. */
export const mapSummary = (m: MapData): string => MAP_TEXT.summary(m.title, m.pins.length, m.routes.length);

/** A coordinate pair in words, as the list says it: "52.520008 degrees north, 13.404954 degrees east". */
export function placeWords(lat: number, lon: number): string {
  const part = (n: number, plus: string, minus: string) => `${Math.abs(n)} degrees ${n < 0 ? minus : plus}`;
  return `${part(lat, 'north', 'south')}, ${part(lon, 'east', 'west')}`;
}

/** The label a pin carries beside its own: the model's numbers and the geocoder's are approximate; a site's row is the site's. */
export const pinLabel = (src: PinSource): string | null => (src === 'model' ? MAP_TEXT.ai : src === 'geocoded' ? MAP_TEXT.geocoded : null);

/** The labels the whole map carries, once each: AI-placed when the model wrote a pin or a route, approximate when one was looked up. */
export function mapLabels(m: MapData): string[] {
  if (m.src === 'site') return [];
  const out: string[] = [];
  if (m.pins.some((p) => p.src === 'model') || m.routes.length > 0) out.push(MAP_TEXT.ai);
  if (m.pins.some((p) => p.src === 'geocoded')) out.push(MAP_TEXT.geocoded);
  return out;
}
