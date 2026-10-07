/**
 * The 3D runtime in real browsers — scene-spec §5–§9, hero-spec §8,
 * motion-tiers-spec §2/§6.1.
 *
 *     pnpm test:3d
 *
 * Builds two sites through the real CLI — the GRAMMAR §8 fixture (a Draco
 * model in a `split` hero, an `orbit` gallery) and a procedural one (a hero
 * and two scenes, one of them `camera orbit`) — and checks what only a
 * browser can: a WebGL context really exists, ONE canvas serves every view,
 * `static` and reduced motion never fetch the 3D chunk, the model loads
 * self-hosted with one decoder and nothing cross-origin, orbit answers the
 * keyboard, a lost context falls back to the posters, and a live `full`
 * hero keeps its scrim between the scene and its type. Every check that
 * could pass vacuously has a control beside it.
 *
 * Headless Chromium renders WebGL with SwiftShader, so no frame time here is
 * device evidence (motion-tiers-spec §8.3); the probe is switched off with
 * `?az-probe=off` wherever a rung change would make a check flaky.
 */

import { chromium, firefox, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, buildSites } from './visual/pipeline.mjs';
import { startServer } from './visual/serve.mjs';
import { Overdue, within, closeWithin, watchdog, human } from './lib/bounded.mjs';
import { textContrast } from './visual/checks.mjs';
import { SCRIM } from '../packages/words/hero/emit.web.ts';

/** Bound on every wait for the runtime to reach a state. */
const WAIT_MS = 15_000;
/** Settle after an input before comparing pixels: damping reaches its target. */
const SETTLE_MS = 800;
/** Software WebGL, the same on every machine and CI runner. */
const GL_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

// The fixture's `auth` is `adapter hosted`: placeholders, a reserved host (auth-spec §4).
process.env.AZ_PUBLIC_AUTH_URL = 'https://auth.invalid';
process.env.AZ_PUBLIC_AUTH_KEY = '<PLACEHOLDER>';

const PROCEDURAL = `az 1

site aurora

page /
  hero split 3d scroll
    title    "Grown, not generated"
    sub      "Every site grows its own."
    describe "Strands curling upward"
    poster   ./assets/poster.webp
  text prose
    title "How it is made"
    body  "A paragraph between the scenes, so the page has somewhere to scroll."
  scene inline 3d
    poster ./assets/poster.webp
    alt    "The same strands, turned by hand"
    camera orbit
  scene full 3d scroll
    poster ./assets/poster.webp
    alt    "The strands, growing as you scroll"
`;

/** hero-spec §8/§10: a `full` hero drawing live behind its type. */
const FULL = `az 1

site aurora

page /
  hero full 3d
    eyebrow  "Limited run"
    title    "Built in the dark"
    sub      "Handmade. Forty pairs a month."
    describe "Strands curling upward"
    poster   ./assets/poster.webp
    cta      "Reserve a pair" /reserve
    alt      "See the process" /process

page /reserve

page /process
`;

/** The same page under another site name: another seed (scene-spec §11.1), another scene. */
const RESEEDED = PROCEDURAL.replace('site aurora', 'site borealis');

/** scene-spec §7: six full-width scenes, far enough apart that the first leaves the warm margin. */
const MANY = `az 1

site aurora

page /
  hero center
    title "A long page of scenes"
${Array.from({ length: 6 }, (_, i) => `  scene full 3d
    poster ./assets/poster.webp
    alt    "Strands, study ${i + 1}"
  text prose
    title "Between the scenes"
    body  "A paragraph of distance, so each scene has somewhere to scroll away to."
`).join('')}`;

/** motion-tiers-spec §5 lite: two scroll-driven scenes on screen at once. */
const PAIR = `az 1

site aurora

page /
  hero center
    title "Two scenes"
  scene inline 3d scroll
    poster ./assets/poster.webp
    alt    "Strands, the first"
  scene inline 3d scroll
    poster ./assets/poster.webp
    alt    "Strands, the second"
  text prose
    title "After the scenes"
    body  "Room to scroll the pair up the page."
  text prose
    title "More room"
    body  "Enough that the pair can be moved past the centre."
`;

/** scene-spec §6.5: blocks with no surface of their own, over a backdrop. */
const BACKDROP = `az 1

site aurora
  scene backdrop 3d scroll
    poster ./assets/poster.webp
    alt    "Slow strands behind the page"

page /
  hero center
    title "Over the backdrop"
    sub   "The type sits on its own surface."
  text prose
    title "The studio"
    body  "Two people, one room, and a surface under every line."
`;

const PROSE = (n) => Array.from({ length: n }, (_, i) => `  text prose
    title "Distance ${i + 1}"
    body  "A paragraph of distance, so the page has somewhere to scroll and the scene sits below the fold."
`).join('');

