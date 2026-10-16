/**
 * @az runtime chat-map-draw
 * Purpose: draws an answer's map into a copy of the chat word's map part — its labels, its list of places and stops at once — then loads the map library and hands it the stage, or leaves the list as the whole map.
 * Spec: docs/chat-block-spec.md §21.4.3, §21.4.4, §21.4.5 (Q19f, Q19h)
 * Exports: drawMap, MapDraw, MAP_DRAW_STATE
 * Edit guide: words through textContent only; the library's module is imported here and nowhere else, only when a map event arrives;
 *   a map no longer in the page is ended (its GL context freed); the list is always drawn first and is never removed.
 * Tests: scripts/chat-e2e.mjs, packages/overlay/test/chat-map.test.ts
 */

/**
 * The event was checked by chat-map.ts validMap. This clones the `map` part
 * (words/chat/figures.ts) and fills, with text only: the title; the fixed
 * label its source earns ("Approximate, AI-placed", "Approximate location",
 * or the site's source line); the list equivalent — each place in order,
 * its coordinates in words and its own label, and each route's stops — in a
 * <details>; and the stage, an image named by the map's summary.
 *
 * The list is the map whenever the map cannot be: without WebGL2, or when the
 * library's module, the server's map.json or the tiles fail. Then the stage
 * and the buttons go, the note says so, the list opens, and the status region
 * hears it once. Otherwise the library's module is imported now — the first
 * time any map is drawn on the page (Q19f) — and draws on the stage
 * (chat-map-gl.ts); az's own buttons zoom and reset it, and each place's
 * "Show on the map" opens its popup.
 *
 * A map is ended — its GL context released — when its answer leaves the page
 * (a new chat, a failed answer) or the panel is cleaned up.
 */

import { clonePart, drop, fill, provenance, slot, type RichDraw } from './chat-draw.ts';
import { mapLabels, mapSummary, MAP_TEXT, pinLabel, placeWords, validMap, type MapData } from './chat-map.ts';

/** The states a drawn map is in, on its root's `data-az-chat-map`: drawing, drawn, or a list only. */
export const MAP_DRAW_STATE = { loading: 'loading', ready: 'ready', list: 'list' } as const;

export interface MapDraw extends RichDraw {
  /** Ends the map with the panel. */
  readonly signal: AbortSignal;
  /** Tells the status region at once (chat.ts announce). */
  readonly announce?: (text: string) => void;
  /** A third-party tile archive's URL when the build was given one (AZ_PUBLIC_MAP_TILES_URL); null: the backend's. */
  readonly tiles: string | null;
}

/** The maps still drawn on a page, each with what ends it; one watcher frees those that leave the page. */
const live = new Map<HTMLElement, AbortController>();
let watcher: MutationObserver | null = null;

function track(doc: Document, root: HTMLElement, ac: AbortController): void {
  live.set(root, ac);
  ac.signal.addEventListener('abort', () => {
    live.delete(root);
    if (live.size === 0) { watcher?.disconnect(); watcher = null; }
  }, { once: true });
  const win = doc.defaultView;
  if (watcher || !win) return;
  watcher = new win.MutationObserver(() => {
    for (const [el, c] of [...live]) if (!el.isConnected) c.abort();
  });
  watcher.observe(doc.documentElement, { childList: true, subtree: true });
}

/** Whether each page can draw with WebGL2, asked once a page (its probe canvas is the page's only extra context). */
const drawable = new WeakMap<Document, boolean>();

/** WebGL2 is there to draw with: the library needs it (Q19h). */
function canDraw(doc: Document): boolean {
  const known = drawable.get(doc);
  if (known !== undefined) return known;
  let ok = false;
  try {
    const gl = doc.defaultView?.WebGL2RenderingContext ? doc.createElement('canvas').getContext('webgl2') : null;
    ok = gl !== null && gl !== undefined;
  } catch {
    ok = false;
  }
  drawable.set(doc, ok);
  return ok;
}

