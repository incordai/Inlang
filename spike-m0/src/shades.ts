/**
 * Shade ramps — every step available as an option, contrast-checked.
 *
 * A reference generator produced an 8-step ramp running ONE direction only
 * (base toward white). That is why it scored 0/10 on AA: light tints on light
 * ground have nowhere to go. A usable ramp runs both ways from the base, and
 * every step must state its contrast against the surfaces it can land on
 * (theme-spec §6 holds a 4.5:1 body floor, 3:1 for large text).
 *
 * Colours are computed in OKLCH so the steps are perceptually even. Raw values
 * are legal HERE — this is the theme layer. CONVENTIONS §4 bans them under
 * `words/` and `target-*`, which read tokens only.
 */

export const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export type Step = (typeof STEPS)[number];

export interface Oklch { l: number; c: number; h: number }

/* ---------------- colour conversion (sRGB <-> OKLCH) ---------------- */

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function oklchToRgb({ l, c, h }: Oklch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;

  const L = l_ * l_ * l_;
  const M = m_ * m_ * m_;
  const S = s_ * s_ * s_;

  const lin = [
    +4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S,
  ];

  return lin.map((v) => {
    const s = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(clamp01(v), 1 / 2.4) - 0.055;
    return Math.round(clamp01(s) * 255);
  }) as [number, number, number];
}

export const toHex = (rgb: [number, number, number]) =>
  '#' + rgb.map((n) => n.toString(16).padStart(2, '0')).join('');

/* ---------------- contrast ---------------- */

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG contrast ratio, TRUNCATED — a printed 4.50 is genuinely at the floor. */
export function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return Math.floor(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

/* ---------------- the ramp ---------------- */

/**
 * Lightness per step. Fixed rather than derived from the base, so every ramp
 * in the system lands on the same lightness ladder and a step number means the
 * same thing whatever the hue — which is what makes `accent.700` swappable.
 */
const LIGHTNESS: Record<Step, number> = {
  50: 0.971, 100: 0.936, 200: 0.885, 300: 0.808, 400: 0.704,
  500: 0.606, 600: 0.523, 700: 0.448, 800: 0.379, 900: 0.312, 950: 0.221,
};

/** Chroma tapers at both ends — full-chroma near-white or near-black is muddy. */
const CHROMA_SCALE: Record<Step, number> = {
  50: 0.18, 100: 0.32, 200: 0.55, 300: 0.78, 400: 0.94,
  500: 1.0, 600: 0.98, 700: 0.9, 800: 0.78, 900: 0.64, 950: 0.48,
};

export interface Shade {
  readonly step: Step;
  readonly oklch: Oklch;
  readonly hex: string;
  readonly rgb: [number, number, number];
}

/** Build the full ramp for a hue. `chroma` is the peak, at step 500. */
export function ramp(hue: number, chroma = 0.16): Shade[] {
  return STEPS.map((step) => {
    const oklch = { l: LIGHTNESS[step], c: chroma * CHROMA_SCALE[step], h: hue };
    const rgb = oklchToRgb(oklch);
    return { step, oklch, hex: toHex(rgb), rgb };
  });
}

/** Which steps clear a contrast floor against a given background. */
export function usableOn(
  shades: Shade[],
  background: [number, number, number],
  floor = 4.5,
): Shade[] {
  return shades.filter((s) => contrast(s.rgb, background) >= floor);
}
