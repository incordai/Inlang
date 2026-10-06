/**
 * Run by data-images.test.ts in a fresh process, so its RSS is this run's
 * alone: N large JPEGs stored at once, through the module's queue
 * (`queue`) or straight through the same pipeline all together
 * (`unbounded`, the CONTROL). Prints { baseMb, peakMb, ms } as JSON. Test-only.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createImages, IMAGE_LIMITS } from '../src/server/data-images.ts';
import { plainJpeg } from './image-fixtures.ts';

const [mode, count, width, height] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5])];
const dir = mkdtempSync(join(tmpdir(), 'az-images-mem-'));
const images = await createImages({ dir });
const big = await plainJpeg(width, height);
const temps = Array.from({ length: count }, () => {
  const t = images.tempPath();
  writeFileSync(t, big);
  return t;
});
await new Promise((r) => setTimeout(r, 200));
const base = process.memoryUsage().rss;
let peak = base;
const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
const t0 = performance.now();
if (mode === 'queue') {
  await Promise.all(temps.map((t) => images.store(t)));
} else {
  const input = { limitInputPixels: IMAGE_LIMITS.maxPixels, failOn: 'error' as const, sequentialRead: true };
  await Promise.all(temps.map((t, i) => sharp(t, input).autoOrient()
    .resize({ width: IMAGE_LIMITS.storedMax, height: IMAGE_LIMITS.storedMax, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: IMAGE_LIMITS.quality }).toFile(join(dir, `control-${i}.webp`))));
}
clearInterval(timer);
peak = Math.max(peak, process.memoryUsage().rss);
const mb = (b: number) => Math.round(b / 1024 / 1024);
process.stdout.write(`${JSON.stringify({ baseMb: mb(base), peakMb: mb(peak), ms: Math.round(performance.now() - t0) })}\n`);
