/**
 * The browser half of the word gate — word-quality-gate §1 items 3–7,
 * VERIFICATION §3 `pnpm test:visual`.
 *
 * For every word's preview.az in every theme: compile through the real CLI,
 * build with Vite, serve, and check in a real browser at 390/768/1440 in
 * light and dark:
 *   3  no horizontal overflow
 *   4  axe: zero violations
 *   5  keyboard: everything reachable, visible focus, no trap
 *   6  prefers-reduced-motion: nothing animates
 *   7  light and dark actually differ (+ screenshots for human review)
 * Chromium runs everything; Firefox and WebKit run a smaller pass (overflow
 * and page errors at one width each), so browser claims rest on real runs.
 *
 *     node scripts/visual.mjs              the full gate
 *     node scripts/visual.mjs hero cta     only these words
 *     node scripts/visual.mjs --self-test  prove every check can fail and pass
 *     node scripts/visual.mjs --every-variant
 *                                          also every variant without a preview
 *                                          of its own (preview.az with the variant
 *                                          swapped in), in the default theme
 *
 * Output (screenshots, report.json) goes to .visual-out/, which is ignored.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, existsSync,
  symlinkSync, rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { WIDTHS, overflow, axe, keyboard, reducedMotion, bodyBackground, columnsOf, restacks, sharedColumn, skipLink, noJs, hydration } from './visual/checks.mjs';
import { startServer } from './visual/serve.mjs';
import {
  carousel, copy, drawer, dropdown, faq, faqDeepLink, hideShrink, lightbox, navMotion, overlayMotion, play, scrollPadding, solid,
} from './visual/behaviours.mjs';
import { behaviourSelfTest } from './visual/behaviour-selftest.mjs';
import { withVariant } from './thumbnails.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const CLI = join(ROOT, 'packages/cli/bin/az.js');
const OUT = join(ROOT, '.visual-out');
const THEMES = ['midnight', 'paper', 'signal'];
const SCHEMES = ['light', 'dark'];
/** Parallel Vite builds; bounded so a laptop stays usable. */
const BUILD_CONCURRENCY = 4;
/** Every navigation is bounded. */
const NAV_TIMEOUT_MS = 15_000;

/* ---- npm and vite without a shell (see verify-build.mjs for why) -------- */

const NODE_DIR = dirname(process.execPath);
const NPM_CLI = [
  join(NODE_DIR, 'node_modules/npm/bin/npm-cli.js'),
  join(NODE_DIR, '../lib/node_modules/npm/bin/npm-cli.js'),
].find((c) => existsSync(c));
if (!NPM_CLI) throw new Error(`visual: npm-cli.js not found in the node install at ${NODE_DIR}`);

const execFileP = promisify(execFile);
const node = (script, args, cwd) => execFileP(process.execPath, [script, ...args], {
  cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  // AZ_BUILD_LOG quiets a project's own build (az-vite/build.mjs) to errors.
  env: { AZ_BUILD_LOG: 'error', ...process.env, AZ_WORDS: WORDS },
});

/** Run `fn` over `items`, at most `limit` at a time. */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/* ---- results ------------------------------------------------------------ */

const CHECKS = ['compile', 'overflow', 'axe', 'keyboard', 'reduced-motion', 'schemes', 'restack', 'column', 'disclosure', 'skip-link',
  'no-js', 'hydration',
  'drawer', 'dropdown', 'solid', 'hide-shrink', 'scroll-padding', 'faq', 'faq-deep-link', 'carousel', 'lightbox', 'copy', 'play', 'overlay-motion', 'nav-motion',
  'firefox', 'webkit'];

/**
 * Responsive-table rows the gate measures, per word and variant: the
 * element that must restack to one column below breakpoint.sm. A variant
 * listed here needs a `preview.<variant>.az` beside the word's preview.az.
 */
