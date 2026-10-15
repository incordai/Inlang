/**
 * `pnpm thumbnails` — one PNG per word × variant (ROADMAP M2; CONVENTIONS §3:
 * previews drive "snapshots + LSP thumbnails").
 *
 * The source for a variant is its `preview.<variant>.az` when the word ships
 * one, else the word's preview.az with that variant substituted on the
 * word's own line. Rendered in Chromium at a fixed 1200×750 viewport, light
 * scheme, reduced motion, animations frozen, the site's default theme, with
 * the word's block scrolled to the top — so the bytes depend only on the
 * source and the machine's fonts.
 *
 * No doc fixes where thumbnails live, so they are build output, not source:
 * written to .thumbnails/<word>/<variant>.png, which is gitignored.
 *
 *     node scripts/thumbnails.mjs            write every thumbnail
 *     node scripts/thumbnails.mjs hero       only these words
 *     node scripts/thumbnails.mjs --verify   render twice; fail unless every
 *                                            variant rendered, identically
 *
 * `none` (nav, scene) renders nothing by definition and gets no thumbnail.
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { ROOT, WORDS, answerPreviewBackend, buildSites, firstRoute } from './visual/pipeline.mjs';
import { startServer } from './visual/serve.mjs';
import { Overdue, within, closeWithin, watchdog, human } from './lib/bounded.mjs';

const OUT = join(ROOT, '.thumbnails');
const VIEWPORT = { width: 1200, height: 750 };
/** Every navigation is bounded. */
const NAV_TIMEOUT_MS = 15_000;
/** The reserved variant that renders nothing (GRAMMAR §5.2). */
const RENDERS_NOTHING = 'none';

/**
 * `source` with `variant` on the word's own line: the first token after the
 * word that is one of its variants is replaced, or the variant is added.
 */
export function withVariant(source, word, variant, variants) {
  const lines = source.split('\n');
  const at = lines.findIndex((l) => new RegExp(`^\\s+${word}(\\s|$)`).test(l));
  if (at < 0) throw new Error(`${word}: the preview has no ${word} line`);
  const indent = /^\s*/.exec(lines[at])[0];
  const tokens = lines[at].trim().split(/\s+/);
  const current = tokens.findIndex((t, i) => i > 0 && variants.includes(t));
  if (current > 0) tokens[current] = variant;
  else tokens.splice(1, 0, variant);
  lines[at] = indent + tokens.join(' ');
  return lines.join('\n');
}

/** Every word × variant, with the .az source that renders it. */
function targets(words) {
  return words.flatMap((word) => {
    const dir = join(WORDS, word);
    const { variants = [] } = JSON.parse(readFileSync(join(dir, 'word.json'), 'utf8'));
    const preview = readFileSync(join(dir, 'preview.az'), 'utf8');
    return variants.filter((v) => v !== RENDERS_NOTHING).map((variant) => {
      const own = join(dir, `preview.${variant}.az`);
      const source = existsSync(own) ? readFileSync(own, 'utf8') : withVariant(preview, word, variant, variants);
      return { word, variant, source, assetsFrom: join(dir, 'preview-assets') };
    });
  });
}

/*
 * Deadlines (lib/bounded.mjs): page.evaluate has no timeout of its own. One
 * target (open, scroll, wait for images, screenshot) takes about a second;
 * a target past TARGET_MS is a FAIL naming it. The whole run's backstop
 * covers each pass's build (its children are bounded in pipeline.mjs) and
 * every target with wide margin.
 */
const TARGET_MS = 60_000;
const CLOSE_MS = 15_000;
const PASS_BASE_MS = 30 * 60_000;
const PER_TARGET_MS = 30_000;

/** One target in its own context: the word's block at the top of the frame, then a screenshot (null when the block is missing). */
async function shoot(ctx, s, server) {
  await answerPreviewBackend(ctx);
  const page = await ctx.newPage();
  await page.goto(new URL(firstRoute(s.source), server.url).href, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
  // The page is wired, and nothing on it is still deciding what to show
  // (a chat panel reads the session first), so every shot is the settled page.
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-az-ready')
    && !document.querySelector('[data-az-chat][aria-busy="true"]'), null, { timeout: NAV_TIMEOUT_MS });
  // A whole class token, so `az-nav` does not match `az-nav-logo`.
  const found = await page.evaluate((cls) => {
    const el = [...document.querySelectorAll('[class]')].find((e) => e.classList.contains(cls));
    if (!el) return false;
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY);
    return true;
  }, `az-${s.word}`);
  if (!found) return null;
  // Scrolling starts lazy images that were below the fold; a shot taken
  // before they finish differs run to run. Wait for fonts and for every
  // image in the frame (only those — a lazy image outside it never loads).
  await page.evaluate(async (h) => {
    await document.fonts.ready;
    const inFrame = [...document.images].filter((img) => {
      const r = img.getBoundingClientRect();
      return r.bottom > 0 && r.top < h;
    });
    await Promise.all(inFrame.map((img) => img.decode().catch(() => undefined)));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, VIEWPORT.height);
  return page.screenshot({ animations: 'disabled', caret: 'hide', timeout: NAV_TIMEOUT_MS });
}