/** One scene below the fold: inside the warm margin, not on screen. */
const BELOW = `az 1

site aurora

page /
  hero center
    title "A scene below the fold"
${PROSE(3)}  scene inline 3d
    poster ./assets/poster.webp
    alt    "Strands below the fold"
${PROSE(6)}`;

/** hero-spec §8: a 3D hero drawn by a backdrop whose model will not load. */
const HERO_BEHIND = `az 1

site aurora
  scene backdrop 3d scroll
    model  ./assets/shoe.glb
    poster ./assets/poster.webp
    alt    "A shoe behind the page"

page /
  hero split 3d
    title    "Over a backdrop"
    describe "Strands curling upward"
    poster   ./assets/poster.webp
${PROSE(2)}`;

/** gallery §9: an orbit ring, one of whose images will be missing. */
const RING = `az 1

site aurora

page /
  hero center
    title "A ring of photographs"
  gallery orbit
    poster ./assets/poster.webp
${[1, 2, 3, 4].map((i) => `    image ./assets/orbit-${i}.webp
      alt "Photograph ${i}"
`).join('')}${PROSE(2)}`;

/** A protected page: its content, and its 3D, render only after the session check. */
const PROTECTED = `az 1

site aurora
  auth
    adapter session
    protect /account

page /login
  auth login

page /account
  hero split 3d
    title    "Your account"
    describe "Strands curling upward"
    poster   ./assets/poster.webp
  faq list
    title "Questions"
    item "How long does a pair take?"
      text "Four to six weeks from order to shipping."
    item "Can I return them?"
      text "Unworn pairs within thirty days."
    item "Do you resole?"
      text "Yes, in the studio."
`;

/*
 * Deadlines (lib/bounded.mjs): page.evaluate has no timeout of its own. The
 * run takes two to three minutes; past RUN_MS it is stuck, and the watchdog
 * names the last check that finished and ends the process (which kills the
 * browsers). Each other engine's pass and each close is bounded on its own.
 */