const RESTACK = {
  hero: { split: '.az-hero' },                 // hero-spec §10: split restacks to stack
  cta: { split: '.az-cta' },                   // cta-spec §6: text above, media below
  faq: { columns: '.az-faq-items' },           // faq-spec §6: one column, declared order
  text: { columns: '.az-text-body' },          // text-spec §7: one column below md
  feature: {
    default: '.az-feature-items',              // feature-spec §6: grid is one column
    rows: '.az-feature-item',                  // feature-spec §6: rows stack media above text
  },
  footer: { columns: '.az-footer-columns' },   // footer-spec §8: groups in one column
  pricing: { default: '.az-pricing-plans' },  // pricing-spec §6: cards, one column
  // gallery-spec §6: grid is TWO columns on a phone, not one.
  gallery: { default: { at: '.az-gallery-items', narrow: 2 } },
};

/**
 * Elements that must share ONE column on a desktop, per word and variant —
 * text that belongs together must not be paired across a grid's columns.
 */
const COLUMN = {
  hero: { split: ['.az-hero-title', '.az-hero-sub', '.az-hero-actions'] },   // hero-spec §2
};
/**
 * Disclosure forms that replace a layout on phones, per word and variant:
 * at 390px the accordion shows (first group open, the rest closed) and the
 * desktop layout is hidden; at 1440px the reverse.
 */
const DISCLOSE = {
  footer: { mega: { accordion: '.az-footer-accordion', desktop: '.az-footer-columns' } },  // footer-spec §8
};

/** Item 3 extension: the phone disclosure form is the one on screen. */
async function disclosure(page, width, sel) {
  const r = await page.evaluate(({ accordion, desktop }) => {
    const shown = (q) => { const el = document.querySelector(q); return !!el && getComputedStyle(el).display !== 'none'; };
    const details = [...document.querySelectorAll(`${accordion} details`)];
    return { accordion: shown(accordion), desktop: shown(desktop), open: details.map((d) => d.open) };
  }, sel);
  const phone = width < 768;
  const problems = [];
  if (r.accordion !== phone) problems.push(`accordion ${r.accordion ? 'shown' : 'hidden'} at ${width}`);
  if (r.desktop === phone) problems.push(`desktop layout ${r.desktop ? 'shown' : 'hidden'} at ${width}`);
  if (phone && (r.open.length < 2 || !r.open[0] || r.open.slice(1).some(Boolean))) {
    problems.push(`expected the first group open and the rest closed, got [${r.open.join(', ')}]`);
  }
  return { pass: problems.length === 0, detail: problems.join('; ') };
}

const results = {};   // word -> check -> { pass, fail, failures: [] }
function record(word, check, where, r) {
  const cell = ((results[word] ??= {})[check] ??= { pass: 0, fail: 0, failures: [] });
  if (r.pass) cell.pass++;
  else { cell.fail++; cell.failures.push(`${where}: ${r.detail}`); }
}

/* ---- build -------------------------------------------------------------- */

/** preview.az with `theme <name>` as the site's first child. */
function themed(source, theme) {
  const lines = source.split('\n');
  const at = lines.findIndex((l) => /^site\b/.test(l));
  if (at < 0) throw new Error('visual: preview has no site line');
  lines.splice(at + 1, 0, `  theme ${theme}`);
  return lines.join('\n');
}

/** The reserved variant that renders nothing (GRAMMAR §5.2) — nothing to check. */
const RENDERS_NOTHING = 'none';

/**
 * The theme the extra variant sites use. Every variant is checked — light
 * and dark, every width, every engine — and the previews are checked in all
 * three themes; checking every variant in every theme as well would triple
 * a run whose theme coverage the previews already give.
 */
const VARIANT_THEME = 'midnight';

/** The variant a preview's word line uses: the one written, else the manifest's first. */
function variantIn(source, word, variants) {
  const line = source.split('\n').find((l) => new RegExp(`^\\s+${word}(\\s|$)`).test(l));
  const written = line?.trim().split(/\s+/).slice(1).find((t) => variants.includes(t));
  return written ?? variants[0];
}

/**
 * A word's sites: preview.az (its default variant) and any
 * preview.<variant>.az in every theme — plus, so EVERY variant is checked,
 * each remaining variant as preview.az with that variant swapped in (the
 * approach the thumbnails use), in one theme.
 */
