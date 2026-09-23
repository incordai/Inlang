/**
 * @az runtime tiers
 * Purpose: motion tiers, the 8-rung ladder and the frame-rate probe (pure decision engine).
 * Spec: docs/motion-tiers-spec.md §3–§5
 * Exports: LADDER, TierProbe, ProbeEngine, capabilityGate, simulate
 * Edit guide: the ratchet never promotes after arming; decisions come from drawn frames only.
 * Tests: packages/scene-runtime/test/scene-runtime.test.ts, packages/scene-runtime/test/probe-hide.test.ts
 */

/**
 * Motion tiers, the degradation ladder and the runtime probe.
 *
 * Implements docs/motion-tiers-spec.md §1–§6. Tests ASSUMPTIONS.md A1b: that a
 * runtime frame-rate probe picks the right rung without false downgrades and
 * without oscillation.
 *
 * Three layers, each testable on its own:
 *   - LADDER: what each rung renders, as data (§5)
 *   - capabilityGate(): entry tier and ceiling from signals, pure (§2)
 *   - ProbeEngine / simulate(): the decision function over frame intervals,
 *     deterministic — no clock, no window, no randomness (§3, §4)
 * TierProbe is the thin adapter that turns rAF timestamps into intervals for
 * the engine. Nothing here reads the DOM — gate.ts does — so the unit suite
 * runs every decision without a browser.
 *
 * Ported from spike-m0/src/tiers.ts, where §8 was measured. The spike-only
 * `?az-rung=` override is not shipped: a site takes `?az-tier=` (§6.1).
 */

export type Tier = 'full' | 'lite' | 'static';

export const TIER_ORDER: readonly Tier[] = ['full', 'lite', 'static'] as const;

/* ------------------------------------------------------------------ */
/* §5 — the ladder                                                      */
/* ------------------------------------------------------------------ */

export interface Rung {
  readonly index: number;
  readonly tier: Tier;
  readonly label: string;
  /** Upper bound on the renderer pixel ratio; the device ratio is never raised. */
  readonly dprCap: number;
  /** The post-fx chain may run. */
  readonly postFx: boolean;
  /** The shadow map may run. */
  readonly shadows: boolean;
  /** Geometry and surface level of detail. */
  readonly lod: 'high' | 'low';
  /** The camera (here: the scene group) follows scroll progress. */
  readonly scrollLinkedCamera: boolean;
  /** A canvas and a WebGL renderer exist at all. */
  readonly canvas: boolean;
  /**
   * Applied at the next quiet moment rather than immediately (§5): rungs 1–2
   * are imperceptible and apply at once; 3–7 wait for scroll-idle or a
   * section boundary, with a hard deadline.
   */
  readonly deferred: boolean;
}

export const LADDER: readonly Rung[] = [
  { index: 0, tier: 'full', label: 'full quality', dprCap: 2.0, postFx: true, shadows: true, lod: 'high', scrollLinkedCamera: true, canvas: true, deferred: false },
  { index: 1, tier: 'full', label: 'DPR 2.0 → 1.5', dprCap: 1.5, postFx: true, shadows: true, lod: 'high', scrollLinkedCamera: true, canvas: true, deferred: false },
  { index: 2, tier: 'full', label: 'post-fx off', dprCap: 1.5, postFx: false, shadows: true, lod: 'high', scrollLinkedCamera: true, canvas: true, deferred: false },
  { index: 3, tier: 'full', label: 'shadows off', dprCap: 1.5, postFx: false, shadows: false, lod: 'high', scrollLinkedCamera: true, canvas: true, deferred: true },
  { index: 4, tier: 'full', label: 'DPR 1.5 → 1.0', dprCap: 1.0, postFx: false, shadows: false, lod: 'high', scrollLinkedCamera: true, canvas: true, deferred: true },
  { index: 5, tier: 'full', label: 'low LOD', dprCap: 1.0, postFx: false, shadows: false, lod: 'low', scrollLinkedCamera: true, canvas: true, deferred: true },
  { index: 6, tier: 'lite', label: 'static camera', dprCap: 1.0, postFx: false, shadows: false, lod: 'low', scrollLinkedCamera: false, canvas: true, deferred: true },
  { index: 7, tier: 'static', label: 'poster', dprCap: 1.0, postFx: false, shadows: false, lod: 'low', scrollLinkedCamera: false, canvas: false, deferred: true },
] as const;

