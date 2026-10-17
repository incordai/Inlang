/**
 * @az runtime stage
 * Purpose: the page's one WebGL renderer: scissored views, probe, ladder, eviction, teardown.
 * Spec: docs/scene-block-spec.md §5–§8 · docs/motion-tiers-spec.md
 * Exports: Stage, StopReason
 * Edit guide: one renderer per page; the loop runs only while something draws; dispose everything on teardown.
 * Tests: scripts/test-3d.mjs
 */

/**
 * The page's one WebGL renderer — scene-spec §5.
 *
 * Every 3D view on the page (a hero, up to four scenes, a backdrop, an orbit
 * gallery) contributes a DOM element that reserves its box; this draws each
 * one into that element's rectangle with scissor and viewport, in one frame,
 * on one fixed canvas at the bottom of the stack (§6.1's DOM contract). The
 * live-context count is 1 whatever the page declares.
 *
 * It owns the ladder at runtime (motion-tiers-spec §3–§5): the probe samples
 * every drawn frame, a rung's DPR cap and level of detail apply at once or at
 * the next quiet moment, and the floor — or a lost context — tears the whole
 * stage down to the posters, which never left the DOM.
 */

import * as THREE from 'three';
import { LADDER, STATIC_RUNG, TierProbe, type Rung, type Start } from './tiers.ts';
import { studioEnvironment } from './env.ts';
import { hex, onSchemeChange } from './colours.ts';
import { ModelCache, model, ring, strands, type Content, type Framing } from './views.ts';
import { budgetFrom, sceneResources, seenAt, toEvict } from './evict.ts';

/** How the object answers the page (the element's `data-az-camera`). */
type Motion = 'fixed' | 'scroll' | 'parallax' | 'orbit';

interface View {
  readonly id: number;
  readonly el: HTMLElement;
  readonly kind: string;
  readonly motion: Motion;
  readonly backdrop: boolean;
  /** Null while evicted (§7): the poster stands in until the view returns. */
  content: Content | null;
  /** Page clock when last inside the warm margin; -Infinity if never. */
  lastVisible: number;
  /** Counted toward the budget once its content is ready. */
  counted: boolean;
  visible: boolean;
  target: number;
  damped: number;
  yaw: number;
  yawTarget: number;
}

/** §5: rungs 3–7 wait for a quiet moment — scroll-idle — but never past this. */
const DEFER_DEADLINE_MS = 2000;
/** Scroll-idle: no scroll event for this long. */
const SCROLL_IDLE_MS = 150;
/** Damping rate for scroll-driven motion (the spike's measured value). */
const DAMPING = 6;
/** Longest frame step the damping integrates, so a stall never jumps. */
const MAX_STEP_S = 0.1;
/** Keyboard orbit step, radians (scene-spec §9: arrow keys rotate). */
const ORBIT_KEY_STEP = Math.PI / 12;
/** Drag distance for one full turn, as a fraction of the view's width. */
const ORBIT_DRAG_TURN = 2;
/** Views this far outside the viewport stay warm (§7: rootMargin ≈ a viewport). */
const WARM_MARGIN = '100% 0px';

/**
 * The view's kind. Read with getAttribute: `dataset` camel-cases a hyphen
 * only before a letter, so `data-az-3d` is `dataset['az-3d']`, never `az3d`.
 */
const kindOf = (el: HTMLElement): string => el.getAttribute('data-az-3d') ?? '';

/** Only the site's own assets: an absolute path, no scheme, no climbing, `.glb`. */
const SAFE_MODEL = /^\/(?!.*\.\.)[A-Za-z0-9._\-/]+\.glb$/;

/**
 * The root attribute the behaviour runtime sets while a modal holds the page,
 * with the offset it was locked at. `scrollY` reads 0 under the lock; the
 * backdrop must not rewind behind a modal and replay on close.
 */
const SCROLL_LOCK = 'data-az-scroll-lock';

