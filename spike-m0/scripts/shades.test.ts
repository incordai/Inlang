/**
 * Shade ramps: every step is an option, and every step states its contrast.
 * Run: pnpm test:shades
 */

import { ramp, contrast, usableOn, toHex } from '../src/shades.ts';

let failures = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failures++;
};

console.log('\nShade ramps\n');

// The hues the spike offers as options.
const HUES = {
  violet: 292, indigo: 275, blue: 250, teal: 195,
  green: 148, lime: 122, amber: 75, orange: 48, rose: 15,
};

const DARK_BG: [number, number, number] = [20, 23, 15];    // --bg dark
const LIGHT_BG: [number, number, number] = [215, 219, 210]; // --bg light

/* 1. Every ramp is monotonic in lightness — a step number must mean the same
      thing across hues, or "accent.700" is not swappable. */
for (const [name, hue] of Object.entries(HUES)) {
  const r = ramp(hue);
  let mono = true;
  for (let i = 1; i < r.length; i++) if (r[i].oklch.l >= r[i - 1].oklch.l) mono = false;
  check(`${name} ramp is monotonic dark-ward`, mono);
}

/* 2. The ramp must span BOTH directions from mid — the failure of a
      tints-only generator, which is why such a palette cannot pass AA. */
{
  const r = ramp(HUES.violet);
  const lightest = r[0], darkest = r[r.length - 1];
  check('ramp spans light AND dark ends',
        lightest.oklch.l > 0.9 && darkest.oklch.l < 0.3,
        `${lightest.hex} (L ${lightest.oklch.l}) -> ${darkest.hex} (L ${darkest.oklch.l})`);
}

/* 3. Usable steps exist on BOTH grounds — this is the whole point of a
      two-directional ramp, and what a tints-only ramp cannot deliver. */
for (const [name, hue] of Object.entries(HUES)) {
  const r = ramp(hue);
  const onDark = usableOn(r, DARK_BG);
  const onLight = usableOn(r, LIGHT_BG);
  check(`${name}: has body-legible steps on dark AND light`,
        onDark.length > 0 && onLight.length > 0,
        `dark: ${onDark.map((s) => s.step).join(',')} | light: ${onLight.map((s) => s.step).join(',')}`);
}

/* 4. CONTROL: the contrast function must actually discriminate, or every
      check above passes vacuously. */
{
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [0, 0, 0];
  const cWB = contrast(white, black);
  const cWW = contrast(white, white);
  check('CONTROL: contrast(white,black) is ~21:1', cWB >= 20.9 && cWB <= 21,
        `${cWB}:1`);
  check('CONTROL: contrast(white,white) is 1:1', cWW === 1, `${cWW}:1`);
}

/* 5. CONTROL: a deliberately impossible floor must exclude everything, proving
      usableOn() filters rather than passing everything through. */
{
  const r = ramp(HUES.amber);
  check('CONTROL: an impossible floor (25:1) yields no usable steps',
        usableOn(r, DARK_BG, 25).length === 0);
}

/* 6. Every step must produce a valid hex — a conversion that silently clamps
      to black would still "pass" the checks above. */
{
  let allValid = true;
  for (const hue of Object.values(HUES)) {
    for (const s of ramp(hue)) if (!/^#[0-9a-f]{6}$/.test(s.hex)) allValid = false;
  }
  check('every step converts to a valid hex', allValid);
  check('CONTROL: toHex formats a known value', toHex([255, 128, 0]) === '#ff8000',
        toHex([255, 128, 0]));
}

console.log('\n  violet ramp (the reference base #8B5CF6 is ~hue 292):');
for (const s of ramp(HUES.violet)) {
  const d = contrast(s.rgb, DARK_BG).toFixed(2).padStart(5);
  const l = contrast(s.rgb, LIGHT_BG).toFixed(2).padStart(5);
  console.log(`    ${String(s.step).padStart(3)}  ${s.hex}   on-dark ${d}:1   on-light ${l}:1`);
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
