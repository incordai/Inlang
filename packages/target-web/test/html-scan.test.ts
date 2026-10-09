/**
 * The page scanner (html-scan.ts) — word-quality-gate §5.5.
 *
 * Three claims: it reads a page as a browser's tokenizer does where a policy
 * or an audit depends on it; it is linear on any input, where the regular
 * expressions it replaced were quadratic; and on real markup its results are
 * exactly theirs (legacy-scan.ts is the old code, kept as the oracle).
 * scripts/verify-build.mjs and the browser gate repeat the equivalence over
 * every page a real build ships.
 *
 * Cost is CPU time (process.cpuUsage), never wall-clock, so a loaded machine
 * cannot fail a linear scan; the old code's cost is shown by how it grows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { decodeAttribute, startTags } from '../src/html-scan.ts';
import { inlineScripts, inlineStyles, ownDigests, styleAttributes } from '../src/csp.ts';
import { legacyOwnDigests, legacyTags, scanDifferences } from './legacy-scan.ts';

const tags = (html: string) => startTags(html).map((t) => [t.name, Object.fromEntries(t.attrs), t.text ?? null]);

test('start tags: names and attributes lowercased, the first of a name wins, values as written', () => {
  assert.deepEqual(tags('<P Class="a" CLASS="b" data-x=1 hidden title=\'q &amp; a\'>t</P>'), [
    ['p', { class: 'a', 'data-x': '1', hidden: '', title: 'q &amp; a' }, null],
  ]);
  assert.deepEqual(tags('<meta charset="utf-8" /><br/><img src=a.png alt="">'), [
    ['meta', { charset: 'utf-8' }, null], ['br', {}, null], ['img', { src: 'a.png', alt: '' }, null],
  ]);
});

test('a `>` inside a quoted value does not end the tag; spaces around `=` are allowed', () => {
  assert.deepEqual(tags('<a title="x > y" href = \'/z\'>k</a><b>'), [
    ['a', { title: 'x > y', href: '/z' }, null], ['b', {}, null],
  ]);
});

test('comments, end tags, doctypes and stray `<` are not start tags', () => {
  assert.deepEqual(tags('<!doctype html><!-- <i style="x"> --><!--><!---><?x <u>?></p x=">"><b>1 < 2</b></>'), [['b', {}, null]]);
});

test('script and style text is not markup, and ends at its own end tag in any case', () => {
  assert.deepEqual(tags('<script>if (a <b) x = "<i style=\'c\'>";</SCRIPT ><style>p>a{}</style\n><i>'), [
    ['script', {}, 'if (a <b) x = "<i style=\'c\'>";'], ['style', {}, 'p>a{}'], ['i', {}, null],
  ]);
  assert.deepEqual(tags('<script></scripts></script>'), [['script', {}, '</scripts>']], 'only </script followed by a space, / or > ends it');
});

test('input that ends inside a tag, a quoted value, a comment or a script ends the scan there', () => {
  assert.deepEqual(tags('<i><a href="x'), [['i', {}, null]]);
  assert.deepEqual(tags('<i><a href=x'), [['i', {}, null]]);
  assert.deepEqual(tags('<i><!-- <b>'), [['i', {}, null]]);
  assert.deepEqual(tags('<i><script>a()'), [['i', {}, null]], 'a browser never runs a script the page ends in');
  assert.deepEqual(tags('<i><style>p{}</style'), [['i', {}, null]]);
});

/* ---- decodeAttribute: HTML §13.2.5.80, numeric character reference end state ---- */

const FFFD = '\uFFFD';

test('decodeAttribute: past U+10FFFF, a surrogate, or zero is U+FFFD — never a RangeError', () => {
  for (const ref of ['&#x110000;', '&#1114112;', '&#xD800;', '&#xDBFF;', '&#xDC00;', '&#xDFFF;', '&#55296;', '&#0;', '&#x0;', '&#X00;']) {
    assert.equal(decodeAttribute(`a${ref}b`), `a${FFFD}b`, ref);
  }
  assert.equal(decodeAttribute('&#x10FFFF;'), '\u{10FFFF}', 'CONTROL: the last code point is kept');
  assert.equal(decodeAttribute('&#1114111;'), '\u{10FFFF}');
});

