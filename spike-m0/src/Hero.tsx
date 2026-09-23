/**
 * The M0 hero — one hand-built `hero 3d scroll`, three tiers, live probe.
 *
 * No compiler, no abstraction (ROADMAP.md M0). This exists to produce numbers
 * for A1b (does the probe pick correctly) and A2 (how long is a hero emitter
 * really — counted twice, structure vs structure-plus-shader).
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import * as THREE from 'three';
import { buildStrands, disposeStrands } from './geometry.ts';
import { createStrandMaterial } from './material.ts';
import { CAMERA, computeFraming } from './framing.ts';
import { resolveLayout, layoutVars, sitePreset, HERO_PRESETS } from './layout.ts';
import { resolvePattern, patternCss } from './patterns.ts';
import { ModelBoundary, readModelUrl, reportFailure, reportModel } from './model-url.tsx';
import {
  LADDER, STATIC_RUNG, TierProbe, capabilityGate, readGateSignals, readForced, startFrom,
  type Rung, type ProbeSnapshot,
} from './tiers.ts';

/** Loaded only when `?az-model=` opts in — the default page never fetches it. */
const Model = lazy(() => import('./model.tsx'));

/**
 * The post-fx chain this scene renders. The spike draws straight to the
 * canvas — no composer, no passes — so rung 2 has nothing to remove here. It
 * is kept as data so the rung's effect is still MEASURED (0 → 0) rather than
 * assumed, and so a scene that adds a pass puts it on the ladder (§5.2).
 */
const POST_CHAIN: readonly string[] = [];

/** §5: deferred rungs wait for this much scroll silence... */
const SCROLL_IDLE_MS = 200;
/** ...or this long at most, so a visitor who never stops still gets relief. */
const DEFER_DEADLINE_MS = 2000;

/** What the renderer is ACTUALLY doing — read back, never assumed (§6.1). */
interface Measured {
  pixelRatio: number;
  postPasses: number;
  cameraSubscriptions: number;
  shadowMap: boolean;
  vertices: number;
  frameloop: 'always' | 'demand' | 'none';
  probeCostP95Ms: number;
}

/** Scroll progress, published to explicit subscribers so they can be counted. */
type ScrollSubscribers = Set<(progress: number) => void>;

function Strands({ rung, scroll, subscribers, measured }: {
  rung: Rung;
  scroll: React.RefObject<number>;
  subscribers: ScrollSubscribers;
  measured: React.RefObject<Measured>;
}) {
  const group = useRef<THREE.Group>(null);
  const high = rung.lod === 'high';

  // Built once per LOD. Rebuilding per frame is the mistake that kills weak devices.
  const built = useMemo(() => buildStrands({ seed: 0x415a, strands: high ? 16 : 10 }), [high]);

  // §5 rung 5: the low LOD also drops the clearcoat pass, the most expensive
  // shading term in this material (§5.2: every expensive term is on the ladder).
  const { material, uniforms } = useMemo(() => createStrandMaterial(high ? 'full' : 'lite'), [high]);

  useEffect(() => { measured.current.vertices = built.vertexCount; }, [built, measured]);

  // The camera follows scroll only while subscribed. Rung 6 unsubscribes: the
  // scene holds its pose, and the count below reads 0.
  const target = useRef(scroll.current ?? 0);
  const invalidate = useThree((st) => st.invalidate);
  useEffect(() => {
    if (!rung.scrollLinkedCamera) return;
    const follow = (p: number) => { target.current = p; };
    follow(scroll.current ?? 0);
    subscribers.add(follow);
    return () => { subscribers.delete(follow); };
  }, [rung.scrollLinkedCamera, scroll, subscribers]);
  useEffect(() => { invalidate(); }, [rung, invalidate]);

  // Framing follows the viewport aspect. A fixed scale overflows on narrow
  // screens — hero-spec §10 requires the behaviour below 768px to be DEFINED,
  // and this is that rule applied to the scene rather than to the copy.
  const aspect = useThree((st) => st.viewport.aspect);
  const framing = useMemo(
    () => computeFraming(aspect, built.radiusXZ),
    [aspect, built.radiusXZ],
  );

  // dispose() on unmount — hero-spec §8. Without it a route change leaks
  // until the tab dies, and nothing in a demo ever reveals it.
  useEffect(() => () => { disposeStrands(built); material.dispose(); }, [built, material]);

  const damped = useRef(target.current);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);            // clamp: a stall must not jump
    damped.current += (target.current - damped.current) * (1 - Math.exp(-6 * dt));
    // Opens already formed: the first paint is what decides whether the page
    // reads as expensive, so scroll COMPLETES the growth rather than starting it.
    uniforms.uGrowth.value = 0.62 + damped.current * 0.48;
    if (group.current) {
      group.current.rotation.y = -0.35 + damped.current * Math.PI * 0.55;
    }
  });

  return (
    // Framed by arithmetic, and against the ROTATION radius rather than the
    // axis-aligned box — the group spins on Y, so the box understates the
    // footprint and the first attempt cropped at the right edge. XZ radius is
    // 3.06; at scale 0.66 the swept disc is 4.04 wide inside a 7.37 view, its
    // right edge clears the frame and its left edge (ndc -0.16) clears the
    // text column (which ends at ndc -0.28).
    <group ref={group} position={framing.position} scale={framing.scale}>
      {built.geometries.map((g, i) => (
        <mesh key={i} geometry={g} material={material} castShadow={false} receiveShadow={false} />
      ))}
    </group>
  );
}

