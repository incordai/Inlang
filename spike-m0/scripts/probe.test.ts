/**
 * A1b — the capability gate, forcing, and the probe's behaviour around the
 * §8.2 decision rows (those live in decision.test.ts).
 *
 * The gate and the engine are pure over their inputs, so every row of the
 * motion-tiers-spec §2 table is driven directly. Every assertion has a control
 * that proves it can fail.
 *
 * Run: pnpm test:probe
 */

import {
  capabilityGate, startFrom, readForced, ProbeEngine, TierProbe, simulate, LADDER,
  PROBE, STATIC_RUNG, TIER_ENTRY_RUNG, type GateSignals, type TraceStep,
} from '../src/tiers.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

const CAPABLE: GateSignals = {
  reducedMotion: false, webgl2: true, accelerated: true, cores: 8, deviceMemory: 8, saveData: false,
};
const gate = (over: Partial<GateSignals>) => capabilityGate({ ...CAPABLE, ...over });
const summary = (g: ReturnType<typeof capabilityGate>) =>
  `entry ${g.entry}, ceiling ${g.ceiling}${g.promotable ? ', promotable' : ''} [${g.reasons.join(', ')}]`;

console.log('\nA1b — capability gate (§2)\n');

check('CONTROL: every signal capable → full/full, not promotable',
  summary(gate({})) === 'entry full, ceiling full []');
for (const [label, over, entry, ceiling] of [
  ['#1 reduced motion', { reducedMotion: true }, 'static', 'static'],
  ['#2 no WebGL2', { webgl2: false }, 'static', 'static'],
  ['#3 software raster', { accelerated: false }, 'lite', 'lite'],
  ['#4 cores ≤ 4', { cores: 4 }, 'full', 'lite'],
  ['#5 cores ≤ 1', { cores: 1 }, 'static', 'static'],
  ['#6 memory ≤ 2', { deviceMemory: 2 }, 'full', 'lite'],
  ['#7 memory ≤ 1', { deviceMemory: 1 }, 'static', 'static'],
  ['#8 save-data', { saveData: true }, 'static', 'static'],
] as const) {
  const g = gate(over);
  // A ceiling below the entry is clamped: `entry full, ceiling lite` enters lite.
  const want = ceiling === 'lite' && entry === 'full' ? 'lite' : entry;
  check(`${label} → entry ${want}, ceiling ${ceiling}`,
    g.entry === want && g.ceiling === ceiling && !g.promotable, summary(g));
}

{
  const g = gate({ deviceMemory: undefined });
  check('§2.1 missing deviceMemory → entry lite, ceiling full, promotable once',
    g.entry === 'lite' && g.ceiling === 'full' && g.promotable, `${summary(g)} missing=${g.missing}`);
  const h = gate({ cores: undefined, deviceMemory: 2 });
  check('§2.1 missing signal with a measured cap → lite/lite, NOT promotable',
    h.entry === 'lite' && h.ceiling === 'lite' && !h.promotable, summary(h));
  const z = gate({ cores: undefined });
  check('§2.1 an unreadable core count is missing, never 0 (0 ≤ 1 would force static)',
    z.entry === 'lite' && z.missing.includes('hardwareConcurrency'), summary(z));
}

console.log('\nForcing (§6.1)\n');
{
  const f = readForced('?az-tier=lite&az-probe=off');
  check('?az-tier=lite&az-probe=off parses', f.tier === 'lite' && f.probeOff && f.rung === null);
  check('?az-rung=4 parses; junk rung ignored',
    readForced('?az-rung=4').rung === 4 && readForced('?az-rung=9').rung === null);
  const s = startFrom(gate({}), readForced('?az-tier=lite'));
  check('forcing lite on a capable device enters rung 6 with the probe on',
    s.rung === 6 && s.probe && !s.promotable, s.reasons.join(', '));
  const up = startFrom(gate({ webgl2: false }), readForced('?az-tier=full'));
  check('?az-tier=full cannot force above the ceiling (no WebGL2 → static)',
    up.rung === STATIC_RUNG, up.reasons.join(', '));
  const rm = startFrom(gate({ reducedMotion: true }), readForced('?az-rung=0&az-probe=off'));
  check('reduced motion is not overridable, even by ?az-rung=0', rm.rung === STATIC_RUNG);
  const ok = startFrom(gate({}), readForced('?az-rung=3&az-probe=off'));
  check('CONTROL: an allowed forced rung is honoured, probe off', ok.rung === 3 && !ok.probe);
}

