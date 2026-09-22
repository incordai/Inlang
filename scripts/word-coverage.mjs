/**
 * What each word's emitter implements, versus what its manifest promises.
 *
 * A word is not done when it compiles — it is done when every variant it
 * advertises renders differently and every prop it declares changes something.
 * This prints the gap so incompleteness stays visible instead of being
 * mistaken for completion (CONVENTIONS §3).
 *
 * Variants are measured by EMITTING them and comparing the output, the same
 * way words/test/variants.test.ts does. Grepping the source for
 * `variant === 'x'` under-reported badly once several words moved to lookup
 * maps: `auth`'s three flows come from a FIELDS table and `nav`'s from a
 * LAYOUT table, so a text search found neither and called six finished
 * variants outstanding. A script that sends someone to redo completed work is
 * worse than no script.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve, THEMES } from '../packages/theme/src/index.ts';
import { WEB_EMITTERS } from '../packages/words/registry.ts';

const W = join(fileURLToPath(new URL('../', import.meta.url)), 'packages/words');
const uses = (s, re) => new Set([...s.matchAll(re)].map((m) => m[1]));


/** Emit context matching words/test/variants.test.ts, so both agree. */
function context() {
  const t = resolve(THEMES.midnight, 'dark');
  return {
    theme: {
      color: t.color, size: t.size, type: t.type, radius: t.radius,
      shadow: t.shadow, space: t.space, motion: t.motion, layer: t.layer,
      breakpoint: t.breakpoint, typeSize: t.typeSize,
    },
    target: 'web',
    slot: (name) => [
      { tag: 'li', attrs: { class: `az-child--${name}` }, children: ['one'] },
      { tag: 'li', attrs: { class: `az-child--${name}` }, children: ['two'] },
    ],
    asset: (p) => p,
  };
}

const arg = (value) => ({ kind: 'string', value });
const kid = (word, ...values) => ({
  word, variant: null, modifiers: [], args: values.map(arg), props: {}, as: null, children: [],
});

const fixture = (word, variant) => ({
  word, variant, modifiers: [], args: [], as: null,
  props: {
    title: 'Built in the dark', sub: 'Handmade.', eyebrow: 'Limited run',
    columns: '3', logo: './logo.svg', copyright: 'Aurora', since: '2019',
    body: 'A paragraph long enough that a column count has something to divide.',
    tagline: 'Handmade in the dark.', monthly: '29', adapter: 'session',
  },
  children: [
    kid('link', 'Work', '/work'), kid('cta', 'Reserve', '/reserve'),
    kid('item', 'Hand-cut leather'), kid('item', 'Sewn, not glued'),
    kid('plan', 'Studio'), kid('image', './a.webp'),
    kid('group', 'Shop'), kid('legal', 'Privacy', '/privacy'),
  ],
});

/** Variants whose output matches an earlier variant of the same word. */
function identicalVariants(word, variants) {
  const emitter = WEB_EMITTERS[word];
  if (!emitter) return [...variants];
  const seen = new Map();
  const dupes = [];
  for (const v of variants) {
    // Strip every mention of the variant NAME, or echoing it into a class or
    // a data attribute would be enough to look implemented.
    const shape = JSON.stringify(emitter.emit(fixture(word, v), context())).split(v).join('V');
    if (seen.has(shape)) dupes.push(v);
    else seen.set(shape, v);
  }
  return dupes;
}

let vTot = 0, vDone = 0, pTot = 0, pDone = 0;
const rows = [];

for (const w of readdirSync(W).filter((d) =>
  statSync(join(W, d)).isDirectory() && existsSync(join(W, d, 'word.json')))) {
  const m = JSON.parse(readFileSync(join(W, w, 'word.json'), 'utf8'));
  const f = join(W, w, 'emit.web.ts');
  const src = existsSync(f) ? readFileSync(f, 'utf8') : '';

  const variants = m.variants ?? [];
  const props = Object.keys(m.props ?? {});
  const seenP = uses(src, /block\.props\.([A-Za-z][A-Za-z0-9]*)/g);

  // A variant counts as implemented when its OUTPUT differs from every other
  // variant of the same word — not when its name appears in the source.
  const missV = src ? identicalVariants(w, variants) : [...variants];
  const missP = props.filter((p) => !seenP.has(p));
  vTot += variants.length; vDone += variants.length - missV.length;
  pTot += props.length;    pDone += props.length - missP.length;

  rows.push({ w, emitter: !!src, variants, missV, props, missP });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`${pad('word', 10)}${pad('emit', 6)}${pad('variants', 10)}${pad('props', 8)}unimplemented`);
console.log('-'.repeat(78));
for (const r of rows) {
  const gaps = [...r.missV.map((v) => v + '/v'), ...r.missP].join(' ');
  console.log(
    pad(r.w, 10) + pad(r.emitter ? 'yes' : 'NO', 6) +
    pad(`${r.variants.length - r.missV.length}/${r.variants.length}`, 10) +
    pad(`${r.props.length - r.missP.length}/${r.props.length}`, 8) +
    (gaps || '—'));
}
console.log('-'.repeat(78));
console.log(`${pad('TOTAL', 16)}${pad(`${vDone}/${vTot}`, 10)}${pad(`${pDone}/${pTot}`, 8)}` +
  `${vTot - vDone} variants + ${pTot - pDone} props remain`);
