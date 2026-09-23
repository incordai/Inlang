/**
 * motion-tiers-spec §8.2 — the decision function over synthetic traces.
 *
 * No browser, no pixels, no flake: a slow device IS a sequence of long frame
 * intervals, and the engine sees nothing else. Every row of the §8.2 table is
 * one block below, each with a control that proves it can fail.
 *
 * Run: pnpm test:decision
 */

import {
  ProbeEngine, simulate, PROBE, STATIC_RUNG, TIER_ENTRY_RUNG,
  type TraceStep, type ProbeSnapshot,
} from '../src/tiers.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const MINUTE = 60_000;
const FULL = { rung: TIER_ENTRY_RUNG.full };
const LITE = { rung: TIER_ENTRY_RUNG.lite, ceilingRung: TIER_ENTRY_RUNG.lite };

/** Frames the settle period discards at a given interval (§3.2). */
const settleCount = (ms: number) => Math.max(PROBE.warmupFrames, Math.ceil(PROBE.settleMs / ms));

function* steady(ms: number, durationMs: number): Generator<number> {
  for (let t = 0; t < durationMs; t += ms) yield ms;
}

const monotonic = (s: ProbeSnapshot) => s.transitions.every((x) => x.to > x.from);
const path = (s: ProbeSnapshot) =>
  s.transitions.map((x) => `${x.from}→${x.to}`).join(' ') || 'none';

console.log('\n§8.2 — decision function, synthetic traces\n');

/* Row 1 — steady 16.7 ms never leaves rung 0. */
{
  const s = simulate(steady(16.7, 10 * MINUTE), FULL);
  check('row 1: steady 16.7ms never leaves rung 0 (10 min)',
    s.rung === 0 && s.transitions.length === 0, `rung ${s.rung}, ${s.windowsJudged} windows judged`);
  const c = simulate(steady(25, 2 * MINUTE), FULL);
  check('CONTROL: steady 25ms over the same period does leave rung 0',
    c.rung > 0, `rung ${c.rung}: ${path(c)}`);
}

/* Row 2 — steady 40 ms from `lite` reaches `static` within 4 windows, not before 3. */
{
  const e = new ProbeEngine(LITE);
  let windowsAtStatic = -1;
  for (const dt of steady(40, 5 * MINUTE)) {
    e.sample(dt);
    if (e.rung === STATIC_RUNG) { windowsAtStatic = e.snapshot.windowsJudged; break; }
  }
  check('row 2: steady 40ms from lite reaches static within 4 windows, not before 3',
    windowsAtStatic >= 3 && windowsAtStatic <= 4, `static after ${windowsAtStatic} windows`);
  const c = simulate(steady(30, 5 * MINUTE), LITE);
  check('CONTROL: 30ms at lite (under the 33.3ms floor) stays lite',
    c.rung === TIER_ENTRY_RUNG.lite, `rung ${c.rung}`);
}

/* Row 3 — one 300 ms spike per 10 s never downgrades. */
{
  const spikes = function* (): Generator<TraceStep> {
    let sinceSpike = 0;
    for (let t = 0; t < 10 * MINUTE; ) {
      if (sinceSpike >= 10_000) { yield 300; t += 300; sinceSpike = 0; continue; }
      yield 16.7; t += 16.7; sinceSpike += 16.7;
    }
  };
  const s = simulate(spikes(), FULL);
  check('row 3: 16.7ms with one 300ms spike per 10s never downgrades',
    s.transitions.length === 0, `${path(s)}, last p95 ${s.lastWindow?.p95.toFixed(1)}ms`);
  const burst = function* (): Generator<TraceStep> {
    for (const dt of steady(16.7, 30_000)) yield dt;
    for (let i = 0; i < 5; i++) yield 300;
  };
  const c = simulate(burst(), FULL);
  check('CONTROL: five consecutive 300ms frames do go straight to static',
    c.rung === STATIC_RUNG, path(c));
}