/** Why the stage stopped — only a page hidden into the back/forward cache comes back. */
export type StopReason = 'pagehide' | 'floor' | 'contextlost' | 'reduced-motion' | 'failed';

export class Stage {
  private readonly doc: Document;
  private readonly win: Window;
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly env: THREE.WebGLRenderTarget;
  private readonly models = new ModelCache();
  private readonly views: View[] = [];
  private readonly probe: TierProbe | null;
  private readonly observer: IntersectionObserver;
  /** Wakes the loop when the page or a view changes size (see the constructor). */
  private readonly sizes: ResizeObserver;
  private readonly cleanups: (() => void)[] = [];
  /** Views whose content failed to load: they keep their poster. */
  private readonly failed = new Set<HTMLElement>();
  private rung: number;
  private pending: { rung: number; since: number } | null = null;
  private lastScroll = 0;
  private frame = 0;
  private lastTs: number | null = null;
  private stopped = false;
  private stopReason: StopReason | null = null;
  /** The rung the page held when it stopped: where a restored page resumes. */
  private rungAtStop: number;
  /** §7: live scene memory the page may hold before paused views are released. */
  private readonly budget: number;
  private accent = '';
  /** 3D heroes drawn by the backdrop (hero-spec §8): live only once the backdrop is. */
  private behind: HTMLElement[] = [];
  /** `?az-probe-trace`: publish what the probe was fed, for tests and diagnosis. */
  private readonly traced: boolean;
  private sampled = 0;
  private hides = 0;

  constructor(doc: Document, start: Start) {
    this.doc = doc;
    const win = doc.defaultView;
    if (!win) throw new Error('3d: no window');
    this.win = win;
    this.rung = start.rung;
    this.rungAtStop = start.rung;
    this.budget = budgetFrom(win.location.search);
    this.traced = new URLSearchParams(win.location.search).has('az-probe-trace');
    this.probe = start.probe
      ? new TierProbe({ rung: start.rung, ceilingRung: start.ceilingRung, promotable: start.promotable })
      : null;

    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'az-3d-canvas';
    // The canvas is not content: each view element carries the name (§9).
    this.canvas.setAttribute('aria-hidden', 'true');
    doc.body.prepend(this.canvas);
    // A renderer that cannot be made leaves nothing behind: no canvas, and a
    // published rung that says the page is at its posters.
    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
      renderer.setClearColor(0x000000, 0);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.env = studioEnvironment(renderer);
    } catch (error) {
      renderer?.dispose();
      this.canvas.remove();
      this.rung = STATIC_RUNG;
      this.publish();
      throw error;
    }
    this.renderer = renderer;
    this.publish();

    this.observer = new win.IntersectionObserver((entries) => {
      const now = win.performance.now();
      for (const entry of entries) {
        const view = this.views.find((v) => v.el === entry.target);
        if (!view) continue;
        // §7 recency: the moment it LEFT the margin counts, not when it came in.
        view.lastVisible = seenAt(view.visible, entry.isIntersecting, view.lastVisible, now);
        view.visible = entry.isIntersecting;
        // An evicted view coming back into the warm margin is rebuilt (§7).
        if (view.visible && !view.content) this.restore(view);
      }
      this.enforceBudget();
      this.wake();
    }, { rootMargin: WARM_MARGIN });
    // A change of layout that moves or sizes a view — a stylesheet applied
    // late, a font or an image above it — is neither a scroll nor a resize,
    // and the observer above reports only a crossing of the warm margin: a
    // loop that stopped with no view on screen would leave a view that is on
    // screen now undrawn. The page's size and each view's are watched, and
    // every change wakes the loop to draw the views where they now are.
    this.sizes = new win.ResizeObserver(() => this.wake());
    this.sizes.observe(doc.documentElement);