test('decodeAttribute: an overlong digit string is capped while it is read — U+FFFD, with no overflow', () => {
  assert.equal(decodeAttribute(`&#${'9'.repeat(400)};x`), `${FFFD}x`, 'a decimal past Number.MAX_VALUE');
  assert.equal(decodeAttribute(`&#x${'F'.repeat(400)};x`), `${FFFD}x`, 'a hexadecimal past Number.MAX_VALUE');
  assert.equal(decodeAttribute(`&#${'1'.repeat(200_000)}`), FFFD, 'every digit is consumed, as the tokenizer does');
  assert.equal(decodeAttribute(`&#x${'0'.repeat(1000)}41;`), 'A', 'CONTROL: leading zeros are no overflow');
});

test('decodeAttribute: 0x80–0x9F through the C1 table; the five it leaves out are kept', () => {
  // HTML §13.2.5.80's table, written out here apart from the source's.
  const table: Record<number, number> = {
    0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6,
    0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c,
    0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a,
    0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
  };
  for (let n = 0x80; n <= 0x9f; n++) {
    const want = String.fromCodePoint(table[n] ?? n);
    assert.equal(decodeAttribute(`&#x${n.toString(16)};`), want, `&#x${n.toString(16)};`);
    assert.equal(decodeAttribute(`&#${n};`), want, `&#${n};`);
  }
  assert.deepEqual([0x81, 0x8d, 0x8f, 0x90, 0x9d].map((n) => decodeAttribute(`&#${n};`)), ['\x81', '\x8d', '\x8f', '\x90', '\x9d']);
});

test('decodeAttribute: noncharacters and controls are kept, as the spec keeps them (a parse error only)', () => {
  for (const n of [0xfdd0, 0xfdef, 0xfffe, 0xffff, 0x1fffe, 0x10fffe, 0x01, 0x0b, 0x0d, 0x1f, 0x7f]) {
    assert.equal(decodeAttribute(`&#x${n.toString(16)};`), String.fromCodePoint(n), n.toString(16));
  }
});

test('decodeAttribute: the `;` is optional after digits; `&#` with no digits is text', () => {
  assert.equal(decodeAttribute('&#65x &#x41g &#X41;'), 'Ax Ag A');
  assert.equal(decodeAttribute('&#x110000 '), `${FFFD} `);
  assert.equal(decodeAttribute('&#; &#x; &#xg; & &#-1;'), '&#; &#x; &#xg; & &#-1;');
});

test('decodeAttribute: named references only as HTML spells them, each with its `;`', () => {
  assert.equal(decodeAttribute('&amp;&AMP;&lt;&LT;&gt;&GT;&quot;&QUOT;&apos;'), '&&<<>>""\'');
  assert.equal(decodeAttribute('&Amp; &APOS; &nbsp; &ampx;'), '&Amp; &APOS; &nbsp; &ampx;', 'not in the table as written: kept');
  assert.equal(decodeAttribute('&amp;#x41;'), '&#x41;', 'decoded once, left to right');
});

/* ---- cost: linear on any input ------------------------------------------ */

const MB = 1024 * 1024;
/** The bound: CPU time per input character. Measured ~20–50ns here; 1µs leaves room for a slow machine. */
const NS_PER_CHAR = 1_000;
/** Eight times the input may cost at most this many times more — linear is ~8, quadratic ~64. */
const GROWTH_8X = 24;

/** `unit` repeated to at least `chars` characters. */
const fill = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

/** Pathological pages: each is a shape a regular expression restarts on at every `<`. */
const ADVERSARIAL: Readonly<Record<string, string>> = {
  'unclosed tags': '<a ',
  'unclosed scripts': '<script ',
  'scripts never closed': '<script>',
  'unclosed metas': '<meta ',
  'attribute soup': '<a b=c d ',
  'unterminated quotes': '<p style="',
  'unterminated comments': '<!--',
  'nested < noise': '<<<<<<<<',
};

/** CPU milliseconds `f` takes: the least of `runs`, so a collection or a JIT pass is not counted. */
function cpuMs(f: () => unknown, runs = 3): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = process.cpuUsage();
    f();
    const used = process.cpuUsage(start);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}

/** The scans the build and the audit run over a page: ownDigests reads it through startTags, as the audit does. */
const scans = (html: string) => ownDigests(html);

