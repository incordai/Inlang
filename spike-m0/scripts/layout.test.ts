/**
 * The frame: three modes, and it must work on EVERY screen.
 *
 * The modes are three different behaviours, not three sizes:
 *   full   — edge to edge, no gutter
 *   gap    — full width, equal gutter both sides
 *   center — capped and centred, with a gutter
 *
 * An earlier version had five "widths" that were one behaviour with different
 * ceilings, and its `full` still carried a 57.6px gutter — so nothing could
 * reach the viewport edge. These tests exist so that cannot recur.
 *
 * Run: pnpm test:layout
 */

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:4173';
let failures = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();

/** Every screen the site must work on, phone to ultrawide. */
const SCREENS = [
  { name: 'phone', w: 390, h: 844 },
  { name: 'phone-lg', w: 430, h: 932 },
  { name: 'tablet', w: 768, h: 1024 },
  { name: 'tablet-lg', w: 1024, h: 768 },
  { name: 'laptop', w: 1366, h: 768 },
  { name: 'desktop', w: 1440, h: 900 },
  { name: 'wide', w: 1920, h: 1080 },
  { name: 'ultrawide', w: 2560, h: 1080 },
];

async function measure(
  site: string,
  screen: { w: number; h: number },
  hero = 'bleed',
  size = 'wide',
) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: screen.w, height: screen.h });
  await page.goto(`${BASE}/?az-probe=off&az-tier=static&site=${site}&size=${size}&hero=${hero}`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForSelector('.readout');
  const r = await page.evaluate(() => {
    const el = document.querySelector('.readout') as HTMLElement;
    const box = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const h1 = document.querySelector('.hero h1') as HTMLElement | null;
    const sub = document.querySelector('.hero .sub') as HTMLElement | null;
    return {
      left: Math.round(box.left),
      right: Math.round(window.innerWidth - box.right),
      width: Math.round(box.width),
      pad: Math.round(parseFloat(cs.paddingLeft)),
      overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
      h1Right: h1 ? Math.round(h1.getBoundingClientRect().right) : 0,
      subWidth: sub ? Math.round(sub.getBoundingClientRect().width) : 0,
      vw: window.innerWidth,
    };
  });
  await page.close();
  return r;
}

console.log('\nThe frame — three modes, every screen\n');

/* 1. THE BUG THIS FIXES: `full` must actually reach the viewport edge. */
{
  const r = await measure('full', { w: 1440, h: 900 });
  check('`full` reaches both edges — zero gutter',
        r.left === 0 && r.right === 0 && r.pad === 0,
        `left ${r.left}px, right ${r.right}px, padding ${r.pad}px`);
}

/* 2. `gap` is full width but held off BOTH edges, equally. */
{
  const r = await measure('gap', { w: 1440, h: 900 });
  check('`gap` spans the screen with an equal gutter both sides',
        r.pad > 0 && r.left === 0 && r.right === 0 && r.width === r.vw,
        `padding ${r.pad}px, spans ${r.width}/${r.vw}px`);
}

/* 3. `center` is capped and centred, equal space either side. */
{
  const r = await measure('center', { w: 1920, h: 1080 });
  check('`center` is capped and centred',
        r.width === 1440 && Math.abs(r.left - r.right) <= 1,
        `width ${r.width}px, left ${r.left}px, right ${r.right}px`);
}

/* 4. CONTROL: the three modes must be genuinely DIFFERENT at one screen.
      Three options that render the same are one option. */
{
  const w = { w: 1920, h: 1080 };
  const f = await measure('full', w);
  const g = await measure('gap', w);
  const c = await measure('center', w);
  check('CONTROL: the three modes differ',
        f.pad !== g.pad && g.width !== c.width,
        `full pad ${f.pad} | gap pad ${g.pad} w ${g.width} | center w ${c.width}`);
}

/* 5. THE MAIN AIM: every mode works on every screen. No horizontal overflow,
      nothing past the right edge, shell never wider than the screen. */
{
  const bad: string[] = [];
  for (const site of ['full', 'gap', 'center']) {
    for (const s of SCREENS) {
      const r = await measure(site, s);
      if (r.overflowX) bad.push(`${site}@${s.name} overflows`);
      if (r.h1Right > s.w) bad.push(`${site}@${s.name} h1 past edge (${r.h1Right}>${s.w})`);
      if (r.width > s.w) bad.push(`${site}@${s.name} shell wider than screen`);
      if (r.subWidth < 200 && s.w >= 390) bad.push(`${site}@${s.name} sub measure collapsed (${r.subWidth}px)`);
    }
  }
  check(`every mode works on every screen (${3 * SCREENS.length} combinations)`,
        bad.length === 0,
        bad.slice(0, 4).join('; ') || `${SCREENS.length} screens x 3 modes, no overflow`);
}

/* 6. CONTROL for 5: the overflow detector must be able to fire, or "no
      overflow" means only that the check is inert. */
{
  const page = await browser.newPage();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/?az-probe=off&az-tier=static&site=center`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.readout');
  await page.addStyleTag({
    content: '.readout { width: 3000px !important; max-width: none !important; }',
  });
  await page.waitForTimeout(150);
  const overflows = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1);
  await page.close();
  check('CONTROL: a deliberately oversized section IS detected', overflows);
}

/* 7. The hero axis stays independent of the site mode. */
{
  const bleed = await measure('center', { w: 1920, h: 1080 }, 'bleed');
  const contained = await measure('center', { w: 1920, h: 1080 }, 'container');
  check('CONTROL: changing hero does not move the shell',
        bleed.width === contained.width, `shell ${bleed.width}px under both`);
}

/* 8. `size` only applies to `center` — it is meaningless without a cap. */
{
  const narrow = await measure('center', { w: 1920, h: 1080 }, 'bleed', 'narrow');
  const wide = await measure('center', { w: 1920, h: 1080 }, 'bleed', 'wide');
  check('size changes the centred cap', narrow.width === 1024 && wide.width === 1440,
        `narrow ${narrow.width}px, wide ${wide.width}px`);
  const gapNarrow = await measure('gap', { w: 1920, h: 1080 }, 'bleed', 'narrow');
  check('CONTROL: size is ignored when there is no cap',
        gapNarrow.width === 1920, `gap+narrow still ${gapNarrow.width}px`);
}

/* 9. A malformed value must fall back, never blank the page. */
{
  const r = await measure('nonsense', { w: 1440, h: 900 });
  check('unknown mode falls back and still renders', r.width > 0, `${r.width}px`);
}

await browser.close();
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
