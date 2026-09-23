import { chromium } from 'playwright';
import { PNG } from 'pngjs';
const b = await chromium.launch();
const p = await b.newPage();
await p.setViewportSize({ width: 1440, height: 900 });
await p.emulateMedia({ colorScheme: 'dark' });
await p.goto('http://localhost:4173/?az-probe=off&az-tier=static', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(800);
const png = PNG.sync.read(await p.screenshot());
await b.close();
const px = (x: number, y: number) => { const i = (y * png.width + x) << 2; return [png.data[i], png.data[i+1], png.data[i+2]]; };
for (const y of [120, 450, 800]) {
  const row = [];
  for (let x = 1318; x <= 1332; x++) row.push(px(x, y).join(','));
  console.log(`y=${y}: ${row.join('  ')}`);
}
