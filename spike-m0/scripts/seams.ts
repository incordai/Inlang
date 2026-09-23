/**
 * Seam detector.
 *
 * Finds horizontal and vertical luminance DISCONTINUITIES across the rendered
 * page — the visible "division lines" between sections and the hard edge of a
 * scrim whose gradient does not reach transparent before its element ends.
 *
 * Instrumenting rather than eyeballing: a seam is a row (or column) whose mean
 * luminance jumps sharply against its neighbour ACROSS A WIDE SPAN. A local
 * edge (text, the 3D object) moves few pixels; a seam moves most of the row.
 *
 * Run: pnpm seams
 */

import { chromium } from 'playwright';
import { PNG } from 'pngjs';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const WIDTH = 1440;
const HEIGHT = 900;
/**
 * Threshold is CALIBRATED against the image's own noise floor, not fixed.
 *
 * The page carries an feTurbulence grain overlay that moves every pixel by
 * +/-3 luminance. A fixed threshold of 1.6 counted that as a jump across most
 * of a column and reported a seam at x=1324 that pixel sampling showed did not
 * exist — the values there were identical within noise. A real seam had a mean
 * jump of 12-15; the grain floor is ~1.8. Measuring against the MEDIAN line
 * jump separates the two with room to spare, and keeps working if the grain
 * strength changes.
 */
const NOISE_MULTIPLE = Number(process.env.NOISE_MULTIPLE ?? 4);
/** A seam must also span this fraction of the line, or it is a local edge. */
const SPAN = Number(process.env.SPAN ?? 0.55);

/**
 * TWO thresholds, and conflating them is a bug I shipped once already.
 *
 * SPAN counting asks "did this pixel move at all?", so it sits just above the
 * grain floor. The MEAN gate asks "did the whole line move meaningfully?", so
 * it sits well above. Raising the per-pixel threshold to the mean's level made
 * a wide, gentle background step stop counting toward the span, so it was
 * filtered out before the mean gate ever saw it — and the detector reported a
 * known-bad page as clean.
 */
let LUMA_JUMP = 1.6;   // per-pixel, span counting
let MEAN_GATE = 5.9;   // per-line, seam confirmation

const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: WIDTH, height: HEIGHT });
await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(`${BASE}/?az-probe=off&az-tier=static`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

/**
 * Scan at SEVERAL scroll positions, not just the top.
 *
 * Scanning only the initial viewport missed a hard-edged panel entirely,
 * because at scroll 0 it sits below the fold. A seam that only appears once
 * the reader scrolls is still a seam.
 */
const SCROLLS = [0, 0.5, 1.0];
const shots: Array<{ at: number; buf: Buffer }> = [];
for (const frac of SCROLLS) {
  await page.evaluate((f) => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, max * f);
  }, frac);
  await page.waitForTimeout(500);
  shots.push({ at: frac, buf: await page.screenshot() });
}
await browser.close();

let totalSeams = 0;
for (const shot of shots) {
const png = PNG.sync.read(shot.buf);
const { width: W, height: H, data } = png;
const at = (x: number, y: number) => {
  const i = (y * W + x) << 2;
  return luma(data[i], data[i + 1], data[i + 2]);
};

console.log(`\nSeam scan — ${W}x${H}, jump>${LUMA_JUMP} across >${SPAN * 100}% of the line\n`);

function scanRows() {
  const hits: Array<{ y: number; frac: number; mean: number }> = [];
  for (let y = 1; y < H; y++) {
    let moved = 0, sum = 0;
    for (let x = 0; x < W; x++) {
      const d = Math.abs(at(x, y) - at(x, y - 1));
      sum += d;
      if (d > LUMA_JUMP) moved++;
    }
    const frac = moved / W;
    if (frac > SPAN) hits.push({ y, frac, mean: sum / W });
  }
  return hits;
}

function scanCols() {
  const hits: Array<{ x: number; frac: number; mean: number }> = [];
  for (let x = 1; x < W; x++) {
    let moved = 0, sum = 0;
    for (let y = 0; y < H; y++) {
      const d = Math.abs(at(x, y) - at(x - 1, y));
      sum += d;
      if (d > LUMA_JUMP) moved++;
    }
    const frac = moved / H;
    if (frac > SPAN) hits.push({ x, frac, mean: sum / H });
  }
  return hits;
}

/** Median mean-jump across every line — the image's own noise floor. */
function calibrate(): number {
  const means: number[] = [];
  for (let y = 1; y < H; y++) {
    let sum = 0;
    for (let x = 0; x < W; x++) sum += Math.abs(at(x, y) - at(x, y - 1));
    means.push(sum / W);
  }
  means.sort((a, b) => a - b);
  return means[Math.floor(means.length / 2)];
}

const floor = calibrate();
LUMA_JUMP = floor * 1.25;
MEAN_GATE = floor * NOISE_MULTIPLE;
console.log(`noise floor ${floor.toFixed(2)} -> span delta ${LUMA_JUMP.toFixed(2)}, mean gate ${MEAN_GATE.toFixed(2)}
`);

const rows = scanRows().filter((r) => r.mean > MEAN_GATE);
const cols = scanCols().filter((c) => c.mean > MEAN_GATE);

console.log(`horizontal seams: ${rows.length}`);
for (const r of rows.slice(0, 12)) {
  console.log(`  y=${String(r.y).padStart(4)}  ${(r.frac * 100).toFixed(0)}% of row  mean jump ${r.mean.toFixed(2)}`);
}
console.log(`vertical seams:   ${cols.length}`);
for (const c of cols.slice(0, 12)) {
  // Localise: which y-range actually jumps, so the culprit element is named
  // rather than guessed.
  let lo = -1, hi = -1;
  for (let y = 0; y < H; y++) {
    if (Math.abs(at(c.x, y) - at(c.x - 1, y)) > LUMA_JUMP) { if (lo < 0) lo = y; hi = y; }
  }
  console.log(`  x=${String(c.x).padStart(4)}  ${(c.frac * 100).toFixed(0)}% of col  mean jump ${c.mean.toFixed(2)}  y-range ${lo}..${hi}`);
}

totalSeams += rows.length + cols.length;
}

console.log('');
if (totalSeams === 0) {
  console.log('CLEAN - no full-width seams at any scroll position');
} else {
  console.log(totalSeams + ' seam line(s) found');
}
console.log('');
process.exitCode = totalSeams === 0 ? 0 : 1;
