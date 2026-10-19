/**
 * @az runtime chat-map-gl
 * Purpose: draws one checked map with the vector-map library — its worker started from a blob: that imports the site's own worker file, tiles from the backend's archive, paint from the theme's tokens, popups as elements of text.
 * Spec: docs/chat-block-spec.md §21.4.3, §21.4.4 (Q19b, Q19c, Q19d, Q19e, Q19h)
 * Exports: mountMap, MapMount, MapHandle, MapView, MAP_GL
 * Edit guide: shipped only with a site whose chat shows maps, imported only by chat-map-draw.ts when a map arrives; the one
 *   createObjectURL of the runtime is here; popups only by setDOMContent with an element whose text is textContent; no control of
 *   the library's (its CSS draws them from data: images); every colour read from a --az-color-* token at draw time, never written here.
 * Tests: scripts/chat-e2e.mjs, packages/overlay/test/chat.test.ts
 */

/**
 * The library draws in a worker. A worker started from a same-origin URL is
 * governed by that script's own response, not the page's <meta> policy
 * (measured in three engines, Q19b) — so the worker is started from a
 * `blob:` URL whose one line imports the site's worker file: a worker made
 * from `blob:` inherits the page's policy, and `worker-src 'self' blob:` is
 * the only directive the map page adds. The blob is made once a page and
 * kept, because the library starts its workers again after its last map
 * goes.
 *
 * Tiles come from the backend's archive (`<backend>/tiles/world.pmtiles`,
 * and `region.pmtiles` when the server has one) read by HTTP Range, or from
 * the third-party archive the build was given (AZ_PUBLIC_MAP_TILES_URL),
 * whose origin the page's policy then names; glyphs and sprites only when
 * the server says it serves them (map.json), so the style never asks for a
 * file that is not there.
 *
 * The view is fitted to the pins and routes — the model writes no zoom and
 * no centre — and may go past the tiles' deepest zoom to city level (issue
 * #21, chat-map.ts zoomCap): places in one city are told apart on the world
 * basemap alone, and the drawer's note says when there is no street detail. Every
 * colour is a theme token read with getComputedStyle when the map is drawn
 * and again when the scheme changes, set as the library's paint properties.
 * Under reduced motion every camera move is instant.
 */

import { addProtocol, LngLat, Map as GlMap, Popup, setWorkerUrl, type MapOptions } from 'maplibre-gl';
import { PMTiles, Protocol } from 'pmtiles';
import { layers, namedFlavor, type Flavor } from '@protomaps/basemaps';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import { mapBounds, pastTiles, pinLabel, zoomCap, type MapData } from './chat-map.ts';

/** The map's fixed numbers: the view's margin, how far a key pans, how long a draw may take. */
export const MAP_GL = {
  paddingPx: 40,
  panPx: 100,
  loadMs: 20_000,
  /** map.json's attribution, at most (the server's AZ_MAP_ATTRIBUTION cap). */
  attribution: 200,
} as const;

/** What drawing one map needs: the stage, the checked map, the backend, the build's third-party archive, the end, the popup's element. */
export interface MapMount {
  readonly doc: Document;
  readonly stage: HTMLElement;
  readonly data: MapData;
  readonly base: string;
  readonly tiles: string | null;
  readonly signal: AbortSignal;
  /** A popup's element for a pin: its label and its source's label, filled by textContent (chat-map-draw.ts). */
  readonly popup: (label: string, src: string | null) => HTMLElement | null;
  /**
   * Told when a camera move starts and when it ends, and once loaded: whether the view is at its widest and at its
   * deepest zoom, whether it is deeper than any of its tiles (no street detail, issue #21), and whether it is the fitted
   * view Reset view returns to (never while it moves).
   */
  readonly view: (state: MapView) => void;
}

/** Where the view is, as az's buttons and the note under the map need it. */
export interface MapView {
  readonly atMin: boolean;
  readonly atMax: boolean;
  readonly pastTiles: boolean;
  readonly fitted: boolean;
}