/**
 * Build every target once and screenshot each; returns { key: Buffer }.
 * `closed` is false when a context or the browser would not close.
 */
async function render(list, work, progress = {}) {
  const sites = list.map((t) => ({ ...t, dir: join(work, `${t.word}-${t.variant}`) }));
  await buildSites(sites, work);
  const shots = {};
  const failures = [];
  let closed = true;
  const server = await startServer();
  const browser = await within(TARGET_MS, 'chromium.launch', () => chromium.launch());
  try {
    for (const s of sites) {
      const key = `${s.word}/${s.variant}`;
      if (!s.compiled) { failures.push(`${key}: does not compile — ${s.error}`); continue; }
      server.serve(s.dist);
      let ctx;
      try {
        const shot = await within(TARGET_MS, `thumbnail ${key}`, async () => {
          ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
          return shoot(ctx, s, server);
        });
        if (shot) shots[key] = shot;
        else failures.push(`${key}: no .az-${s.word} element on the page`);
      } catch (e) {
        if (!(e instanceof Overdue)) throw e;
        failures.push(`${key}: ${e.message}`);
      }
      if (ctx) closed = (await closeWithin(ctx, CLOSE_MS, `context.close ${key}`)) && closed;
      progress.last = `thumbnail ${key}`;
    }
  } finally {
    closed = (await closeWithin(browser, CLOSE_MS, 'chromium.close')) && closed;
    closed = (await closeWithin(server, CLOSE_MS, 'server.close')) && closed;
  }
  return { shots, failures, closed };
}

async function main(argv) {
  const verify = argv.includes('--verify');
  const names = argv.filter((a) => !a.startsWith('--'));
  const all = readdirSync(WORDS).filter((w) => existsSync(join(WORDS, w, 'preview.az'))).sort();
  const unknown = names.filter((n) => !all.includes(n));
  if (unknown.length) throw new Error(`thumbnails: no preview for: ${unknown.join(', ')}`);
  const words = names.length ? names : all;
  const list = targets(words);

  const started = performance.now();
  const passes = verify ? 2 : 1;
  const runMs = passes * (PASS_BASE_MS + list.length * PER_TARGET_MS);
  const progress = { last: 'building' };
  const run = watchdog(runMs, 'thumbnails', progress);
  console.log(`deadlines: target ${human(TARGET_MS)} · run ${human(runMs)} (${list.length} targets × ${passes})`);
  const work = mkdtempSync(join(tmpdir(), 'az-thumbs-'));
  const first = await render(list, join(work, 'a'), progress);
  const failures = [...first.failures];
  let closed = first.closed;
  if (verify) {
    progress.last = 'building the second pass';
    const second = await render(list, join(work, 'b'), progress);
    closed = closed && second.closed;
    for (const key of Object.keys(first.shots)) {
      if (!second.shots[key]?.equals(first.shots[key])) failures.push(`${key}: two renders of one source differ`);
    }
  }
  for (const t of list) {
    const key = `${t.word}/${t.variant}`;
    if (!first.shots[key] && !failures.some((f) => f.startsWith(`${key}:`))) failures.push(`${key}: not rendered`);
  }

  rmSync(OUT, { recursive: true, force: true });
  for (const [key, png] of Object.entries(first.shots)) {
    mkdirSync(join(OUT, key.split('/')[0]), { recursive: true });
    writeFileSync(join(OUT, `${key}.png`), png);
  }
  rmSync(work, { recursive: true, force: true });

  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`${Object.keys(first.shots).length}/${list.length} thumbnails${verify ? ', each rendered twice' : ''} in ${seconds}s — .thumbnails/`);
  console.log(failures.length === 0 ? 'THUMBNAILS OK' : `${failures.length} THUMBNAIL(S) FAILED`);
  run.clear();
  // A browser that would not close is still running: ending the process is
  // what kills it (Playwright kills what it launched on exit).
  if (!closed) process.exit(failures.length === 0 ? 0 : 1);
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));