function previewsOf(word, everyVariant) {
  const dir = join(WORDS, word);
  const files = readdirSync(dir)
    .map((f) => /^preview(?:\.([a-z]+))?\.az$/.exec(f))
    .filter(Boolean)
    .map((m) => ({ file: m[0], variant: m[1] ?? null, themes: THEMES }));
  const { variants = [] } = JSON.parse(readFileSync(join(dir, 'word.json'), 'utf8'));
  const preview = readFileSync(join(dir, 'preview.az'), 'utf8');
  const covered = new Set([variantIn(preview, word, variants), ...files.map((f) => f.variant)]);
  const rest = variants
    .filter((v) => v !== RENDERS_NOTHING && !covered.has(v))
    .map((v) => ({ file: `preview.az as ${v}`, variant: v, source: withVariant(preview, word, v, variants), themes: [VARIANT_THEME] }));
  return [...files, ...(everyVariant ? rest : [])].sort((a, b) => a.file.localeCompare(b.file));
}

async function buildAll(words, work, everyVariant) {
  const sites = words.flatMap((word) => previewsOf(word, everyVariant).flatMap((p) =>
    p.themes.map((theme) => ({ word, theme, variant: p.variant, file: p.file, source: p.source,
      label: p.variant ? `${theme}:${p.variant}` : theme }))));
  for (const s of sites) {
    s.dir = join(work, `${s.word}-${s.variant ?? 'default'}-${s.theme}`);
    mkdirSync(s.dir, { recursive: true });
    const src = join(WORDS, s.word);
    const preview = s.source ?? readFileSync(join(src, s.file), 'utf8');
    writeFileSync(join(s.dir, 'site.az'), themed(preview, s.theme));
    // Each page is its own HTML file, and a preview's extra pages exist only
    // so its links resolve. The word under test is on the FIRST page declared.
    s.path = firstRoute(preview);
    if (existsSync(join(src, 'preview-assets'))) cpSync(join(src, 'preview-assets'), join(s.dir, 'preview-assets'), { recursive: true });
  }
  // A preview that no longer compiles is a finding for that word, not a
  // reason to skip every other word.
  await pool(sites, BUILD_CONCURRENCY, async (s) => {
    try {
      await node(CLI, ['build', join(s.dir, 'site.az'), '--out', join(s.dir, 'proj')], s.dir);
      s.compiled = true;
      record(s.word, 'compile', s.label, { pass: true });
    } catch (e) {
      const errors = String(e.stderr ?? e.message).split('\n').filter((l) => / error /.test(l))
        .map((l) => l.replace(/^.*?error /, ''));
      record(s.word, 'compile', s.label, { pass: false, detail: errors.join(' | ') || 'az build failed' });
    }
  });
  const built = sites.filter((s) => s.compiled);
  console.log(`compiled ${built.length}/${sites.length} sites`);
  if (built.length === 0) return [];

  // One install per distinct dependency set: a 3D site adds `three`, every
  // other site emits the same set — so one or two installs, never one per site.
  const depsOf = (dir) => JSON.stringify({ ...JSON.parse(readFileSync(join(dir, 'proj/package.json'), 'utf8')), name: '' });
  const installs = new Map();
  for (const s of built) {
    const key = depsOf(s.dir);
    if (!installs.has(key)) installs.set(key, { dir: join(work, `shared-${installs.size}`), from: s.dir });
    s.install = installs.get(key).dir;
  }
  for (const { dir, from } of installs.values()) {
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), readFileSync(join(from, 'proj/package.json')));
    await node(NPM_CLI, ['install', '--no-audit', '--no-fund'], dir);
  }
  console.log(`installed ${installs.size} shared node_modules`);

  await pool(built, BUILD_CONCURRENCY, async (s) => {
    const proj = join(s.dir, 'proj');
    symlinkSync(join(s.install, 'node_modules'), join(proj, 'node_modules'), 'dir');
    // The project's OWN build: the client bundle, then every page
    // pre-rendered — so every check below sees the pages that ship.
    await node(join(proj, 'az-vite/build.mjs'), [], proj);
    s.dist = join(proj, 'dist');
  });
  console.log(`built ${built.length} sites (client + pre-render)\n`);
  return built;
}

/** The first `page <route>` of a .az source, as a URL path. */
function firstRoute(source) {
  const m = /^page\s+(\S+)/m.exec(source);
  if (!m) throw new Error('preview has no page');
  return m[1] === '/' ? '/' : `${m[1]}/`;
}