/** What az's own buttons call, and the attribution line to show under the map. */
export interface MapHandle {
  readonly attribution: string;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  /** Bring a pin into view and open its popup. */
  show(index: number): void;
}

/** What the server serves (GET /tiles/map.json, backend chat-tiles.ts), checked. */
interface Served {
  readonly archives: readonly ('world' | 'region')[];
  readonly glyphs: boolean;
  readonly sprites: boolean;
  readonly attribution: string;
}

/** How near a zoom limit counts as at it: the library's fitted zoom is a float. */
const ZOOM_EPSILON = 1e-6;
/** How near the fitted view counts as it, in zoom levels and degrees: a float's noise, far under one pixel at any zoom. */
const FIT_EPSILON = 1e-6;

const protocol = new Protocol();
/** Once a page: the worker's blob and the archive protocol (Q19b). */
let started = false;
/** map.json per backend, read once a page. */
const servedBy = new Map<string, Promise<Served>>();

function start(doc: Document): void {
  if (started) return;
  started = true;
  // The only object URL the runtime makes (a sink test holds it): one line that imports the site's own worker file.
  const worker = new URL(workerUrl, doc.baseURI).href;
  const blob = URL.createObjectURL(new Blob([`import ${JSON.stringify(worker)};\n`], { type: 'text/javascript' }));
  setWorkerUrl(blob);
  addProtocol('pmtiles', protocol.tile);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** map.json, checked: its archives by name, whether glyphs and sprites are served, the attribution — or a throw. */
async function served(base: string, signal: AbortSignal): Promise<Served> {
  const at = `${base.replace(/\/+$/, '')}/tiles/map.json`;
  let p = servedBy.get(at);
  if (!p) {
    p = (async () => {
      const r = await fetch(at, { credentials: 'omit', signal: AbortSignal.timeout(MAP_GL.loadMs) });
      if (!r.ok) throw new Error(`map.json ${r.status}`);
      const v: unknown = await r.json();
      if (!isRecord(v) || !Array.isArray(v.archives) || typeof v.glyphs !== 'boolean' || typeof v.sprites !== 'boolean' || typeof v.attribution !== 'string') throw new Error('map.json shape');
      const archives = v.archives.map((a) => (isRecord(a) && (a.name === 'world' || a.name === 'region') ? a.name : null));
      if (archives.includes(null) || v.attribution.length > MAP_GL.attribution || /[\u0000-\u001f]/.test(v.attribution)) throw new Error('map.json shape');
      return { archives: archives as ('world' | 'region')[], glyphs: v.glyphs, sprites: v.sprites, attribution: v.attribution };
    })();
    servedBy.set(at, p);
    // A failed read is not kept: the next map asks again.
    p.catch(() => servedBy.delete(at));
  }
  signal.throwIfAborted();
  return p;
}

/** The theme's tokens a map paints with, as the active scheme resolves them, each normalised by the browser's own 2D context. */
const TOKENS = ['bg', 'surface', 'surface-alt', 'text', 'muted', 'border', 'border-strong', 'accent', 'focus', 'series-1', 'series-2', 'series-3'] as const;
type Token = (typeof TOKENS)[number];

function tokens(doc: Document): Record<Token, string> {
  const css = doc.defaultView?.getComputedStyle(doc.documentElement);
  const ctx = doc.createElement('canvas').getContext('2d');
  if (!css || !ctx) throw new Error('no style to read the theme from');
  const out = {} as Record<Token, string>;
  for (const t of TOKENS) {
    const raw = css.getPropertyValue(`--az-color-${t}`).trim();
    if (!raw) throw new Error(`no colour token ${t}`);
    ctx.fillStyle = raw;
    out[t] = String(ctx.fillStyle);
  }
  return out;
}

/** Whether a colour the 2D context wrote (`#rrggbb` or `rgba(…)`) is dark: the scheme the basemap's own details are drawn for. */
function dark(colour: string): boolean {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour);
  const rgb = hex ? hex.slice(1).map((h) => parseInt(h, 16)) : (/^rgba?\((\d+), (\d+), (\d+)/.exec(colour)?.slice(1).map(Number) ?? [255, 255, 255]);
  const [r, g, b] = rgb.map((c) => c / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

type Style = Exclude<NonNullable<MapOptions['style']>, string>;
type Layer = Style['layers'][number];

/** One archive the map draws: its source name, its URL, how deep it goes. */
interface Archive { readonly name: string; readonly url: string; readonly maxZoom: number }

/**
 * The style: the basemap's layers for each archive in the theme's colours
 * (its own details in the light or dark set the scheme calls for), labels
 * only with glyphs and icons only with sprites, then the routes and pins.
 */
function styleFor(doc: Document, m: MapData, base: string, archives: readonly Archive[], has: Served, selected: number | null, still: boolean): Style {
  const t = tokens(doc);
  const night = dark(t.bg);
  const flavor: Flavor = {
    ...namedFlavor(night ? 'dark' : 'light'),
    background: t['surface-alt'], earth: t.surface, water: t['surface-alt'], boundaries: t['border-strong'],
    city_label: t.text, city_label_halo: t.bg, state_label: t.muted, state_label_halo: t.bg, country_label: t.muted,
    subplace_label: t.muted, subplace_label_halo: t.bg, ocean_label: t.muted,
  };
  const backend = base.replace(/\/+$/, '');
  const basemap: Layer[] = archives.flatMap((a) => (layers(a.name, flavor, { lang: doc.documentElement.lang || 'en' }) as Layer[])
    .filter((l) => (l.type !== 'symbol' || has.glyphs) && (has.sprites || !('layout' in l && l.layout !== undefined && 'icon-image' in l.layout)))
    .map((l) => ({ ...l, id: `${a.name}-${l.id}` }) as Layer));
  const routes = {
    type: 'FeatureCollection' as const,
    features: m.routes.map((r, i) => ({ type: 'Feature' as const, properties: { i }, geometry: { type: 'LineString' as const, coordinates: r.points.map(([lat, lon]) => [lon, lat]) } })),
  };
  const pins = {
    type: 'FeatureCollection' as const,
    features: m.pins.map((p, i) => ({ type: 'Feature' as const, properties: { i }, geometry: { type: 'Point' as const, coordinates: [p.lon, p.lat] } })),
  };
  const own: Layer[] = [
    // Two routes differ by more than colour: the second is dashed (§20.4's rule for lines).
    { id: 'az-route-0', type: 'line', source: 'az-routes', filter: ['==', ['get', 'i'], 0], layout: { 'line-join': 'round', 'line-cap': 'round' }, paint: { 'line-color': t['series-2'], 'line-width': 4 } },
    { id: 'az-route-1', type: 'line', source: 'az-routes', filter: ['==', ['get', 'i'], 1], layout: { 'line-join': 'round' }, paint: { 'line-color': t['series-3'], 'line-width': 4, 'line-dasharray': [2, 1.5] } },
    { id: 'az-pins', type: 'circle', source: 'az-pins', paint: { 'circle-color': t['series-1'], 'circle-radius': 7, 'circle-stroke-color': t.bg, 'circle-stroke-width': 2 } },
    {
      id: 'az-pin-open', type: 'circle', source: 'az-pins', filter: ['==', ['get', 'i'], selected ?? -1],
      paint: { 'circle-color': t['series-1'], 'circle-radius': 9, 'circle-stroke-color': t.focus, 'circle-stroke-width': 3 },
    },
  ];
  return {
    version: 8,
    // Under reduced motion a repaint is a cut, not a fade.
    ...(still ? { transition: { duration: 0, delay: 0 } } : {}),
    ...(has.glyphs ? { glyphs: `${backend}/tiles/glyphs/{fontstack}/{range}.pbf` } : {}),
    ...(has.sprites ? { sprite: `${backend}/tiles/sprites/${night ? 'dark' : 'light'}` } : {}),
    sources: {
      ...Object.fromEntries(archives.map((a) => [a.name, { type: 'vector', url: `pmtiles://${a.url}` }])),
      'az-routes': { type: 'geojson', data: routes },
      'az-pins': { type: 'geojson', data: pins },
    },
    layers: [...basemap, ...own],
  } as Style;
}

/** The archives the map draws, each read once for its header: the world (the backend's, or the build's third party), and the region. */
async function archivesFor(o: MapMount, has: Served): Promise<Archive[]> {
  const backend = o.base.replace(/\/+$/, '');
  const urls: [string, string][] = [];
  const world = o.tiles ?? (has.archives.includes('world') ? `${backend}/tiles/world.pmtiles` : null);
  if (world === null) throw new Error('no tile archive');
  urls.push(['world', world]);
  if (has.archives.includes('region')) urls.push(['region', `${backend}/tiles/region.pmtiles`]);
  const out: Archive[] = [];
  for (const [name, url] of urls) {
    let p = protocol.get(url);
    if (!p) {
      p = new PMTiles(url);
      protocol.add(p);
    }
    const header = await p.getHeader();
    o.signal.throwIfAborted();
    out.push({ name, url, maxZoom: header.maxZoom });
  }
  return out;
}

/** Call `onChange` when the active scheme may have changed: the OS preference, or the page's own `data-scheme`. */
function onScheme(doc: Document, onChange: () => void, signal: AbortSignal): void {
  const win = doc.defaultView;
  const query = win?.matchMedia?.('(prefers-color-scheme: dark)');
  query?.addEventListener('change', onChange, { signal });
  if (!win) return;
  const observer = new win.MutationObserver(onChange);
  observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-scheme'] });
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
}

/** Draw `o.data` on `o.stage`; resolves once the map has loaded, rejects (the caller shows the list) when it cannot. */
export async function mountMap(o: MapMount): Promise<MapHandle> {
  const { doc, stage, data: m, signal } = o;
  const has = await served(o.base, signal);
  start(doc);
  const archives = await archivesFor(o, has);
  // Issue #21: the tiles go as deep as the regional extract, or the world without one; the view goes on to city level.
  const deepest = Math.max(...archives.map((a) => a.maxZoom));
  const cap = zoomCap(deepest);
  const reduced = () => doc.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;
  const [w, s, e, n] = mapBounds(m);
  const bounds: [[number, number], [number, number]] = [[w, s], [e, n]];
  let selected: number | null = null;
  const map = new GlMap({
    container: stage, style: styleFor(doc, m, o.base, archives, has, selected, reduced()),
    bounds, fitBoundsOptions: { padding: MAP_GL.paddingPx, maxZoom: cap }, maxZoom: cap,
    attributionControl: false, keyboard: false, scrollZoom: false, boxZoom: false, dragRotate: false, pitchWithRotate: false,
    touchPitch: false, fadeDuration: reduced() ? 0 : 300,
  });
  // A map in a chat turns no further than north up: rotation by two fingers would hide which way the places lie.
  map.touchZoomRotate.disableRotation();
  // No close button (the library writes its × as markup); a click elsewhere, or Reset view, closes it.
  const popup = new Popup({ closeButton: false, closeOnClick: true, focusAfterOpen: false });
  const end = () => { popup.remove(); map.remove(); };
  signal.addEventListener('abort', end, { once: true });

  /** The map drew its style, or it failed, or it ran past its bound. */
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('map load timed out')), MAP_GL.loadMs);
    const fail = (err: unknown) => { clearTimeout(timer); reject(err instanceof Error ? err : new Error('map failed')); };
    map.once('load', () => { clearTimeout(timer); map.off('error', onError); resolve(); });
    const onError = (ev: { error?: unknown }) => fail(ev.error);
    map.on('error', onError);
    signal.addEventListener('abort', () => fail(new Error('ended')), { once: true });
  });
  // One more frame once loaded. WebKit on Linux can go on showing the frame before the one that fired `load`: measured,
  // every tile had arrived before that render, yet the stage showed bare water until another frame was drawn.
  map.triggerRepaint();
  // After it loads, a tile that fails is a gap in the map, not an answer that fails: kept quiet, never a console error.
  map.on('error', () => undefined);

  // The zoom buttons follow the view when a move ends — at once under reduced motion, where every move is a jump.
  // The fitted view, as the library worked it out for the bounds it opened at: Reset view returns to it.
  const fit = map.cameraForBounds(bounds, { padding: MAP_GL.paddingPx, maxZoom: cap });
  const fitted = () => {
    if (!fit || fit.zoom === undefined || fit.center === undefined) return false;
    const c = map.getCenter();
    const f = LngLat.convert(fit.center);
    return Math.abs(map.getZoom() - fit.zoom) <= FIT_EPSILON && Math.abs(c.lng - f.lng) <= FIT_EPSILON && Math.abs(c.lat - f.lat) <= FIT_EPSILON;
  };
  /** `moving`: a camera move has started, so the view is on its way somewhere — not the fitted one, whatever it was. */
  const limits = (moving: boolean) => {
    if (signal.aborted) return;
    const zoom = map.getZoom();
    o.view({ atMin: zoom <= map.getMinZoom() + ZOOM_EPSILON, atMax: zoom >= cap - ZOOM_EPSILON, pastTiles: pastTiles(zoom, deepest), fitted: !moving && fitted() });
  };
  // While its view moves the stage is busy — the picture is changing — and Reset view is offered from the move's first
  // frame: a move "Show on the map" started can be reset before it ends, not only after.
  map.on('movestart', () => {
    stage.setAttribute('aria-busy', 'true');
    limits(true);
  });
  map.on('moveend', () => {
    stage.removeAttribute('aria-busy');
    limits(false);
  });
  limits(false);

  // The canvas is not a second stop or a second name: the stage is the image, and takes the keys.
  const canvas = map.getCanvas();
  canvas.setAttribute('tabindex', '-1');
  canvas.removeAttribute('role');
  canvas.removeAttribute('aria-label');
  canvas.setAttribute('aria-hidden', 'true');

  const animate = () => !reduced();
  const restyle = () => { if (!signal.aborted) map.setStyle(styleFor(doc, m, o.base, archives, has, selected, reduced())); };
  onScheme(doc, restyle, signal);

  const open = (i: number) => {
    const p = m.pins[i];
    const el = p ? o.popup(p.label, pinLabel(p.src)) : null;
    if (!p || !el) return;
    selected = i;
    map.setFilter('az-pin-open', ['==', ['get', 'i'], i]);
    popup.setLngLat([p.lon, p.lat]).setDOMContent(el).addTo(map);
  };
  popup.on('close', () => {
    selected = null;
    if (!signal.aborted && map.getLayer('az-pin-open')) map.setFilter('az-pin-open', ['==', ['get', 'i'], -1]);
  });
  map.on('click', 'az-pins', (ev) => {
    const i = Number(ev.features?.[0]?.properties?.i);
    if (Number.isInteger(i)) open(i);
  });

  // §21.4.5: the arrow keys pan, + and − zoom, on the stage — az's keys, not the library's, so reduced motion is honoured.
  stage.addEventListener('keydown', (ev) => {
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [-MAP_GL.panPx, 0], ArrowRight: [MAP_GL.panPx, 0], ArrowUp: [0, -MAP_GL.panPx], ArrowDown: [0, MAP_GL.panPx],
    };
    if (ev.target !== stage || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    if (Object.hasOwn(pan, ev.key)) map.panBy(pan[ev.key], { animate: animate() });
    else if (ev.key === '+' || ev.key === '=') map.zoomIn({ animate: animate() });
    else if (ev.key === '-' || ev.key === '_') map.zoomOut({ animate: animate() });
    else return;
    ev.preventDefault();
  }, { signal });

  return {
    attribution: has.attribution,
    zoomIn: () => map.zoomIn({ animate: animate() }),
    zoomOut: () => map.zoomOut({ animate: animate() }),
    reset: () => { popup.remove(); map.fitBounds(bounds, { padding: MAP_GL.paddingPx, maxZoom: cap, animate: animate() }); },
    show: (i) => {
      const p = m.pins[i];
      if (!p) return;
      map.easeTo({ center: [p.lon, p.lat], animate: animate() });
      open(i);
    },
  };
}