/**
 * A studio environment built from emissive planes and rendered to a cube
 * target — no .hdr file and no CDN fetch.
 *
 * An HDRI download would put a third-party network request into every site the
 * compiler generates, which PRD principle 1 rules out for the build and which
 * is simply bad practice at runtime. Lightformers give the same job — a large
 * soft key, a rim, a fill — from geometry we own.
 */
function StudioEnv() {
  return (
    <Environment resolution={256} environmentIntensity={1.0}>
      {/* key: large, soft, high and slightly front-left */}
      <Lightformer form="rect" intensity={4.2} color="#fdfbf4"
                   position={[-3.5, 4.5, 5]} scale={[9, 9, 1]} target={[0, 0, 0]} />
      {/* rim: tight and cool, behind and right — this is what draws the edge */}
      <Lightformer form="rect" intensity={6.0} color="#cfe6ff"
                   position={[5, 1.5, -4]} scale={[5, 5, 1]} target={[0, 0, 0]} />
      {/* fill: broad, warm, low — lifts the shadow side off black */}
      <Lightformer form="rect" intensity={1.4} color="#e8dfc8"
                   position={[2, -3.5, 3]} scale={[8, 5, 1]} target={[0, 0, 0]} />
      {/* ground bounce */}
      <Lightformer form="rect" intensity={0.9} color="#8fa06a"
                   position={[0, -5, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[12, 12, 1]} />
    </Environment>
  );
}

/**
 * Feeds the probe one sample per frame, and times itself doing it — §8.1
 * check 7 wants the probe's cost measured, not argued.
 */
function ProbeDriver({ probe, measured }: { probe: TierProbe; measured: React.RefObject<Measured> }) {
  const cost = useRef(new Float64Array(600));
  const i = useRef(0);
  useEffect(() => () => probe.pause(), [probe]);
  useFrame(() => {
    const t0 = performance.now();
    probe.sample(t0, document.visibilityState === 'visible');
    cost.current[i.current++ % cost.current.length] = performance.now() - t0;
    if (i.current % 60 === 0) {
      const n = Math.min(i.current, cost.current.length);
      const s = Array.from(cost.current.subarray(0, n)).sort((a, b) => a - b);
      measured.current.probeCostP95Ms = s[Math.ceil(0.95 * n) - 1];
    }
  });
  return null;
}

/**
 * `?az-load=<ms>` — burn that much main thread per frame. Spike-only test
 * input for motion-tiers-spec §8.3: CPU throttling cannot starve this scene
 * on a fast GPU (its per-frame JS is tiny), so the detector is exercised with
 * a synthetic per-frame load instead — labelled proxy, like throttling.
 */
function SyntheticLoad({ ms }: { ms: number }) {
  useFrame(() => {
    const end = performance.now() + ms;
    while (performance.now() < end) { /* synthetic load */ }
  });
  return null;
}

const SYNTHETIC_LOAD_MS = (() => {
  const v = Number(new URLSearchParams(window.location.search).get('az-load'));
  return Number.isFinite(v) && v > 0 ? v : 0;
})();

/**
 * Reads the renderer's real state back every frame, and turns a lost context
 * into the floor (§2 #9). Disposes the renderer on unmount — hero-spec §8.
 */
function RendererWatch({ rung, looping, measured, subscribers, onContextLost }: {
  rung: Rung;
  looping: boolean;
  measured: React.RefObject<Measured>;
  subscribers: ScrollSubscribers;
  onContextLost: () => void;
}) {
  const { gl } = useThree();
  useEffect(() => {
    const el = gl.domElement;
    const lost = (e: Event) => { e.preventDefault(); onContextLost(); };
    el.addEventListener('webglcontextlost', lost);
    return () => el.removeEventListener('webglcontextlost', lost);
  }, [gl, onContextLost]);
  useEffect(() => () => { gl.dispose(); }, [gl]);
  const publish = () => {
    const m = measured.current;
    m.pixelRatio = gl.getPixelRatio();
    m.shadowMap = gl.shadowMap.enabled;
    m.postPasses = rung.postFx ? POST_CHAIN.length : 0;
    m.cameraSubscriptions = subscribers.size;
    m.frameloop = looping ? 'always' : 'demand';
  };
  useEffect(publish);
  useFrame(publish);
  return null;
}

declare global {
  interface Window { __AZ_TIER__?: unknown }
}

export function Hero() {

  /**
   * The FRAME, resolved before anything is laid out.
   *
   * Two independent axes (layout.ts): the site shell, and how the hero relates
   * to it. `?site=narrow&hero=bleed` is a valid, common pairing — neither axis
   * constrains the other, and neither is forced.
   */
  const layout = useMemo(() => resolveLayout(), []);

  /**
   * The background pattern — a SHAPE, coloured by the theme.
   *
   * `--pattern-ink` and `--pattern-ground` are the indirection that keeps the
   * shape themeable: the pattern module never names a colour, and swapping the
   * theme repaints every pattern with it.
   */
  const pattern = useMemo(() => resolvePattern(), []);

  useEffect(() => {
    const vars = {
      ...layoutVars(layout.site, layout.hero, layout.size),
      '--pattern-ink': 'var(--accent)',
      '--pattern-ground': 'var(--bg)',
    };
    const css = patternCss(pattern);
    const root = document.documentElement;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    root.style.setProperty('--pattern-image', css.backgroundImage);
    root.style.setProperty('--pattern-size', css.backgroundSize);
    root.style.setProperty('--pattern-position', css.backgroundPosition);
    return () => {
      for (const k of Object.keys(vars)) root.style.removeProperty(k);
      for (const k of ['--pattern-image', '--pattern-size', '--pattern-position']) {
        root.style.removeProperty(k);
      }
    };
  }, [layout, pattern]);

  /**
   * The entry rung is resolved ONCE, synchronously, before the probe exists.
   *
   * This ordering is load-bearing. An earlier version set the tier from the
   * gate in an effect while constructing the probe from React's initial state,
   * so the probe started at `full` and its polling loop wrote that back over
   * the gate's decision — a `prefers-reduced-motion` visitor was served the
   * full scene. The gate is a ceiling, not a suggestion.
   */
  const start = useMemo(() => {
    const signals = readGateSignals();
    const gate = capabilityGate(signals);
    return { signals, gate, ...startFrom(gate, readForced()) };
  }, []);

  // The engine is the authority on the rung; this is what the page SHOWS,
  // which may lag it while a deferred rung waits for a quiet moment (§5).
  const [applied, setApplied] = useState(start.rung);
  const [snap, setSnap] = useState<ProbeSnapshot | null>(null);
  const scroll = useRef(0);
  const lastScrollAt = useRef(0);
  const subscribers = useMemo<ScrollSubscribers>(() => new Set(), []);
  const measured = useRef<Measured>({
    pixelRatio: 0, postPasses: 0, cameraSubscriptions: 0, shadowMap: false,
    vertices: 0, frameloop: 'none', probeCostP95Ms: 0,
  });

  // The opt-in .glb path (A8). Procedural strands stay the default.
  const modelUrl = useMemo(() => readModelUrl(), []);
  const [modelState, setModelState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => {
    if (modelUrl) reportModel({ url: modelUrl, state: 'loading', readyMs: null, triangles: 0, error: null });
  }, [modelUrl]);
  const onModelVertices = useCallback((n: number) => {
    measured.current.vertices = n;
    setModelState('ready');
  }, []);
  const onModelFail = useCallback((error: unknown) => {
    if (modelUrl) reportFailure(modelUrl, error);
    setModelState('failed');
  }, [modelUrl]);

  const probe = useMemo(() => {
    if (!start.probe || start.rung === STATIC_RUNG) return null;
    return new TierProbe({ rung: start.rung, ceilingRung: start.ceilingRung, promotable: start.promotable });
    // One probe per page view: re-creating it would reset the ratchet and
    // reintroduce the oscillation it exists to prevent.
  }, [start]);

  const onContextLost = useMemo(() => () => {
    probe?.contextLost();
    setApplied(STATIC_RUNG);       // nothing to defer: the canvas is already dead
  }, [probe]);

  // Follow the engine. Rungs 1–2 and the one promotion apply at once; 3–7
  // wait for SCROLL_IDLE_MS of scroll silence, or DEFER_DEADLINE_MS at most.
  //
  // The deadline is measured from the engine's decision (probe.decidedAt, the
  // frame it happened on) and enforced by a timer set for that exact moment.
  // Counting from when the 100ms poll first saw the decision, and checking
  // the deadline only on poll ticks, let a deferred rung land up to two
  // polls late — past the 2s the spec promises.
  useEffect(() => {
    if (!probe) return;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const clear = () => { if (deadline !== null) { clearTimeout(deadline); deadline = null; } };
    const follow = (force: boolean) => {
      const s = probe.engine.snapshot;
      setSnap(s);
      setApplied((cur) => {
        if (s.rung === cur) { clear(); return cur; }
        if (s.rung < cur || !LADDER[s.rung].deferred) { clear(); return s.rung; }
        const now = performance.now();
        const since = probe.decidedAt ?? now;
        const quiet = now - lastScrollAt.current >= SCROLL_IDLE_MS;
        if (force || quiet || now - since >= DEFER_DEADLINE_MS) { clear(); return s.rung; }
        deadline ??= setTimeout(() => { deadline = null; follow(true); },
          Math.max(0, since + DEFER_DEADLINE_MS - now));
        return cur;
      });
    };
    const id = setInterval(() => follow(false), 100);
    return () => { clearInterval(id); clear(); };
  }, [probe]);

  const rung = LADDER[applied];
  const tier = rung.tier;
  // §3.6 measures two windows WHILE RENDERING `lite`, before the scroll-link
  // engages; §5.1 drops `lite` to on-demand frames. Both hold only if the loop
  // keeps running until the promotion question is settled (ratchet armed).
  const armed = snap?.armed ?? !start.promotable;
  const looping = rung.scrollLinkedCamera || (!!probe && !armed);

  // §9 instrumentation. The spike ships its readout in every build; a real
  // target would keep this behind import.meta.env.DEV.
  useEffect(() => {
    const id = setInterval(() => {
      window.__AZ_TIER__ = {
        entry: start.gate.entry, ceiling: start.gate.ceiling, promotable: start.promotable,
        reasons: start.reasons, missing: start.gate.missing, signals: start.signals,
        probe: !!probe, decidedRung: probe?.engine.rung ?? applied, rung: applied, tier,
        canvas: rung.canvas, ...measured.current,
        cameraSubscriptions: subscribers.size,
        engine: probe?.engine.snapshot ?? null,
      };
    }, 100);
    return () => clearInterval(id);
  }, [start, probe, applied, tier, rung, subscribers]);

  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      scroll.current = max > 0 ? window.scrollY / max : 0;
      lastScrollAt.current = performance.now();
      for (const follow of subscribers) follow(scroll.current);

      // Fade the 3D layer out as the reader leaves the hero. Written as a CSS
      // custom property rather than React state: this runs on every scroll
      // event, and a re-render per event would cost far more than the fade.
      // Timed against the HERO, which is what the layer belongs to.
      //
      // Nothing fades while the hero is still the focus, and the layer is gone
      // by the moment the hero has fully scrolled past (85svh) — which is when
      // the next section owns the screen and its text must not have vines
      // across it. Fading earlier dimmed the hero's own scene; fading later
      // left the layer over the following copy.
      const vh = window.innerHeight || 1;
      const HERO_FRACTION = 0.85;                  // matches .hero min-height
      const start = vh * (HERO_FRACTION - 0.5);
      const t = Math.min(1, Math.max(0, (window.scrollY - start) / (vh * 0.5)));
      const eased = 1 - t * t * (3 - 2 * t);           // smoothstep out
      document.documentElement.style.setProperty('--stage-opacity', eased.toFixed(3));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      document.documentElement.style.removeProperty('--stage-opacity');
    };
  }, [subscribers]);

  const gateReasons = start.reasons;
  const dpr = Math.min(window.devicePixelRatio || 1, rung.dprCap);

  return (
    <>
      {/* Fixed-viewport scrim between the scene and the copy. Not bound to any
          section, so it cannot produce a section edge — hero-spec §8. */}
      <div className="pattern" aria-hidden="true" />
      <div className="scrim" aria-hidden="true" />

      {/* The headline is real DOM and paints before any canvas mounts —
          hero-spec §8: text must be the LCP element, never the canvas. */}
      <header className="hero">
        <p className="eyebrow">M0 spike</p>
        <h1>Let the<br />scene <em>decide.</em></h1>
        <p className="sub">
          The tier is measured on this device, not guessed from its user agent.
          Scroll to drive growth; the readout below is the live probe.
        </p>
      </header>

      <div className="stage" aria-hidden="true">
        {rung.canvas ? (
          <Canvas
            dpr={dpr}
            shadows={rung.shadows}
            // §5.1 step 3: once the camera stops following scroll, frames are
            // drawn only on demand, so the scene's remaining cost is zero.
            frameloop={looping ? 'always' : 'demand'}
            gl={{ antialias: false, powerPreference: 'high-performance' }}
            camera={{ position: CAMERA.position, fov: CAMERA.fov }}
          >
            <StudioEnv />
            {modelUrl ? (
              <ModelBoundary url={modelUrl} onFail={onModelFail}>
                <Suspense fallback={null}>
                  <Model url={modelUrl} rung={rung} scroll={scroll} subscribers={subscribers}
                         onVertices={onModelVertices} onFail={onModelFail} />
                </Suspense>
              </ModelBoundary>
            ) : (
              <Strands rung={rung} scroll={scroll} subscribers={subscribers} measured={measured} />
            )}
            <RendererWatch rung={rung} looping={looping} measured={measured}
                           subscribers={subscribers} onContextLost={onContextLost} />
            {/* An on-demand loop has no frame rate to measure: sampling its
                gaps would read an idle page as a frozen one. */}
            {probe && looping && <ProbeDriver probe={probe} measured={measured} />}
            {SYNTHETIC_LOAD_MS > 0 && <SyntheticLoad ms={SYNTHETIC_LOAD_MS} />}
          </Canvas>
        ) : null}
        {/* hero-spec §8: the poster stands in while a model loads, if it
            fails, and whenever the rung draws no canvas at all. */}
        {(!rung.canvas || (modelUrl && modelState !== 'ready')) && (
          <div className="poster" role="img" data-model-state={modelUrl ? modelState : undefined}
               aria-label="Static poster: the scene does not animate on this device." />
        )}
      </div>

      <section className="readout">
        <h2>Probe</h2>
        <dl>
          <div><dt>tier</dt><dd data-tier={tier}>{tier}</dd></div>
          <div><dt>rung</dt><dd data-rung={applied}>{applied} — {rung.label}</dd></div>
          <div><dt>entry gate</dt><dd>{gateReasons.length ? gateReasons.join(', ') : 'no disqualifiers'}{start.gate.missing.length ? ` · missing: ${start.gate.missing.join(', ')}` : ''}</dd></div>
          <div><dt>ceiling</dt><dd>{start.gate.ceiling}{start.promotable ? ' (one promotion allowed)' : ''}</dd></div>
          <div><dt>dpr</dt><dd>{rung.canvas ? dpr : '—'}</dd></div>
          <div><dt>site width</dt><dd data-site={layout.site}>{layout.site} — {sitePreset(layout.site, layout.size).label}</dd></div>
          <div><dt>hero width</dt><dd data-hero={layout.hero}>{layout.hero} — {HERO_PRESETS[layout.hero].label}</dd></div>
          <div><dt>pattern</dt><dd data-pattern={pattern.shape}>{pattern.shape} · {pattern.origin}</dd></div>
          <div><dt>settled</dt><dd>{snap?.settled ? 'yes' : probe ? 'settling…' : 'probe off'}</dd></div>
          <div><dt>samples</dt><dd>{snap?.samples ?? 0}</dd></div>
          <div><dt>windows judged</dt><dd>{snap?.windowsJudged ?? 0}</dd></div>
          <div><dt>ratchet</dt><dd>{snap ? (snap.armed ? 'armed' : 'not armed — one promotion possible') : '—'}</dd></div>
          <div><dt>p50 interval</dt><dd>{snap?.lastWindow ? `${snap.lastWindow.p50.toFixed(1)} ms` : '—'}</dd></div>
          <div><dt>p95 interval</dt><dd>{snap?.lastWindow ? `${snap.lastWindow.p95.toFixed(1)} ms` : '—'}</dd></div>
        </dl>
        <h3>Ratchet log</h3>
        <pre>{snap?.transitions.length
          ? snap.transitions.map((x) => `t+${(x.atMs / 1000).toFixed(1)}s  rung ${x.from}→${x.to} (${LADDER[x.to].label}) · ${x.reason}`).join('\n')
          : 'no transitions — rung held'}</pre>
        <p className="hint">
          Pin a tier with <code>?az-tier=full|lite|static</code> or a rung with{' '}
          <code>?az-rung=0…7</code>; add <code>&amp;az-probe=off</code> to freeze it — this
          is what keeps visual snapshots deterministic.
          The frame is independent of it: <code>?site=</code>{' '}
          <code>full|gap|center</code> (with <code>?size=</code>{' '}
          <code>wide|default|narrow|reading</code> for <code>center</code>) and <code>?hero=</code>{' '}
          <code>bleed|container|inset</code> combine freely. Background:{' '}
          <code>?pattern=</code>{' '}
          <code>none|glow|spotlight|ramp|grid|hatch|dots</code> with{' '}
          <code>?origin=</code> and <code>?intensity=</code>.
        </p>
      </section>

      <div className="scroll-space" aria-hidden="true" />
    </>
  );
}
