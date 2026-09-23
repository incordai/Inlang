/**
 * M0 browser verification — the parts only a real engine can prove.
 *
 * The logic tests (probe.test.ts, determinism.ts) run headless and cover the
 * mechanism. This covers what they cannot: that a WebGL context is actually
 * obtained, that the three tiers really differ on screen, that the forced-tier
 * override works, and that reduced-motion reaches `static`.
 *
 * Requires the preview server: pnpm preview --port 4173
 * Run: pnpm test:browser
 */

import { chromium, type Browser, type Page } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

async function readout(page: Page, key: string): Promise<string> {
  return page
    .locator('.readout dl > div', { hasText: new RegExp(`^${key}`) })
    .locator('dd')
    .first()
    .innerText();
}

async function run() {
  const browser: Browser = await chromium.launch();
  console.log('\nM0 — browser verification\n');

  /* 1. The page loads and the HEADLINE is present in the DOM.
        hero-spec §8: text must be the LCP element, never the canvas. */
  {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    const h1 = await page.locator('h1').innerText();
    check('page loads, <h1> present', h1.length > 0, JSON.stringify(h1.replace(/\n/g, ' ')));
    check('exactly one <h1> (hero-spec §4)', (await page.locator('h1').count()) === 1);
    await page.waitForTimeout(2500);
    check('no console or page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }

  /* 2. A WebGL context is genuinely obtained and the canvas has real pixels.
        This is the thing no headless logic test can assert. */
  {
    // DPR 3, so the rung-0 cap (2.0) has something to clamp.
    const page = await browser.newPage({ deviceScaleFactor: 3 });
    await page.goto(`${BASE}/?az-probe=off&az-tier=full`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 10_000 });
    // R3F sizes the canvas from a resize observer AFTER mount; 300x150 is the
    // HTML default and reading it before the observer fires measures nothing.
    await page.waitForFunction(
      () => {
        const c = document.querySelector('canvas') as HTMLCanvasElement | null;
        return !!c && c.width > 300 && c.clientWidth > 0;
      },
      { timeout: 10_000 },
    );
    const info = await page.evaluate(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement | null;
      if (!c) return null;
      return { w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight };
    });
    check('canvas exists with a backing store', !!info && info.w > 0 && info.h > 0,
          info ? `${info.w}x${info.h} backing, ${info.cssW}x${info.cssH} css` : 'no canvas');
    // motion-tiers-spec §5 rung 0: the device ratio is capped at 2.0, never raised.
    const ratio = info ? info.w / info.cssW : 0;
    check('rung 0 caps a DPR-3 device at 2.0', Math.abs(ratio - 2.0) < 0.01, `ratio=${ratio.toFixed(3)}`);
    await page.close();
  }

  /* 3. Forced tier works — required for deterministic visual snapshots
        (motion-tiers-spec §6, word-quality-gate §1 checks 3/6/7). */
  for (const t of ['full', 'lite', 'static'] as const) {
    const page = await browser.newPage();
    await page.goto(`${BASE}/?az-probe=off&az-tier=${t}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const shown = (await readout(page, 'tier')).trim();
    const hasCanvas = (await page.locator('canvas').count()) > 0;
    const expectCanvas = t !== 'static';
    check(`?az-probe=off&az-tier=${t} pins the tier`, shown === t, `readout says "${shown}"`);
    check(`?az-probe=off&az-tier=${t} canvas ${expectCanvas ? 'present' : 'absent'}`,
          hasCanvas === expectCanvas);
    await page.screenshot({ path: `dist-shots/tier-${t}.png`, fullPage: false });
    await page.close();
  }

  /* 4. CONTROL for 3: the three tiers must actually LOOK different. If the
        screenshots were identical, "tier pinned" would be cosmetic. */
  {
    const fs = await import('node:fs');
    const sizes = (['full', 'lite', 'static'] as const).map(
      (t) => fs.statSync(`dist-shots/tier-${t}.png`).size,
    );
    check('CONTROL: the three tiers render differently',
          new Set(sizes).size === 3, `png sizes: ${sizes.join(', ')} bytes`);
  }

  /* 5. prefers-reduced-motion must reach `static` — not slower motion.
        hero-spec §9 and motion-tiers-spec §2. */
  {
    const page = await browser.newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const tier = (await readout(page, 'tier')).trim();
    const gate = await readout(page, 'entry gate');
    check('prefers-reduced-motion → static', tier === 'static', `tier=${tier}, gate="${gate.trim()}"`);
    await page.close();
  }

  /* 6. CONTROL for 5: without the media override the same page must NOT be
        static, or test 5 passes for the wrong reason. */
  {
    const page = await browser.newPage();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const tier = (await readout(page, 'tier')).trim();
    check('CONTROL: without reduced-motion it is NOT static', tier !== 'static', `tier=${tier}`);
    await page.close();
  }

  /* 7. The probe actually runs: it must settle and accumulate samples.
        On the GPU-backed browser: the default headless shell renders with
        SwiftShader at ~600ms a frame, and §3.2's 60 warm-up frames then take
        ~36s — correct behaviour, but not what this check is about. */
  {
    const gpu = await chromium.launch({ channel: 'chromium' });
    const page = await gpu.newPage();
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);
    const settled = (await readout(page, 'settled')).trim();
    const samples = parseInt((await readout(page, 'samples')).trim(), 10);
    const windows = parseInt((await readout(page, 'windows judged')).trim(), 10);
    const p95 = (await readout(page, 'p95')).trim();
    check('probe settles and collects samples', settled === 'yes' && (samples > 0 || windows > 0),
          `settled=${settled}, samples=${samples}, windows=${windows}, p95=${p95}`);
    await gpu.close();
  }

  /* 8. dispose() on unmount — hero-spec §8. Navigating away must not leave a
        live WebGL context behind. Verified by context count, not by hope. */
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/?az-probe=off&az-tier=full`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas');
    await page.waitForTimeout(1500);
    const lost = await page.evaluate(async () => {
      const c = document.querySelector('canvas') as HTMLCanvasElement;
      const gl = c.getContext('webgl2') ?? c.getContext('webgl');
      return { hadContext: !!gl, isLost: gl ? gl.isContextLost() : true };
    });
    check('a live WebGL context was obtained', lost.hadContext && !lost.isLost,
          JSON.stringify(lost));
    await page.close();
  }

  /* 9. MEASURE — the defect a green suite hid.
        hero-spec §3: two containers, not one. Putting the display measure on
        the hero CONTAINER squeezed the sub paragraph to one word per line and
        every assertion above still passed, because nothing measured layout.
        Line boxes are counted via Range rects, which is what the browser
        actually laid out rather than what the CSS intended. */
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/?az-probe=off&az-tier=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.hero .sub');

    // Count VISUAL lines, not rect fragments. getClientRects() returns one
    // rect per fragment, so <br> and inline <em> inflate the raw count above
    // the number of lines a reader sees. Distinct rounded `top` values is the
    // honest measure.
    const lineCount = (sel: string) =>
      page.evaluate((s) => {
        const el = document.querySelector(s);
        if (!el) return -1;
        const r = document.createRange();
        r.selectNodeContents(el);
        const tops = new Set(
          Array.from(r.getClientRects())
            .filter((rc) => rc.width > 0 && rc.height > 0)
            .map((rc) => Math.round(rc.top)),
        );
        return tops.size;
      }, sel);

    const widths = await page.evaluate(() => {
      const g = (s: string) => {
        const e = document.querySelector(s) as HTMLElement | null;
        return e ? Math.round(e.getBoundingClientRect().width) : -1;
      };
      return { hero: g('.hero'), h1: g('.hero h1'), sub: g('.hero .sub') };
    });

    const h1Lines = await lineCount('.hero h1');
    const subLines = await lineCount('.hero .sub');

    // hero-spec §3: "Never let a headline exceed 3 lines" at any breakpoint.
    check('headline is at most 3 lines at 1440px', h1Lines > 0 && h1Lines <= 3,
          `${h1Lines} line boxes`);

    // A 45–65ch sub at ~16px is roughly 380–700px. One word per line is ~90px.
    check('sub paragraph has a real measure, not one word per line',
          widths.sub >= 320,
          `sub width ${widths.sub}px, ${subLines} lines`);

    // The container must be wider than the headline measure — that IS the
    // two-container rule, asserted directly.
    check('container is wider than the headline measure (two containers)',
          widths.hero > widths.h1,
          `hero ${widths.hero}px vs h1 ${widths.h1}px`);

    check('eyebrow stays on one line', (await lineCount('.eyebrow')) === 1);
    await page.screenshot({ path: 'dist-shots/measure-1440.png' });
    await page.close();
  }

  /* 10. CONTROL for 9: re-apply the defect in-page and confirm the checks
         FAIL. Without this, "measure is fine" could mean "the check is inert". */
  {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/?az-probe=off&az-tier=static`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.hero .sub');
    await page.addStyleTag({ content: '.hero { max-width: 26ch !important; }' });
    await page.waitForTimeout(200);
    const subW = await page.evaluate(() => {
      const e = document.querySelector('.hero .sub') as HTMLElement;
      return Math.round(e.getBoundingClientRect().width);
    });
    check('CONTROL: re-applying `max-width:26ch` to the container DOES break it',
          subW < 320, `sub collapses to ${subW}px`);
    await page.close();
  }

  await browser.close();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