const RUN_MS = 15 * 60_000;
const ENGINE_MS = 60_000;
const CLOSE_MS = 15_000;
const progress = { last: 'building' };
const run = watchdog(RUN_MS, 'test:3d', progress);
console.log(`deadlines: run ${human(RUN_MS)} · other engine ${human(ENGINE_MS)} · close ${human(CLOSE_MS)}`);

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  progress.last = name;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? '   ' + detail : ''}`);
};

const work = mkdtempSync(join(tmpdir(), 'az-3d-'));
const fixtureAssets = join(ROOT, 'packages/core/test/fixture-assets');
const fixture = { dir: join(work, 'fixture'), source: readFileSync(join(ROOT, 'packages/core/test/fixture-site.az'), 'utf8') };
const procedural = { dir: join(work, 'procedural'), source: PROCEDURAL };
const reseeded = { dir: join(work, 'reseeded'), source: RESEEDED };
const many = { dir: join(work, 'many'), source: MANY };
const pair = { dir: join(work, 'pair'), source: PAIR };
const backdrop = { dir: join(work, 'backdrop'), source: BACKDROP };
const below = { dir: join(work, 'below'), source: BELOW };
const heroBehind = { dir: join(work, 'hero-behind'), source: HERO_BEHIND };
const ringSite = { dir: join(work, 'ring'), source: RING };
const protectedSite = { dir: join(work, 'protected'), source: PROTECTED };
const fullHero = { dir: join(work, 'full'), source: FULL };
mkdirSync(fixture.dir, { recursive: true });
cpSync(fixtureAssets, fixture.dir, { recursive: true });
const sites = [procedural, reseeded, many, pair, backdrop, below, heroBehind, ringSite, protectedSite, fullHero];
for (const s of sites) {
  mkdirSync(join(s.dir, 'assets'), { recursive: true });
  cpSync(join(fixtureAssets, 'assets/orbit.webp'), join(s.dir, 'assets/poster.webp'));
}
cpSync(join(fixtureAssets, 'assets/shoe.glb'), join(heroBehind.dir, 'assets/shoe.glb'));
for (const i of [1, 2, 3, 4]) cpSync(join(fixtureAssets, `assets/orbit-${i}.webp`), join(ringSite.dir, `assets/orbit-${i}.webp`));
await buildSites([fixture, ...sites], work);
for (const s of [fixture, ...sites]) {
  if (!s.compiled) throw new Error(`3d: ${s.dir} did not compile: ${s.error}`);
}
// A published file that fails to load: the model behind the hero, and one
// photograph of the ring. The build shipped them; the host lost them.
rmSync(join(heroBehind.dist, 'assets/shoe.glb'));
rmSync(join(ringSite.dist, 'assets', readdirSync(join(ringSite.dist, 'assets')).find((f) => /^orbit-2\./.test(f))));

const server = await startServer();
const browser = await chromium.launch({ args: GL_ARGS });

/** Open a page of a site, recording every request and page error. */
async function open(site, path, { reducedMotion = 'no-preference' } = {}) {
  server.serve(site.dist);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(new URL(path, server.url).href, { waitUntil: 'load' });
  return { page, context, requests, errors };
}

const rung = (page) => page.evaluate(() => document.documentElement.getAttribute('data-az3d-rung'));
const canvases = (page) => page.evaluate(() => document.querySelectorAll('canvas').length);
const liveViews = (page) => page.evaluate(() => document.querySelectorAll('[data-az-3d][data-live="true"]').length);
const fetched3d = (requests) => requests.some((u) => /\/assets\/az3d-[^/]*\.js$/.test(u));
const waitFor = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: WAIT_MS }).then(() => true, () => false);

/* ---- a renderer exists, and there is only one ------------------------------ */
{
  const { page, context, requests, errors } = await open(procedural, '/?az-probe=off');
  const live = await waitFor(page, () => document.querySelector('.az-hero-visual[data-live="true"]'));
  const gl = await page.evaluate(() => {
    const c = document.querySelector('canvas.az-3d-canvas');
    return c ? Boolean(c.getContext('webgl2')) : false;
  });
  check('a WebGL2 context exists and the hero view is live', live && gl, `rung ${await rung(page)}`);
  check('CONTROL: the 3D chunk was fetched for it', fetched3d(requests));

  // scene-spec §5: every view on the page shares ONE canvas.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const allLive = await waitFor(page, () => document.querySelectorAll('[data-az-3d][data-live="true"]').length === 3);
  check('§5: three views, one canvas, one context', allLive && (await canvases(page)) === 1,
    `${await liveViews(page)} live views, ${await canvases(page)} canvas`);
  check('no page errors while three views draw', errors.length === 0, errors[0] ?? '');
  await context.close();
}

/* ---- static and reduced motion never load 3D ------------------------------- */
for (const [label, path, reducedMotion] of [
  ['?az-tier=static', '/?az-tier=static', 'no-preference'],
  ['prefers-reduced-motion', '/', 'reduce'],
]) {
  const { page, context, requests } = await open(procedural, path, { reducedMotion });
  await page.waitForTimeout(SETTLE_MS);
  const poster = await page.evaluate(() => getComputedStyle(document.querySelector('.az-hero-poster')).visibility);
  check(`§8 ${label}: no 3D chunk, no canvas, the poster shows`,
    !fetched3d(requests) && (await canvases(page)) === 0 && poster === 'visible',
    `chunk ${fetched3d(requests)}, canvases ${await canvases(page)}, poster ${poster}`);
  await context.close();
}

/* ---- camera orbit answers the keyboard ------------------------------------ */
{
  const { page, context } = await open(procedural, '/?az-probe=off');
  const view = page.locator('.az-scene-view[data-az-camera="orbit"]');
  await view.scrollIntoViewIfNeeded();
  await waitFor(page, () => document.querySelector('.az-scene-view[data-az-camera="orbit"][data-live="true"]'));
  // Reach it by Tab, as a keyboard user would, so :focus-visible applies.
  let focused = false;
  for (let i = 0; i < 40 && !focused; i++) {
    await page.keyboard.press('Tab');
    focused = await page.evaluate(() => document.activeElement?.getAttribute('data-az-camera') === 'orbit');
  }
  const ring = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  check('§9: the orbit view is reachable by Tab and shows a focus ring', focused && ring !== 'none', `outline ${ring}`);

  const box = await view.boundingBox();
  const shot = () => page.screenshot({ clip: box });
  await page.waitForTimeout(SETTLE_MS);
  const before = await shot();
  await page.waitForTimeout(SETTLE_MS);
  const still = await shot();
  check('CONTROL: without input the orbit view holds its pose', before.equals(still));
  for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(SETTLE_MS);
  check('§9: arrow keys turn the object', !before.equals(await shot()));
  await context.close();
}

/* ---- ROADMAP M0: a snapshot pinned to `lite` is reproducible ------------- */
// motion-tiers-spec §6.1: `?az-tier=lite` pins the ladder's lite rung (a
// static camera), so with the page at rest nothing moves. SwiftShader
// rasterises on the CPU, which makes exact bytes a fair demand. Two fresh
// contexts and a browser restart must agree; another seed must not.
{
  const LITE = '/?az-tier=lite&az-probe=off';
  const snapshot = async (b, site) => {
    server.serve(site.dist);
    const context = await b.newContext({
      viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'no-preference',
    });
    try {
      const page = await context.newPage();
      await page.goto(new URL(LITE, server.url).href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const live = await waitFor(page, () => document.querySelector('.az-hero [data-az-3d][data-live="true"]'));
      await page.waitForTimeout(SETTLE_MS);
      const png = await page.screenshot({ animations: 'disabled', caret: 'hide' });
      return { live, rung: await rung(page), png };
    } finally {
      await closeWithin(context, CLOSE_MS, 'lite snapshot context.close');
    }
  };
  const a = await snapshot(browser, procedural);
  const b = await snapshot(browser, procedural);
  const other = await snapshot(browser, reseeded);
  const restarted = await chromium.launch({ args: GL_ARGS });
  let c;
  try { c = await snapshot(restarted, procedural); } finally { await closeWithin(restarted, CLOSE_MS, 'restarted chromium.close'); }
  check('M0: `?az-tier=lite` pins the lite rung and the hero draws live', a.live && a.rung === '6', `rung ${a.rung}`);
  check('M0: a lite snapshot is byte-identical in two fresh contexts', a.png.equals(b.png), `${a.png.length} bytes`);
  check('M0: a lite snapshot is byte-identical after a browser restart', a.png.equals(c.png));
  check('CONTROL: another site name (another seed) renders different bytes', other.live && !other.png.equals(a.png));
}

/* ---- the scheme changes: the scene repaints its colours ------------------- */
{
  const { page, context } = await open(procedural, '/?az-probe=off');
  const view = page.locator('.az-scene-view[data-az-camera="orbit"]');
  await view.scrollIntoViewIfNeeded();
  await waitFor(page, () => document.querySelector('.az-scene-view[data-az-camera="orbit"][data-live="true"]'));
  const box = await view.boundingBox();
  // The view's own pixels only — the page around it changes with the scheme too.
  const shot = () => page.screenshot({ clip: { x: box.x + box.width / 4, y: box.y + box.height / 4, width: box.width / 2, height: box.height / 2 } });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(SETTLE_MS);
  const light = await shot();
  await page.waitForTimeout(SETTLE_MS);
  check('CONTROL: the view is pixel-stable with no scheme change', light.equals(await shot()));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(SETTLE_MS);
  const dark = await shot();
  check('theme-spec §3.4: the OS scheme flips and the scene repaints its colours', !light.equals(dark));
  // An explicit choice wins over the OS (theme-spec §3.2), and the scene follows it.
  await page.evaluate(() => document.documentElement.setAttribute('data-scheme', 'light'));
  await page.waitForTimeout(SETTLE_MS);
  check('theme-spec §3.4: data-scheme overrides the OS and the scene follows', (await shot()).equals(light));
  await context.close();
}

/* ---- §7: paused views past the budget are released, then rebuilt ---------- */
// GPU objects still held after visiting every scene, per run: eviction must
// hold fewer than the control, which keeps all six resident.
const heldAfterVisit = {};
for (const budget of ['0', null]) {
  const { page, context, errors } = await open(many, `/?az-probe=off${budget === null ? '' : `&az-scene-budget=${budget}`}`);
  const views = page.locator('.az-scene-view');
  const n = await views.count();
  const gpu = () => page.evaluate(() => (document.documentElement.getAttribute('data-az3d-gpu') ?? '0,0').split(',').map(Number));
  // Visit every scene, top to bottom, letting each go live.
  for (let i = 0; i < n; i++) {
    await views.nth(i).scrollIntoViewIfNeeded();
    await waitFor(page, (k) => document.querySelectorAll('.az-scene-view')[k].getAttribute('data-live') === 'true', i);
  }
  await page.waitForTimeout(SETTLE_MS);
  heldAfterVisit[budget ?? 'default'] = (await gpu())[0];
  const state = await page.evaluate(() => [...document.querySelectorAll('.az-scene-view')].map((el) => ({
    evicted: el.getAttribute('data-az-evicted') === 'true',
    live: el.getAttribute('data-live') === 'true',
    onScreen: (() => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; })(),
  })));
  const evicted = state.filter((s) => s.evicted).length;
  if (budget === null) {
    check('CONTROL: under the default budget no scene is evicted', evicted === 0, `${evicted}/${n} evicted`);
  } else {
    check('§7: past the budget, far-away paused scenes are released to their posters',
      state[0].evicted && !state[0].live && evicted > 0, `${evicted}/${n} evicted`);
    check('§7: a scene on screen is never evicted', state.every((s) => !s.onScreen || !s.evicted));
    await views.nth(0).scrollIntoViewIfNeeded();
    const back = await waitFor(page, () => {
      const el = document.querySelector('.az-scene-view');
      return el.getAttribute('data-live') === 'true' && el.getAttribute('data-az-evicted') !== 'true';
    });
    check('§7: an evicted scene coming back is rebuilt and goes live', back);
  }
  check('no page errors while scenes are released and rebuilt', errors.length === 0, errors[0] ?? '');
  await context.close();
}
check('§7: releasing frees GPU memory — fewer geometries held than with every scene resident',
  heldAfterVisit['0'] < heldAfterVisit.default,
  `evicting ${heldAfterVisit['0']} vs resident ${heldAfterVisit.default}`);

/* ---- §6.5: over a backdrop, text sits on a surface of its own --------------- */
{
  const bgOf = (page, sel) => page.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
  const { page, context } = await open(backdrop, '/?az-probe=off');
  await page.waitForTimeout(SETTLE_MS);
  const hero = await bgOf(page, '.az-hero');
  const text = await bgOf(page, '.az-text');
  const veiled = (c) => /(\/|,)\s*0\.92\)$/.test(c);
  check('§6.5: the hero and the text block take the veil over a backdrop', veiled(hero) && veiled(text), `${hero} | ${text}`);
  const axe = await new AxeBuilder({ page }).analyze();
  check('§6.5: axe finds no violation on the backdrop page', axe.violations.length === 0,
    axe.violations.map((v) => `${v.id}×${v.nodes.length}`).join(', '));
  await context.close();
  const control = await open(procedural, '/?az-tier=static');
  check('CONTROL: without a backdrop the hero keeps no surface', !veiled(await bgOf(control.page, '.az-hero')),
    await bgOf(control.page, '.az-hero'));
  await control.context.close();
}

/* ---- the model: self-hosted, one decoder, nothing cross-origin ------------ */
{
  server.serve(fixture.dist);
  const origin = new URL(server.url).origin;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const foreign = [];
  // Anything not from the site itself is refused and recorded.
  await page.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    foreign.push(route.request().url());
    return route.abort();
  });
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(new URL('/?az-probe=off', server.url).href, { waitUntil: 'load' });
  const live = await waitFor(page, () => document.querySelector('.az-hero-visual[data-live="true"]'));
  const wasm = requests.filter((u) => u.endsWith('.wasm'));
  check('the model loads and the hero goes live', live);
  check('the Draco decoder is self-hosted: exactly one wasm, from the site', wasm.length === 1 && wasm[0].startsWith(origin), wasm.join(' '));
  check('nothing is fetched from another origin', foreign.length === 0, foreign.join(' '));
  check('CONTROL: the model file itself was fetched', requests.some((u) => u.endsWith('/assets/shoe.glb')));
  await context.close();
}

/* ---- a page without a view never loads 3D, even on a 3D site --------------- */
{
  const { page, context, requests } = await open(fixture, '/legal/');
  await page.waitForTimeout(SETTLE_MS);
  check('a 3D site\'s page with no view loads no 3D chunk and no canvas',
    !fetched3d(requests) && (await canvases(page)) === 0);
  await context.close();
}

/* ---- a lost context falls back to the posters ------------------------------ */
{
  const { page, context, errors } = await open(procedural, '/?az-probe=off');
  await waitFor(page, () => document.querySelector('.az-hero-visual[data-live="true"]'));
  await page.evaluate(() => document.querySelector('canvas.az-3d-canvas')
    .getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  const down = await waitFor(page, () => !document.querySelector('canvas'));
  const poster = await page.evaluate(() => getComputedStyle(document.querySelector('.az-hero-poster')).visibility);
  check('§2 #9: a lost context tears down to the posters, rung 7',
    down && (await rung(page)) === '7' && (await liveViews(page)) === 0 && poster === 'visible',
    `rung ${await rung(page)}, poster ${poster}`);
  check('no page errors from the teardown', errors.length === 0, errors[0] ?? '');
  await context.close();
}

/* ---- §7: the loop stops when nothing is on screen -------------------------- */
{
  // Count animation frames the page asks for: with the only view below the
  // fold (warm, not on screen) nothing is drawn, so nothing should loop.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    window.__azFrames = 0;
    window.requestAnimationFrame = (fn) => { window.__azFrames++; return raf(fn); };
  });
  const page = await context.newPage();
  server.serve(below.dist);
  await page.goto(new URL('/?az-probe=off', server.url).href, { waitUntil: 'load' });
  // Just below the fold, well inside the warm margin.
  await page.evaluate(() => {
    const el = document.querySelector('.az-scene-view');
    const top = el.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top: Math.max(0, top - innerHeight - 120), behavior: 'instant' });
  });
  const placed = await page.evaluate(() => {
    const r = document.querySelector('.az-scene-view').getBoundingClientRect();
    return r.top > innerHeight && r.top < innerHeight * 2;
  });
  await page.waitForTimeout(SETTLE_MS * 2);
  const before = await page.evaluate(() => window.__azFrames);
  await page.waitForTimeout(2000);
  const idle = (await page.evaluate(() => window.__azFrames)) - before;
  check('§7: with nothing on screen the render loop stops (no frames for a warm, off-screen view)',
    placed && idle < 10, `${idle} frames requested in 2s${placed ? '' : ' (view not placed below the fold)'}`);
  // CONTROL: once it is on screen, it draws.
  await page.locator('.az-scene-view').scrollIntoViewIfNeeded();
  const live = await waitFor(page, () => document.querySelector('.az-scene-view[data-live="true"]'));
  check('CONTROL: the same view on screen goes live', live);
  await context.close();
}

/* ---- §3.3: a hidden tab is reported to the probe --------------------------- */
{
  const { page, context } = await open(below, '/?az-probe-trace');
  await page.locator('.az-scene-view').scrollIntoViewIfNeeded();
  await waitFor(page, () => document.querySelector('.az-scene-view[data-live="true"]'));
  // A hidden tab gets no frames: freeze them, then report the tab hidden.
  await page.evaluate(() => {
    window.requestAnimationFrame = () => 0;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const told = await waitFor(page, () => Number((document.documentElement.getAttribute('data-az3d-probe') ?? '0 0').split(' ')[1]) > 0);
  check('§3.3: the probe hears the tab hid even though no frame comes', told,
    await page.evaluate(() => document.documentElement.getAttribute('data-az3d-probe')));
  await context.close();
}

/* ---- the back/forward cache: 3D comes back ----------------------------------- */
{
  const { page, context, errors } = await open(procedural, '/?az-probe=off');
  await waitFor(page, () => document.querySelector('.az-hero-visual[data-live="true"]'));
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  const down = await waitFor(page, () => !document.querySelector('canvas'));
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  const back = await waitFor(page, () => document.querySelectorAll('canvas.az-3d-canvas').length === 1
    && document.querySelector('.az-hero-visual[data-live="true"]'));
  check('a page restored from the back/forward cache starts its 3D again', down && back, `rung ${await rung(page)}`);
  check('no page errors across the restore', errors.length === 0, errors[0] ?? '');
  await context.close();
}

/* ---- §6.3: a modal's scroll lock does not rewind the backdrop ------------- */
{
  // The backdrop animates at rest, so its pixels are no witness: with
  // ?az-probe-trace the stage publishes the scroll position it is following.
  const { page, context } = await open(backdrop, '/?az-probe=off&az-probe-trace');
  await page.evaluate(() => { document.body.style.minHeight = '4000px'; });
  await page.evaluate(() => window.scrollTo({ top: 800, behavior: 'instant' }));
  await page.waitForTimeout(SETTLE_MS);
  const target = () => page.evaluate(() => Number(document.documentElement.getAttribute('data-az3d-backdrop') ?? 'NaN'));
  const before = await target();
  check('CONTROL: scrolled down, the backdrop follows the page', before > 0, String(before));
  // The lock as the behaviour runtime makes it: body fixed at its offset,
  // scrollY 0, the offset on the root. Nothing on screen moves.
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-az-scroll-lock', String(window.scrollY));
    Object.assign(document.body.style, { position: 'fixed', top: `${-window.scrollY}px`, insetInline: '0', overflow: 'hidden' });
  });
  await page.waitForTimeout(SETTLE_MS);
  const during = await target();
  check('§6.3: under a modal\'s scroll lock the backdrop holds, not rewinds to the top', during === before, `${before} -> ${during}`);
  await context.close();
}

/* ---- hero-spec §8: a hero keeps its poster while the backdrop cannot draw -- */
{
  const { page, context } = await open(heroBehind, '/?az-probe=off');
  await page.waitForTimeout(SETTLE_MS * 3);
  const poster = await page.evaluate(() => getComputedStyle(document.querySelector('.az-hero-poster')).visibility);
  check('a 3D hero behind a backdrop whose model failed keeps its poster', poster === 'visible', `poster ${poster}`);
  await context.close();
}

/* ---- gallery §9: a ring with a missing photograph keeps its list ---------- */
{
  const { page, context, errors } = await open(ringSite, '/?az-probe=off');
  await page.locator('[data-az-3d="orbit"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(SETTLE_MS * 3);
  // Live, the ring hides the poster and moves the list out of sight; a ring
  // with a hole in it must not.
  const state = await page.evaluate(() => ({
    live: document.querySelector('[data-az-3d-host]').getAttribute('data-live'),
    poster: getComputedStyle(document.querySelector('.az-gallery-poster')).visibility,
  }));
  check('an orbit ring with a photograph missing stays on the poster and its list', state.live !== 'true' && state.poster === 'visible',
    `live ${state.live}, poster ${state.poster}`);
  check('no page errors from the failed photograph', errors.length === 0, errors[0] ?? '');
  await context.close();
}

/* ---- scene-spec §9: an orbit drag released outside the view ends ----------- */
{
  const { page, context } = await open(procedural, '/?az-probe=off');
  const view = page.locator('.az-scene-view[data-az-camera="orbit"]');
  await view.scrollIntoViewIfNeeded();
  await waitFor(page, () => document.querySelector('.az-scene-view[data-az-camera="orbit"][data-live="true"]'));
  const box = await view.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 });
  // Out of the view, then released out there.
  await page.mouse.move(box.x + box.width + 200, box.y - 200, { steps: 4 });
  await page.mouse.up();
  // Back over the view with no button held — hover styles apply to both
  // shots — and let the drag's turn finish easing in before the baseline:
  // under software WebGL frames are slow and each eases a capped step, so
  // it waits until two shots in a row agree (bounded).
  await page.mouse.move(box.x + 20, box.y + box.height / 2);
  const shot = () => page.screenshot({ clip: box });
  let released = await shot();
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(SETTLE_MS);
    const next = await shot();
    if (next.equals(released)) break;
    released = next;
  }
  // Hovering across the view with no button held must not turn it.
  await page.mouse.move(box.x + box.width - 20, box.y + box.height / 2, { steps: 8 });
  await page.waitForTimeout(SETTLE_MS * 4);
  check('§9: a drag released outside the view ends — hovering afterwards does not turn the object', released.equals(await shot()));
  await context.close();
}

/* ---- a renderer that cannot be made leaves nothing behind ----------------- */
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // The gate's own probe canvases still get a context; the page's renderer does not.
  await context.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      return this.classList.contains('az-3d-canvas') ? null : get.call(this, type, attrs);
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  server.serve(procedural.dist);
  await page.goto(new URL('/?az-probe=off', server.url).href, { waitUntil: 'load' });
  await page.waitForTimeout(SETTLE_MS * 2);
  const state = await page.evaluate(() => ({
    canvases: document.querySelectorAll('canvas').length,
    rung: document.documentElement.getAttribute('data-az3d-rung'),
    poster: getComputedStyle(document.querySelector('.az-hero-poster')).visibility,
  }));
  check('a renderer that fails to start leaves no canvas, says static, keeps the posters, throws nothing',
    state.canvases === 0 && state.rung === '7' && state.poster === 'visible' && errors.length === 0,
    `${state.canvases} canvas, rung ${state.rung}, poster ${state.poster}${errors[0] ? `; ${errors[0]}` : ''}`);
  await context.close();
}

/* ---- a protected page: content after the session check is still wired ---- */
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  // The session adapter's one read (auth-spec §3.3), answered as signed in.
  await page.route('**/api/auth/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ session: { user: { id: 'u-1', email: 'reader@example.org' } } }),
  }));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  server.serve(protectedSite.dist);
  await page.goto(new URL('/account/?az-probe=off', server.url).href, { waitUntil: 'load' });
  await page.locator('.az-session').waitFor({ state: 'visible', timeout: WAIT_MS });
  const collapsed = await waitFor(page, () => {
    const b = [...document.querySelectorAll('[data-az-disclosure]')];
    return b.length > 0 && b.every((x) => x.getAttribute('aria-expanded') === 'false');
  });
  check('a protected page\'s FAQ, rendered after the session check, is wired (answers collapse)', collapsed);
  const live = await waitFor(page, () => document.querySelector('.az-hero-visual[data-live="true"]'));
  check('a protected page\'s 3D, rendered after the session check, starts', live && (await canvases(page)) === 1,
    `${await canvases(page)} canvas`);
  check('no page errors on the protected page', errors.length === 0, errors[0] ?? '');
  await context.close();
}

/* ---- hero-spec §8/§10: `full` live — the scrim over the scene, the type at 4.5:1 -- */
// The scrim layer and the canvas take no pointer, so a hit test does not see
// them: for the one read they are made hittable, and the stack at the
// title's centre is read top first. The contrast is read from pixels with
// the lite rung's static camera, so the scene holds still for the capture.
{
  const TEXT = ['.az-hero-eyebrow', '.az-hero-title', '.az-hero-sub', '.az-hero .az-action--secondary'];
  for (const scheme of ['light', 'dark']) {
    const { page, context, errors } = await open(fullHero, '/?az-tier=lite&az-probe=off');
    try {
      await page.emulateMedia({ colorScheme: scheme });
      const live = await waitFor(page, () => document.querySelector('.az-hero[data-live="true"]')
        && getComputedStyle(document.querySelector('.az-hero-poster')).visibility === 'hidden');
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.waitForTimeout(SETTLE_MS);
      const stack = await page.evaluate(() => {
        const probe = document.createElement('style');
        probe.textContent = '.az-3d-canvas, .az-hero-scrim { pointer-events: auto !important; }';
        document.head.append(probe);
        try {
          const r = document.querySelector('.az-hero-title').getBoundingClientRect();
          const hits = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          const at = (q) => hits.findIndex((el) => el.matches(q));
          const scrim = document.querySelector('.az-hero-scrim');
          const cs = scrim ? getComputedStyle(scrim) : null;
          return {
            title: at('.az-hero-title'), scrim: at('.az-hero-scrim'), visual: at('.az-hero-visual'), canvas: at('canvas.az-3d-canvas'),
            opacity: cs?.opacity ?? null, visibility: cs?.visibility ?? null, image: cs?.backgroundImage ?? '',
          };
        } finally {
          probe.remove();
        }
      });
      const order = `title ${stack.title}, scrim ${stack.scrim}, visual ${stack.visual}, canvas ${stack.canvas} (0 is on top)`;
      check(`hero §8 full live (${scheme}): the scrim paints over the scene and under the type`,
        live && stack.title >= 0 && stack.scrim > stack.title && stack.visual > stack.scrim && stack.canvas > stack.scrim, order);
      // The gradient's stops, as computed: every alpha in it is one of SCRIM's.
      const alphas = [...stack.image.matchAll(/\/\s*([\d.]+)\s*\)|rgba\([^)]*,\s*([\d.]+)\s*\)/g)].map((m) => Number(m[1] ?? m[2]));
      const want = [SCRIM.bottom / 100, SCRIM.top / 100];
      check(`hero §10 full live (${scheme}): the scrim is opaque as a layer and its stops are ${SCRIM.bottom}% → ${SCRIM.top}%`,
        stack.opacity === '1' && stack.visibility === 'visible' && alphas.length === want.length
          && alphas.every((a, i) => Math.abs(a - want[i]) < 0.005),
        `opacity ${stack.opacity}, visibility ${stack.visibility}, ${stack.image}`);
      const held = await textContrast(page, TEXT);
      check(`hero §9 full live (${scheme}): every line over the scene holds 4.5:1`, live && held.problems.length === 0,
        held.problems.length ? held.problems.join('; ') : `worst ${held.worst}:1`);
      // CONTROL: the same read with the scrim taken away is worse, so it is
      // the scrim, over real canvas pixels, that the read above measured.
      await page.evaluate(() => {
        const off = document.createElement('style');
        off.id = 'az-no-scrim';
        off.textContent = '.az-hero-scrim { display: none !important; }';
        document.head.append(off);
      });
      const bare = await textContrast(page, TEXT);
      check(`CONTROL: full live (${scheme}) without its scrim reads lower`, bare.worst < held.worst,
        `bare ${bare.worst}:1 vs scrimmed ${held.worst}:1`);
      check(`no page errors on the live full hero (${scheme})`, errors.length === 0, errors[0] ?? '');
    } finally {
      await closeWithin(context, CLOSE_MS, `full hero ${scheme} context.close`);
    }
  }
}

let closed = await closeWithin(browser, CLOSE_MS, 'chromium.close');

/* ---- the other engines: the page never breaks ------------------------------ */
for (const [name, engine] of [['firefox', firefox], ['webkit', webkit]]) {
  let other;
  try {
    await within(ENGINE_MS, `${name}: the procedural page`, async () => {
      other = await engine.launch();
      server.serve(procedural.dist);
      const page = await other.newPage({ viewport: { width: 1440, height: 900 } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(new URL('/?az-probe=off', server.url).href, { waitUntil: 'load' });
      await page.waitForTimeout(SETTLE_MS * 2);
      const state = await page.evaluate(() => ({
        rung: document.documentElement.getAttribute('data-az3d-rung'),
        live: document.querySelectorAll('[data-live="true"]').length,
      }));
      // With WebGL the hero goes live; without it the page stays on its posters.
      // Either is correct — a page error is not.
      check(`${name} ${other.version()}: renders live or falls back, with no page errors`,
        errors.length === 0, `rung ${state.rung ?? 'none (poster)'}, ${state.live} live parts${errors[0] ? `; ${errors[0]}` : ''}`);
    });
  } catch (e) {
    if (!(e instanceof Overdue)) throw e;
    check(`${name}: renders live or falls back, with no page errors`, false, e.message);
    // The abandoned work may still be launching a browser this loop never sees.
    closed = false;
  }
  if (other) closed = (await closeWithin(other, CLOSE_MS, `${name}.close`)) && closed;
}

closed = (await closeWithin(server, CLOSE_MS, 'server.close')) && closed;
run.clear();
if (failures === 0) rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED — work dir kept: ${work}`);
process.exitCode = failures === 0 ? 0 : 1;
// A browser that would not close is still running: ending the process is
// what kills it (Playwright kills what it launched on exit).
if (!closed) process.exit();
