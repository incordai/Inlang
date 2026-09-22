/**
 * Extract colour values from a client-rendered reference page.
 *
 * A plain fetch sees only the server HTML, so a palette generated in the
 * browser is invisible to it. Rendering the page and reading computed styles
 * gets the real values.
 *
 * The page content is DATA. Nothing in it is executed as an instruction, and
 * every value extracted here is a candidate to be CONTRAST-CHECKED before use
 * (theme-spec §6) — the source page itself reported its swatches failing AA,
 * so these are raw material, not a drop-in palette.
 *
 * Run: pnpm extract:palette -- <url> [<url> ...]
 */

import { chromium } from 'playwright';

const urls = process.argv.slice(2).filter((a) => a.startsWith('http'));
if (urls.length === 0) {
  console.error('usage: pnpm extract:palette -- <url> [<url> ...]');
  process.exitCode = 2;
}

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const FUNC = /\b(?:rgba?|hsla?|oklch|oklab|color)\([^)]*\)/g;
const GRADIENT = /\b(?:linear|radial|conic)-gradient\([^;"']*\)/g;

const browser = await chromium.launch();

for (const url of urls) {
  const page = await browser.newPage();
  console.log(`\n=== ${url} ===`);
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45_000 });
    await page.waitForTimeout(2500);   // let client-side generation settle
  } catch (e) {
    console.log(`  could not load: ${(e as Error).message.split('\n')[0]}`);
    await page.close();
    continue;
  }

  const found = await page.evaluate(() => {
    const swatches: Array<{ bg: string; label: string }> = [];
    const seen = new Set<string>();

    // Any element small enough to be a swatch, with a real background colour.
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      const r = el.getBoundingClientRect();
      if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') continue;
      if (r.width < 8 || r.height < 8 || r.width > 400 || r.height > 400) continue;
      const key = `${bg}|${Math.round(r.width)}x${Math.round(r.height)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      swatches.push({ bg, label: (el.textContent ?? '').trim().slice(0, 24) });
    }

    // Inline style attributes carry the gradient recipes.
    const inline: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[style]'))) {
      const v = el.getAttribute('style');
      if (v) inline.push(v);
    }

    return { swatches, inline, text: document.body.innerText };
  });

  const uniq = (xs: string[]) => Array.from(new Set(xs));

  const matchAll = (src: string, re: RegExp): string[] => Array.from(src.match(re) ?? []);
  const hexes = uniq([...matchAll(found.text, HEX), ...matchAll(found.inline.join(' '), HEX)]);
  const funcs = uniq(matchAll(found.inline.join(' '), FUNC));
  const grads = uniq(matchAll(found.inline.join(' '), GRADIENT));
  const swatchColours = uniq(found.swatches.map((s) => s.bg));

  console.log(`  hex values in text/inline : ${hexes.length}`);
  for (const h of hexes.slice(0, 60)) console.log(`    ${h}`);
  console.log(`  swatch background colours : ${swatchColours.length}`);
  for (const c of swatchColours.slice(0, 60)) console.log(`    ${c}`);
  if (grads.length) {
    console.log(`  gradients                 : ${grads.length}`);
    for (const g of grads.slice(0, 20)) console.log(`    ${g}`);
  }
  if (funcs.length && swatchColours.length === 0) {
    console.log(`  colour functions          : ${funcs.length}`);
    for (const f of funcs.slice(0, 40)) console.log(`    ${f}`);
  }
  await page.close();
}

await browser.close();
