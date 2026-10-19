/**
 * An answer's map as the page checks it (chat-block-spec §21.4): the closed
 * event, every cap at the cap and one past it, every coordinate in range with
 * at most six decimals and never an exponent, each source's own pins (a
 * model map's are `model` or `geocoded` with no day; a site map's `site`
 * with its day and no route); the view's box, the summary, the coordinates
 * in words, the labels each source earns — fixed copy, never the event's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAP_CAPS, MAP_TEXT, MAP_ZOOM, mapBounds, mapLabels, mapSummary, pastTiles, pinLabel, placeWords, validMap, zoomCap } from '../src/runtime/chat-map.ts';
import { blockOf, RICH_BLOCKS } from '../src/runtime/chat-logic.ts';

const MODEL = {
  title: 'Where to find us', src: 'model',
  pins: [{ label: 'Workshop', lat: 52.520008, lon: 13.404954, src: 'model' }, { label: 'Hall', lat: 52.521918, lon: 13.413215, src: 'geocoded' }],
  routes: [{ label: 'Walk', points: [[52.520008, 13.404954], [52.5163, 13.3777]] }],
};
const SITE = { title: 'Our stores', src: 'site', asOf: '2026-10-16', pins: [{ label: 'North store', lat: 52.53, lon: 13.41, src: 'site' }], routes: [] };

test('a model\'s map and a site\'s map as the server sends them check out', () => {
  assert.deepEqual(validMap(MODEL), { ...MODEL, asOf: null });
  assert.deepEqual(validMap(SITE), SITE);
  // The page draws it through the same closed key list as every rich component.
  assert.ok(RICH_BLOCKS.includes('map'));
  assert.deepEqual(blockOf({ map: MODEL }), { kind: 'rich', word: 'map', data: MODEL });
});

test('coordinates: six decimals stand, seven do not; in range only; never an exponent, NaN or a string', () => {
  const at = (lat: unknown, lon: unknown) => validMap({ ...MODEL, pins: [{ label: 'P', lat, lon, src: 'model' }] }) !== null;
  assert.ok(at(52.123456, 13.123456));
  assert.ok(at(90, -180));
  assert.ok(at(-90, 180));
  assert.equal(at(52.1234567, 13), false);
  assert.equal(at(90.000001, 0), false);
  assert.equal(at(0, -180.000001), false);
  assert.equal(at(1e-7, 0), false, 'written 1e-7: seven decimals, as an exponent');
  assert.equal(at(1e21, 0), false);
  for (const bad of [NaN, Infinity, '52.5', null, undefined]) assert.equal(at(bad, 0), false, String(bad));
  const route = (points: unknown[]) => validMap({ ...MODEL, routes: [{ label: 'R', points }] }) !== null;
  assert.equal(route([[1, 2], [1.1234567, 2]]), false);
  assert.equal(route([[1, 2], [1, 2, 3]]), false);
  assert.equal(route([[1, 2], [91, 2]]), false);
});

test('caps at the cap and one past: 1–24 pins, 0–2 routes of 2–50 points, labels of 40 code points, a title of 80', () => {
  const pins = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `P${i}`, lat: i, lon: i, src: 'model' }));
  assert.ok(validMap({ ...MODEL, pins: pins(MAP_CAPS.pins) }));
  assert.equal(validMap({ ...MODEL, pins: pins(MAP_CAPS.pins + 1) }), null);
  assert.equal(validMap({ ...MODEL, pins: [] }), null);
  const routes = (n: number, points = 2) => Array.from({ length: n }, (_, i) => ({ label: `R${i}`, points: Array.from({ length: points }, (__, j) => [j % 90, j]) }));
  assert.ok(validMap({ ...MODEL, routes: routes(2, 50) }));
  assert.equal(validMap({ ...MODEL, routes: routes(3) }), null);
  assert.equal(validMap({ ...MODEL, routes: routes(1, 1) }), null);
  assert.equal(validMap({ ...MODEL, routes: routes(1, 51) }), null);
  const flags = '🇩🇪'.repeat(20);
  assert.equal([...flags].length, 40);
  assert.ok(validMap({ ...MODEL, pins: [{ ...MODEL.pins[0], label: flags }] }), '40 code points');
  assert.equal(validMap({ ...MODEL, pins: [{ ...MODEL.pins[0], label: `${flags}x` }] }), null);
  assert.equal(validMap({ ...MODEL, pins: [{ ...MODEL.pins[0], label: 'two\nlines' }] }), null);
  assert.ok(validMap({ ...MODEL, title: 't'.repeat(MAP_CAPS.title) }));
  assert.equal(validMap({ ...MODEL, title: 't'.repeat(MAP_CAPS.title + 1) }), null);
});

test('sources: a model map has no day and only model or geocoded pins; a site map has its day, only site pins, no route; nothing else', () => {
  assert.equal(validMap({ ...MODEL, asOf: '2026-10-16' }), null, 'a model\'s map with a day would read as the site\'s');
  assert.equal(validMap({ ...MODEL, pins: [{ ...MODEL.pins[0], src: 'site' }] }), null);
  assert.equal(validMap({ ...SITE, asOf: undefined }), null);
  assert.equal(validMap({ ...SITE, pins: [{ ...SITE.pins[0], src: 'model' }] }), null, 'a model pin in a site map would lose its label');
  assert.equal(validMap({ ...SITE, routes: MODEL.routes }), null);
  assert.equal(validMap({ ...MODEL, src: 'tool' }), null);
  assert.equal(validMap({ ...MODEL, zoom: 12 }), null, 'no other key: the model writes no zoom');
  assert.equal(validMap({ ...MODEL, pins: [{ ...MODEL.pins[0], url: 'https://evil.example/' }] }), null);
  assert.equal(validMap([MODEL]), null);
});

test('the view\'s box is every pin and route point; the summary counts them; coordinates are said in words', () => {
  assert.deepEqual(mapBounds(validMap(MODEL)!), [13.3777, 52.5163, 13.413215, 52.521918]);
  assert.equal(mapSummary(validMap(MODEL)!), 'Map: Where to find us, 2 places, 1 route.');
  assert.equal(mapSummary(validMap(SITE)!), 'Map: Our stores, 1 place.');
  assert.equal(MAP_TEXT.listed('Our stores', 1), 'Map: Our stores, 1 place, shown as a list.');
  assert.equal(placeWords(52.520008, 13.404954), '52.520008 degrees north, 13.404954 degrees east');
  assert.equal(placeWords(-33.8688, -151.2093), '33.8688 degrees south, 151.2093 degrees west');
});

test('labels: the model\'s numbers are AI-placed, the geocoder\'s approximate, the site\'s its own — fixed copy, once each', () => {
  assert.equal(pinLabel('model'), 'Approximate, AI-placed');
  assert.equal(pinLabel('geocoded'), 'Approximate location');
  assert.equal(pinLabel('site'), null);
  assert.deepEqual(mapLabels(validMap(MODEL)!), ['Approximate, AI-placed', 'Approximate location']);
  assert.deepEqual(mapLabels(validMap({ ...MODEL, pins: [MODEL.pins[1]], routes: [] })!), ['Approximate location']);
  assert.deepEqual(mapLabels(validMap({ ...MODEL, pins: [MODEL.pins[1]] })!), ['Approximate, AI-placed', 'Approximate location'], 'a route is the model\'s numbers');
  assert.deepEqual(mapLabels(validMap(SITE)!), []);
});

test('issue #21: a map zooms past its tiles to city level — 14 on the world\'s zoom 0–6, deeper with a deeper region — and says so when it is past them', () => {
  assert.equal(MAP_ZOOM.overzoom, 14);
  assert.equal(zoomCap(6), 14, 'the bundled world basemap stops at 6; the view goes on to 14');
  assert.equal(zoomCap(15), 15, 'a regional extract deeper than 14 keeps its own depth');
  // Two pins 2 km apart in one city need about zoom 12 in a 400-px stage: within the cap now, past the world's tiles.
  const [w, s, e, n] = mapBounds(validMap(MODEL)!);
  const across = Math.max((e - w) / 360, (Math.log(Math.tan(Math.PI / 4 + (n * Math.PI) / 360)) - Math.log(Math.tan(Math.PI / 4 + (s * Math.PI) / 360))) / (2 * Math.PI));
  const fitted = Math.log2((400 - 80) / (256 * across));
  assert.ok(fitted > 6 && fitted <= zoomCap(6), `fitted at ${fitted.toFixed(1)}`);
  assert.equal(pastTiles(fitted, 6), true);
  assert.equal(pastTiles(6, 6), false, 'at the tiles\' own depth there is detail to show');
  assert.equal(pastTiles(5.2, 6), false);
  assert.equal(MAP_TEXT.detail, 'This map has no street detail at this zoom.');
});