/** The runtime's mark on <html> once the page is hydrated and wired. */
const READY = 'html[data-az-ready]';

/**
 * Load a site page and wait until it is hydrated and its behaviours wired.
 * A pre-rendered page shows its markup at once — before React has adopted
 * it and before the runtime has attached — so waiting for markup is not
 * enough: the runtime marks <html data-az-ready> when it is done.
 */
async function open(page, path, server) {
  await page.goto(new URL(path, server.url).href, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  await page.waitForSelector(READY, { state: 'attached', timeout: NAV_TIMEOUT_MS });
}

/* ---- check one site ----------------------------------------------------- */

async function checkSite(s, browsers, server) {
  server.serve(s.dist);
  const shots = join(OUT, s.word);
  mkdirSync(shots, { recursive: true });
  const tag = (scheme, width) => `${s.label}/${scheme}/${width}`;
  // A word's preview.az is keyed `default`; preview.<variant>.az by its variant.
  const row = RESTACK[s.word]?.[s.variant ?? 'default'];
  const restackAt = typeof row === 'string' ? row : row?.at;
  const narrowColumns = typeof row === 'string' ? 1 : row?.narrow ?? 1;
  const tracks = {};

  const ctx = await browsers.chromium.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  const bg = {};
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'no-preference' });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await open(page, s.path, server);
      record(s.word, 'overflow', tag(scheme, width), await overflow(page));
      await page.screenshot({ path: join(shots, `${s.label.replace(':', '-')}-${scheme}-${width}.png`), fullPage: true });
      if (restackAt && scheme === 'light') tracks[width] = await columnsOf(page, restackAt);
      const disclose = DISCLOSE[s.word]?.[s.variant];
      if (disclose && scheme === 'light' && width !== 768) {
        record(s.word, 'disclosure', tag(scheme, width), await disclosure(page, width, disclose));
      }
      if (width === 390 && scheme === 'light' && await page.$('.az-skip-link')) {
        record(s.word, 'skip-link', tag(scheme, width), await skipLink(page));
      }
      if (width !== 768) record(s.word, 'axe', tag(scheme, width), await axe(page));
      if (width === 1440) {
        const column = COLUMN[s.word]?.[s.variant];
        if (column && scheme === 'light') record(s.word, 'column', `${s.label}/light`, await sharedColumn(page, column));
        bg[scheme] = await bodyBackground(page);
        record(s.word, 'keyboard', tag(scheme, width), await keyboard(page));
      }
    }
  }
  if (restackAt) record(s.word, 'restack', `${s.label}/light`, restacks(tracks[390], tracks[1440], narrowColumns));
  record(s.word, 'schemes', s.label, {
    pass: bg.light !== bg.dark,
    detail: `light and dark paint the same body background (${bg.light})`,
  });

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, s.path, server);
  record(s.word, 'reduced-motion', `${s.label}/light/1440`, await reducedMotion(page));
  await page.setViewportSize({ width: 390, height: 900 });
  await open(page, s.path, server);
  const still = await overlayMotion(page);
  if (still) record(s.word, 'overlay-motion', `${s.label}/light/390`, still);
  await open(page, s.path, server);
  const barStill = await navMotion(page);
  if (barStill) record(s.word, 'nav-motion', `${s.label}/light/390`, barStill);
  await ctx.close();

  // A6: the page as shipped, read with JavaScript off; then hydrated with
  // nothing reported — a mismatch throws the pre-rendered markup away.
  const url = new URL(s.path, server.url).href;
  record(s.word, 'no-js', `${s.label}/chromium/1440`, await noJs(browsers.chromium, url));
  record(s.word, 'hydration', `${s.label}/chromium/1440`, await hydration(browsers.chromium, url, READY));

  // The behaviour runtime, in a fresh context per width: the drawer is the
  // phone menu, the dropdown the desktop one; faq, copy, play and solid are
  // width-independent and checked on the desktop page. Every engine runs
  // them — a behaviour that works only in Chromium is not built.
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    for (const width of [390, 1440]) {
      const bctx = await browsers[engine].newContext({ viewport: { width, height: 900 } });
      const bpage = await bctx.newPage();
      bpage.setDefaultTimeout(NAV_TIMEOUT_MS);
      const checks = width === 390 ? { drawer, carousel } : { dropdown, solid, 'hide-shrink': hideShrink, 'scroll-padding': scrollPadding, faq, 'faq-deep-link': faqDeepLink, carousel, lightbox, copy, play };
      for (const [name, fn] of Object.entries(checks)) {
        await open(bpage, s.path, server);
        const r = await fn(bpage).catch((e) => ({ pass: false, detail: `threw: ${String(e.message).split('\n')[0]}` }));
        if (r) record(s.word, name, `${s.label}/${engine}/light/${width}`, r);
      }
      await bctx.close();
    }
  }

  // The smaller pass: another engine at one width, overflow and page errors.
  for (const [name, width] of [['firefox', 1440], ['webkit', 390]]) {
    const other = await browsers[name].newPage({ viewport: { width, height: 900 } });
    const errors = [];
    other.on('pageerror', (e) => errors.push(e.message));
    await open(other, s.path, server);
    const o = await overflow(other);
    record(s.word, name, `${s.label}/light/${width}`, {
      pass: o.pass && errors.length === 0,
      detail: [o.detail, ...errors.map((e) => `page error: ${e}`)].filter(Boolean).join('; '),
    });
    await other.close();
  }
}

