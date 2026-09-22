/**
 * Capture the FRAME matrix — site width x hero width, the two independent axes.
 *
 * One browser, one page per combination, desktop only. Launching a browser per
 * combination and shooting three viewports each starved the preview server and
 * produced canvas-visibility timeouts that looked like layout bugs.
 *
 * Run: pnpm matrix
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173';

const COMBOS = (process.env.MATRIX_PATTERNS
  ? ['none', 'glow', 'spotlight', 'ramp', 'grid', 'hatch', 'dots'].map((pattern) => ({
      site: 'center', hero: 'bleed', pattern,
    }))
  : [
      { site: 'full',   hero: 'bleed',     pattern: 'glow' },
      { site: 'gap',    hero: 'bleed',     pattern: 'glow' },
      { site: 'center', hero: 'bleed',     pattern: 'glow' },
      { site: 'center', hero: 'container', pattern: 'glow' },
    ]);

const browser = await chromium.launch();

for (const c of COMBOS) {
  const page = await browser.newPage();
  // 1920 so `center` actually caps — at 1440 it and `gap` are the same width
  // and only the gutter differs, which hides the distinction being captured.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${BASE}/?tier=full&site=${c.site}&hero=${c.hero}&pattern=${c.pattern}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('canvas', { state: 'attached', timeout: 30_000 });
  await page.waitForTimeout(3000);

  const measured = await page.evaluate(() => {
    const g = (s: string) => {
      const e = document.querySelector(s) as HTMLElement | null;
      return e ? Math.round(e.getBoundingClientRect().width) : -1;
    };
    const el = document.querySelector('.readout') as HTMLElement;
    const pad = Math.round(parseFloat(getComputedStyle(el).paddingLeft));
    const left = Math.round(el.getBoundingClientRect().left);
    return { hero: g('.hero'), shell: g('.readout'), pad, left };
  });

  const name = process.env.MATRIX_PATTERNS ? `pattern-${c.pattern}` : `frame-${c.site}-${c.hero}`;
  await page.screenshot({ path: `dist-shots/${name}.png` });
  console.log(
    `${name.padEnd(24)} shell ${String(measured.shell).padStart(4)}px  ` +
    `gutter ${String(measured.pad).padStart(2)}px  ` +
    `offset ${String(measured.left).padStart(3)}px  hero ${String(measured.hero).padStart(4)}px`);
  await page.close();
}

await browser.close();