    this.listen(this.canvas, 'webglcontextlost', (e) => {
      e.preventDefault();
      this.probe?.contextLost();
      this.teardown('contextlost');
    });
    this.listen(win, 'scroll', () => { this.lastScroll = win.performance.now(); this.wake(); }, { passive: true });
    this.listen(win, 'resize', () => this.wake());
    // A hidden tab gets no frames, so the loop cannot notice it: the probe is
    // told here, and the frame that would never come is dropped (§3.3).
    this.listen(doc, 'visibilitychange', () => {
      if (doc.visibilityState !== 'hidden') { this.wake(); return; }
      if (this.frame) { win.cancelAnimationFrame(this.frame); this.frame = 0; }
      this.lastTs = null;
      if (this.probe) { this.probe.hide(); this.hides++; this.trace(); }
    });
    this.listen(win, 'pagehide', () => this.teardown('pagehide'));
    this.cleanups.push(onSchemeChange(doc, () => this.recolour()));
    const reduced = win.matchMedia('(prefers-reduced-motion: reduce)');
    // Reduced motion removes the motion, not the layer: back to the posters (§6.5).
    this.listen(reduced, 'change', () => { if (reduced.matches) this.teardown('reduced-motion'); });
  }

  private listen<T extends EventTarget>(target: T, type: string, fn: (e: Event) => void,
    options?: AddEventListenerOptions): void {
    target.addEventListener(type, fn, options);
    this.cleanups.push(() => target.removeEventListener(type, fn, options));
  }

  /** Why the stage stopped, or null while it runs. */
  get stoppedFor(): StopReason | null { return this.stopReason; }

  /** The rung the page held when it stopped. */
  get lastRung(): number { return this.rungAtStop; }

  /** Register every `[data-az-3d]` element on the page. A failure releases everything taken so far. */
  mount(): void {
    try {
      const els = [...this.doc.querySelectorAll<HTMLElement>('[data-az-3d]')];
      const backdropDeclared = els.some((el) => el.dataset.azVariant === 'backdrop');
      const accent = hex(this.doc, 'accent');
      this.accent = accent;
      const heroes: HTMLElement[] = [];
      for (const el of els) {
        // hero-spec §8: with a backdrop on the page, a 3D hero takes no
        // rectangle — its 3D is the backdrop's first scroll segment.
        if (backdropDeclared && kindOf(el) === 'hero') { heroes.push(el); continue; }
        this.add(el, accent);
      }
      // Only a backdrop that really exists draws the heroes; one that could
      // not be made leaves them to draw themselves.
      if (this.views.some((v) => v.backdrop)) this.behind = heroes;
      else for (const el of heroes) this.add(el, accent);
      // Backdrop first: it is the rectangle every other view sits over (§6.2).
      this.views.sort((a, b) => Number(b.backdrop) - Number(a.backdrop));
      this.applyDpr();
    } catch (error) {
      this.teardown('failed');
      throw error;
    }
  }

  private add(el: HTMLElement, accent: string): void {
    const content = this.contentFor(el, accent);
    if (!content) return;
    const motion = (['scroll', 'parallax', 'orbit'].includes(el.dataset.azCamera ?? '')
      ? el.dataset.azCamera : 'fixed') as Motion;
    const view: View = {
      id: this.views.length, el, kind: kindOf(el), motion, backdrop: el.dataset.azVariant === 'backdrop',
      content, lastVisible: -Infinity, counted: false,
      visible: false, target: 0, damped: 0, yaw: 0, yawTarget: 0,
    };
    content.setRung(LADDER[this.rung]);
    if (motion === 'orbit') this.orbitInput(view);
    this.views.push(view);
    this.observer.observe(el);
    this.sizes.observe(el);
  }

  /** A view's content failed to load: it keeps its poster, and so do the heroes it would draw. */
  private fail(el: HTMLElement): void {
    this.failed.add(el);
    this.markLive(el, false);
    if (el.dataset.azVariant === 'backdrop') for (const hero of this.behind) this.markLive(hero, false);
  }

  private contentFor(el: HTMLElement, accent: string): Content | null {
    const env = this.env.texture;
    if (kindOf(el) === 'orbit') {
      const host = el.closest('[data-az-3d-host]');
      const sources = host ? [...host.querySelectorAll<HTMLImageElement>('img[data-az-ring]')].map((i) => i.src) : [];
      if (sources.length === 0) return null;
      return ring(sources, Number(el.dataset.azAspect) || 1, env, () => this.fail(el));
    }
    const framing: Framing = el.dataset.azFraming === 'beside-text' ? 'beside-text' : 'centred';
    const url = el.dataset.azModel;
    if (url) {
      if (!SAFE_MODEL.test(url)) return null;
      return model(url, this.models, env, framing, () => this.fail(el));
    }
    return strands(Number(el.dataset.azSeed) >>> 0, accent, env, framing);
  }

  /** `camera orbit`: arrow keys and horizontal drag turn the object; vertical drag scrolls the page. */
  private orbitInput(view: View): void {
    this.listen(view.el, 'keydown', (e) => {
      const key = (e as KeyboardEvent).key;
      if (key !== 'ArrowLeft' && key !== 'ArrowRight') return;
      e.preventDefault();
      view.yawTarget += key === 'ArrowLeft' ? -ORBIT_KEY_STEP : ORBIT_KEY_STEP;
      this.wake();
    });
    let startX: number | null = null;
    let startYaw = 0;
    const end = () => { startX = null; };
    this.listen(view.el, 'pointerdown', (e) => {
      const p = e as PointerEvent;
      startX = p.clientX;
      startYaw = view.yawTarget;
      // The drag keeps the pointer when it leaves the view, so a release
      // outside still ends it — without capture the up is lost there and
      // plain hovering would turn the object afterwards.
      try { view.el.setPointerCapture(p.pointerId); } catch { /* no active pointer to capture */ }
    });
    this.listen(view.el, 'pointermove', (e) => {
      if (startX === null) return;
      const p = e as PointerEvent;
      // A mouse whose button is up is not dragging, whatever was missed.
      if (p.pointerType === 'mouse' && (p.buttons & 1) === 0) { end(); return; }
      const width = view.el.getBoundingClientRect().width || 1;
      view.yawTarget = startYaw + ((p.clientX - startX) / width) * (Math.PI * 2 / ORBIT_DRAG_TURN);
      this.wake();
    });
    this.listen(view.el, 'pointerup', end);
    this.listen(view.el, 'pointercancel', end);
    this.listen(view.el, 'lostpointercapture', end);
  }

  private markLive(el: HTMLElement, live: boolean): void {
    const host = el.closest<HTMLElement>('[data-az-3d-host]');
    const parts = [el, ...(host ? [host, ...host.querySelectorAll<HTMLElement>('[data-az-live-part]')] : [])];
    for (const part of parts) {
      if (live) part.setAttribute('data-live', 'true');
      else part.removeAttribute('data-live');
    }
  }

  private applyDpr(): void {
    const cap = LADDER[this.rung].dprCap;
    this.renderer.setPixelRatio(Math.min(this.win.devicePixelRatio || 1, cap));
  }

  private recolour(): void {
    if (this.stopped) return;
    const accent = hex(this.doc, 'accent');
    this.accent = accent;
    for (const v of this.views) v.content?.recolour(accent);
    this.wake();
  }

  /** Rebuild an evicted view's content; its poster stays until it is ready. */
  private restore(view: View): void {
    const content = this.contentFor(view.el, this.accent);
    if (!content) return;
    content.setRung(LADDER[this.rung]);
    view.content = content;
    view.el.removeAttribute('data-az-evicted');
  }

  /** Release the least-recently-visible paused views while over budget (§7). */
  private enforceBudget(): void {
    if (this.stopped) return;
    const residents = this.views
      .filter((v) => v.content && v.counted)
      .map((v) => ({
        id: v.id, visible: v.visible, backdrop: v.backdrop, lastVisible: v.lastVisible,
        resources: sceneResources(v.content!.scene),
      }));
    for (const id of toEvict(residents, this.budget)) {
      // By id, not index: mount() re-sorts the list to put the backdrop first.
      const v = this.views.find((x) => x.id === id);
      if (!v) continue;
      v.content?.dispose();
      v.content = null;
      v.counted = false;
      this.markLive(v.el, false);
      v.el.setAttribute('data-az-evicted', 'true');
    }
    this.publishMemory();
  }

  /** GPU objects the renderer still holds — what a test sees eviction free. */
  private publishMemory(): void {
    const m = this.renderer.info.memory;
    this.doc.documentElement.setAttribute('data-az3d-gpu', `${m.geometries},${m.textures}`);
  }

  /**
   * Run a frame. The loop keeps going only while something ON SCREEN is drawn
   * or still loading, and stops itself otherwise (§7); scroll, resize, the
   * warm-margin observer and input wake it.
   */
  private wake(): void {
    if (this.stopped || this.frame || this.doc.visibilityState === 'hidden') return;
    this.frame = this.win.requestAnimationFrame((ts) => this.tick(ts));
  }

  private tick(ts: number): void {
    this.frame = 0;
    if (this.stopped || this.doc.visibilityState === 'hidden') { this.lastTs = null; return; }
    const dt = this.lastTs === null ? 0 : Math.min((ts - this.lastTs) / 1000, MAX_STEP_S);
    const { drawn, loading } = this.draw(dt);
    if (this.stopped) return;
    if (drawn > 0) {
      this.lastTs = ts;
      // Only a frame that drew something measures the device (§3).
      this.decide(ts);
    } else {
      // A frame that drew nothing is not a frame of the scene: the next gap
      // must not be measured.
      this.probe?.pause();
      this.lastTs = null;
    }
    if (this.stopped) return;
    if (drawn > 0 || loading) this.frame = this.win.requestAnimationFrame((next) => this.tick(next));
  }

  /** Feed the probe, and apply its rung now or at the next quiet moment (§5). */
  private decide(ts: number): void {
    if (!this.probe) return;
    this.probe.sample(ts, true);
    this.sampled++;
    this.trace();
    const next = this.probe.engine.rung;
    if (next === this.rung) { this.pending = null; return; }
    if (!LADDER[next].deferred) { this.setRung(next); return; }
    this.pending ??= { rung: next, since: ts };
    this.pending.rung = next;
    const idle = ts - this.lastScroll >= SCROLL_IDLE_MS;
    if (idle || ts - this.pending.since >= DEFER_DEADLINE_MS) {
      this.setRung(next);
      this.pending = null;
    }
  }

  private setRung(next: number): void {
    this.rung = next;
    this.publish();
    if (next === STATIC_RUNG) { this.teardown('floor'); return; }
    this.applyDpr();
    for (const v of this.views) v.content?.setRung(LADDER[next]);
  }

  /** Draw every view on screen; how many were drawn, and whether one on screen is still loading. */
  private draw(dt: number): { drawn: number; loading: boolean } {
    const rung: Rung = LADDER[this.rung];
    const w = this.doc.documentElement.clientWidth;
    const h = this.doc.documentElement.clientHeight;
    const size = this.renderer.getSize(new THREE.Vector2());
    if (size.x !== w || size.y !== h) this.renderer.setSize(w, h, false);

    this.renderer.setScissorTest(false);
    this.renderer.clear();
    this.renderer.setScissorTest(true);

    const scrollMax = Math.max(1, this.doc.documentElement.scrollHeight - h);
    // Under a modal's scroll lock both scrollY and the page's height read as
    // collapsed; the page has not moved, so the backdrop holds where it is.
    const locked = this.doc.documentElement.hasAttribute(SCROLL_LOCK);

    let arrived = false;
    let drawn = 0;
    let loading = false;
    for (const v of this.views) {
      if (!v.visible && !v.backdrop) continue;
      const content = v.content;
      if (!content || this.failed.has(v.el)) continue;
      const r = v.backdrop ? { left: 0, top: 0, width: w, height: h, bottom: h } : v.el.getBoundingClientRect();
      const onScreen = r.width > 0 && r.height > 0 && r.bottom >= 0 && r.top <= h;
      if (!content.ready) { if (onScreen) loading = true; continue; }
      if (!v.counted) { v.counted = true; arrived = true; }
      if (!onScreen) continue;

      const k = 1 - Math.exp(-DAMPING * dt);
      // motion-tiers-spec §5: `lite` rungs hold a static camera for every
      // view, so only rungs with a scroll-linked camera move (scene-spec §8).
      if (rung.scrollLinkedCamera) {
        // §6.3 / §8: a backdrop follows the page; a view follows its own box.
        if (v.backdrop) {
          if (!locked && (v.motion === 'scroll' || v.motion === 'parallax')) v.target = this.win.scrollY / scrollMax;
          if (this.traced) this.doc.documentElement.setAttribute('data-az3d-backdrop', v.target.toFixed(4));
        } else if (v.motion === 'scroll' || v.motion === 'parallax' || v.kind === 'orbit') {
          v.target = Math.min(1, Math.max(0, (h - r.top) / (h + r.height)));
        }
        v.damped += (v.target - v.damped) * k;
      }
      // scene-block-spec §9: the visitor's own turn (arrow keys, drag) is not
      // the scroll-linked camera, so it holds on every live rung — an orbit
      // view that takes focus answers its keys on `lite` too.
      v.yaw += (v.yawTarget - v.yaw) * k;
      const x = r.left;
      const y = h - r.bottom;
      this.renderer.setViewport(x, y, r.width, r.height);
      this.renderer.setScissor(x, y, r.width, r.height);
      content.setAspect(r.width / r.height);
      content.update({ progress: v.motion === 'parallax' ? v.damped * 0.5 : v.damped, yaw: v.yaw });
      this.renderer.render(content.scene, content.camera);
      drawn++;
      if (!v.el.hasAttribute('data-live')) {
        this.markLive(v.el, true);
        // The heroes the backdrop draws hand over only now it is really drawn.
        if (v.backdrop) for (const hero of this.behind) this.markLive(hero, true);
      }
    }
    // New content has arrived on the GPU: it now counts toward the budget.
    if (arrived) this.enforceBudget();
    return { drawn, loading };
  }

  /** Release everything and return every view to its poster (§7 released, §8 static). */
  teardown(reason: StopReason): void {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    this.rungAtStop = this.rung;
    this.rung = STATIC_RUNG;
    this.publish();
    if (this.frame) this.win.cancelAnimationFrame(this.frame);
    this.observer.disconnect();
    this.sizes.disconnect();
    for (const c of this.cleanups) c();
    for (const v of this.views) {
      v.content?.dispose();
      this.markLive(v.el, false);
    }
    for (const el of this.doc.querySelectorAll<HTMLElement>('[data-az-3d]')) this.markLive(el, false);
    this.models.dispose();
    this.env.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  /**
   * The current rung, on the root element — what tests and a curious reader
   * can see (motion-tiers-spec §9) without a global on window.
   */
  private publish(): void {
    this.doc.documentElement.setAttribute('data-az3d-rung', String(this.rung));
  }

  /** `?az-probe-trace`: frames the probe measured, and times it was told the tab hid. */
  private trace(): void {
    if (this.traced) this.doc.documentElement.setAttribute('data-az3d-probe', `${this.sampled} ${this.hides}`);
  }
}
