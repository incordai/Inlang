/**
 * The block specs' validation tables, as the compiler enforces them.
 *
 * Each row a manifest declares (checks.ts) has a case here: a source that
 * must raise the code, and a CONTROL that must not — without the control a
 * rule that fired on everything would pass. The last tests hold the
 * manifests to that: every declared code has a case, codes are unique, and
 * they sit in GRAMMAR §7's per-word range.
 *
 * Also covered: the generic enforcement of what manifests already declared
 * and nothing checked — slot minimums, a slot fill's own slot bounds and
 * values, int ranges, file types, word limits, and one value per site-scoped
 * prop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, type Manifest } from '../src/index.ts';
import { BLOCK_KINDS, PAGE_KINDS, SITE_KINDS, type Check } from '../src/checks.ts';

const WORDS = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages/words');
const manifests = new Map<string, Manifest>();
for (const n of readdirSync(WORDS)) {
  const f = join(WORDS, n, 'word.json');
  if (!existsSync(f)) continue;
  const m = JSON.parse(readFileSync(f, 'utf8')) as Manifest;
  manifests.set(m.name, m);
}

/** Pages every case can link to, so a route check fires only where meant. */
const PAGES = ['/signup', '/reset', '/terms', '/work', '/reserve', '/about', '/privacy'];

/** A whole file: the page-level `body` lines under `page /`, plus `site` extras. */
function file(body: string, site = ''): string {
  const indent = (s: string) => s.split('\n').map((l) => (l ? `  ${l}` : l)).join('\n');
  return `az 1\nsite probe\n  auth\n    adapter session\n${site ? indent(site) + '\n' : ''}`
    + `page /\n${indent(body)}\n` + PAGES.map((p) => `page ${p}\n`).join('');
}

function codes(src: string): { code: string; severity: string }[] {
  return compile(src, { manifests }).diagnostics.map((d) => ({ code: d.code, severity: d.severity }));
}

const times = (n: number, line: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => line(i + 1)).join('\n');

const HERO = 'hero center\n  title "Built in the dark"';
const img = (i: number) => `  image ./p${i}.webp\n    alt "Photo ${i}"`;
const images = (n: number) => times(n, img);
const item = (i: number) => `  item "Question ${i}?"\n    text "Answer ${i}."`;
const fitem = (i: number) => `  item "Point ${i}"\n    text "Detail ${i}."`;
const plan = (name: string, extra = '') =>
  `  plan "${name}"\n    monthly 29${extra}\n    cta "Choose ${name}" /reserve`;
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
const scene = (variant = 'inline') =>
  `scene ${variant} 3d\n  poster ./s.webp\n  alt "A shoe"`;

interface Case { code: string; severity: 'error' | 'warning'; bad: string; good: string }

