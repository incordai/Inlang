/**
 * Background patterns: shapes stay themeable, and none of them hardcodes a colour.
 * Run: pnpm test:patterns
 */

import {
  patternCss, resolvePattern, PATTERN_SHAPES,
  type PatternShape, type PatternOrigin,
} from '../src/patterns.ts';

let failures = 0;
const check = (n: string, ok: boolean, d = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${d ? `  — ${d}` : ''}`);
  if (!ok) failures++;
};

console.log('\nBackground patterns\n');

const DRAWN = PATTERN_SHAPES.filter((s) => s !== 'none');
const ORIGINS: PatternOrigin[] = ['top', 'bottom', 'left', 'right', 'center'];

/* 1. THE POINT: no shape may contain a colour literal. A hardcoded hex is
      what made the source library unthemeable — CONVENTIONS §4. */
{
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
  let offenders: string[] = [];
  for (const shape of DRAWN) {
    for (const origin of ORIGINS) {
      const css = patternCss({ shape, origin });
      if (LITERAL.test(css.backgroundImage)) offenders.push(`${shape}/${origin}`);
    }
  }
  check('no shape emits a colour literal', offenders.length === 0, offenders.join(', '));

  // CONTROL: the detector must actually catch one, or the check is inert.
  check('CONTROL: the literal detector catches a hex',
        LITERAL.test('radial-gradient(50% 50%, #8b5cf6 0%, transparent 70%)'));
}

/* 2. Every drawn shape produces real CSS; `none` produces none. */
{
  let allDrawn = true;
  for (const shape of DRAWN) {
    const css = patternCss({ shape });
    if (!css.backgroundImage || css.backgroundImage === 'none') allDrawn = false;
  }
  check('every drawn shape emits a background-image', allDrawn);
  check('`none` emits no background-image',
        patternCss({ shape: 'none' }).backgroundImage === 'none');
  check('intensity 0 emits no background-image',
        patternCss({ shape: 'glow', intensity: 0 }).backgroundImage === 'none');
}

/* 3. Shapes must be DISTINCT. Six options that render the same are one option. */
{
  const seen = new Map<string, PatternShape>();
  let dupes: string[] = [];
  for (const shape of DRAWN) {
    const css = patternCss({ shape }).backgroundImage;
    const prev = seen.get(css);
    if (prev) dupes.push(`${prev} == ${shape}`);
    seen.set(css, shape);
  }
  check('all six shapes render differently', dupes.length === 0, dupes.join(', '));
}

/* 4. Origin must actually move the light, or it is a decorative parameter. */
{
  const top = patternCss({ shape: 'glow', origin: 'top' }).backgroundImage;
  const bottom = patternCss({ shape: 'glow', origin: 'bottom' }).backgroundImage;
  check('origin moves the glow', top !== bottom);
  // CONTROL: a shape with no focal point must IGNORE origin's position, so
  // `grid` should be identical at every origin.
  const gTop = patternCss({ shape: 'grid', origin: 'top' }).backgroundImage;
  const gBot = patternCss({ shape: 'grid', origin: 'bottom' }).backgroundImage;
  check('CONTROL: a lattice shape ignores origin', gTop === gBot);
}

/* 5. Intensity must scale opacity monotonically. */
{
  const pct = (s: string) => (s.match(/([\d.]+)%, transparent/) ?? [])[1];
  const low = pct(patternCss({ shape: 'spotlight', intensity: 0.25 }).backgroundImage);
  const high = pct(patternCss({ shape: 'spotlight', intensity: 1 }).backgroundImage);
  check('intensity scales opacity', Number(low) < Number(high), `${low}% vs ${high}%`);
}

/* 6. Lattice pitch must reach background-size, and hairlines stay 1px —
      scaling the line with the cell turns a grid into stripes. */
{
  const small = patternCss({ shape: 'grid', scale: 16 });
  const large = patternCss({ shape: 'grid', scale: 64 });
  check('scale drives the lattice pitch',
        small.backgroundSize.includes('16px') && large.backgroundSize.includes('64px'),
        `${small.backgroundSize} | ${large.backgroundSize}`);
  check('hairline stays 1px at any pitch',
        small.backgroundImage.includes('0 1px') && large.backgroundImage.includes('0 1px'));
}

/* 7. URL resolution must never throw and never blank on bad input. */
{
  const bad = resolvePattern('?pattern=nonsense&origin=sideways&intensity=-5&scale=0');
  check('malformed params fall back to a drawable default',
        bad.shape === 'glow' && bad.origin === 'top' && bad.intensity === 1 && bad.scale === 32,
        JSON.stringify(bad));
  const good = resolvePattern('?pattern=dots&origin=center&intensity=0.5&scale=48');
  check('valid params are honoured',
        good.shape === 'dots' && good.origin === 'center' && good.intensity === 0.5 && good.scale === 48,
        JSON.stringify(good));
  // CONTROL: absurd values are clamped, not passed through.
  const huge = resolvePattern('?intensity=999&scale=99999');
  check('CONTROL: out-of-range values are clamped',
        huge.intensity === 2 && huge.scale === 200, JSON.stringify(huge));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