export const STATIC_RUNG = LADDER.length - 1;

/** The rung a tier is entered at — its best rung. */
export const TIER_ENTRY_RUNG: Readonly<Record<Tier, number>> = { full: 0, lite: 6, static: 7 };

export const tierOf = (rung: number): Tier => LADDER[rung].tier;

/* ------------------------------------------------------------------ */
/* §2 — static capability gate                                          */
/* ------------------------------------------------------------------ */

/** Raw signals. `undefined` means the browser did not expose it (§2.1). */
export interface GateSignals {
  readonly reducedMotion: boolean;
  readonly webgl2: boolean;
  /** WebGL2 with failIfMajorPerformanceCaveat succeeded. */
  readonly accelerated: boolean;
  readonly cores: number | undefined;
  readonly deviceMemory: number | undefined;
  readonly saveData: boolean | undefined;
}

export interface GateResult {
  readonly entry: Tier;
  readonly ceiling: Tier;
  /** §3.6: entered low only because signals were missing — may promote once. */
  readonly promotable: boolean;
  readonly reasons: string[];
  readonly missing: string[];
}

const lower = (a: Tier, b: Tier): Tier =>
  TIER_ORDER[Math.max(TIER_ORDER.indexOf(a), TIER_ORDER.indexOf(b))];

/**
 * §2 table, rows 1–8. Pure over the signals so every row is unit-testable.
 * A missing signal never reads as "capable" (§2.1).
 */
export function capabilityGate(s: GateSignals): GateResult {
  const reasons: string[] = [];
  const missing: string[] = [];
  const floor = (why: string): GateResult =>
    ({ entry: 'static', ceiling: 'static', promotable: false, reasons: [...reasons, why], missing });

  if (s.reducedMotion) return floor('prefers-reduced-motion');
  if (!s.webgl2) return floor('no-webgl2');
  if (s.saveData === true) return floor('save-data');
  if (s.cores !== undefined && s.cores <= 1) return floor(`cores=${s.cores}`);
  if (s.deviceMemory !== undefined && s.deviceMemory <= 1) return floor(`deviceMemory=${s.deviceMemory}`);

  let ceiling: Tier = 'full';
  let entry: Tier = 'full';
  if (!s.accelerated) { reasons.push('software-raster'); ceiling = 'lite'; entry = 'lite'; }
  if (s.cores !== undefined && s.cores <= 4) { reasons.push(`cores=${s.cores}`); ceiling = lower(ceiling, 'lite'); }
  if (s.deviceMemory !== undefined && s.deviceMemory <= 2) { reasons.push(`deviceMemory=${s.deviceMemory}`); ceiling = lower(ceiling, 'lite'); }

  if (s.cores === undefined) missing.push('hardwareConcurrency');
  if (s.deviceMemory === undefined) missing.push('deviceMemory');
  if (s.saveData === undefined) missing.push('saveData');

  entry = lower(entry, ceiling);
  if (missing.length > 0) {
    // Unknown must cost frames, not risk them: start at `lite`. If nothing
    // measured has capped the ceiling, one promotion is possible (§3.6).
    return { entry: 'lite', ceiling, promotable: ceiling === 'full', reasons, missing };
  }
  return { entry, ceiling, promotable: false, reasons, missing };
}

/* ------------------------------------------------------------------ */
/* §6.1 — forcing a tier or rung                                        */
/* ------------------------------------------------------------------ */

