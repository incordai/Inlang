/**
 * @az server chat-geocode
 * Purpose: a map's `place` looked up by the operator's geocoder — server-side only, bounded in time and size, cached a day, counted per address.
 * Spec: docs/chat-block-spec.md §21.4.2, §21.4.4 (Q19g)
 * Exports: GEOCODE_LIMITS, GeocodeOutcome, geocodeKey, readGeocode, callGeocoder, createGeocoder, Geocoder, GeocoderOptions
 * Edit guide: fetch only, no SDK, no vendor names; the URL is the operator's, the model's words are one query value; no redirect
 *   is followed; the first result's two numbers are all that is read; a log line names an outcome and a time — never the address.
 * Tests: packages/backend/test/chat-geocode.test.ts
 */

/**
 * A model may write `place "Main hall" "Alexanderplatz, Berlin"` in a map
 * (chat-block-spec §21.4.2) when the operator has set AZ_GEOCODER_URL. The
 * address is the model's text; here it is
 *
 *   1. normalised (NFC, spaces collapsed, case folded) and answered from the
 *      cache when the same address was found in the last 24 hours;
 *   2. otherwise counted against the visitor's address allowance
 *      (AZ_GEOCODER_PER_ADDRESS, in the database windows every instance
 *      shares), and sent as the one query parameter `q` of a GET to the
 *      operator's URL — within 2 s, redirects refused;
 *   3. read only from a `200` JSON reply of at most 16 KB: a JSON array of
 *      results, or an object whose `results` is one; the first result's
 *      `lat` and `lon` (or `lng`), each a JSON number or a decimal string of
 *      one, in range — and nothing else of it.
 *
 * The browser never calls the geocoder, and the model never reads what it
 * answered: the page receives a pin labelled "Approximate location".
 *
 * Copied into a generated server with chat; imports only its siblings and the answer checker (#chat-answer).
 */

import { createRateLimits, type Windows } from './chat-limits.ts';
import type { GeocodeRun } from '#chat-answer/chat-rich.ts';
import { roundCoordinate } from '#chat-answer/chat-map.ts';
import type { ChatRate } from './env.ts';
import { BodyTooLarge, readCapped } from './outbound.ts';

/** chat-block-spec §21.4.2. */
export const GEOCODE_LIMITS = {
  timeoutMs: 2_000,
  bytes: 16 * 1024,
  cacheMs: 24 * 60 * 60 * 1000,
  cacheEntries: 1_000,
} as const;

/** One lookup's outcome: the coordinates, nothing found, or why it failed (for the log, never the address). */
export type GeocodeOutcome =
  | { readonly ok: true; readonly at: { readonly lat: number; readonly lon: number } | null }
  | { readonly ok: false; readonly why: string };

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** The address as the cache keys it: NFC, runs of space as one, trimmed, case folded. */
export const geocodeKey = (address: string): string => address.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

/** A decimal as a JSON number or a string of one (a geocoder often writes coordinates as strings). */
const DECIMAL = /^-?(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,15})?$/;
const coordinate = (v: unknown, max: number): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && DECIMAL.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && Math.abs(n) <= max ? roundCoordinate(n) : null;
};

/**
 * The first result's coordinates from a geocoder's JSON reply, null when it
 * found nothing (an empty list), or 'shape' when the reply is not one of the
 * two shapes or its first result has no coordinates in range.
 */
export function readGeocode(value: unknown): { lat: number; lon: number } | null | 'shape' {
  const list = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object' && Array.isArray((value as { results?: unknown }).results) ? (value as { results: unknown[] }).results : null;
  if (list === null) return 'shape';
  if (list.length === 0) return null;
  const first = list[0] as { lat?: unknown; lon?: unknown; lng?: unknown } | null;
  if (first === null || typeof first !== 'object') return 'shape';
  const lat = coordinate(first.lat, 90);
  const lon = coordinate(first.lon ?? first.lng, 180);
  return lat === null || lon === null ? 'shape' : { lat, lon };
}

/** GET `<url>?q=<address>` within GEOCODE_LIMITS; `signal` aborts it too (the visitor left). Never throws. */
export async function callGeocoder(url: string, address: string, signal: AbortSignal, fetchImpl: Fetch = (...a) => fetch(...a)): Promise<GeocodeOutcome> {
  const target = new URL(url);
  target.searchParams.set('q', address);
  const deadline = AbortSignal.timeout(GEOCODE_LIMITS.timeoutMs);
  const both = AbortSignal.any([deadline, signal]);
  const late = () => (deadline.aborted ? 'timeout' : 'aborted');
  let response: Response;
  try {
    response = await fetchImpl(target.href, { method: 'GET', headers: { accept: 'application/json' }, signal: both, redirect: 'error' });
  } catch (e) {
    if (both.aborted) return { ok: false, why: late() };
    const cause = (e as { cause?: { message?: unknown } } | null)?.cause?.message;
    return { ok: false, why: typeof cause === 'string' && /redirect/i.test(cause) ? 'redirect' : 'network' };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, why: `status ${response.status}` };
  }
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, why: 'type' };
  }
  let body: string;
  try {
    body = await readCapped(response, GEOCODE_LIMITS.bytes);
  } catch (e) {
    if (e instanceof BodyTooLarge) return { ok: false, why: 'too_large' };
    return { ok: false, why: both.aborted ? late() : 'network' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, why: 'malformed' };
  }
  const at = readGeocode(parsed);
  return at === 'shape' ? { ok: false, why: 'shape' } : { ok: true, at };
}

export interface GeocoderOptions {
  /** AZ_GEOCODER_URL. */
  readonly url: string;
  /** AZ_GEOCODER_PER_ADDRESS. */
  readonly perAddress: ChatRate;
  /** The rate-limit windows every instance shares (chat-limits.ts). */
  readonly windows: Windows;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface Geocoder {
  /** The lookup for one answer: calls counted against `address`; `signal` aborts them (the visitor left). */
  forAnswer(address: string, signal: AbortSignal): GeocodeRun;
}

export function createGeocoder(o: GeocoderOptions): Geocoder {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fetchImpl: Fetch = o.fetch ?? ((...a) => fetch(...a));
  const limits = createRateLimits(o.windows, 'geocode', o.perAddress, {});
  /** A day per normalised address, least recently used out past 1 000: what was found, or that nothing was. */
  const cache = new Map<string, { at: number; found: { lat: number; lon: number } | null }>();
  return {
    forAnswer(address, signal) {
      return async (place) => {
        const key = geocodeKey(place);
        const hit = cache.get(key);
        if (hit && now() - hit.at < GEOCODE_LIMITS.cacheMs) {
          cache.delete(key);
          cache.set(key, hit);
          return hit.found;
        }
        // Only a call costs the operator: an address found before is not counted against the visitor.
        if (!(await limits.take(address, null))) {
          log('chat: geocode limited 0ms');
          return 'unavailable';
        }
        const started = now();
        const r = await callGeocoder(o.url, place, signal, fetchImpl);
        // An outcome and a time — never the address, never what was found.
        log(`chat: geocode ${r.ok ? (r.at ? 'found' : 'none') : r.why} ${now() - started}ms`);
        if (!r.ok) return 'unavailable';
        cache.delete(key);
        cache.set(key, { at: now(), found: r.at });
        while (cache.size > GEOCODE_LIMITS.cacheEntries) cache.delete(cache.keys().next().value as string);
        return r.at;
      };
    },
  };
}