console.log('\nLadder (§5)\n');
{
  const dpr = LADDER.map((r) => r.dprCap).join(' ');
  check('DPR caps step 2.0 → 1.5 (rung 1) → 1.0 (rung 4)', dpr === '2 1.5 1.5 1.5 1 1 1 1', dpr);
  check('each rung removes exactly the one thing §5 names, cumulatively',
    LADDER.every((r, i) => i === 0 || (
      (r.postFx <= LADDER[i - 1].postFx) && (r.shadows <= LADDER[i - 1].shadows)
      && (r.scrollLinkedCamera <= LADDER[i - 1].scrollLinkedCamera) && (r.canvas <= LADDER[i - 1].canvas))));
  check('tiers: rungs 0–5 full, 6 lite, 7 static',
    LADDER.map((r) => r.tier[0]).join('') === 'ffffffls');
  check('rungs 1–2 immediate, 3–7 deferred to a quiet moment',
    LADDER.map((r) => (r.deferred ? 'd' : 'i')).join('') === 'iiiddddd');
}

console.log('\nProbe behaviour around the §8.2 rows\n');

const frames = (ms: number, n: number): TraceStep[] => Array(n).fill(ms);

/* Load jank inside the settle period must never count (§3.2). */
{
  const s = simulate([...frames(55, 25), ...frames(16.7, 3000)], { rung: 0 });
  check('load jank inside the settle period is ignored', s.transitions.length === 0 && s.settled);
  const c = simulate([...frames(16.7, 200), ...frames(55, 1000)], { rung: 0 });
  check('CONTROL: the same 55ms frames after settle do count', c.transitions.length > 0);
}

/* The browser adapter: a hidden tab's gap is not a frame. */
{
  const p = new TierProbe({ rung: 0 });
  let t = 0;
  for (let i = 0; i < 2000; i++) { p.sample(t, true); t += 16.7; }
  p.sample(t, false);                     // tab hidden
  t += 30_000;                            // 30s away
  for (let i = 0; i < 2000; i++) { p.sample(t, true); t += 16.7; }
  const s = p.engine.snapshot;
  check('a 30s hidden-tab gap is not a frame and trips nothing',
    s.transitions.length === 0 && s.outliers === 0, `outliers=${s.outliers}`);
  const q = new TierProbe({ rung: 0 });
  let u = 0;
  for (let i = 0; i < 2000; i++) { q.sample(u, true); u += 16.7; }
  u += 30_000;                            // same gap, but the page never said it was hidden
  for (let i = 0; i < 2000; i++) { q.sample(u, true); u += 16.7; }
  check('CONTROL: the same gap reported as visible is caught as an outlier',
    q.engine.snapshot.outliers === 1, `outliers=${q.engine.snapshot.outliers}`);
}

/* Closed loop: in a real page each rung makes frames faster. A device that
   holds 20ms only at low DPR must REST there, not fall through to static. */
{
  const costOf = (rung: number) => [26, 24, 23, 22, 18, 16, 12, 0][rung];
  const e = new ProbeEngine({ rung: 0 });
  for (let i = 0; i < 20_000; i++) e.sample(costOf(e.rung));
  check('closed loop: a device that holds the floor at rung 4 rests at rung 4',
    e.rung === 4, `path ${e.snapshot.transitions.map((x) => x.to).join('→')}`);
  const worse = (rung: number) => [60, 58, 55, 52, 48, 45, 40, 0][rung];
  const f = new ProbeEngine({ rung: 0 });
  for (let i = 0; i < 40_000 && f.rung < STATIC_RUNG; i++) f.sample(worse(f.rung));
  check('CONTROL: a device that fails every rung continues to static',
    f.rung === STATIC_RUNG, `ended at rung ${f.rung}`);
}

/* Context loss goes straight to the floor from anywhere (§2 #9). */
{
  const s = simulate([...frames(16.7, 500), 'contextlost'], { rung: 0 });
  check('webglcontextlost → static immediately', s.rung === STATIC_RUNG,
    s.transitions.map((x) => x.reason).join(', '));
}

/* Post-transition settle: the window after a rung change is not judged. */
{
  const e = new ProbeEngine({ rung: 0 });
  for (let i = 0; i < 200; i++) e.sample(16.7);
  const before = e.snapshot.windowsJudged;
  for (let i = 0; i < PROBE.windowSize * PROBE.confirmWindows; i++) e.sample(30);
  const atDrop = e.snapshot.windowsJudged;
  for (let i = 0; i < PROBE.windowSize; i++) e.sample(30);
  check('the window after a rung change is discarded, not judged',
    e.rung === 1 && e.snapshot.windowsJudged === atDrop,
    `judged ${before} → ${atDrop} → ${e.snapshot.windowsJudged}`);
}

check('CONTROL: TIER_ENTRY_RUNG agrees with the ladder',
  LADDER[TIER_ENTRY_RUNG.full].tier === 'full' && LADDER[TIER_ENTRY_RUNG.lite].tier === 'lite'
  && LADDER[TIER_ENTRY_RUNG.static].tier === 'static');

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