/* ---- self-test: every check must be able to fail, and to pass ----------- */

const BAD = `<!doctype html><html lang="en"><head><title>bad</title><style>
  button:focus { outline: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 1s infinite; }
</style></head><body>
  <main id="m" tabindex="-1"><a href="#m">Skip to content</a><h1>Bad</h1>
  <div class="g" style="display:grid;grid-template-columns:1fr 1fr"><span>a</span><span>b</span></div>
  <div class="f" style="display:flex;flex-wrap:wrap;gap:8px"><span style="width:40px">a</span><span style="width:40px">b</span></div>
  <div style="display:grid;grid-template-columns:1fr 1fr"><p class="c1">Title</p><p class="c2">Sub</p></div>
  <div style="width:800px;height:10px"></div>
  <button></button>
  <button class="spin">Spin</button>
  <input aria-label="trap" onkeydown="if (event.key === 'Tab') event.preventDefault()">
  </main></body></html>`;

const GOOD = `<!doctype html><html lang="en"><head><title>good</title><style>
  body { background: white; }
  @media (prefers-color-scheme: dark) { body { background: black; color: white; } }
  @media (prefers-reduced-motion: no-preference) {
    /* transform, not opacity: a fading text's contrast depends on when axe
       samples it, which made this page's axe verdict timing-dependent. */
    @keyframes fade { from { transform: translateX(2px); } } .fade { animation: fade 1s infinite; }
  }
  .skip { position: absolute; top: 0; transform: translateY(-200%); }
  .skip:focus-visible { transform: none; }
  .g { display: grid; grid-template-columns: 1fr 1fr; }
  @media (width < 768px) { .g { grid-template-columns: 1fr; } }
</style></head><body>
  <header><a class="skip" href="#m">Skip to content</a></header>
  <main id="m" tabindex="-1"><h1>Good</h1>
  <div class="g"><span>a</span><span>b</span></div>
  <div class="f" style="display:flex;flex-wrap:wrap;gap:8px"><span style="width:40px">a</span><span style="width:40px">b</span></div>
  <style>@media (width < 768px) { .f { flex-direction: column; } }</style>
  <div style="display:grid;grid-template-columns:1fr 1fr"><div><p class="c1">Title</p><p class="c2">Sub</p></div><div></div></div>
  <p class="fade">Fits.</p>
  <a href="#x">A link</a> <button>A button</button>
  <fieldset><legend>Billing</legend>
    <label><input type="radio" name="billing" checked> Monthly</label>
    <label><input type="radio" name="billing"> Annual</label>
  </fieldset>
  </main></body></html>`;

/** nav §5: a pinned bar, with or without the scroll padding that clears it. */
const PINNED = (padded) => `<!doctype html><html lang="en"><head><title>pinned</title><style>
  ${padded ? 'html { scroll-padding-top: 88px; }' : ''}
  nav { position: sticky; top: 0; height: 72px; background: white; }
</style></head><body><nav aria-label="Main"><a href="/">Home</a></nav><main><h1>Pinned</h1></main></body></html>`;