test('LINEAR: 300 000 unclosed `<a ` (900KB) — the page that held az audit for minutes', () => {
  const page = '<a '.repeat(300_000);
  const ms = cpuMs(() => scans(page));
  assert.ok(ms <= (page.length * NS_PER_CHAR) / 1e6, `${ms.toFixed(1)}ms CPU for ${page.length} characters`);
});

for (const [name, unit] of Object.entries(ADVERSARIAL)) {
  test(`LINEAR: ${name}, 5MB — under ${NS_PER_CHAR}ns of CPU per character, and eight times the input costs about eight times as much`, () => {
    const big = fill(unit, 5 * MB);
    const small = fill(unit, (5 * MB) / 8);
    // One run of the larger: a 5MB scan is long enough that a collection cannot dominate it.
    const tBig = cpuMs(() => scans(big), 1);
    const tSmall = cpuMs(() => scans(small));
    assert.ok(tBig <= (big.length * NS_PER_CHAR) / 1e6, `${tBig.toFixed(1)}ms CPU for ${big.length} characters`);
    // A floor of 1ms: below it the clock's resolution, not the scan, decides the ratio.
    assert.ok(tBig <= GROWTH_8X * Math.max(tSmall, 1), `8× the input took ${(tBig / tSmall).toFixed(1)}× (${tSmall.toFixed(1)} → ${tBig.toFixed(1)}ms)`);
  });
}

test('LINEAR: a 5MB page of real, closed markup', () => {
  const page = fill('<p class="x" style="color:red">t &amp; u</p><script type="application/ld+json">{"a":1}</script><!-- -->', 5 * MB);
  const ms = cpuMs(() => scans(page), 1);
  assert.ok(ms <= (page.length * NS_PER_CHAR) / 1e6, `${ms.toFixed(1)}ms CPU for ${page.length} characters`);
});

/** The old scans the build and the audit ran over a page. */
const legacyScans = (html: string) => {
  legacyOwnDigests(html);
  legacyTags(html, 'meta');
  legacyTags(html, 'a');
};

/**
 * The shapes the old code was quadratic on (nested `<` noise and unterminated
 * quotes it read in linear time), each with the size it is measured from:
 * enough characters that eight times as many cost the old code far past the bound.
 */
const QUADRATIC: Readonly<Record<string, number>> = {
  'unclosed tags': 1_200,
  'unclosed scripts': 1_200,
  'scripts never closed': 8_000,
  'unclosed metas': 1_200,
  'attribute soup': 1_200,
  'unterminated comments': 8_000,
};

for (const [name, chars] of Object.entries(QUADRATIC)) {
  test(`QUADRATIC (old code): ${name} — eight times the input costs far more than eight times as much, past the bound`, () => {
    const unit = ADVERSARIAL[name];
    // Small inputs: at the scanner's 5MB the old code runs for hours. One run of the
    // larger: seconds of CPU, which no collection or JIT pass could account for.
    const small = fill(unit, chars);
    const big = fill(unit, 8 * chars);
    const tSmall = cpuMs(() => legacyScans(small));
    const tBig = cpuMs(() => legacyScans(big), 1);
    assert.ok(tBig > GROWTH_8X * Math.max(tSmall, 1), `8× the input took ${(tBig / tSmall).toFixed(1)}× (${tSmall.toFixed(1)} → ${tBig.toFixed(1)}ms)`);
    assert.ok(tBig > (big.length * NS_PER_CHAR) / 1e6, `CONTROL: ${tBig.toFixed(1)}ms CPU for ${big.length} characters is past the bound`);
  });
}

test('QUADRATIC (old code): the 900KB page of unclosed `<a ` is still running at twice the scanner\'s bound', async () => {
  const page = '<a '.repeat(300_000);
  // A wall-clock deadline: a loaded machine only makes the old code later still.
  const deadline = Math.max(2 * (page.length * NS_PER_CHAR) / 1e6, 2_000);
  const legacy = new URL('./legacy-scan.ts', import.meta.url).href;
  const worker = new Worker(
    `const { workerData, parentPort } = require('node:worker_threads');
     import(workerData.legacy).then((m) => { m.legacyStyleAttributes(workerData.page); parentPort.postMessage('done'); });`,
    { eval: true, workerData: { legacy, page } },
  );
  const outcome = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => resolve('running'), deadline);
    worker.once('message', (m: string) => { clearTimeout(timer); resolve(m); });
    worker.once('error', (e) => { clearTimeout(timer); reject(e); });
  });
  await worker.terminate();
  assert.equal(outcome, 'running', `the old scan finished inside ${deadline}ms`);
});