const CASES: Case[] = [
  // ---- auth -------------------------------------------------------------
  { code: 'AZ2000', severity: 'error', bad: file('auth'),
    good: file('auth login\n  alt "Create an account" /signup') },
  { code: 'AZ2001', severity: 'error',
    bad: file('auth login\nauth signup\n  terms /terms'), good: file('auth login') },
  { code: 'AZ2002', severity: 'warning', bad: file('auth login'),
    good: file('auth login\n  alt "Create an account" /signup') },
  { code: 'AZ2003', severity: 'warning', bad: file('auth login glass'), good: file('auth login') },
  // A site-level rule: `protect` needs a page with `auth login` somewhere.
  { code: 'AZ2004', severity: 'warning',
    bad: 'az 1\nsite probe\n  auth\n    adapter session\n    protect /account\npage /\npage /account\n',
    good: 'az 1\nsite probe\n  auth\n    adapter session\n    protect /account\npage /\npage /account\n'
      + 'page /login\n  auth login\n    alt "Create an account" /account\n' },
  // A page rule with site-scoped props resolved: `methods oauth` needs a
  // server that runs the provider sign-in (auth-spec §3.4, §3.5) — a
  // `custom` adapter has none the compiler knows of.
  { code: 'AZ2005', severity: 'error',
    bad: 'az 1\nsite probe\n  auth\n    adapter custom\n    impl ./adapter.ts\npage /\n  auth login\n    methods password oauth\n'
      + '    alt "Create an account" /signup\n' + PAGES.map((p) => `page ${p}\n`).join(''),
    good: file('auth login\n  methods password oauth\n  alt "Create an account" /signup') },
  // `hosted` runs provider sign-in only with the token-endpoint profile (§3.5).
  { code: 'AZ2006', severity: 'error',
    bad: 'az 1\nsite probe\n  auth\n    adapter hosted\npage /\n  auth login\n    methods password oauth\n'
      + '    alt "Create an account" /signup\n' + PAGES.map((p) => `page ${p}\n`).join(''),
    good: 'az 1\nsite probe\n  auth\n    adapter hosted\n    profile token-endpoint\npage /\n  auth login\n    methods password oauth\n'
      + '    alt "Create an account" /signup\n' + PAGES.map((p) => `page ${p}\n`).join('') },
  // ---- cta ---------------------------------------------------------------
  { code: 'AZ2020', severity: 'error', bad: file(`${HERO}\ncta band\n  title "Reserve"`),
    good: file(`${HERO}\ncta band\n  title "Reserve"\n  cta "Reserve" /reserve`) },
  { code: 'AZ2021', severity: 'warning', bad: file('cta band\n  title "Reserve"\n  cta "Go" /reserve'),
    good: file(`${HERO}\ncta band\n  title "Reserve"\n  cta "Go" /reserve`) },
  { code: 'AZ2022', severity: 'warning',
    bad: file(`${HERO}\ncta band glass\n  title "R"\n  cta "Go" /reserve`),
    good: file(`${HERO}\ncta card glass\n  title "R"\n  cta "Go" /reserve`) },
  { code: 'AZ2024', severity: 'warning',
    bad: file(`${HERO}\ncta card glass\n  title "R"\n  cta "Go" /reserve`),
    good: file(`${HERO}\ncta card glass\n  title "R"\n  cta "Go" /reserve`, 'scene backdrop 3d\n  poster ./b.webp\n  alt "Fog"') },
  { code: 'AZ2023', severity: 'warning',
    bad: file(`${HERO}\n${times(3, () => 'cta band\n  title "R"\n  cta "Go" /reserve')}`),
    good: file(`${HERO}\n${times(2, () => 'cta band\n  title "R"\n  cta "Go" /reserve')}`) },
  // ---- faq ---------------------------------------------------------------
  { code: 'AZ2040', severity: 'error', bad: file('faq\n  title "Questions"'),
    good: file(`faq\n  title "Questions"\n${times(3, item)}`) },
  { code: 'AZ2041', severity: 'error',
    bad: file(`faq\n  title "Q"\n${times(2, item)}\n  item "No answer?"`),
    good: file(`faq\n  title "Q"\n${times(3, item)}`) },
  { code: 'AZ2042', severity: 'error',
    bad: file(`faq\n  title "Q"\n${times(2, item)}\n${item(1)}`),
    good: file(`faq\n  title "Q"\n${times(3, item)}`) },
  { code: 'AZ2043', severity: 'error',
    bad: file(`faq\n  title "A"\n${times(3, item)}\nfaq\n  title "B"\n${times(3, item)}`),
    good: file(`faq\n  title "A"\n${times(3, item)}\nfaq\n  title "B"\n  schema off\n${times(3, item)}`) },
  { code: 'AZ2044', severity: 'warning', bad: file(`faq\n  title "Q"\n${times(2, item)}`),
    good: file(`faq\n  title "Q"\n${times(3, item)}`) },
  { code: 'AZ2045', severity: 'warning', bad: file(`faq\n  title "Q"\n${times(13, item)}`),
    good: file(`faq\n  title "Q"\n${times(12, item)}`) },
  { code: 'AZ2046', severity: 'warning',
    bad: file(`faq\n  title "Q"\n${times(2, item)}\n  item "Shipping"\n    text "Yes."`),
    good: file(`faq\n  title "Q"\n${times(3, item)}`) },
  // ---- feature ------------------------------------------------------------
  { code: 'AZ2060', severity: 'warning', bad: file(`feature rows\n  columns 3\n${times(3, fitem)}`),
    good: file(`feature grid\n  columns 3\n${times(3, fitem)}`) },
  { code: 'AZ2061', severity: 'error', bad: file(`feature grid\n${times(1, fitem)}`),
    good: file(`feature grid\n${times(2, fitem)}`) },
  { code: 'AZ2062', severity: 'error', bad: file(`feature bento\n${times(2, fitem)}`),
    good: file(`feature bento\n${times(3, fitem)}`) },
  { code: 'AZ2063', severity: 'error', bad: file(`feature bento\n${times(8, fitem)}`),
    good: file(`feature bento\n${times(7, fitem)}`) },
  { code: 'AZ2064', severity: 'error',
    bad: file('feature bento\n  item "A" lead\n    text "a"\n  item "B" lead\n    text "b"\n  item "C"\n    text "c"'),
    good: file('feature bento\n  item "A" lead\n    text "a"\n  item "B"\n    text "b"\n  item "C"\n    text "c"') },
  { code: 'AZ2065', severity: 'warning', bad: file(`feature rows\n${times(6, fitem)}`),
    good: file(`feature rows\n${times(5, fitem)}`) },
  { code: 'AZ2066', severity: 'warning',
    bad: file(`feature grid\n  item "Everything you need to run your workshop"\n    text "x"\n${times(1, fitem)}`),
    good: file(`feature grid\n  item "Sewn, not glued"\n    text "x"\n${times(1, fitem)}`) },
  { code: 'AZ2067', severity: 'warning', bad: file(`feature rows\n  item "Fast"\n${times(1, fitem)}`),
    good: file(`feature rows\n${times(2, fitem)}`) },
  { code: 'AZ2068', severity: 'warning', bad: file(`feature grid reveal\n${times(2, fitem)}`),
    good: file(`${HERO}\nfeature grid reveal\n${times(2, fitem)}`) },
  // ---- footer -------------------------------------------------------------
  { code: 'AZ2080', severity: 'error', bad: file(`${HERO}\nfooter minimal\nfooter minimal`),
    good: file(`${HERO}\nfooter minimal`) },
  { code: 'AZ2081', severity: 'error', bad: file(`${HERO}\nfooter\n  link "Gone" /nowhere`),
    good: file(`${HERO}\nfooter\n  link "Work" /work`) },
  { code: 'AZ2082', severity: 'warning',
    bad: file(`${HERO}\nfooter mega\n${times(2, (i) => `  group "G${i}"`)}`),
    good: file(`${HERO}\nfooter mega\n${times(4, (i) => `  group "G${i}"`)}`) },
  { code: 'AZ2083', severity: 'warning',
    bad: file(`${HERO}\nfooter\n${times(25, (i) => `  link "L${i}" /work`)}`),
    good: file(`${HERO}\nfooter\n${times(24, (i) => `  link "L${i}" /work`)}`) },
  { code: 'AZ2084', severity: 'warning',
    bad: file(`${HERO}\nfooter\n  link "Read our privacy policy" /privacy`),
    good: file(`${HERO}\nfooter\n  link "Privacy" /privacy`) },
  { code: 'AZ2085', severity: 'warning', bad: file(`${HERO}\nfooter minimal glass`),
    good: file(`${HERO}\nfooter minimal glass`, 'scene backdrop 3d\n  poster ./b.webp\n  alt "Fog"') },
  // ---- gallery -------------------------------------------------------------
  { code: 'AZ2100', severity: 'error', bad: file('gallery grid'), good: file(`gallery grid\n${images(2)}`) },
  { code: 'AZ2101', severity: 'error', bad: file(`gallery grid\n${images(1)}`),
    good: file(`gallery grid\n${images(2)}`) },
  { code: 'AZ2102', severity: 'warning', bad: file(`gallery grid\n${images(61)}`),
    good: file(`gallery grid\n${images(60)}`) },
  { code: 'AZ2103', severity: 'error', bad: file(`gallery grid\n${images(201)}`),
    good: file(`gallery grid\n${images(200)}`) },
  { code: 'AZ2104', severity: 'error', bad: file(`gallery orbit\n  poster ./o.webp\n${images(17)}`),
    good: file(`gallery orbit\n  poster ./o.webp\n${images(16)}`) },
  { code: 'AZ2105', severity: 'error', bad: file(`gallery orbit\n  poster ./o.webp\n${images(3)}`),
    good: file(`gallery orbit\n  poster ./o.webp\n${images(4)}`) },
  { code: 'AZ2106', severity: 'warning', bad: file(`gallery grid\n${images(1)}\n  image ./bare.webp`),
    // alt "" is the author saying "decorative" — an answer, not an omission.
    good: file(`gallery grid\n${images(1)}\n  image ./bare.webp\n    alt ""\n    caption "Said here"`) },
  { code: 'AZ2107', severity: 'warning',
    bad: file(`gallery grid\n  image ./a.webp\n    alt "Welt"\n    caption "Welt"\n  image ./b.webp\n    alt "B"\n    caption "Bee"`),
    good: file(`gallery grid\n  image ./a.webp\n    alt "A welt"\n    caption "Welt"\n  image ./b.webp\n    alt "B"\n    caption "Bee"`) },
  { code: 'AZ2108', severity: 'warning',
    bad: file(`gallery grid\n  image ./a.webp\n    alt "A"\n    caption "One"\n${images(2)}`),
    good: file(`gallery grid\n${images(3)}`) },
  { code: 'AZ2109', severity: 'warning', bad: file(`gallery masonry\n  columns 3\n${images(2)}`),
    good: file(`gallery grid\n  columns 3\n${images(2)}`) },
  { code: 'AZ2110', severity: 'warning', bad: file(`gallery grid\n  ratio auto\n${images(2)}`),
    good: file(`gallery masonry\n  ratio auto\n${images(2)}`) },
  { code: 'AZ2111', severity: 'warning', bad: file(`gallery orbit lightbox\n  poster ./o.webp\n${images(4)}`),
    good: file(`gallery grid lightbox\n${images(4)}`) },
  { code: 'AZ2112', severity: 'warning', bad: file(`gallery carousel\n${images(3)}`),
    good: file(`gallery carousel\n${images(4)}`) },
  { code: 'AZ2113', severity: 'error',
    bad: file(`gallery orbit\n  poster ./o.webp\n${images(4)}\ngallery orbit\n  poster ./o.webp\n${images(4)}`),
    good: file(`gallery orbit\n  poster ./o.webp\n${images(4)}\ngallery grid\n${images(4)}`) },
  // ---- hero --------------------------------------------------------------
  { code: 'AZ2120', severity: 'error',
    bad: file(`${HERO}\n  cta "A" /reserve\n  cta "B" /work\n  alt "C" /about`),
    good: file(`${HERO}\n  cta "A" /reserve\n  alt "C" /about`) },
  { code: 'AZ2121', severity: 'error', bad: file(`${HERO}\n${HERO}`), good: file(HERO) },
  { code: 'AZ2123', severity: 'warning', bad: file('hero full glass\n  title "T"', 'scene backdrop 3d\n  poster ./b.webp\n  alt "Fog"'),
    good: file('hero center glass\n  title "T"', 'scene backdrop 3d\n  poster ./b.webp\n  alt "Fog"') },
  { code: 'AZ2124', severity: 'warning', bad: file('hero center glass\n  title "T"'),
    good: file('hero center glass\n  title "T"', 'scene backdrop 3d\n  poster ./b.webp\n  alt "Fog"') },
  { code: 'AZ2122', severity: 'warning', bad: file(`${HERO}\n  height full`), good: file(`${HERO}\n  height tall`) },
  // ---- nav ---------------------------------------------------------------
  { code: 'AZ2140', severity: 'warning', bad: file(HERO, `nav bar\n${times(8, (i) => `  link "L${i}" /work`)}`),
    good: file(HERO, `nav bar\n${times(7, (i) => `  link "L${i}" /work`)}`) },
  { code: 'AZ2141', severity: 'error', bad: file(HERO, 'nav mega\n  group "Shop"'),
    good: file(HERO, 'nav mega\n  group "Shop"\n  group "Studio"') },
  { code: 'AZ2142', severity: 'error', bad: file(HERO, 'nav bar\n  cta "A" /reserve\n  cta "B" /work'),
    good: file(HERO, 'nav bar\n  cta "A" /reserve') },
  { code: 'AZ2143', severity: 'warning', bad: file(HERO, 'nav bar\n  link "Our latest work" /work'),
    good: file(HERO, 'nav bar\n  link "Work" /work') },
  // ---- pricing ------------------------------------------------------------
  { code: 'AZ2160', severity: 'error', bad: file('pricing\n  title "Plans"'),
    good: file(`pricing\n  title "Plans"\n${plan('Studio')}`) },
  { code: 'AZ2161', severity: 'error',
    bad: file(`pricing\n  title "P"\n${plan('Studio', '\n    highlight on')}\n${plan('Practice', '\n    highlight on')}`),
    good: file(`pricing\n  title "P"\n${plan('Studio', '\n    highlight on')}\n${plan('Practice', '\n    highlight off')}`) },
  { code: 'AZ2162', severity: 'error',
    bad: file(`pricing\n  title "P"\n${plan('Studio', '\n    annual 290')}\n${plan('Atelier')}`),
    good: file(`pricing\n  title "P"\n${plan('Studio', '\n    annual 290')}\n${plan('Atelier', '\n    annual 490')}`) },
  { code: 'AZ2163', severity: 'error',
    bad: file('pricing\n  title "P"\n  plan "S"\n    monthly "29*10"\n    cta "Go" /reserve'),
    good: file(`pricing\n  title "P"\n${plan('S')}`) },
  { code: 'AZ2164', severity: 'error',
    bad: file(`pricing\n  title "P"\n${plan('S', '\n    annual "29*10"')}`),
    good: file(`pricing\n  title "P"\n${plan('S', '\n    annual 290')}`) },
  { code: 'AZ2165', severity: 'error', bad: file(`pricing\n  title "P"\n  billing annual\n${plan('S')}`),
    good: file(`pricing\n  title "P"\n  billing annual\n${plan('S', '\n    annual 290')}`) },
  { code: 'AZ2166', severity: 'warning',
    bad: file(`pricing\n  title "P"\n${times(5, (i) => plan(`P${i}`))}`),
    good: file(`pricing\n  title "P"\n${times(4, (i) => plan(`P${i}`))}`) },
  // ---- scene --------------------------------------------------------------
  { code: 'AZ2180', severity: 'error', bad: file(`${HERO}\nscene inline\n  poster ./s.webp\n  alt "A shoe"`),
    good: file(`${HERO}\n${scene()}`) },
  { code: 'AZ2181', severity: 'error', bad: file(scene()), good: file(`${HERO}\n${scene()}`) },
  { code: 'AZ2182', severity: 'error', bad: file(`${HERO}\n${times(9, () => scene())}`),
    good: file(`${HERO}\n${times(8, () => scene())}`) },
  { code: 'AZ2183', severity: 'warning', bad: file(`${HERO}\n${times(5, () => scene())}`),
    good: file(`${HERO}\n${times(4, () => scene())}`) },
  { code: 'AZ2184', severity: 'warning', bad: file(`${HERO}\n${scene('full')}\n${scene('full')}`),
    good: file(`${HERO}\n${scene('full')}\n${scene('inline')}`) },
  { code: 'AZ2185', severity: 'warning', bad: file(`${HERO}\n${scene()}\n  camera orbit`),
    good: file(`${HERO}\n${scene()}\n  camera fixed`) },
  // ---- text ---------------------------------------------------------------
  { code: 'AZ2200', severity: 'warning', bad: file(`${HERO}\ntext prose reveal\n  body "Copy."`),
    good: file(`${HERO}\ntext centered reveal\n  body "Copy."`) },
  { code: 'AZ2201', severity: 'warning', bad: file(`${HERO}\ntext\n  body "One.\\n\\nTwo."`),
    good: file(`${HERO}\ntext\n  body "One.\\nTwo."`) },
  { code: 'AZ2202', severity: 'warning', bad: file(`${HERO}\ntext centered\n  body "${words(61)}"`),
    good: file(`${HERO}\ntext centered\n  body "${words(60)}"`) },
  { code: 'AZ2203', severity: 'warning', bad: file(`${HERO}\ntext columns\n  body "${words(119)}"`),
    good: file(`${HERO}\ntext columns\n  body "${words(120)}"`) },
  { code: 'AZ2204', severity: 'warning', bad: file(`${HERO}\ntext columns\n  body "${words(301)}"`),
    good: file(`${HERO}\ntext columns\n  body "${words(300)}"`) },

  // ---- generic: what manifests declared and nothing enforced -------------
  // A slot fill's own slot minimum: pricing's plan must have its cta.
  { code: 'AZ1216', severity: 'error', bad: file('pricing\n  title "P"\n  plan "S"\n    monthly 29'),
    good: file(`pricing\n  title "P"\n${plan('S')}`) },
  // …and its maximum.
  { code: 'AZ1209', severity: 'error', bad: file(`pricing\n  title "P"\n${plan('S', '\n    cta "Again" /work')}`),
    good: file(`pricing\n  title "P"\n${plan('S')}`) },
  { code: 'AZ1407', severity: 'error', bad: file(`feature grid\n  columns three\n${times(3, fitem)}`),
    good: file(`feature grid\n  columns 3\n${times(3, fitem)}`) },
  { code: 'AZ1408', severity: 'error', bad: file(`feature grid\n  columns 5\n${times(3, fitem)}`),
    good: file(`feature grid\n  columns 4\n${times(3, fitem)}`) },
  { code: 'AZ1409', severity: 'warning', bad: file(`hero center\n  title "${words(13)}"`),
    good: file(`hero center\n  title "${words(12)}"`) },
  { code: 'AZ1410', severity: 'error', bad: file(`${HERO}\ntext\n  body ./about.txt`),
    good: file(`${HERO}\ntext\n  body ./about.md`) },
  // A markdown body given as a path is sandboxed like any path.
  { code: 'AZ1210', severity: 'error', bad: file(`${HERO}\ntext\n  body ../../secret.md`),
    good: file(`${HERO}\ntext\n  body ./content/about.md`) },
  { code: 'AZ1505', severity: 'error', bad: file(HERO, 'auth\n  adapter hosted'),
    good: file(HERO, 'auth\n  adapter session') },
];