/**
 * nav §10 Q2: a `side` column pinned beside the content. `beside` is the
 * layout the target emits (grid: column + content) and needs no padding;
 * `over` pins the same column on top of the content, which must fail.
 */
// The target's structure: a page wrapper holding the nav, then <main> as the
// content column (the nav sits before <main>, so the skip link skips it).
const SIDE = (beside) => `<!doctype html><html lang="en"><head><title>side</title><style>
  .az-page { ${beside ? 'display: grid; grid-template-columns: 256px minmax(0, 1fr); align-items: start;' : ''} }
  nav { position: ${beside ? 'sticky' : 'fixed'}; top: 0; left: 0; width: 256px; height: 100svh; background: white; }
</style></head><body><div class="az-page"><nav aria-label="Main"><a href="/">Home</a></nav>
<main><h1>Docs</h1></main></div></body></html>`;

/**
 * ASSUMPTIONS A6: a page as a build ships it. `full` is pre-rendered — an
 * open FAQ answer, a usable auth form, a year fallback — and marks itself
 * ready. `empty` ships an empty root that a script fills and reports a
 * hydration mismatch the way React does. `partial` is pre-rendered but its
 * FAQ answer ships hidden, its form has no field and its year is blank.
 */
const SHIPPED = (kind) => {
  const body = kind === 'partial'
    ? `<main><h1>Help</h1><div class="az-faq-answer" id="q1-panel" hidden>Yes.</div>
      <form class="az-auth-form" data-flow="login"><button type="submit">Sign in</button></form></main>
      <footer><p>© <span data-year="dynamic"></span> Site</p></footer>`
    : `<main><h1>Help</h1><div class="az-faq-answer" id="q1-panel">Yes.</div>
      <form class="az-auth-form" data-flow="login"><label>Email <input type="email" name="email"></label>
      <button type="submit">Sign in</button></form></main>
      <footer><p>© <span data-year="dynamic">2024</span> Site</p></footer>`;
  const root = kind === 'empty' ? '' : body;
  const fill = kind === 'empty'
    ? `document.getElementById('root').innerHTML = ${JSON.stringify(body)};
       console.error('Minified React error #418; visit https://react.dev/errors/418 for the full message');`
    : '';
  return `<!doctype html><html lang="en"><head><title>shipped</title></head><body>
  <div id="root">${root}</div>
  <script>${fill} document.documentElement.setAttribute('data-az-ready', '');</script></body></html>`;
};

