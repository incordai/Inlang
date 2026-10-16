/**
 * @az server chat-map
 * Purpose: an answer's map — pins, places and routes read from the model's lines and checked whole, or a site table's rows asked by name; and its canonical lines.
 * Spec: docs/chat-block-spec.md §21.4.2, §21.4.4
 * Exports: MAP_LIMITS, MapPin, MapPlace, MapRoute, RichMap, MapReader, MapRead, MapLost, readMap, mapLines, coordinateOf, roundCoordinate, microDegrees,
 *   mapWords, MapNode
 * Edit guide: a coordinate is the answer grammar's number, in range, at most six decimals — never rounded for the model, which
 *   would place a pin it did not write; a place is an address the server may geocode, never a URL; `src` is set by the resolver.
 * Tests: packages/backend/test/chat-map.test.ts
 */

/**
 * `map` (chat-block-spec §21.4) is a value of `show`, never a word:
 *
 *     map "Where to find us"
 *       pin "Workshop" 52.520008 13.404954
 *       place "Main hall" "Alexanderplatz, Berlin"
 *       route "Walk"
 *         point 52.520008 13.404954
 *         point 52.5163 13.3777
 *     map "Our stores" from stores label name lat latitude lon longitude where open yes
 *
 * The model's pins are the model's numbers: the page shows them as
 * "Approximate, AI-placed", which the model cannot remove. A coordinate with
 * more than six decimals, or out of range, drops its pin (or its route) by
 * itself — counted `number` — and the rest of the map stands. A `place` is
 * an address the operator's geocoder looks up on the server (chat-geocode.ts);
 * without AZ_GEOCODER_URL the line drops (`not_shown`). A `from` is a request
 * the server answers from a public table (chat-query.ts parsePins); its words
 * are checked for shape here and against the schema there.
 *
 * Copied into a generated server with chat; imports only its siblings.
 */

import type { LineToken } from './chat-answer.ts';

/** chat-block-spec §21.4.2. The page holds the same (overlay chat-map.ts MAP_CAPS). */
export const MAP_LIMITS = {
  title: 80,
  /** Pins and places together. */
  pins: 24,
  label: 40,
  routes: 2,
  routePoints: { min: 2, max: 50 },
  decimals: 6,
  /** A place's address, in code points. */
  address: 120,
  /** Places one answer may geocode. */
  placesPerAnswer: 3,
  /** Child lines: the pins and places, two routes and their points. */
  lines: 24 + 2 * (1 + 50),
} as const;

export interface MapPin { readonly label: string; readonly lat: number; readonly lon: number }
export interface MapPlace { readonly label: string; readonly address: string }
export interface MapRoute { readonly label: string; readonly points: readonly (readonly [number, number])[] }

/** A map as read from the model: its own pins, places and routes, or a site table's request (the words after `from`). */
export type RichMap =
  | { readonly title: string; readonly pins: readonly MapPin[]; readonly places: readonly MapPlace[]; readonly routes: readonly MapRoute[] }
  | { readonly title: string; readonly from: readonly string[] };

/** One child line of the map, as chat-rich.ts holds it: its tokens and the lines one level under it. */
export interface MapNode { readonly tokens: readonly LineToken[]; readonly children: readonly MapNode[] }

/** The reader's own helpers (chat-rich.ts reader): its string rules, its `from` count, its failure. */
export interface MapReader {
  readonly bare: (t: LineToken | undefined, v?: string) => boolean;
  readonly str: (t: LineToken | undefined) => t is LineToken;
  readonly clean: (s: string) => string;
  readonly clampText: (s: string, max: number) => string;
  readonly parseNumber: (s: string) => number | null;
  readonly from: (tokens: readonly LineToken[], i: number) => string[];
  readonly fail: (why: 'shape' | 'empty' | 'too_many') => never;
  /** AZ_GEOCODER_URL is set: a `place` may be looked up. */
  readonly geocoder: boolean;
}

/** What one line lost by itself, the rest of the map standing — each is counted as the answer's drops. */
export type MapLost = 'number' | 'not_shown' | 'too_long';

export interface MapRead {
  readonly map: RichMap;
  readonly lost: readonly MapLost[];
  /** Pins, places and route points: the answer's data points. */
  readonly points: number;
  /** Places to geocode, counted against the answer's. */
  readonly places: number;
}

/** A coordinate in the answer grammar's number subset, within ±`max`, at most six decimals — or null. */
export function coordinateOf(word: string, max: number, parseNumber: (s: string) => number | null): number | null {
  const n = parseNumber(word);
  if (n === null || n < -max || n > max) return null;
  const point = word.indexOf('.');
  if (point >= 0 && word.length - point - 1 > MAP_LIMITS.decimals) return null;
  return n;
}

/** A coordinate held to six decimals (about a decimetre) — what the geocoder answered, which is the operator's, never dropped for its precision. */
export const roundCoordinate = (n: number): number => {
  const r = Math.round(n * 1e6) / 1e6;
  return r === 0 ? 0 : r;
};

/**
 * A site row's coordinate: a `number` field is whole (data-spec §3), so a
 * table holds a coordinate as millionths of a degree — `52520008` is
 * 52.520008°, exactly the map's six decimals. Null when it is not a whole
 * number within ±`max` degrees.
 */
export function microDegrees(v: unknown, max: number): number | null {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > max * 1e6) return null;
  const n = Number((v / 1e6).toFixed(MAP_LIMITS.decimals));
  return n === 0 ? 0 : n;
}

