import { chromium } from 'playwright';
const b = await chromium.launch();
for (const site of ['full', 'wide', 'narrow']) {
  const p = await b.newPage();
  await p.setViewportSize({ width: 1440, height: 900 });
  await p.goto(`http://127.0.0.1:4173/?az-probe=off&az-tier=static&site=${site}`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.readout');
  const r = await p.evaluate(() => {
    const e = document.querySelector('.readout') as HTMLElement;
    const cs = getComputedStyle(e);
    const box = e.getBoundingClientRect();
    return { width: Math.round(box.width), left: Math.round(box.left),
             padL: cs.paddingLeft, maxW: cs.maxWidth };
  });
  console.log(`site=${site.padEnd(7)} width ${String(r.width).padStart(4)}  left ${String(r.left).padStart(3)}  padding-inline ${r.padL}  max-width ${r.maxW}`);
  await p.close();
}
await b.close();
