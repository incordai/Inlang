/**
 * Motion tiers and the runtime probe.
 *
 * Implements docs/motion-tiers-spec.md. Tests ASSUMPTIONS.md A1b: that a
 * runtime frame-rate probe can pick the right tier without false downgrades
 * and without oscillation.
 *
 * The design point: the tier is MEASURED on the visitor's device, never
 * inferred from a device class. Emitted code stays byte-identical; only the
 * render adapts.
 */

export type Tier = 'full' | 'lite' | 'static';

export const TIER_ORDER: readonly Tier[] = ['full', 'lite', 'static'] as const;

/** Per-tier render settings. `static` never creates a renderer at all. */
export interface TierSettings {
  readonly dpr: number;
  readonly shells: number;
  readonly postFx: boolean;
  readonly shadows: boolean;
  readonly scrollLinkedCamera: boolean;
}

export const TIER_SETTINGS: Readonly<Record<Tier, TierSettings>> = {
  // DPR 1.75 is the clamp measured on a shipped reference scene
  // (docs/3d-technique-reference.md §6). Above it, cost rises faster than
  // perceived quality.
  full: { dpr: 1.75, shells: 13, postFx: true, shadows: true, scrollLinkedCamera: true },
  lite: { dpr: 1.0, shells: 8, postFx: false, shadows: false, scrollLinkedCamera: true },
  static: { dpr: 1.0, shells: 0, postFx: false, shadows: false, scrollLinkedCamera: false },
};

/* ------------------------------------------------------------------ */
/* Static capability gate — decided before first paint, no measurement  */
/* ------------------------------------------------------------------ */

export interface CapabilityResult {
  readonly tier: Tier;
  readonly reasons: string[];
}

/**
 * Hard disqualifiers that need no measurement.
 *
 * A MISSING signal never counts as "capable" — motion-tiers-spec.md §2. Where
 * a browser does not expose `deviceMemory` we do not treat absence as a pass,
 * we simply do not use it as a fail either, and let the probe decide.
 */
export function capabilityGate(win: Window = window): CapabilityResult {
  const reasons: string[] = [];

  if (win.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    reasons.push('prefers-reduced-motion');
  }

  // Save-Data is only on some browsers; absence is not a pass or a fail.
  const conn = (win.navigator as { connection?: { saveData?: boolean } }).connection;
  if (conn?.saveData === true) reasons.push('save-data');

  if (!hasWebGL2(win)) reasons.push('no-webgl2');

  if (reasons.length > 0) return { tier: 'static', reasons };

  // Soft signals: these cap the ENTRY tier at `lite` but never force `static`,
  // because a low core count on a modern phone is not the same as incapable.
  const cores = win.navigator.hardwareConcurrency;
  const mem = (win.navigator as { deviceMemory?: number }).deviceMemory;
  if (typeof cores === 'number' && cores > 0 && cores <= 4) reasons.push(`cores=${cores}`);
  if (typeof mem === 'number' && mem > 0 && mem <= 4) reasons.push(`deviceMemory=${mem}`);

  return { tier: reasons.length > 0 ? 'lite' : 'full', reasons };
}

