/**
 * ROADMAP M0: "forced-tier override works; a snapshot pinned to `lite` is
 * reproducible" (motion-tiers-spec §6, §8.1).
 *
 * A page pinned to the `lite` tier (rung 6, static camera) is rendered in
 * three independent sessions — two fresh contexts in one browser, and a
 * third after relaunching the browser — and the screenshots must be byte
 * identical. The headless shell renders WebGL with SwiftShader, a CPU
 * rasteriser, which is what makes exact bytes a fair demand (a GPU driver
 * may differ run to run; CI never has one).
 *
 * Settings held fixed: viewport, device scale factor, colour scheme, reduced
 * motion, scroll position 0, fonts settled, the probe off (no rung change),
 * CSS animations disabled, the live readout panel masked (it prints timings).
 * `lite` has no scroll-linked camera, so with the page at rest nothing moves.
 *
 * CONTROLS: rung 4 (high LOD) renders different bytes, so equality is not
 * an artefact of a blank or constant canvas; `?az-tier=lite` and
 * `?az-rung=6` render the same bytes, so the override means the same rung.
 *
 * Starts `vite preview` on the built dist/ itself (run `pnpm build` first).
 * Run: pnpm test:snapshot
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium, type Browser } from 'playwright';

const PORT = 4179;
const BASE = `http://localhost:${PORT}`;
/** Every wait is bounded (project rule 13). */
const SERVER_READY_MS = 30_000;
const RUNG_READY_MS = 15_000;
/** Time for the demand-mode canvas to draw its final frame after the rung settles. */
const SETTLE_MS = 1_000;
const VIEWPORT = { width: 1280, height: 720 };

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

interface AzTier { rung: number; canvas: boolean; pixelRatio: number }

async function startPreview(): Promise<() => void> {
  const child = spawn(process.execPath,
    ['node_modules/vite/bin/vite.js', 'preview', '--port', String(PORT), '--strictPort'],
    { stdio: 'ignore' });
  const end = Date.now() + SERVER_READY_MS;
  for (;;) {
    try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
    if (Date.now() > end) { child.kill(); throw new Error(`preview did not start within ${SERVER_READY_MS}ms`); }
    await new Promise((r) => setTimeout(r, 200));
  }
  return () => child.kill();
}

/** One session: a fresh context, the page pinned, the canvas at rest, the PNG's hash. */
async function shot(browser: Browser, query: string, rung: number): Promise<string> {
  const context = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'no-preference',
  });
  try {
    const page = await context.newPage();
    await page.goto(`${BASE}/?${query}&az-probe=off`, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const end = Date.now() + RUNG_READY_MS;
    for (;;) {
      const t = await page.evaluate(() => (window as unknown as { __AZ_TIER__?: AzTier }).__AZ_TIER__);
      if (t && t.rung === rung && t.canvas && t.pixelRatio > 0) break;
      if (Date.now() > end) throw new Error(`rung ${rung} not reached for ?${query}: ${JSON.stringify(t)}`);
      await page.waitForTimeout(100);
    }
    await page.waitForTimeout(SETTLE_MS);
    const png = await page.screenshot({
      animations: 'disabled', caret: 'hide', mask: [page.locator('.readout')], timeout: RUNG_READY_MS,
    });
    return createHash('sha256').update(png).digest('hex').slice(0, 16);
  } finally {
    await context.close();
  }
}

console.log('\nM0 — a snapshot pinned to `lite` is reproducible\n');
const stop = await startPreview();
try {
  let browser = await chromium.launch();
  const a = await shot(browser, 'az-rung=6', 6);
  const b = await shot(browser, 'az-rung=6', 6);
  const viaTier = await shot(browser, 'az-tier=lite', 6);
  const control = await shot(browser, 'az-rung=4', 4);
  await browser.close();
  browser = await chromium.launch();          // a restart: nothing carried over
  const c = await shot(browser, 'az-rung=6', 6);
  await browser.close();

  check('lite (rung 6): two fresh contexts render identical bytes', a === b, `${a} · ${b}`);
  check('lite (rung 6): identical after a browser restart', a === c, `${a} · ${c}`);
  check('?az-tier=lite renders the same bytes as ?az-rung=6', a === viaTier, viaTier);
  check('CONTROL: rung 4 (high LOD) renders different bytes', control !== a, `${control} vs ${a}`);
} finally {
  stop();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