async function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), 'az-visual-self-'));
  for (const [name, html] of [['bad', BAD], ['good', GOOD]]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'index.html'), html);
  }
  const server = await startServer();
  const browser = await chromium.launch();
  let wrong = 0;
  const expect = (label, r, shouldPass) => {
    const ok = r.pass === shouldPass;
    if (!ok) wrong++;
    console.log(`  ${ok ? 'ok  ' : 'WRONG'}  ${label}: ${r.pass ? 'PASS' : 'FAIL'}${r.detail ? ` — ${r.detail}` : ''}`);
  };
  for (const [name, shouldPass] of [['bad', false], ['good', true]]) {
    console.log(`\n${name} page — every check should ${shouldPass ? 'PASS' : 'FAIL'}`);
    server.serve(join(dir, name));
    // AxeBuilder requires a page from an explicit context.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(server.url);
    // First, on a fresh load — as the real run does — before any other walk
    // has moved focus.
    expect('nav §7 skip link visible on focus', await skipLink(page), shouldPass);
    // Reload: blur does not reset where the next Tab starts from, and the
    // keyboard walk below must begin at the top as it does in the real run.
    await page.reload();
    expect('item 3 overflow at 390', await overflow(page), shouldPass);
    expect('item 4 axe', await axe(page), shouldPass);
    expect('item 5 keyboard', await keyboard(page), shouldPass);
    const narrow = await columnsOf(page, '.g');
    const narrowFlex = await columnsOf(page, '.f');
    await page.setViewportSize({ width: 1440, height: 900 });
    expect('responsive table: restacks below sm', restacks(narrow, await columnsOf(page, '.g')), shouldPass);
    expect('responsive table: a flex row stacks below sm', restacks(narrowFlex, await columnsOf(page, '.f')), shouldPass);
    expect('text shares one column', await sharedColumn(page, ['.c1', '.c2']), shouldPass);
    await page.setViewportSize({ width: 390, height: 900 });
    const bg = {};
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      bg[scheme] = await bodyBackground(page);
    }
    expect('item 7 schemes differ', { pass: bg.light !== bg.dark, detail: `${bg.light} / ${bg.dark}` }, shouldPass);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.reload();
    expect('item 6 reduced motion', await reducedMotion(page), shouldPass);
    await ctx.close();
  }
  for (const [name, padded] of [['pinned-bad', false], ['pinned-good', true]]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'index.html'), PINNED(padded));
    server.serve(join(dir, name));
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(server.url);
    expect(`nav §5 scroll padding (${padded ? 'good' : 'bad'} page)`, await scrollPadding(page), padded);
    await ctx.close();
  }
  for (const [name, beside] of [['side-over', false], ['side-beside', true]]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'index.html'), SIDE(beside));
    server.serve(join(dir, name));
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(server.url);
    expect(`nav §10 side column (${beside ? 'beside the content' : 'over the content'})`, await scrollPadding(page), beside);
    await ctx.close();
  }
  for (const [name, shipped, shouldPass] of [
    ['shipped-empty', 'empty', false], ['shipped-partial', 'partial', false], ['shipped-full', 'full', true],
  ]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'index.html'), SHIPPED(shipped));
    server.serve(join(dir, name));
    expect(`A6 reads with JS off (${shipped} page)`, await noJs(browser, server.url), shouldPass);
    // The partial page's markup is all there; only its hydration is clean.
    expect(`A6 hydrates cleanly (${shipped} page)`, await hydration(browser, server.url, READY), shipped !== 'empty');
  }
  console.log('\nbehaviour runtime — each check fails without it and passes with it');
  await behaviourSelfTest(browser, server, dir, expect);
  await browser.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${wrong === 0 ? 'SELF-TEST PASSED — every check fails the bad page and passes the good one' : `SELF-TEST FAILED — ${wrong} check(s) misjudged`}`);
  return wrong === 0 ? 0 : 1;
}

/* ---- main --------------------------------------------------------------- */

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();

  const everyVariant = argv.includes('--every-variant');
  const names = argv.filter((a) => !a.startsWith('--'));
  const all = readdirSync(WORDS).filter((w) => existsSync(join(WORDS, w, 'preview.az'))).sort();
  const words = names.length ? all.filter((w) => names.includes(w)) : all;
  const unknown = names.filter((a) => !all.includes(a));
  if (unknown.length) throw new Error(`visual: no preview for: ${unknown.join(', ')}`);

  const started = performance.now();
  const work = mkdtempSync(join(tmpdir(), 'az-visual-'));
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const sites = await buildAll(words, work, everyVariant);
  const browsers = { chromium: await chromium.launch(), firefox: await firefox.launch(), webkit: await webkit.launch() };
  const versions = Object.fromEntries(Object.entries(browsers).map(([k, b]) => [k, b.version()]));
  const server = await startServer();
  try {
    for (const s of sites) {
      await checkSite(s, browsers, server);
      process.stdout.write(`checked ${s.word}/${s.label}\n`);
    }
  } finally {
    await server.close();
    await Promise.all(Object.values(browsers).map((b) => b.close()));
  }

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n${pad('word', 10)}${CHECKS.map((c) => pad(c, 16)).join('')}`);
  let failed = 0;
  for (const w of words) {
    console.log(pad(w, 10) + CHECKS.map((c) => {
      const cell = results[w]?.[c] ?? { pass: 0, fail: 0 };
      failed += cell.fail;
      return pad(cell.fail ? `FAIL ${cell.fail}/${cell.pass + cell.fail}` : `pass ${cell.pass}`, 16);
    }).join(''));
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ versions, seconds: Number(seconds), results }, null, 2) + '\n');
  console.log(`\nbrowsers: ${Object.entries(versions).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  console.log(`${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`} in ${seconds}s — details in .visual-out/report.json`);
  if (failed === 0) rmSync(work, { recursive: true, force: true });
  else console.log(`work dir kept for inspection: ${work}`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