export interface Forced {
  readonly tier: Tier | null;
  readonly probeOff: boolean;
}

/** §6.1: `?az-tier=full|lite|static` and `?az-probe=off`, from a query string. */
export function readForced(search: string): Forced {
  const q = new URLSearchParams(search);
  const t = q.get('az-tier');
  return {
    tier: t === 'full' || t === 'lite' || t === 'static' ? t : null,
    probeOff: q.get('az-probe') === 'off',
  };
}

export interface Start {
  readonly rung: number;
  /** Best rung this page view may ever occupy. */
  readonly ceilingRung: number;
  readonly promotable: boolean;
  readonly probe: boolean;
  readonly reasons: string[];
}

/**
 * Combine the gate with any forcing. A force can never go ABOVE the ceiling
 * (`?az-tier=full` without WebGL2 still gets `static`), and reduced motion is
 * a ceiling of `static`, so it is not overridable either (§6.1).
 */
export function startFrom(gate: GateResult, forced: Forced): Start {
  const ceilingRung = TIER_ENTRY_RUNG[gate.ceiling];
  if (forced.tier === null) {
    return { rung: TIER_ENTRY_RUNG[gate.entry], ceilingRung, promotable: gate.promotable,
             probe: !forced.probeOff, reasons: gate.reasons };
  }
  const wanted = TIER_ENTRY_RUNG[forced.tier];
  const rung = Math.max(wanted, ceilingRung);
  return {
    rung, ceilingRung, promotable: false, probe: !forced.probeOff,
    reasons: [...gate.reasons,
      rung === wanted ? `forced via ?az-tier=${forced.tier}` : `?az-tier=${forced.tier} capped by ceiling ${gate.ceiling}`],
  };
}

/* ------------------------------------------------------------------ */
/* §3, §4 — the decision function                                        */
/* ------------------------------------------------------------------ */

export const PROBE = {
  settleMs: 1500,
  warmupFrames: 60,
  outlierMs: 500,
  windowSize: 120,
  minSamples: 90,
  /** p95 floors by tier (§3.4). */
  floorMs: { full: 20.0, lite: 33.3 } as Readonly<Record<'full' | 'lite', number>>,
  confirmWindows: 3,
  freezeMs: 250,
  freezeRun: 5,
  promoteMs: 13.0,
  promoteWindows: 2,
  longHorizon: 300,
  driftSpan: 30,
  driftMinEntries: 60,
  driftWorse: 1.25,
} as const;

export interface Transition {
  readonly from: number;
  readonly to: number;
  readonly reason: string;
  /** Elapsed ms of accepted frame time since the first frame. */
  readonly atMs: number;
}

export interface WindowStats { readonly p50: number; readonly p95: number; readonly n: number }

export interface ProbeSnapshot {
  readonly rung: number;
  readonly tier: Tier;
  readonly settled: boolean;
  readonly armed: boolean;
  readonly samples: number;
  readonly windowsJudged: number;
  readonly lastWindow: WindowStats | null;
  readonly outliers: number;
  readonly driftTrips: number;
  readonly transitions: readonly Transition[];
}

export interface EngineInit {
  readonly rung: number;
  readonly ceilingRung?: number;
  readonly promotable?: boolean;
}

/** Nearest-rank percentile over the first `n` values of `buf`. */
function percentile(sorted: Float64Array, n: number, p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * n) - 1)];
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * The probe's state machine. Deterministic: it sees only the intervals and
 * events it is handed — no clock, no DOM — so a synthetic trace reproduces a
 * device exactly (§8.2). Buffers are allocated once (§4 cost).
 */
export class ProbeEngine {
  private rungNow: number;
  private readonly ceilingRung: number;
  private promotable: boolean;
  private armed: boolean;

  private elapsed = 0;
  private frames = 0;
  private settled = false;