/** The words a map's `from` takes (§21.4.2): `<table> label <f> lat <f> lon <f> [where <f> <v>]`, shape only. */
export function mapWords(words: readonly string[]): boolean {
  if (words.length !== 7 && words.length !== 10) return false;
  if (words[1] !== 'label' || words[3] !== 'lat' || words[5] !== 'lon') return false;
  return words.length === 7 || words[7] === 'where';
}

const quoted = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

/**
 * The map under `head` (`map "title"`, or `map "title" from …`), its child
 * lines as a tree — or a failure through `r.fail`.
 */
export function readMap(head: readonly LineToken[], tree: readonly MapNode[], r: MapReader): MapRead {
  const label = (t: LineToken | undefined, max: number): string => {
    if (!r.str(t)) return r.fail('shape');
    const v = r.clean(t.value).trim();
    if (v === '' || v.includes('\n')) r.fail('shape');
    return r.clampText(v, max);
  };
  const title = label(head[1], MAP_LIMITS.title);
  if (r.bare(head[2], 'from')) {
    if (tree.length > 0) r.fail('shape');
    const words = r.from(head, 2);
    if (!mapWords(words)) r.fail('shape');
    return { map: { title, from: words }, lost: [], points: 0, places: 0 };
  }
  if (head.length !== 2) r.fail('shape');
  if (tree.length === 0) r.fail('empty');
  const lost: MapLost[] = [];
  const pins: MapPin[] = [];
  const places: MapPlace[] = [];
  const routes: MapRoute[] = [];
  /** `lat lon` as two bare words, each in range — or null (the line goes by itself). */
  const pair = (a: LineToken | undefined, b: LineToken | undefined): readonly [number, number] | null => {
    if (!r.bare(a) || !r.bare(b)) return r.fail('shape');
    const lat = coordinateOf(a!.value, 90, r.parseNumber);
    const lon = coordinateOf(b!.value, 180, r.parseNumber);
    return lat === null || lon === null ? null : [lat, lon];
  };
  if (tree.filter((n) => r.bare(n.tokens[0], 'route')).length > MAP_LIMITS.routes) r.fail('too_many');
  let marks = 0;
  for (const n of tree) {
    const [k, a, b, c] = n.tokens;
    if (r.bare(k, 'pin')) {
      if (n.tokens.length !== 4 || n.children.length > 0) r.fail('shape');
      if (++marks > MAP_LIMITS.pins) r.fail('too_many');
      const text = label(a, MAP_LIMITS.label);
      const at = pair(b, c);
      if (at === null) { lost.push('number'); continue; }
      pins.push({ label: text, lat: at[0], lon: at[1] });
    } else if (r.bare(k, 'place')) {
      if (n.tokens.length !== 3 || n.children.length > 0 || !r.str(b)) r.fail('shape');
      if (++marks > MAP_LIMITS.pins) r.fail('too_many');
      const text = label(a, MAP_LIMITS.label);
      const address = r.clean(b!.value).trim();
      if (address === '' || address.includes('\n')) r.fail('shape');
      // Only the operator's geocoder can place an address (§21.4.2); without it the line is not shown.
      if (!r.geocoder) { lost.push('not_shown'); continue; }
      if ([...address].length > MAP_LIMITS.address) { lost.push('too_long'); continue; }
      places.push({ label: text, address });
    } else if (r.bare(k, 'route')) {
      if (n.tokens.length !== 2) r.fail('shape');
      const text = label(a, MAP_LIMITS.label);
      if (n.children.length < MAP_LIMITS.routePoints.min) r.fail('empty');
      if (n.children.length > MAP_LIMITS.routePoints.max) r.fail('too_many');
      const points: (readonly [number, number])[] = [];
      let bad = false;
      for (const p of n.children) {
        if (!r.bare(p.tokens[0], 'point') || p.tokens.length !== 3 || p.children.length > 0) r.fail('shape');
        const at = pair(p.tokens[1], p.tokens[2]);
        if (at === null) bad = true;
        else points.push(at);
      }
      // One point off the grammar's coordinates takes its route with it; the pins stand.
      if (bad) { lost.push('number'); continue; }
      routes.push({ label: text, points });
    } else {
      r.fail('shape');
    }
  }
  if (pins.length + places.length === 0) r.fail('empty');
  const points = pins.length + places.length + routes.reduce((s, x) => s + x.points.length, 0);
  return { map: { title, pins, places, routes }, lost, points, places: places.length };
}

/** A coordinate as the canonical lines write it: the number as written, never an exponent (the grammar caps it at six decimals). */
const coord = (n: number): string => String(n);

/** The map in its canonical lines — what the answer's record holds: the model's pins, places and routes, or the request. */
export function mapLines(m: RichMap): string[] {
  if ('from' in m) return [`map ${quoted(m.title)} from ${m.from.join(' ')}`];
  const out = [`map ${quoted(m.title)}`];
  for (const p of m.pins) out.push(`  pin ${quoted(p.label)} ${coord(p.lat)} ${coord(p.lon)}`);
  for (const p of m.places) out.push(`  place ${quoted(p.label)} ${quoted(p.address)}`);
  for (const route of m.routes) {
    out.push(`  route ${quoted(route.label)}`);
    for (const [lat, lon] of route.points) out.push(`    point ${coord(lat)} ${coord(lon)}`);
  }
  return out;
}
