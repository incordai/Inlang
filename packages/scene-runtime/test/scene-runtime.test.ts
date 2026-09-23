/**
 * The 3D runtime's pure parts — the same code a generated site runs.
 *
 * Determinism (A8b) and the decision function (motion-tiers-spec §8.2) were
 * measured in spike-m0; these tests hold the ported copies to that evidence.
 * The cross-engine check stays in the spike (`pnpm test:engines`), because
 * it needs three browser engines.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStrands, disposeStrands } from '../src/runtime/geometry.ts';
import { seedFrom } from '../src/runtime/seed.ts';
import { computeCentredFraming, fitsInFrame } from '../src/runtime/framing.ts';
import {
  capabilityGate, readForced, simulate, startFrom, PROBE, STATIC_RUNG, TIER_ENTRY_RUNG,
  type GateSignals, type TraceStep,
} from '../src/runtime/tiers.ts';

/* ---- determinism, A8b ------------------------------------------------------ */

/** The hash spike-m0 recorded for seed 0x415a in Node, Chromium, Firefox and WebKit. */
const SPIKE_HASH = 'cc723c2a1b107de4';

test('A8b: the ported generator reproduces the hash the spike measured across engines', () => {
  const built = buildStrands({ seed: 0x415a });
  assert.equal(built.hash, SPIKE_HASH);
  assert.equal(built.vertexCount, 4802);
  disposeStrands(built);
});

test('A8b: three builds of one seed give one hash', () => {
  const hashes = [0, 1, 2].map(() => {
    const b = buildStrands({ seed: seedFrom('aurora|/|0') });
    disposeStrands(b);
    return b.hash;
  });
  assert.equal(new Set(hashes).size, 1);
});

test('CONTROL: a different seed gives a different mesh', () => {
  const a = buildStrands({ seed: seedFrom('aurora|/|0') });
  const b = buildStrands({ seed: seedFrom('aurora|/|1') });
  assert.notEqual(a.hash, b.hash);
  disposeStrands(a); disposeStrands(b);
});

/* ---- framing -------------------------------------------------------------- */

test('a centred view keeps the swept disc inside the frame at every aspect', () => {
  const built = buildStrands({ seed: 0x415a });
  for (const aspect of [21 / 9, 16 / 9, 4 / 3, 1, 3 / 4, 390 / 844]) {
    const f = computeCentredFraming(aspect, built.radiusXZ);
    assert.ok(fitsInFrame(built.radiusXZ, aspect, { position: f.position, scale: f.scale }).fits,
      `overflows at aspect ${aspect.toFixed(2)}`);
  }
  disposeStrands(built);
});

/* ---- the gate and forcing, §2 and §6.1 ------------------------------------ */

const CAPABLE: GateSignals = {
  reducedMotion: false, webgl2: true, accelerated: true, cores: 8, deviceMemory: 8, saveData: false,
};

test('§2: reduced motion, no WebGL2 and Save-Data all start at the poster', () => {
  for (const s of [{ reducedMotion: true }, { webgl2: false }, { saveData: true }]) {
    assert.equal(capabilityGate({ ...CAPABLE, ...s }).entry, 'static', JSON.stringify(s));
  }
  assert.equal(capabilityGate(CAPABLE).entry, 'full', 'CONTROL: a capable device starts full');
});

test('§6.1: ?az-tier= forces a tier but never above the ceiling', () => {
  const capable = capabilityGate(CAPABLE);
  assert.equal(startFrom(capable, readForced('?az-tier=static')).rung, STATIC_RUNG);
  assert.equal(startFrom(capable, readForced('?az-tier=lite')).rung, TIER_ENTRY_RUNG.lite);
  const reduced = capabilityGate({ ...CAPABLE, reducedMotion: true });
  assert.equal(startFrom(reduced, readForced('?az-tier=full')).rung, STATIC_RUNG,
    'reduced motion is a ceiling of static — not overridable');
  assert.equal(startFrom(capable, readForced('?az-probe=off')).probe, false);
});

/* ---- the decision function, §8.2 ---------------------------------------- */

const MINUTE = 60_000;
function* steady(ms: number, durationMs: number): Generator<number> {
  for (let t = 0; t < durationMs; t += ms) yield ms;
}

test('§8.2 row 1: steady 16.7ms never leaves rung 0', () => {
  const s = simulate(steady(16.7, 10 * MINUTE), { rung: 0 });
  assert.equal(s.rung, 0);
  assert.equal(simulate(steady(25, 2 * MINUTE), { rung: 0 }).rung > 0, true, 'CONTROL: 25ms does');
});

test('§8.2 row 3: a 300ms spike every 10s never downgrades', () => {
  function* spiky(): Generator<number> {
    for (let t = 0; t < 5 * MINUTE; t += 16.7) yield t % 10_000 < 16.7 ? 300 : 16.7;
  }
  assert.equal(simulate(spiky(), { rung: 0 }).rung, 0);
});

/** Frames until the probe settles at a given interval (§3.2), so windows align. */
const settleCount = (ms: number) => Math.max(PROBE.warmupFrames, Math.ceil(PROBE.settleMs / ms));

test('§8.2 row 4: alternating good and bad windows never downgrade', () => {
  function* alternating(): Generator<number> {
    for (let i = 0; i < settleCount(16.7); i++) yield 16.7;
    for (let w = 0; w < 200; w++) for (let i = 0; i < PROBE.windowSize; i++) yield w % 2 ? 30 : 16.7;
  }
  assert.equal(simulate(alternating(), { rung: 0 }).transitions.length, 0);
  function* backToBack(): Generator<number> {
    for (let i = 0; i < settleCount(16.7); i++) yield 16.7;
    for (let w = 0; w < 6; w++) for (let i = 0; i < PROBE.windowSize; i++) yield 30;
  }
  assert.ok(simulate(backToBack(), { rung: 0 }).transitions.length > 0,
    'CONTROL: the same bad windows back to back do downgrade');
});

test('§8.2 row 6: once at static the rung never rises', () => {
  const trace: TraceStep[] = [...steady(16.7, 5_000), 'contextlost', ...steady(10, MINUTE)];
  const s = simulate(trace, { rung: 0 });
  assert.equal(s.rung, STATIC_RUNG);
  assert.ok(s.transitions.every((t) => t.to > t.from), 'monotonic');
});

test('§8.2 row 7: fewer than the minimum samples decide nothing', () => {
  const settle = Math.max(PROBE.warmupFrames, Math.ceil(PROBE.settleMs / 40));
  const s = simulate(steady(40, (settle + PROBE.minSamples - 1) * 40), { rung: 0 });
  assert.equal(s.windowsJudged, 0);
});