  private readonly buf = new Float64Array(PROBE.windowSize);
  private readonly sorted = new Float64Array(PROBE.windowSize);
  private n = 0;
  private skip = 0;
  private strikes = 0;
  private freezeRun = 0;
  private outliers = 0;
  private windowsJudged = 0;
  private promoGood = 0;
  private promoSeen = 0;
  private last: WindowStats | null = null;

  /** Window p95s since the drift baseline was (re)taken, capped at longHorizon. */
  private long: number[] = [];
  private driftTrips = 0;
  private readonly log: Transition[] = [];

  constructor(init: EngineInit) {
    this.rungNow = init.rung;
    this.ceilingRung = init.ceilingRung ?? 0;
    this.promotable = !!init.promotable;
    // The ratchet is armed from the first frame unless one promotion is owed.
    this.armed = !this.promotable;
  }

  get rung(): number { return this.rungNow; }

  /** One frame interval, in ms. Call only for frames of a visible page. */
  sample(dt: number): void {
    if (this.rungNow === STATIC_RUNG) return;
    this.elapsed += dt;
    this.frames++;

    if (!this.settled) {
      // §3.2: 1500 ms AND 60 frames, whichever ends later.
      if (this.elapsed >= PROBE.settleMs && this.frames >= PROBE.warmupFrames) this.settled = true;
      return;
    }

    // §3.4: a run of visible freezes goes straight to the floor.
    this.freezeRun = dt > PROBE.freezeMs ? this.freezeRun + 1 : 0;
    if (this.freezeRun >= PROBE.freezeRun) {
      this.setRung(STATIC_RUNG, `${PROBE.freezeRun} consecutive intervals over ${PROBE.freezeMs}ms`);
      return;
    }

    if (dt > PROBE.outlierMs) { this.outliers++; return; }
    if (this.skip > 0) { this.skip--; return; }

    this.buf[this.n++] = dt;
    if (this.n === PROBE.windowSize) this.closeWindow();
  }

  /**
   * The tab was hidden. The partial window is judged only if it has enough
   * samples (§3.3), and the drift baseline is re-taken on return (§4): a
   * cooled device is a different device.
   */
  hidden(): void {
    this.closeWindow();
    this.long = [];
  }

  /** §2 #9 / §3.4: the context is gone; nothing above `static` exists. */
  contextLost(): void {
    this.setRung(STATIC_RUNG, 'webglcontextlost');
  }

  private closeWindow(): void {
    const n = this.n;
    this.n = 0;
    if (n < PROBE.minSamples) return;

    this.sorted.set(this.buf.subarray(0, n));
    const view = this.sorted.subarray(0, n).sort();
    const stats = { p50: percentile(view, n, 50), p95: percentile(view, n, 95), n };
    this.last = stats;
    this.windowsJudged++;

    // §3.6: the one promotion, decided on the first two windows.
    if (!this.armed) {
      this.promoSeen++;
      if (stats.p95 <= PROBE.promoteMs) this.promoGood++;
      if (this.promoSeen === PROBE.promoteWindows) {
        if (this.promoGood === PROBE.promoteWindows && this.rungNow > this.ceilingRung) {
          this.setRung(this.ceilingRung,
            `promote: ${PROBE.promoteWindows} windows p95 ≤ ${PROBE.promoteMs}ms at lite`);
        }
        this.armed = true;
        return;
      }
    }

    const tier = tierOf(this.rungNow);
    const floorMs = tier === 'full' ? PROBE.floorMs.full : PROBE.floorMs.lite;

    // §3.4 + §3.5: persistent failure only; any passing window resets.
    if (stats.p95 > floorMs) {
      this.strikes++;
      if (this.strikes >= PROBE.confirmWindows) {
        this.setRung(this.rungNow + 1,
          `${PROBE.confirmWindows} windows p95 over ${floorMs}ms (last p50 ${stats.p50.toFixed(1)} p95 ${stats.p95.toFixed(1)})`);
        return;
      }
    } else {
      this.strikes = 0;
    }

    this.checkDrift(stats.p95, floorMs);
  }

