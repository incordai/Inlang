/**
 * Capture review screenshots across viewports and scroll positions.
 * Requires the preview server: pnpm preview --port 4173
 * Run: pnpm shoot
 *
 * A FRESH PAGE per viewport. Reusing one page and re-navigating after scrolling
 * it to the bottom made the second `goto` hang until timeout — and it leaks
 * scroll position and the --stage-opacity custom property between captures,
 * so a later shot could inherit an earlier one's fade state.
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173';

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 1024, height: 768 },   // 4:3 — where it used to crop
  { name: 'phone', width: 390, height: 844 },     // portrait — restack case
];

const browser = await chromium.launch();

for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: vp.width, height: vp.height });
  await page.emulateMedia({ colorScheme: 'dark' });
  const q = process.env.SHOOT_QUERY ?? 'az-probe=off&az-tier=full';
  await page.goto(`${BASE}/?${q}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 15_000 });
  await page.waitForTimeout(3200);               // let growth settle past t=0
  await page.screenshot({ path: `dist-shots/${process.env.SHOOT_PREFIX ?? 'vp'}-${vp.name}.png` });

  // Mid-fade: proves the 3D layer dissolves rather than cutting.
  await page.evaluate(() => window.scrollTo(0, window.innerHeight * 0.72));
  await page.waitForTimeout(1400);
  await page.screenshot({ path: `dist-shots/${process.env.SHOOT_PREFIX ?? 'vp'}-${vp.name}-fading.png` });

  // Scroll end: growth complete, 3D layer gone.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `dist-shots/${process.env.SHOOT_PREFIX ?? 'vp'}-${vp.name}-end.png` });

  await page.close();
  console.log(`captured ${vp.name}`);
}

await browser.close();
