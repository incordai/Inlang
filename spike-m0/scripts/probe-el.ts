import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
await p.setViewportSize({ width: 1440, height: 900 });
await p.emulateMedia({ colorScheme: 'dark' });
await p.goto('http://localhost:4173/?az-probe=off&az-tier=static', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(800);
const info = await p.evaluate(() => {
  const out: Record<string, unknown> = {};
  for (const sel of ['.hero', '.readout', '.stage', '.scrim', '.scroll-space', 'body', '.readout h2', '.readout dl']) {
    const e = document.querySelector(sel) as HTMLElement | null;
    if (e) { const r = e.getBoundingClientRect(); out[sel] = { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; }
  }
  const hb = getComputedStyle(document.querySelector('.hero')!, '::before');
  out['hero::before'] = { inset: hb.inset, bg: hb.backgroundImage.slice(0, 90) };
  const ro = getComputedStyle(document.querySelector('.readout')!);
  out['readout style'] = { border: ro.borderTopWidth + ' ' + ro.borderTopColor, bg: ro.backgroundColor, filter: ro.backdropFilter };
  return out;
});
console.log(JSON.stringify(info, null, 2));
await b.close();
