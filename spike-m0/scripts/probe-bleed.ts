import { chromium } from 'playwright';
const b = await chromium.launch();
for (const q of ['az-probe=off&az-tier=full&site=wide&hero=bleed', 'az-probe=off&az-tier=full&site=narrow&hero=container']) {
  const p = await b.newPage();
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.goto(`http://127.0.0.1:4173/?${q}`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);
  const info = await p.evaluate(() => {
    const c = document.querySelector('canvas') as HTMLElement | null;
    const stage = document.querySelector('.stage') as HTMLElement | null;
    const hero = document.querySelector('.hero') as HTMLElement | null;
    const cs = getComputedStyle(document.documentElement);
    const box = (e: HTMLElement | null) => e ? { w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) } : null;
    return {
      canvas: box(c), stage: box(stage), hero: box(hero),
      heroMax: cs.getPropertyValue('--hero-max').trim(),
      siteMax: cs.getPropertyValue('--site-max').trim(),
      stageOpacity: stage ? getComputedStyle(stage).opacity : 'n/a',
      docScrollW: document.documentElement.scrollWidth,
    };
  });
  console.log(q, '\n ', JSON.stringify(info));
  await p.close();
}
await b.close();