for (const c of CASES) {
  test(`${c.code}: raised as ${c.severity} on the case the spec describes`, () => {
    const got = codes(c.bad);
    const hit = got.find((d) => d.code === c.code);
    assert.ok(hit, `expected ${c.code}, got: ${JSON.stringify(got)}\n${c.bad}`);
    assert.equal(hit.severity, c.severity);
  });
  test(`${c.code}: CONTROL — not raised on the passing case`, () => {
    const got = codes(c.good);
    assert.ok(!got.some((d) => d.code === c.code), `unexpected ${c.code}: ${JSON.stringify(got)}\n${c.good}`);
  });
}

test('a slot fill\'s values are typed: an unknown enum and an escaping path are refused', () => {
  const focus = codes(file(`gallery grid\n${images(1)}\n  image ./x.webp\n    alt "X"\n    focus sideways`));
  assert.ok(focus.some((d) => d.code === 'AZ1208'), JSON.stringify(focus));
  const media = codes(file(`feature grid\n${times(1, fitem)}\n  item "Leak"\n    text "x"\n    media ../../etc/x.webp`));
  assert.ok(media.some((d) => d.code === 'AZ1210'), JSON.stringify(media));
});

test('footer: year dynamic needs since — the requirement is keyed on the VALUE', () => {
  const bad = codes(file(`${HERO}\nfooter\n  year dynamic`));
  assert.ok(bad.some((d) => d.code === 'AZ1206'), JSON.stringify(bad));
  const good = codes(file(`${HERO}\nfooter\n  year dynamic\n  since 2019`));
  assert.ok(!good.some((d) => d.code === 'AZ1206'), JSON.stringify(good));
});