/** The map in an event, drawn — its list at once, the map itself when the library comes — and what the status region says of it; or null. */
export function drawMap(d: MapDraw, data: unknown): { el: HTMLElement; said: string } | null {
  const m = validMap(data);
  const root = m && clonePart(d.components, 'map');
  const stage = root && slot(root, 'stage');
  const controls = root && slot(root, 'controls');
  const list = root && slot(root, 'list');
  const note = root && slot(root, 'note');
  const pins = root && slot(root, 'pins');
  const routes = root && slot(root, 'routes');
  const attribution = root && slot(root, 'attribution');
  const pinProto = pins && slot(pins, 'pin');
  const routeProto = routes && slot(routes, 'route');
  if (!m || !root || !stage || !controls || !list || !note || !pins || !routes || !attribution || !pinProto || !routeProto) return null;
  const doc = d.doc;
  const id = `az-chat-map-${d.suffix}`;
  fill(root, 'title', m.title);
  slot(root, 'title')?.setAttribute('id', id);
  root.setAttribute('aria-labelledby', id);
  // The labels the source earns, or the site's own line with the day it was read — fixed copy, never the model's.
  const labels = mapLabels(m);
  if (labels.length > 0) fill(root, 'label', labels.join(' · '));
  else drop(root, 'label');
  if (m.src === 'site' && m.asOf) fill(root, 'asOf', provenance(doc, 'site', m.asOf, null));
  else drop(root, 'source');
  const summary = mapSummary(m);
  stage.setAttribute('aria-label', summary);

  /* ---- the list equivalent: every place in order, every route's stops ---- */
  pinProto.remove();
  const shows: { button: HTMLButtonElement; index: number }[] = [];
  m.pins.forEach((p, i) => {
    const item = pinProto.cloneNode(true) as HTMLElement;
    item.removeAttribute('data-az-chat-slot');
    fill(item, 'pin-label', p.label);
    fill(item, 'pin-where', placeWords(p.lat, p.lon));
    const own = pinLabel(p.src);
    if (own) fill(item, 'pin-src', own);
    else drop(item, 'pin-src');
    const button = slot(item, 'pin-show') as HTMLButtonElement | null;
    if (button) shows.push({ button, index: i });
    pins.append(item);
  });
  routeProto.remove();
  if (m.routes.length === 0) routes.remove();
  m.routes.forEach((r, k) => {
    const box = routeProto.cloneNode(true) as HTMLElement;
    box.removeAttribute('data-az-chat-slot');
    fill(box, 'route-title', r.label);
    // The group is named by its title.
    const title = slot(box, 'route-title');
    title?.setAttribute('id', `${id}-r${k + 1}`);
    box.setAttribute('aria-labelledby', `${id}-r${k + 1}`);
    const stops = slot(box, 'stops');
    const stopProto = stops && slot(stops, 'stop');
    if (!stops || !stopProto) return;
    stopProto.remove();
    r.points.forEach(([lat, lon], j) => {
      const li = stopProto.cloneNode(false) as HTMLElement;
      li.textContent = `${MAP_TEXT.stop(j + 1)}: ${placeWords(lat, lon)}`;
      stops.append(li);
    });
    stops.removeAttribute('data-az-chat-slot');
    routes.append(box);
  });

  const ac = new AbortController();
  d.signal.addEventListener('abort', () => ac.abort(), { once: true, signal: ac.signal });
  const zoomIn = slot(controls, 'zoom-in') as HTMLButtonElement | null;
  const zoomOut = slot(controls, 'zoom-out') as HTMLButtonElement | null;
  const reset = slot(controls, 'reset') as HTMLButtonElement | null;
  const buttons = [zoomIn, zoomOut, reset, ...shows.map((s) => s.button)].filter((b): b is HTMLButtonElement => b !== null);
  for (const b of buttons) b.disabled = true;

  /** The list is the whole map: the stage, the buttons and the attribution go, the note says so — once. */
  let listed = false;
  const asList = () => {
    if (listed) return;
    listed = true;
    ac.abort();
    stage.remove();
    controls.remove();
    attribution.remove();
    for (const s of shows) s.button.remove();
    note.textContent = MAP_TEXT.fallback;
    note.hidden = false;
    (list as HTMLDetailsElement).open = true;
    root.setAttribute('data-az-chat-map', MAP_DRAW_STATE.list);
  };
  const listedSaid = MAP_TEXT.listed(m.title, m.pins.length);

  if (!canDraw(doc)) {
    asList();
    return { el: root, said: labels.length > 0 ? `${listedSaid} ${labels.join(', ')}.` : listedSaid };
  }
  track(doc, root, ac);
  // After the answer is in the page (the caller appends it): the library sizes the map to the stage it is given.
  queueMicrotask(() => { void mount(d, m, root, stage, attribution, { zoomIn, zoomOut, reset, shows, buttons }, ac, () => {
    if (ac.signal.aborted || listed) return;
    asList();
    // Said once, when the map the status region heard about turns out to be a list.
    d.announce?.(listedSaid);
  }); });
  return { el: root, said: labels.length > 0 ? `${summary} ${labels.join(', ')}.` : summary };
}

interface MapButtons {
  readonly zoomIn: HTMLButtonElement | null;
  readonly zoomOut: HTMLButtonElement | null;
  readonly reset: HTMLButtonElement | null;
  readonly shows: readonly { readonly button: HTMLButtonElement; readonly index: number }[];
  readonly buttons: readonly HTMLButtonElement[];
}

/** Load the library (once a page), hand it the stage, wire az's buttons; any failure is the list. */
async function mount(d: MapDraw, m: MapData, root: HTMLElement, stage: HTMLElement, attribution: HTMLElement, b: MapButtons, ac: AbortController, failed: () => void): Promise<void> {
  try {
    const gl = await import('./chat-map-gl.ts');
    if (ac.signal.aborted) return;
    const popup = clonePart(d.components, 'map-popup');
    const handle = await gl.mountMap({
      doc: d.doc, stage, data: m, base: d.backend, tiles: d.tiles, signal: ac.signal,
      popup: (label, src) => {
        if (!popup) return null;
        const el = popup.cloneNode(true) as HTMLElement;
        fill(el, 'label', label);
        if (src) fill(el, 'src', src);
        else drop(el, 'src');
        return el;
      },
      // A zoom button at its limit says so and does nothing — aria-disabled, so a focused one keeps its focus.
      view: (atMin, atMax) => {
        b.zoomOut?.setAttribute('aria-disabled', String(atMin));
        b.zoomIn?.setAttribute('aria-disabled', String(atMax));
      },
    });
    if (ac.signal.aborted) return;
    attribution.textContent = handle.attribution;
    const on = (el: HTMLElement | null, fn: () => void) => el?.addEventListener('click', () => {
      if (el.getAttribute('aria-disabled') !== 'true') fn();
    }, { signal: ac.signal });
    on(b.zoomIn, () => handle.zoomIn());
    on(b.zoomOut, () => handle.zoomOut());
    on(b.reset, () => handle.reset());
    for (const s of b.shows) on(s.button, () => handle.show(s.index));
    for (const x of b.buttons) x.disabled = false;
    root.setAttribute('data-az-chat-map', MAP_DRAW_STATE.ready);
  } catch (error) {
    // The list stands in for the map; the reason is for the site's owner (a missing archive, a tile host that refused).
    if (!ac.signal.aborted) console.warn('chat: the map could not be drawn; its places are listed', error);
    failed();
  }
}
