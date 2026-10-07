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
 * and, from the gallery spec (§7 rule 1), that images held back and then
 * released move nothing on the page (`image-shift`, CLS 0); from the hero
 * spec (§10), that text over a poster keeps 4.5:1 at 375, 768 and 1440px
 * (`over-media`), and (§2) that a centred column centres on one axis
 * (`centred`).
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
import { crc32, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { WIDTHS, FRAME_WIDTH, overflow, axe, keyboard, reducedMotion, bodyBackground, columnsOf, restacks, sharedColumn, skipLink, noJs, hydration, imageShift, frame, fonts, themeReading, settingsDiffer, textOverPoster, centredUnder, PHONE_WIDTH } from './visual/checks.mjs';
import { FONT_STACKS, THEMES as THEME_TOKENS } from '../packages/theme/src/index.ts';
import { startServer } from './visual/serve.mjs';
import {
  billing, carousel, copy, drawer, dropdown, faq, faqDeepLink, hideShrink, lightbox, navMotion, overlayMotion, play, reveal, revealReduced, scrollPadding, sheetDrag, solid, year,
} from './visual/behaviours.mjs';
import { behaviourSelfTest } from './visual/behaviour-selftest.mjs';
import { withVariant } from './thumbnails.mjs';
import { COMPILE_MS, INSTALL_MS, PROJECT_BUILD_MS } from './visual/pipeline.mjs';
import { Overdue, within, closeWithin, watchdog, human, slowest } from './lib/bounded.mjs';

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

/*
 * Deadlines (lib/bounded.mjs). page.evaluate has no timeout of its own, so a
 * check whose page never answers would otherwise wait forever — one did, for
 * 4h18m. Sized from measured runs (the slowest completions print at the end)
 * with several times the margin, so only a stuck engine ever reaches them.
 */
/** One check, setup step or reload. */
const CHECK_MS = 60_000;
/**
 * Every check of one site, all engines. A site takes 15–40s; the slowest,
 * a 3D scene, took 100s on a machine running three gates at once.
 */
const SITE_MS = 10 * 60_000;
/** The whole run: a base plus a share per site — about 5× a normal run. */
const RUN_BASE_MS = 20 * 60_000;
const RUN_PER_SITE_MS = 2 * 60_000;
/** Closing a page, context, browser or server. */
const CLOSE_MS = 15_000;
/** Building every site, before the whole-run deadline is known. */
const BUILD_ALL_MS = 60 * 60_000;
/** The self-test: the whole of it, and its stuck page's one check. */
const SELF_TEST_MS = 15 * 60_000;
const SELF_TEST_CHECK_MS = 5_000;

/* ---- npm and vite without a shell (see verify-build.mjs for why) -------- */

const NODE_DIR = dirname(process.execPath);
const NPM_CLI = [
  join(NODE_DIR, 'node_modules/npm/bin/npm-cli.js'),
  join(NODE_DIR, '../lib/node_modules/npm/bin/npm-cli.js'),
].find((c) => existsSync(c));
if (!NPM_CLI) throw new Error(`visual: npm-cli.js not found in the node install at ${NODE_DIR}`);

const execFileP = promisify(execFile);
const node = (script, args, cwd, timeout) => execFileP(process.execPath, [script, ...args], {
  cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  // Bounded: a hung child is killed and its call rejects, naming the signal.
  timeout, killSignal: 'SIGKILL',
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

const CHECKS = ['compile', 'deadline', 'overflow', 'axe', 'keyboard', 'reduced-motion', 'schemes', 'restack', 'column', 'frame', 'font', 'theme-settings', 'disclosure', 'skip-link',
  'no-js', 'hydration', 'image-shift', 'over-media', 'centred',
  'drawer', 'dropdown', 'solid', 'hide-shrink', 'scroll-padding', 'faq', 'faq-deep-link', 'carousel', 'lightbox', 'copy', 'play', 'overlay-motion', 'nav-motion',
  'reveal', 'reveal-reduced', 'sheet-drag',
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
 * Text over media, per word and variant (hero-spec §9/§10): on a phone, a
 * tablet and a desktop (OVER_MEDIA_WIDTHS), each on a tall and a short
 * screen (OVER_MEDIA_HEIGHTS), at the static tier — reduced
 * motion, so the poster is what shows — every line of text keeps 4.5:1 over
 * the darkest and the lightest poster fixture (files in the word's
 * preview-assets/assets). A variant listed here needs a
 * `preview.<variant>.az` with a poster, which the check swaps for each.
 */
const OVER_MEDIA = {
  hero: {
    full: {
      poster: '.az-hero-poster',
      text: ['.az-hero-eyebrow', '.az-hero-title', '.az-hero-sub', '.az-hero .az-action--secondary'],
      fixtures: ['poster-dark.webp', 'poster-light.webp'],
    },
  },
};
/** The widths over-media measures: the narrowest phone, then the tablet and desktop gate widths. */
const OVER_MEDIA_WIDTHS = [PHONE_WIDTH, WIDTHS[1], WIDTHS[2]];
/**
 * The heights it measures each width at. The header's height is a minimum
 * and its copy is centred in it, so WHERE the text sits over the scrim
 * depends on the screen: on a tall one the copy sits mid-gradient; on a
 * short one — a landscape phone, a short browser window — the copy fills the
 * header and the eyebrow sits at the scrim's lightest end, its top edge.
 */
const OVER_MEDIA_HEIGHTS = [900, 390];

/**
 * Centred layouts, per word and variant (hero-spec §2: a single centred
 * column of type): the sub's and the actions' horizontal centres sit within
 * 1px of the title's, on a desktop and on a phone (CENTRED_WIDTHS). A word's
 * preview.az is keyed `default`.
 */
const CENTRED = {
  hero: {
    default: { title: '.az-hero-title', under: ['.az-hero-sub', '.az-hero-actions'] },
    full: { title: '.az-hero-title', under: ['.az-hero-sub', '.az-hero-actions'] },
  },
};
const CENTRED_WIDTHS = [WIDTHS[2], PHONE_WIDTH];

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

/**
 * theme-spec §8.1, checked on the hero (it carries the page's <h1>): the
 * preview as written must render the theme's own families, and the same
 * preview with these `font` roles must render the role's stacks — in every
 * theme. The roles differ from every theme's own stacks, so a site that
 * ignored `font` cannot pass both.
 */
const FONT_WORD = 'hero';
const FONT_ROLES = { display: 'serif', body: 'mono' };

/** preview.az with a `font` block as the site's first child. */
function withFonts(source) {
  const lines = source.split('\n');
  const at = lines.findIndex((l) => /^site\b/.test(l));
  lines.splice(at + 1, 0, '  font', ...Object.entries(FONT_ROLES).map(([r, f]) => `    ${r} ${f}`));
  return lines.join('\n');
}

/** The families a site should render: its theme's, with any role overridden. */
function expectedFonts(theme, roles = {}) {
  const t = THEME_TOKENS[theme].type;
  return {
    display: roles.display ? FONT_STACKS[roles.display] : t.display,
    body: roles.body ? FONT_STACKS[roles.body] : t.body,
  };
}

/**
 * PRD §6.1a, checked on the hero (it paints the pattern): the preview as
 * written and the same preview with each of these `theme` settings, in one
 * theme. Each must render its own accent colour and its own pattern, and the
 * preview as written no pattern — so a site that dropped either setting, or
 * rendered every value alike, cannot pass.
 */
const THEME_SETTINGS = [
  { accent: 'teal', pattern: 'glow top' },
  { accent: 'rose', pattern: 'dots center' },
];

/** preview.az with `theme <name>` plus its settings as the site's first child. */
function withSettings(source, theme, settings) {
  const lines = source.split('\n');
  const at = lines.findIndex((l) => /^site\b/.test(l));
  lines.splice(at + 1, 0, `  theme ${theme}`, ...Object.entries(settings).map(([k, v]) => `    ${k} ${v}`));
  return lines.join('\n');
}

/** What the theme-settings sites rendered, compared once all are checked. */
const themeReadings = [];

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
  if (words.includes(FONT_WORD)) {
    const preview = readFileSync(join(WORDS, FONT_WORD, 'preview.az'), 'utf8');
    for (const theme of THEMES) {
      sites.push({ word: FONT_WORD, theme, variant: null, file: 'preview.az + font', source: withFonts(preview),
        label: `${theme}:font`, roles: FONT_ROLES });
    }
    THEME_SETTINGS.forEach((settings, i) => {
      sites.push({ word: FONT_WORD, theme: VARIANT_THEME, variant: null, file: `preview.az + theme settings ${i + 1}`,
        source: withSettings(preview, VARIANT_THEME, settings), label: `${VARIANT_THEME}:${settings.accent}`, settings });
    });
  }
  for (const s of sites) {
    s.dir = join(work, `${s.word}-${s.variant ?? 'default'}-${s.theme}${s.roles ? '-font' : ''}${s.settings ? `-${s.settings.accent}` : ''}`);
    mkdirSync(s.dir, { recursive: true });
    const src = join(WORDS, s.word);
    const preview = s.source ?? readFileSync(join(src, s.file), 'utf8');
    writeFileSync(join(s.dir, 'site.az'), s.settings ? preview : themed(preview, s.theme));
    // Each page is its own HTML file, and a preview's extra pages exist only
    // so its links resolve. The word under test is on the FIRST page declared.
    s.path = firstRoute(preview);
    if (existsSync(join(src, 'preview-assets'))) cpSync(join(src, 'preview-assets'), join(s.dir, 'preview-assets'), { recursive: true });
  }
  // A preview that no longer compiles is a finding for that word, not a
  // reason to skip every other word.
  await pool(sites, BUILD_CONCURRENCY, async (s) => {
    try {
      await node(CLI, ['build', join(s.dir, 'site.az'), '--out', join(s.dir, 'proj')], s.dir, COMPILE_MS);
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
    await node(NPM_CLI, ['install', '--no-audit', '--no-fund'], dir, INSTALL_MS);
  }
  console.log(`installed ${installs.size} shared node_modules`);

  await pool(built, BUILD_CONCURRENCY, async (s) => {
    const proj = join(s.dir, 'proj');
    symlinkSync(join(s.install, 'node_modules'), join(proj, 'node_modules'), 'dir');
    // The project's OWN build: the client bundle, then every page
    // pre-rendered — so every check below sees the pages that ship.
    await node(join(proj, 'az-vite/build.mjs'), [], proj, PROJECT_BUILD_MS);
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

/**
 * A page that can be thrown away and replaced: its context, its settings,
 * and the site page it shows. When a check misses its deadline the page is
 * presumed stuck — `reset` closes it (bounded) and opens a fresh one in the
 * same state, so the next check runs on a live page.
 */
async function surface(browser, server, path, init = {}) {
  const sf = { ctx: null, page: null, media: null, viewport: init.viewport ?? null };
  sf.reset = async (reopen = true) => {
    if (sf.ctx) await closeWithin(sf.ctx, CLOSE_MS, 'context.close');
    sf.ctx = await within(CHECK_MS, 'newContext', () => browser.newContext(init));
    sf.page = await within(CHECK_MS, 'newPage', () => sf.ctx.newPage());
    sf.page.setDefaultTimeout(NAV_TIMEOUT_MS);
    if (sf.viewport) await within(CHECK_MS, 'setViewportSize', () => sf.page.setViewportSize(sf.viewport));
    if (sf.media) await within(CHECK_MS, 'emulateMedia', () => sf.page.emulateMedia(sf.media));
    if (reopen) await within(CHECK_MS, 'reload', () => open(sf.page, path, server));
  };
  /** Change media and/or viewport, remembered for a reset. */
  sf.set = async ({ media, viewport }) => {
    if (media) { sf.media = media; await sf.page.emulateMedia(media); }
    if (viewport) { sf.viewport = viewport; await sf.page.setViewportSize(viewport); }
  };
  sf.close = () => closeWithin(sf.ctx, CLOSE_MS, 'context.close');
  await sf.reset(false);
  return sf;
}

/**
 * `fn(page)` within `ms`. A miss is recorded as a FAIL of `check` naming the
 * engine and place, the page is replaced, and the result is undefined — so
 * one stuck check costs one deadline, not the run.
 */
async function guardedCheck(sf, word, engine, check, where, fn, ms = CHECK_MS) {
  try {
    return await within(ms, `${check} @ ${engine} ${word}/${where}`, () => fn(sf.page));
  } catch (e) {
    if (!(e instanceof Overdue)) throw e;
    record(word, check, where, { pass: false, detail: `${engine}: ${e.message} — page replaced` });
    await sf.reset();
    return undefined;
  }
}

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

  const guarded = (sf, engine, check, where, fn) => guardedCheck(sf, s.word, engine, check, where, fn);
  const sf = await surface(browsers.chromium, server, s.path);
  /** A chromium check whose result is recorded as returned (a null result is "not applicable"). */
  const checked = async (check, where, fn) => {
    const r = await guarded(sf, 'chromium', check, where, fn);
    if (r) record(s.word, check, where, r);
    return r;
  };
  /** Settings, then the page reloaded in them — one bounded step. */
  const load = (check, where, settings) => guarded(sf, 'chromium', check, where, async (page) => {
    await sf.set(settings);
    await open(page, s.path, server);
    return true;
  });

  const bg = {};
  for (const scheme of SCHEMES) {
    for (const width of WIDTHS) {
      const where = tag(scheme, width);
      if (!await load('overflow', where, { media: { colorScheme: scheme, reducedMotion: 'no-preference' }, viewport: { width, height: 900 } })) continue;
      await checked('overflow', where, overflow);
      await guarded(sf, 'chromium', 'overflow', where, (page) =>
        page.screenshot({ path: join(shots, `${s.label.replace(':', '-')}-${scheme}-${width}.png`), fullPage: true }));
      if (restackAt && scheme === 'light') tracks[width] = await guarded(sf, 'chromium', 'restack', where, (page) => columnsOf(page, restackAt));
      const disclose = DISCLOSE[s.word]?.[s.variant];
      if (disclose && scheme === 'light' && width !== 768) {
        await checked('disclosure', where, (page) => disclosure(page, width, disclose));
      }
      if (width === 390 && scheme === 'light' && await guarded(sf, 'chromium', 'skip-link', where, (page) => page.$('.az-skip-link'))) {
        await checked('skip-link', where, skipLink);
      }
      if (width !== 768) await checked('axe', where, axe);
      if (width === 1440) {
        const column = COLUMN[s.word]?.[s.variant];
        if (column && scheme === 'light') await checked('column', `${s.label}/light`, (page) => sharedColumn(page, column));
        bg[scheme] = await guarded(sf, 'chromium', 'schemes', where, bodyBackground);
        await checked('keyboard', where, keyboard);
      }
    }
  }
  // A width whose reading missed its deadline is already a FAIL; 0 and -1 are readings.
  if (restackAt && tracks[390] !== undefined && tracks[1440] !== undefined) record(s.word, 'restack', `${s.label}/light`, restacks(tracks[390], tracks[1440], narrowColumns));
  // PRD §6.1a: wider than the frame, every block's content sits inside it.
  const wide = `${s.label}/light/${FRAME_WIDTH}`;
  if (await load('frame', wide, { media: { colorScheme: 'light', reducedMotion: 'no-preference' }, viewport: { width: FRAME_WIDTH, height: 900 } })) {
    await checked('frame', wide, frame);
    // theme-spec §8.1: the hero's preview as written (the theme's families) and
    // the same preview with `font` roles (the roles' stacks).
    if (s.word === FONT_WORD && !s.variant) {
      await checked('font', wide, (page) => fonts(page, expectedFonts(s.theme, s.roles)));
    }
    // PRD §6.1a: the hero preview as written and with each theme setting.
    if (s.word === FONT_WORD && !s.variant && !s.roles && s.theme === VARIANT_THEME) {
      const reading = await guarded(sf, 'chromium', 'theme-settings', wide, themeReading);
      if (reading) themeReadings.push({ label: s.label, patterned: Boolean(s.settings), ...reading });
    }
  }
  if (bg.light !== undefined && bg.dark !== undefined) {
    record(s.word, 'schemes', s.label, {
      pass: bg.light !== bg.dark,
      detail: `light and dark paint the same body background (${bg.light})`,
    });
  }

  // hero-spec §10: text over the poster on a phone, a tablet and a desktop, in both schemes.
  const overMedia = OVER_MEDIA[s.word]?.[s.variant];
  if (overMedia) {
    const fixtures = overMedia.fixtures.map((name) => ({
      name, type: 'image/webp', bytes: readFileSync(join(WORDS, s.word, 'preview-assets/assets', name)),
    }));
    for (const scheme of SCHEMES) {
      for (const width of OVER_MEDIA_WIDTHS) {
        for (const height of OVER_MEDIA_HEIGHTS) {
          const where = `${tag(scheme, width)}x${height}`;
          if (await load('over-media', where, { media: { colorScheme: scheme, reducedMotion: 'reduce' }, viewport: { width, height } })) {
            await checked('over-media', where, (page) => textOverPoster(page, overMedia, fixtures));
          }
        }
      }
    }
  }
  // hero-spec §2: a centred column centres every part of it on one axis.
  const centred = CENTRED[s.word]?.[s.variant ?? 'default'];
  if (centred) {
    for (const width of CENTRED_WIDTHS) {
      const where = tag('light', width);
      if (await load('centred', where, { media: { colorScheme: 'light', reducedMotion: 'no-preference' }, viewport: { width, height: 900 } })) {
        await checked('centred', where, (page) => centredUnder(page, centred));
      }
    }
  }
  const reduced = { colorScheme: 'light', reducedMotion: 'reduce' };
  if (await load('reduced-motion', `${s.label}/light/1440`, { media: reduced, viewport: { width: 1440, height: 900 } })) {
    await checked('reduced-motion', `${s.label}/light/1440`, reducedMotion);
  }
  if (await load('overlay-motion', `${s.label}/light/390`, { viewport: { width: 390, height: 900 } })) {
    await checked('overlay-motion', `${s.label}/light/390`, overlayMotion);
  }
  if (await load('nav-motion', `${s.label}/light/390`, {})) {
    await checked('nav-motion', `${s.label}/light/390`, navMotion);
  }
  if (await load('reveal-reduced', `${s.label}/light/1440`, { viewport: { width: 1440, height: 900 } })) {
    await checked('reveal-reduced', `${s.label}/light/1440`, revealReduced);
  }
  await sf.close();

  // A6: the page as shipped, read with JavaScript off; then hydrated with
  // nothing reported — a mismatch throws the pre-rendered markup away. Each
  // opens its own context; one that misses its deadline is left to the
  // browser's close.
  const url = new URL(s.path, server.url).href;
  // gallery-spec §7 rule 1: images held, then released — nothing moves.
  for (const [check, fn] of [
    ['no-js', () => noJs(browsers.chromium, url)],
    ['hydration', () => hydration(browsers.chromium, url, READY)],
    ['image-shift', () => imageShift(browsers.chromium, url, READY)],
  ]) {
    const where = `${s.label}/chromium/1440`;
    try {
      record(s.word, check, where, await within(CHECK_MS, `${check} @ chromium ${s.word}/${where}`, fn));
    } catch (e) {
      if (!(e instanceof Overdue)) throw e;
      record(s.word, check, where, { pass: false, detail: `chromium: ${e.message}` });
    }
  }

  // The behaviour runtime, in a fresh context per width: the drawer is the
  // phone menu, the dropdown the desktop one; faq, copy, play and solid are
  // width-independent and checked on the desktop page. Every engine runs
  // them — a behaviour that works only in Chromium is not built.
  for (const engine of ['chromium', 'firefox', 'webkit']) {
    for (const width of [390, 1440]) {
      const bsf = await surface(browsers[engine], server, s.path, { viewport: { width, height: 900 } });
      const checks = width === 390 ? { drawer, carousel, 'sheet-drag': sheetDrag } : { dropdown, solid, 'hide-shrink': hideShrink, 'scroll-padding': scrollPadding, faq, 'faq-deep-link': faqDeepLink, carousel, lightbox, copy, play, billing, year, reveal };
      for (const [name, fn] of Object.entries(checks)) {
        const where = `${s.label}/${engine}/light/${width}`;
        const r = await guarded(bsf, engine, name, where, async (page) => {
          await open(page, s.path, server);
          return fn(page).catch((e) => ({ pass: false, detail: `threw: ${String(e.message).split('\n')[0]}` }));
        });
        if (r) record(s.word, name, where, r);
      }
      await bsf.close();
    }
  }

  // The smaller pass: another engine at one width, overflow and page errors.
  for (const [name, width] of [['firefox', 1440], ['webkit', 390]]) {
    const osf = await surface(browsers[name], server, s.path, { viewport: { width, height: 900 } });
    const errors = [];
    osf.page.on('pageerror', (e) => errors.push(e.message));
    const where = `${s.label}/light/${width}`;
    const o = await guarded(osf, name, name, where, async (page) => {
      await open(page, s.path, server);
      return overflow(page);
    });
    if (o) {
      record(s.word, name, where, {
        pass: o.pass && errors.length === 0,
        detail: [o.detail, ...errors.map((e) => `page error: ${e}`)].filter(Boolean).join('; '),
      });
    }
    await osf.close();
  }
}

/* ---- self-test: every check must be able to fail, and to pass ----------- */

const BAD = `<!doctype html><html lang="en"><head><title>bad</title><style>
  button:focus { outline: none; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin 1s infinite; }
</style></head><body>
  <div class="az-site" style="--az-frame: 1440px"><div class="az-page">
  <main id="m" tabindex="-1"><a href="#m">Skip to content</a><h1>Bad</h1>
  <section class="frame-probe" style="padding-inline: 64px"><p>Unframed: content runs past the frame.</p></section>
  <div class="g" style="display:grid;grid-template-columns:1fr 1fr"><span>a</span><span>b</span></div>
  <div class="f" style="display:flex;flex-wrap:wrap;gap:8px"><span style="width:40px">a</span><span style="width:40px">b</span></div>
  <div style="display:grid;grid-template-columns:1fr 1fr"><p class="c1">Title</p><p class="c2">Sub</p></div>
  <div style="width:800px;height:10px"></div>
  <button></button>
  <button class="spin">Spin</button>
  <input aria-label="trap" onkeydown="if (event.key === 'Tab') event.preventDefault()">
  </main></div></div></body></html>`;

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
  /* PRD §6.1a: each block insets its content to the site frame. */
  .az-page > :not(main), main > * { padding-inline: max(24px, calc((100% - var(--az-frame, 100%)) / 2)); }
</style></head><body>
  <div class="az-site" style="--az-frame: 1440px"><div class="az-page">
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
  </main></div></div></body></html>`;

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

/**
 * gallery-spec §7 rule 1: a photo above the text and one far below the fold
 * (lazy), as a word emits them — with the file's width/height, or without.
 */
const SHIFT = (sized) => {
  const img = (lazy) => `<img src="/photo.png" alt="A photo"${sized ? ' width="320" height="200"' : ''}${lazy ? ' loading="lazy"' : ''}
    style="display:block;width:100%;height:auto">`;
  return `<!doctype html><html lang="en"><head><title>shift</title></head><body><main><h1>Shift</h1>
  ${img(false)}<p>Text under the photo.</p><div style="height:3000px"></div>${img(true)}<p>The end.</p></main>
  <script>document.documentElement.setAttribute('data-az-ready', '');</script></body></html>`;
};

/**
 * hero-spec §10: light text on a poster, straight on it or over a scrim that
 * holds for any poster — as `full` sets its type over its visual.
 */
const OVER = (scrimmed) => `<!doctype html><html lang="en"><head><title>over media</title></head><body><main>
  <header style="position:relative;isolation:isolate;min-height:400px;padding:24px;color:#fff">
  <img class="p" src="/poster.png" alt="" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:-1">
  ${scrimmed ? '<div style="position:absolute;inset:0;z-index:-1;background:rgb(0 0 0 / 0.8)"></div>' : ''}
  <h1>Over media</h1><p>Light text on the poster.</p></header></main></body></html>`;

/**
 * hero-spec §2: a centred column — flex, text centred — whose title, sub and
 * actions either centre on one axis or, as `full` once did, sit in boxes at
 * the start edge with only their text centred inside them.
 */
const CENTRE = (centred) => `<!doctype html><html lang="en"><head><title>centred</title></head><body><main>
  <header style="display:flex;flex-direction:column;text-align:center;padding-inline:64px${centred ? ';align-items:center' : ''}">
  <h1 class="t" style="max-width:20ch;margin:0">Built in the dark</h1>
  <p class="s" style="max-width:40ch">Handmade.</p>
  <ul class="a" style="display:flex;gap:16px;list-style:none;padding:0"><li><a href="/x">Reserve</a></li><li><a href="/y">See</a></li></ul>
  </header></main></body></html>`;

/** A real PNG of one grey (`value`, 0–255), made here so no binary is checked in. */
function solidPng(width, height, value = 0x80) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);                           // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, value)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A page that never answers once a check measures it: its script spins
 * inside getBoundingClientRect, as a stuck engine spins. Loading it is fine
 * (the ready mark is set before anything measures).
 */
const STUCK = `<!doctype html><html lang="en"><head><title>stuck</title><script>
  Element.prototype.getBoundingClientRect = function () { for (;;) {} };
  document.documentElement.setAttribute('data-az-ready', '');
</script></head><body><main><h1>Stuck</h1></main></body></html>`;

/**
 * The deadline: a check on the stuck page must FAIL at its deadline naming
 * the check, engine and place, and leave a live page behind. Without the
 * deadline this check waits forever (it once held the gate for 4h18m).
 */
async function deadlineSelfTest(browser, server, dir, expect) {
  mkdirSync(join(dir, 'stuck'));
  writeFileSync(join(dir, 'stuck', 'index.html'), STUCK);
  server.serve(join(dir, 'stuck'));
  const sf = await surface(browser, server, '/', { viewport: { width: 390, height: 900 } });
  await within(CHECK_MS, 'open the stuck page', () => open(sf.page, '/', server));
  const stuckPage = sf.page;
  const started = performance.now();
  const r = await guardedCheck(sf, 'self-test', 'chromium', 'overflow', 'stuck/390', overflow, SELF_TEST_CHECK_MS);
  const took = performance.now() - started;
  const failure = results['self-test']?.overflow?.failures[0] ?? '';
  expect('deadline: overflow on a page that never answers', {
    pass: r !== undefined || !failure.includes('overflow @ chromium self-test/stuck/390'),
    detail: failure,
  }, false);
  // The deadline, then the stuck page's bounded close and a bounded reopen.
  const limit = SELF_TEST_CHECK_MS + CLOSE_MS + NAV_TIMEOUT_MS;
  expect(`deadline: the FAIL comes in time (under ${human(limit)})`, { pass: took < limit, detail: `${(took / 1000).toFixed(1)}s` }, true);
  const title = await within(SELF_TEST_CHECK_MS, 'the replaced page answers', () => sf.page.evaluate(() => document.title)).catch((e) => e.message);
  expect('deadline: a new, live page replaces the stuck one', {
    pass: sf.page !== stuckPage && title === 'stuck', detail: String(title),
  }, true);
  await sf.close();
}

async function selfTest() {
  const progress = { last: 'starting' };
  const run = watchdog(SELF_TEST_MS, 'test:visual --self-test', progress);
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
    progress.last = label;
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
    await page.setViewportSize({ width: FRAME_WIDTH, height: 900 });
    expect('PRD §6.1a content sits in the site frame', await frame(page), shouldPass);
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
  // theme-spec §8.1: a page that sets the families it was asked for, and one
  // left to the browser's default face — the bug `font` used to ship.
  for (const [name, styled] of [['fonts-bad', false], ['fonts-good', true]]) {
    mkdirSync(join(dir, name));
    const css = styled ? `body { font-family: ${FONT_STACKS.mono}; } h1 { font-family: ${FONT_STACKS.serif}; }` : '';
    writeFileSync(join(dir, name, 'index.html'),
      `<!doctype html><html lang="en"><head><title>fonts</title><style>${css}</style></head><body><main><h1>Fonts</h1><p>Body.</p></main></body></html>`);
    server.serve(join(dir, name));
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(server.url);
    expect(`theme-spec §8.1 font roles render (${styled ? 'good' : 'bad'} page)`,
      await fonts(page, { display: FONT_STACKS.serif, body: FONT_STACKS.mono }), styled);
    await ctx.close();
  }
  // PRD §6.1a: sites that set different accents and patterns, and the bug
  // `theme` used to ship — every setting dropped, every site alike.
  for (const [name, honoured] of [['settings-bad', false], ['settings-good', true]]) {
    const readings = [];
    for (const [i, ink] of ['#7c3aed', '#0f766e', '#be123c'].entries()) {
      const page = `${name}-${i}`;
      const accent = honoured ? ink : '#7c3aed';
      const pattern = honoured && i > 0 ? `radial-gradient(circle at ${i * 30}% 10%, ${ink}, transparent)` : 'none';
      mkdirSync(join(dir, page));
      writeFileSync(join(dir, page, 'index.html'),
        `<!doctype html><html lang="en"><head><title>theme</title><style>:root { --az-color-accent: ${accent}; } header { background-image: ${pattern}; }</style></head><body><header><h1>Theme</h1></header></body></html>`);
      server.serve(join(dir, page));
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await ctx.newPage();
      await p.goto(server.url);
      readings.push({ label: page, patterned: i > 0, ...await themeReading(p) });
      await ctx.close();
    }
    expect(`PRD §6.1a theme settings render per value (${honoured ? 'good' : 'bad'} sites)`, settingsDiffer(readings), honoured);
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
  // gallery-spec §7 rule 1: the same image, with and without its size.
  for (const [name, sized] of [['shift-unsized', false], ['shift-sized', true]]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'index.html'), SHIFT(sized));
    writeFileSync(join(dir, name, 'photo.png'), solidPng(320, 200));
    server.serve(join(dir, name));
    expect(`§7 rule 1 a late image moves nothing (${sized ? 'sized' : 'unsized'} page)`,
      await within(CHECK_MS, 'image-shift self-test', () => imageShift(browser, server.url, READY)), sized);
  }
  // hero-spec §10: the darkest and the lightest poster, as the real run swaps them.
  const posters = [['black', 0], ['white', 255]].map(([name, value]) => ({ name, type: 'image/png', bytes: solidPng(320, 200, value) }));
  for (const [name, scrimmed] of [['media-bare', false], ['media-scrim', true]]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'index.html'), OVER(scrimmed));
    writeFileSync(join(dir, name, 'poster.png'), solidPng(320, 200));
    server.serve(join(dir, name));
    const ctx = await browser.newContext({ viewport: { width: PHONE_WIDTH, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(server.url);
    expect(`hero §10 text over media holds 4.5:1 (${scrimmed ? 'scrimmed' : 'bare'} page)`,
      await within(CHECK_MS, 'over-media self-test', () => textOverPoster(page, { poster: '.p', text: ['h1', 'p'] }, posters)), scrimmed);
    await closeWithin(ctx, CLOSE_MS, 'context.close');
  }
  // hero-spec §2: the start-edge boxes and the centred column, at both widths the real run uses.
  for (const [name, centred] of [['centre-start', false], ['centre-axis', true]]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, 'index.html'), CENTRE(centred));
    server.serve(join(dir, name));
    for (const width of CENTRED_WIDTHS) {
      const ctx = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await ctx.newPage();
      await page.goto(server.url);
      expect(`hero §2 the column centres on one axis (${centred ? 'centred' : 'start-edge'} page, ${width}px)`,
        await within(CHECK_MS, 'centred self-test', () => centredUnder(page, { title: '.t', under: ['.s', '.a'] })), centred);
      await closeWithin(ctx, CLOSE_MS, 'context.close');
    }
  }
  console.log('\nbehaviour runtime — each check fails without it and passes with it');
  await behaviourSelfTest(browser, server, dir, expect);
  console.log('\ndeadline — a check on a page that never answers fails in time');
  await deadlineSelfTest(browser, server, dir, expect);
  const closed = (await closeWithin(browser, CLOSE_MS, 'chromium.close')) && (await closeWithin(server, CLOSE_MS, 'server.close'));
  run.clear();
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${wrong === 0 ? 'SELF-TEST PASSED — every check fails the bad page and passes the good one' : `SELF-TEST FAILED — ${wrong} check(s) misjudged`}`);
  // A browser that would not close is still running: ending the process is
  // what kills it (Playwright kills what it launched on exit).
  if (!closed) process.exit(wrong === 0 ? 0 : 1);
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

  const progress = { last: 'building' };
  const building = watchdog(BUILD_ALL_MS, 'test:visual build', progress);
  const sites = await buildAll(words, work, everyVariant);
  building.clear();
  // The whole run: every site at its own deadline, plus the launches and closes.
  const runMs = RUN_BASE_MS + sites.length * RUN_PER_SITE_MS;
  const run = watchdog(runMs, 'test:visual', progress);
  console.log(`deadlines: check ${human(CHECK_MS)} · site ${human(SITE_MS)} · run ${human(runMs)} (${sites.length} sites)` +
    ` · close ${human(CLOSE_MS)} · build: compile ${human(COMPILE_MS)}, install ${human(INSTALL_MS)}, project ${human(PROJECT_BUILD_MS)}\n`);
  const launch = async () => ({
    chromium: await within(CHECK_MS, 'chromium.launch', () => chromium.launch()),
    firefox: await within(CHECK_MS, 'firefox.launch', () => firefox.launch()),
    webkit: await within(CHECK_MS, 'webkit.launch', () => webkit.launch()),
  });
  const closeAll = async (set) => (await Promise.all(Object.entries(set).map(([k, b]) => closeWithin(b, CLOSE_MS, `${k}.close`)))).every(Boolean);
  let browsers = await launch();
  const versions = Object.fromEntries(Object.entries(browsers).map(([k, b]) => [k, b.version()]));
  const server = await startServer();
  let closedCleanly = true;
  try {
    for (const s of sites) {
      try {
        await within(SITE_MS, `site ${s.word}/${s.label}`, () => checkSite(s, browsers, server));
      } catch (e) {
        if (!(e instanceof Overdue)) throw e;
        // The site's own work is abandoned mid-way and may still hold the
        // browsers: replace them, so the next site starts clean.
        record(s.word, 'deadline', s.label, { pass: false, detail: `${e.message} — browsers relaunched` });
        closedCleanly = (await closeAll(browsers)) && closedCleanly;
        browsers = await launch();
      }
      progress.last = `checked ${s.word}/${s.label}`;
      process.stdout.write(`${progress.last}\n`);
    }
  } finally {
    await closeWithin(server, CLOSE_MS, 'server.close');
    closedCleanly = (await closeAll(browsers)) && closedCleanly;
    run.clear();
  }
  if (sites.some((s) => s.settings)) {
    record(FONT_WORD, 'theme-settings', themeReadings.map((r) => r.label).join(' vs '), settingsDiffer(themeReadings));
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
  console.log(`slowest steps: ${slowest(12)}`);
  console.log(`${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`} in ${seconds}s — details in .visual-out/report.json`);
  if (failed === 0) rmSync(work, { recursive: true, force: true });
  else console.log(`work dir kept for inspection: ${work}`);
  // A browser that would not close is still running: ending the process is
  // what kills it (Playwright kills what it launched on exit).
  if (!closedCleanly) process.exit(failed === 0 ? 0 : 1);
  return failed === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
