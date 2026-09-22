/**
 * A1b probe: does the runtime tier probe pick correctly, and never oscillate?
 *
 * ROADMAP.md M0 exit criteria — "the probe selects the right tier on every
 * device available, including a deliberately throttled one" and "zero tier
 * oscillation across a 60s scroll; downgrade ratchets one way".
 *
 * This drives TierProbe.sample() with synthetic frame intervals, which is the
 * real mechanism — a slow device IS a sequence of long frame intervals. Every
 * assertion has a control that proves it can fail.
 *
 * Run: pnpm test:probe
 */

import { TierProbe, DEFAULT_PROBE, type Tier } from '../src/tiers.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** Feed `count` frames of `intervalMs`, starting after the settle period. */
function drive(probe: TierProbe, intervalMs: number, count: number, t0 = 0): number {
  let t = t0;
  for (let i = 0; i < count; i++) {
    probe.sample(t);
    t += intervalMs;
  }
  return t;
}

function newProbe(entry: Tier = 'full') {
  const log: Array<{ tier: Tier; why: string }> = [];
  const p = new TierProbe(entry, (tier, why) => log.push({ tier, why }));
  return { p, log };
}

/** Frames needed to clear the settle window at a given interval. */
const settleFrames = (ms: number) => Math.ceil(DEFAULT_PROBE.settleMs / ms) + 2;

console.log('\nA1b — runtime tier probe\n');

/* 1. A fast device must NOT be downgraded. This is the false-positive case,
      and it is the one that would quietly make every site worse. */
{
  const { p, log } = newProbe();
  drive(p, 16, settleFrames(16) + 600); // ~60fps for ~10s
  check('60fps device holds `full`', p.state.tier === 'full' && log.length === 0,
        `p95=${p.state.p95.toFixed(1)}ms, ${log.length} downgrades`);
}

/* 2. A genuinely slow device MUST be downgraded. */
{
  const { p, log } = newProbe();
  drive(p, 50, settleFrames(50) + 400); // ~20fps
  check('20fps device downgrades off `full`', p.state.tier !== 'full' && log.length > 0,
        `→ ${p.state.tier} after ${log.length} step(s)`);
}

/* 3. CONTROL for 1 and 2 together: the threshold must actually discriminate.
      If both cases produced the same tier, tests 1 and 2 would be vacuous. */
{
  const fast = newProbe(); drive(fast.p, 16, settleFrames(16) + 600);
  const slow = newProbe(); drive(slow.p, 50, settleFrames(50) + 400);
  check('CONTROL: fast and slow reach DIFFERENT tiers',
        fast.p.state.tier !== slow.p.state.tier,
        `fast=${fast.p.state.tier} slow=${slow.p.state.tier}`);
}

/* 4. The settle period must suppress load jank. A burst of terrible frames
      inside the settle window must not trip anything. */
{
  const { p, log } = newProbe();
  let t = 0;
  for (let i = 0; i < 20; i++) { p.sample(t); t += 55; } // 20 awful frames, ~1.1s
  check('load jank inside settle window is ignored',
        p.state.tier === 'full' && log.length === 0,
        `${log.length} downgrades during settle`);
}

/* 5. The one-way ratchet: no upgrade, ever. Drive it slow until it drops,
      then drive it fast for a long time and assert it does NOT climb back. */
{
  const { p } = newProbe();
  let t = drive(p, 50, settleFrames(50) + 400);
  const dropped = p.state.tier;
  drive(p, 8, 1200, t); // 120fps for a long stretch
  check('ratchet is one-way — fast frames never promote',
        p.state.tier === dropped && dropped !== 'full',
        `stayed at ${p.state.tier} after 1200 fast frames`);
}

/* 6. No oscillation across a long alternating run — the failure the ratchet
      exists to prevent. Alternating good/bad must produce a bounded number of
      transitions, never a flapping stream. */
{
  const { p, log } = newProbe();
  let t = 0;
  for (let i = 0; i < 4000; i++) {           // ~60s of frames
    p.sample(t);
    t += i % 200 < 100 ? 12 : 45;            // alternating fast / slow blocks
  }
  check('no oscillation over ~60s alternating load',
        log.length <= 2,                     // at most full→lite→static
        `${log.length} transitions: ${log.map((l) => l.tier).join(' → ') || 'none'}`);
}

/* 7. `static` is the floor — it must not attempt a further downgrade. */
{
  const { p, log } = newProbe('static');
  drive(p, 200, 400); // catastrophically slow
  check('`static` is the floor, no further downgrade',
        p.state.tier === 'static' && log.length === 0);
}

/* 8. A backgrounded tab produces one enormous interval. That is not device
      capability and must not trip the ratchet. */
{
  const { p, log } = newProbe();
  let t = drive(p, 16, settleFrames(16) + 200);
  p.sample(t + 30000);                        // tab hidden for 30s
  drive(p, 16, 200, t + 30016);
  check('a 30s tab-hidden gap does not trip the ratchet',
        p.state.tier === 'full' && log.length === 0,
        `${log.length} downgrades`);
}

/* 9. CONTROL for 8: prove the probe WOULD have downgraded on sustained slow
      frames at that same point, so test 8 is not passing by accident. */
{
  const { p, log } = newProbe();
  let t = drive(p, 16, settleFrames(16) + 200);
  drive(p, 50, 400, t);                       // sustained slow, not one spike
  check('CONTROL: sustained slow frames at the same point DO downgrade',
        log.length > 0, `${log.length} downgrade(s)`);
}

/* 10. CLOSED LOOP — the realistic case tests 2 and 6 cannot express.
       In a real page, dropping a tier makes frames FASTER. Feed intervals that
       improve as the tier drops, and assert the probe RESTS at `lite` rather
       than falling through to `static`. Without this, "it downgraded" could
       mean "it over-downgraded" and every test above would still pass. */
{
  const { p, log } = newProbe();
  const intervalFor = (t: Tier) => (t === 'full' ? 45 : t === 'lite' ? 14 : 8);
  let t = 0;
  for (let i = 0; i < 3000; i++) { p.sample(t); t += intervalFor(p.state.tier); }
  check('closed loop: a lite-capable device RESTS at `lite`',
        p.state.tier === 'lite',
        `ended at ${p.state.tier} after ${log.length} step(s): ${log.map((l) => l.tier).join(' -> ')}`);
}

/* 11. CONTROL for 10: a device that cannot manage `lite` either must continue
       to `static`, proving test 10 rests by measurement and not by stalling. */
{
  const { p } = newProbe();
  const intervalFor = (t: Tier) => (t === 'full' ? 60 : t === 'lite' ? 48 : 10);
  let t = 0;
  for (let i = 0; i < 3000; i++) { p.sample(t); t += intervalFor(p.state.tier); }
  check('CONTROL: a device failing `lite` too continues to `static`',
        p.state.tier === 'static', `ended at ${p.state.tier}`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