/* Row 4 — alternating good/bad windows never downgrade, never oscillate. */
function alternating(): Generator<TraceStep> {
  return (function* () {
    for (let i = 0; i < settleCount(16.7); i++) yield 16.7;
    for (let w = 0; w < 200; w++) {
      const ms = w % 2 === 0 ? 16.7 : 30;          // 30ms: over the 20ms floor
      for (let i = 0; i < PROBE.windowSize; i++) yield ms;
    }
  })();
}
{
  const s = simulate(alternating(), FULL);
  check('row 4: alternating good/bad windows never downgrade, never oscillate',
    s.transitions.length === 0, `${s.windowsJudged} windows judged, ${path(s)}`);
  const c = simulate((function* () {
    for (let i = 0; i < settleCount(16.7); i++) yield 16.7;
    for (let w = 0; w < 6; w++) for (let i = 0; i < PROBE.windowSize; i++) yield 30;
  })(), FULL);
  check('CONTROL: the same bad windows back to back do downgrade',
    c.transitions.length > 0, path(c));
}

/* Row 5 — 16.7 ms ramping to 30 ms over 6 minutes trips the drift check once.
   This tests the DRIFT DETECTOR, not thermal throttling (§8.3). */
{
  const ramp = function* (): Generator<TraceStep> {
    for (let t = 0; t < 6 * MINUTE; ) {
      const ms = 16.7 + (30 - 16.7) * (t / (6 * MINUTE));
      yield ms; t += ms;
    }
  };
  const s = simulate(ramp(), FULL);
  check('row 5: a 6-minute ramp 16.7→30ms trips the drift check exactly once',
    s.driftTrips === 1, `${s.driftTrips} trip(s); transitions ${path(s)}`);
  const c = simulate(steady(16.7, 6 * MINUTE), FULL);
  check('CONTROL: no ramp, no drift trip', c.driftTrips === 0, `${c.driftTrips} trip(s)`);
}

/* Row 6 — after static, the tier never decreases: the ratchet holds. */
{
  const e = new ProbeEngine(LITE);
  for (const dt of steady(40, 2 * MINUTE)) e.sample(dt);
  const atStatic = e.rung;
  for (const dt of steady(8, 10 * MINUTE)) e.sample(dt);
  check('row 6: after static, 10 min of 8ms frames never climbs back',
    atStatic === STATIC_RUNG && e.rung === STATIC_RUNG, `rung ${atStatic} → ${e.rung}`);

  // The one promotion (§3.6), then a failure, then fast frames again: the
  // promotion must not be repeated.
  const p = new ProbeEngine({ rung: TIER_ENTRY_RUNG.lite, ceilingRung: 0, promotable: true });
  for (const dt of steady(8, 20_000)) p.sample(dt);
  const promoted = p.rung;
  for (const dt of steady(40, MINUTE)) p.sample(dt);
  const dropped = p.rung;
  for (const dt of steady(8, 10 * MINUTE)) p.sample(dt);
  const s = p.snapshot;
  check('row 6: one promotion, then downgrades only — never promoted again',
    promoted === 0 && dropped > 0 && s.rung === dropped
      && s.transitions.filter((x) => x.to < x.from).length === 1,
    `lite → ${promoted} → ${dropped} → ${s.rung}: ${path(s)}`);

  const all = [simulate(steady(25, 5 * MINUTE), FULL), simulate(alternating(), FULL),
    simulate(steady(40, 5 * MINUTE), LITE)];
  check('row 6: every transition in the traces above is a downgrade',
    all.every(monotonic), all.map(path).join(' | '));
}

/* Row 7 — fewer than 90 samples: no decision at all. */
{
  const partial = (count: number): TraceStep[] =>
    [...Array(settleCount(100)).fill(100), ...Array(count).fill(100), 'hidden'];
  const s = simulate(partial(PROBE.minSamples - 1), FULL);
  check('row 7: 89 terrible samples then the tab hides — no decision taken',
    s.windowsJudged === 0 && s.transitions.length === 0, `${s.windowsJudged} windows judged`);
  const c = simulate(partial(PROBE.minSamples), FULL);
  check('CONTROL: with 90 samples the same partial window IS judged',
    c.windowsJudged === 1, `${c.windowsJudged} windows judged`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