function hasWebGL2(win: Window): boolean {
  try {
    const c = win.document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    // Release immediately — a probe must not hold a live context, since
    // browsers cap simultaneous contexts per page (scene-spec §5).
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Forced tier — required so visual snapshots stay deterministic        */
/* ------------------------------------------------------------------ */

/**
 * `?tier=lite` pins the tier and disables the probe.
 *
 * motion-tiers-spec.md §6: the probe makes the RENDER adaptive while emitted
 * code stays identical. Without a way to pin it, word-quality-gate §1 checks 3,
 * 6 and 7 (visual snapshots) could not be deterministic.
 */
export function forcedTier(search: string = window.location.search): Tier | null {
  const v = new URLSearchParams(search).get('tier');
  return v === 'full' || v === 'lite' || v === 'static' ? v : null;
}

/* ------------------------------------------------------------------ */
/* The runtime probe                                                    */
/* ------------------------------------------------------------------ */

export interface ProbeConfig {
  /** Ignore the first N ms — load jank must not read as a slow device. */
  readonly settleMs: number;
  /** Rolling window of frame intervals used for each decision. */
  readonly windowSize: number;
  /** Minimum samples before ANY decision is allowed. */
  readonly minSamples: number;
  /** Downgrade if the p95 frame interval exceeds this (ms). */
  readonly downgradeMs: number;
  /** Consecutive failing windows required to act — this is the hysteresis. */
  readonly strikes: number;
}

export const DEFAULT_PROBE: ProbeConfig = {
  settleMs: 1200,
  windowSize: 90,
  minSamples: 60,
  // 60fps is 16.7ms. 33ms is two missed frames at 60Hz, i.e. sustained 30fps.
  // VERIFICATION §2 records p5 FPS; p95 INTERVAL is the same statistic seen
  // from the other side, and interval is what a frame loop can measure.
  downgradeMs: 33,
  strikes: 2,
};

export interface ProbeState {
  readonly tier: Tier;
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly settled: boolean;
  readonly ratchetedAt: number | null;
}

/**
 * A one-way ratchet. The tier may only ever move DOWN.
 *
 * motion-tiers-spec.md §3: allowing upgrades produces oscillation, because the
 * device that just failed at `full` will pass at `lite` and be promoted back
 * into failing. A visitor seeing quality flicker is worse served than one on a
 * slightly-too-low tier.
 */
export class TierProbe {
  private intervals: number[] = [];
  private last = 0;
  private startedAt = 0;
  private strikes = 0;
  private current: Tier;
  private ratchetedAt: number | null = null;
  private readonly cfg: ProbeConfig;
  private readonly onChange: (t: Tier, why: string) => void;

  constructor(entry: Tier, onChange: (t: Tier, why: string) => void, cfg = DEFAULT_PROBE) {
    this.current = entry;
    this.onChange = onChange;
    this.cfg = cfg;
  }

  /** Call once per frame with the timestamp. */
  sample(nowMs: number): void {
    if (this.startedAt === 0) {
      this.startedAt = nowMs;
      this.last = nowMs;
      return;
    }
    const dt = nowMs - this.last;
    this.last = nowMs;

    // Still settling: measure nothing. Load jank is not device capability.
    if (nowMs - this.startedAt < this.cfg.settleMs) return;

    // A tab that was backgrounded produces one enormous interval. That is not
    // a slow device, so discard rather than let it trip the ratchet.
    if (dt > 1000) return;

    this.intervals.push(dt);
    if (this.intervals.length > this.cfg.windowSize) this.intervals.shift();
    if (this.intervals.length < this.cfg.minSamples) return;
    if (this.current === 'static') return; // floor: nothing left to drop

    if (this.percentile(95) > this.cfg.downgradeMs) {
      this.strikes++;
      if (this.strikes >= this.cfg.strikes) this.downgrade();
    } else {
      this.strikes = 0; // recovery clears strikes, but never promotes
    }
  }

  private downgrade(): void {
    const i = TIER_ORDER.indexOf(this.current);
    if (i < 0 || i >= TIER_ORDER.length - 1) return;
    const next = TIER_ORDER[i + 1];
    const why = `p95 ${this.percentile(95).toFixed(1)}ms > ${this.cfg.downgradeMs}ms for ${this.cfg.strikes} windows`;
    this.current = next;
    this.ratchetedAt = this.last;
    this.strikes = 0;
    this.intervals = []; // re-measure the new tier from scratch
    this.onChange(next, why);
  }

  private percentile(p: number): number {
    if (this.intervals.length === 0) return 0;
    const s = [...this.intervals].sort((a, b) => a - b);
    const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
    return s[idx];
  }

  get state(): ProbeState {
    return {
      tier: this.current,
      samples: this.intervals.length,
      p50: this.percentile(50),
      p95: this.percentile(95),
      settled: this.startedAt > 0 && this.last - this.startedAt >= this.cfg.settleMs,
      ratchetedAt: this.ratchetedAt,
    };
  }
}