  /**
   * §4 drift. The detector TRIPS when the recent median is more than 25%
   * worse than the baseline; it STEPS DOWN only if the current window also
   * breaches the floor — drift alone is not a problem. A trip re-takes the
   * baseline, so one sustained drift is reported once, not every 30 windows.
   */
  private checkDrift(p95: number, floorMs: number): void {
    this.long.push(p95);
    if (this.long.length > PROBE.longHorizon) this.long.shift();
    const count = this.long.length;
    if (count < PROBE.driftMinEntries || count % PROBE.driftSpan !== 0) return;

    const baseline = median(this.long.slice(0, PROBE.driftSpan));
    const recent = median(this.long.slice(-PROBE.driftSpan));
    if (recent <= baseline * PROBE.driftWorse) return;

    this.driftTrips++;
    this.long = [];
    if (p95 > floorMs && this.rungNow < STATIC_RUNG) {
      this.setRung(this.rungNow + 1,
        `drift: median p95 ${recent.toFixed(1)}ms vs baseline ${baseline.toFixed(1)}ms, window over ${floorMs}ms`);
    }
  }

  /**
   * The only way the rung changes. §3.5: once armed, the rung index never
   * decreases — enforced here, not by convention.
   */
  private setRung(to: number, reason: string): void {
    if (to === this.rungNow) return;
    if (this.armed && to < this.rungNow) return;
    this.log.push({ from: this.rungNow, to, reason, atMs: this.elapsed });
    this.rungNow = to;
    // Any transition — the one promotion included — arms the ratchet.
    this.armed = true;
    this.strikes = 0;
    this.n = 0;
    // §3.2: the next window measured the previous configuration.
    this.skip = PROBE.windowSize;
  }

  get snapshot(): ProbeSnapshot {
    return {
      rung: this.rungNow,
      tier: tierOf(this.rungNow),
      settled: this.settled,
      armed: this.armed,
      samples: this.n,
      windowsJudged: this.windowsJudged,
      lastWindow: this.last,
      outliers: this.outliers,
      driftTrips: this.driftTrips,
      transitions: [...this.log],
    };
  }
}

/** A trace step: a frame interval in ms, or an event. */
export type TraceStep = number | 'hidden' | 'contextlost';

/** The pure decision function: a trace in, the decisions out. */
export function simulate(trace: Iterable<TraceStep>, init: EngineInit): ProbeSnapshot {
  const e = new ProbeEngine(init);
  for (const step of trace) {
    if (step === 'hidden') e.hidden();
    else if (step === 'contextlost') e.contextLost();
    else e.sample(step);
  }
  return e.snapshot;
}

/* ------------------------------------------------------------------ */
/* Browser adapter                                                       */
/* ------------------------------------------------------------------ */

/** Turns rAF timestamps into intervals; skips frames of a hidden page. */
export class TierProbe {
  readonly engine: ProbeEngine;
  private lastTs: number | null = null;

  constructor(init: EngineInit) {
    this.engine = new ProbeEngine(init);
  }

  sample(nowMs: number, visible: boolean): void {
    if (!visible) {
      if (this.lastTs !== null) this.engine.hidden();
      this.lastTs = null;
      return;
    }
    if (this.lastTs !== null) this.engine.sample(nowMs - this.lastTs);
    this.lastTs = nowMs;
  }

  /** The render loop paused (on-demand frames): the next gap is not a frame. */
  pause(): void { this.lastTs = null; }

  /**
   * The tab was hidden. Called from `visibilitychange` itself: a hidden tab
   * gets no animation frames, so a loop waiting for its next frame would
   * never see the page hidden (§3.3, §4's drift re-baseline).
   */
  hide(): void {
    this.engine.hidden();
    this.lastTs = null;
  }

  contextLost(): void { this.engine.contextLost(); }
}
