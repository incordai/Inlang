/**
 * The 3D layer must fade out as the reader leaves the hero.
 * Run: pnpm test:fade
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
let failures = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${BASE}/?az-probe=off&az-tier=full`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('canvas');
await page.waitForTimeout(1200);

const opacityAt = async (y: number) => {
  await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.waitForTimeout(320);
  return page.evaluate(() => {
    const el = document.querySelector('.stage') as HTMLElement;
    return parseFloat(getComputedStyle(el).opacity);
  });
};

console.log('\n3D layer fade on scroll\n');

const top = await opacityAt(0);
const quarter = await opacityAt(225);
const oneVh = await opacityAt(900);
const far = await opacityAt(1800);

check('fully visible at the top', top === 1, `opacity ${top}`);
check('untouched while the hero is still the focus', quarter === 1, `opacity ${quarter}`);
check('faded out by one viewport down', far < 0.02, `opacity ${far}`);
check('fade is monotonic, never brightens on the way down',
      top >= quarter && quarter >= oneVh && oneVh >= far,
      `${top} >= ${quarter} >= ${oneVh} >= ${far}`);
// CONTROL: the values must actually differ, or "monotonic" is trivially true
// for a property that never changes at all.
check('CONTROL: opacity genuinely changes across the scroll',
      top - far > 0.9, `delta ${(top - far).toFixed(3)}`);

// LEGIBILITY: the 3D layer must be effectively gone by the time the next
// section reaches reading position, or the vines cross its text mid-fade.
// hero-spec §8 forbids live text over a moving scene without a scrim, and the
// scrim only covers the hero's copy.
const readoutTop = await page.evaluate(() => {
  const e = document.querySelector('.readout') as HTMLElement;
  return e.getBoundingClientRect().top + window.scrollY;
});
// The criterion is "the hero has fully scrolled past", not "the next section
// is halfway up". At mid-viewport the readout still SHARES the screen with the
// hero, and the layer legitimately belongs to the hero while it is visible.
const atReading = await opacityAt(readoutTop);
check('3D layer is gone once the hero has fully scrolled past',
      atReading < 0.05, `opacity ${atReading} when .readout reaches the viewport top`);

// Scrolling back up restores it — a one-way fade would strand the hero blank.
const back = await opacityAt(0);
check('returns to full when scrolled back to the top', back === 1, `opacity ${back}`);

await browser.close();
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