/* ---- equivalence: on real markup, exactly the old results ---------------- */

/** A small deterministic generator (mulberry32), so a failure reproduces. */
function random(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text as a server renderer escapes it. */
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => escapeText(s).replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

/**
 * A page of the shapes the pre-render writes: nested elements with
 * double-quoted, escaped attributes (style among them), escaped text, its
 * `<!-- -->` separators, JSON-LD and executed inline scripts, inline
 * sheets, links that open a tab, metas, CR LF line ends.
 */
function realisticPage(seed: number): string {
  const r = random(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const words = ['Handmade', 'pairs', 'a & b', '"quoted"', 'it\'s', '1 < 2', 'café —', 'x > y', 'end'];
  const styles = ['color:var(--az-color-accent)', 'content:"&"', 'margin:0 auto', 'background:url(\'/a.png\')', 'grid-template:"a b" 1fr'];
  const out: string[] = [];
  const element = (depth: number): void => {
    const tag = pick(['div', 'p', 'span', 'section', 'a', 'button', 'li', 'h2']);
    const attrs: string[] = [];
    if (r() < 0.5) attrs.push(`class="${escapeAttr(pick(['az-hero', 'fixture-badge', 'a b']))}"`);
    if (r() < 0.4) attrs.push(`style="${escapeAttr(pick(styles))}"`);
    if (tag === 'a') attrs.push(`href="/${pick(['work', 'legal?x=1&amp;y=2'])}"`, ...(r() < 0.5 ? ['target="_blank"'] : []), ...(r() < 0.5 ? ['rel="noopener noreferrer"'] : []));
    if (r() < 0.2) attrs.push('hidden=""');
    out.push(`<${tag}${attrs.map((a) => ` ${a}`).join('')}>`);
    const children = depth > 3 ? 0 : Math.floor(r() * 4);
    for (let i = 0; i < children; i++) {
      const kind = r();
      if (kind < 0.45) element(depth + 1);
      else if (kind < 0.7) out.push(escapeText(pick(words)));
      else if (kind < 0.8) out.push('<!-- -->');
      else if (kind < 0.85) out.push(`<script type="application/ld+json">${JSON.stringify({ '@type': 'FAQPage', q: pick(words) }).replace(/</g, '\\u003c')}</script>`);
      else if (kind < 0.9) out.push(`<script>window.__a = ${JSON.stringify(pick(words))};\r\n</script>`);
      else if (kind < 0.95) out.push(`<style>.a{${pick(styles)}}</style>`);
      else out.push('<br/>');
    }
    out.push(`</${tag}>`);
  };
  for (let i = 0; i < 6; i++) element(0);
  return `<!doctype html>\r\n<html lang="en">\r\n  <head>\r\n    <meta charset="utf-8" />\r\n` +
    `    <meta http-equiv="Content-Security-Policy" content="default-src &#x27;self&#x27;; object-src &#x27;none&#x27;" />\r\n` +
    `    <meta name="description" content="${escapeAttr(pick(words))}" />\r\n` +
    `    <title>${escapeText(pick(words))}</title>\r\n    <script type="module" crossorigin src="./assets/index.js"></script>\r\n` +
    `  </head>\r\n  <body>\r\n    <div id="root">${out.join('')}</div>\r\n  </body>\r\n</html>\r\n`;
}

test('EQUIVALENCE: 500 generated pages of pre-render markup — every result exactly the old code\'s', () => {
  let attrs = 0;
  let scripts = 0;
  for (let seed = 1; seed <= 500; seed++) {
    const html = realisticPage(seed);
    assert.deepEqual(scanDifferences(html), [], `seed ${seed}`);
    attrs += styleAttributes(html).length;
    scripts += inlineScripts(html).length + inlineStyles(html).length;
  }
  assert.ok(attrs > 500 && scripts > 100, `CONTROL: the pages carry what is compared (${attrs} style attributes, ${scripts} scripts and sheets)`);
});