test('a count check that owns a slot bound silences the generic one', () => {
  // faq-spec §9 warns at 13 questions; the manifest's max 12 must not also error.
  const got = codes(file(`faq\n  title "Q"\n${times(13, item)}`));
  assert.ok(!got.some((d) => d.code === 'AZ1209'), JSON.stringify(got));
  // CONTROL: a slot no check owns keeps its generic bound (hero's two ctas).
  const hero = codes(file(`${HERO}\n  cta "A" /reserve\n  cta "B" /work\n  cta "C" /about`));
  assert.ok(hero.some((d) => d.code === 'AZ1209'), JSON.stringify(hero));
});

/* ---- the manifests themselves ---------------------------------------- */

const declared: { word: string; check: Check }[] = [...manifests.values()]
  .flatMap((m) => (m.checks ?? []).map((check) => ({ word: m.name, check })));

test('CONTROL: the manifests declare checks at all', () => {
  assert.ok(declared.length >= 50, `only ${declared.length} checks found`);
});

test('every declared check code is unique, per-word (AZ2000+), and of a known kind', () => {
  const seen = new Map<string, string>();
  for (const { word, check } of declared) {
    assert.match(check.code, /^AZ2\d{3}$/, `${word}: ${check.code} is outside GRAMMAR §7's AZ2000+ range`);
    assert.ok(!seen.has(check.code), `${check.code} is declared by both ${seen.get(check.code)} and ${word}`);
    seen.set(check.code, word);
    assert.ok(BLOCK_KINDS.has(check.kind) || PAGE_KINDS.has(check.kind) || SITE_KINDS.has(check.kind),
      `${word}: unknown kind '${check.kind}'`);
    assert.ok(check.severity === 'error' || check.severity === 'warning', `${word} ${check.code}: severity`);
  }
});

test('every declared check has a case in this file', () => {
  const covered = new Set(CASES.map((c) => c.code));
  const missing = declared.filter(({ check }) => !covered.has(check.code)).map(({ word, check }) => `${word} ${check.code}`);
  assert.deepEqual(missing, []);
});

test('every case\'s severity matches its manifest', () => {
  for (const c of CASES) {
    const d = declared.find(({ check }) => check.code === c.code);
    if (d) assert.equal(d.check.severity, c.severity, c.code);
  }
});
