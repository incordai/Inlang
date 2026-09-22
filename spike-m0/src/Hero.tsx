/**
 * The M0 hero — one hand-built `hero 3d scroll`, three tiers, live probe.
 *
 * No compiler, no abstraction (ROADMAP.md M0). This exists to produce numbers
 * for A1b (does the probe pick correctly) and A2 (how long is a hero emitter
 * really — counted twice, structure vs structure-plus-shader).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Environment, Lightformer } from '@react-three/drei';
import * as THREE from 'three';
import { buildStrands, disposeStrands } from './geometry.ts';
import { createStrandMaterial } from './material.ts';
import { CAMERA, computeFraming } from './framing.ts';
import { resolveLayout, layoutVars, sitePreset, HERO_PRESETS } from './layout.ts';
import { resolvePattern, patternCss } from './patterns.ts';
import {
  TIER_SETTINGS, TierProbe, capabilityGate, forcedTier,
  type Tier, type ProbeState,
} from './tiers.ts';

function Strands({ tier, scroll }: { tier: Tier; scroll: React.RefObject<number> }) {
  const group = useRef<THREE.Group>(null);
  const settings = TIER_SETTINGS[tier];

  // Built once. Rebuilding per frame is the mistake that kills weak devices.
  const built = useMemo(
    () => buildStrands({ seed: 0x415a, strands: settings.shells > 8 ? 16 : 10 }),
    [settings.shells],
  );

  const { material, uniforms } = useMemo(() => createStrandMaterial(tier), [tier]);

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

  const damped = useRef(0);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);            // clamp: a stall must not jump
    const target = scroll.current ?? 0;
    damped.current += (target - damped.current) * (1 - Math.exp(-6 * dt));
    // Opens already formed: the first paint is what decides whether the page
    // reads as expensive, so scroll COMPLETES the growth rather than starting it.
    uniforms.uGrowth.value = 0.62 + damped.current * 0.48;
    if (group.current && settings.scrollLinkedCamera) {
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

/** Feeds the probe one sample per frame and reports the tier upward. */
function ProbeDriver({
  probe, onState,
}: { probe: TierProbe; onState: (s: ProbeState) => void }) {
  const { gl } = useThree();
  const frames = useRef(0);
  useFrame(() => {
    probe.sample(performance.now());
    if (++frames.current % 15 === 0) onState(probe.state);
  });
  useEffect(() => () => { gl.dispose(); }, [gl]);
  return null;
}

export function Hero() {
  const pinned = useMemo(() => forcedTier(), []);

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
   * The entry tier is resolved ONCE, synchronously, before the probe exists.
   *
   * This ordering is load-bearing. An earlier version set the tier from the
   * gate in an effect while constructing the probe from React's initial state,
   * so the probe started at `full` and its polling loop wrote that back over
   * the gate's decision — a `prefers-reduced-motion` visitor was served the
   * full scene. The gate is a ceiling, not a suggestion: the probe may only
   * ever move DOWN from it.
   */
  const entry = useMemo(
    () => (pinned
      ? { tier: pinned, reasons: [`forced via ?tier=${pinned}`] }
      : capabilityGate()),
    [pinned],
  );

  // Seeded from `entry` on the very first render, so a disqualified visitor
  // never sees even one frame of a canvas they should not get.
  const [tier, setTier] = useState<Tier>(entry.tier);
  const [probeState, setProbeState] = useState<ProbeState | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const gateReasons = entry.reasons;
  const scroll = useRef(0);

  const probe = useMemo(() => {
    if (pinned) return null;
    return new TierProbe(entry.tier, (t, why) =>
      setLog((l) => [...l, `${new Date().toISOString().slice(11, 19)}  → ${t}  (${why})`]),
    );
    // Keyed on the ENTRY tier: the probe owns every subsequent change, so
    // re-creating it on each tier change would reset the ratchet and
    // reintroduce the oscillation it exists to prevent.
  }, [pinned, entry.tier]);

  // Mirror the probe's tier into React state without re-creating the probe.
  useEffect(() => {
    if (!probe) return;
    const id = setInterval(() => {
      const s = probe.state;
      setProbeState(s);
      setTier((cur) => (s.tier !== cur ? s.tier : cur));
    }, 250);
    return () => clearInterval(id);
  }, [probe]);

  useEffect(() => {
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      scroll.current = max > 0 ? window.scrollY / max : 0;

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
  }, []);

  const settings = TIER_SETTINGS[tier];

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
        {tier !== 'static' ? (
          <Canvas
            dpr={settings.dpr}
            gl={{ antialias: false, powerPreference: 'high-performance' }}
            camera={{ position: CAMERA.position, fov: CAMERA.fov }}
          >
            <StudioEnv />
            <Strands tier={tier} scroll={scroll} />
            {probe && <ProbeDriver probe={probe} onState={setProbeState} />}
          </Canvas>
        ) : (
          <div className="poster" role="img"
               aria-label="Static poster: the scene does not animate on this device." />
        )}
      </div>

      <section className="readout">
        <h2>Probe</h2>
        <dl>
          <div><dt>tier</dt><dd data-tier={tier}>{tier}</dd></div>
          <div><dt>entry gate</dt><dd>{gateReasons.length ? gateReasons.join(', ') : 'no disqualifiers'}</dd></div>
          <div><dt>dpr</dt><dd>{settings.dpr}</dd></div>
          <div><dt>site width</dt><dd data-site={layout.site}>{layout.site} — {sitePreset(layout.site, layout.size).label}</dd></div>
          <div><dt>hero width</dt><dd data-hero={layout.hero}>{layout.hero} — {HERO_PRESETS[layout.hero].label}</dd></div>
          <div><dt>pattern</dt><dd data-pattern={pattern.shape}>{pattern.shape} · {pattern.origin}</dd></div>
          <div><dt>settled</dt><dd>{probeState?.settled ? 'yes' : 'settling…'}</dd></div>
          <div><dt>samples</dt><dd>{probeState?.samples ?? 0}</dd></div>
          <div><dt>p50 interval</dt><dd>{probeState ? `${probeState.p50.toFixed(1)} ms` : '—'}</dd></div>
          <div><dt>p95 interval</dt><dd>{probeState ? `${probeState.p95.toFixed(1)} ms` : '—'}</dd></div>
        </dl>
        <h3>Ratchet log</h3>
        <pre>{log.length ? log.join('\n') : 'no downgrades — tier held'}</pre>
        <p className="hint">
          Pin a tier with <code>?tier=full</code>, <code>?tier=lite</code> or
          <code>?tier=static</code> — this is what keeps visual snapshots deterministic.
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
