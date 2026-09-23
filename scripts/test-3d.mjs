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
 * keyboard, and a lost context falls back to the posters. Every check that
 * could pass vacuously has a control beside it.
 *
 * Headless Chromium renders WebGL with SwiftShader, so no frame time here is
 * device evidence (motion-tiers-spec §8.3); the probe is switched off with
 * `?az-probe=off` wherever a rung change would make a check flaky.
 */

import { chromium, firefox, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT, buildSites } from './visual/pipeline.mjs';
import { startServer } from './visual/serve.mjs';

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

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? '   ' + detail : ''}`);
};

const work = mkdtempSync(join(tmpdir(), 'az-3d-'));
const fixtureAssets = join(ROOT, 'packages/core/test/fixture-assets');
const fixture = { dir: join(work, 'fixture'), source: readFileSync(join(ROOT, 'packages/core/test/fixture-site.az'), 'utf8') };
const procedural = { dir: join(work, 'procedural'), source: PROCEDURAL };
const many = { dir: join(work, 'many'), source: MANY };
const pair = { dir: join(work, 'pair'), source: PAIR };
const backdrop = { dir: join(work, 'backdrop'), source: BACKDROP };
mkdirSync(fixture.dir, { recursive: true });
cpSync(fixtureAssets, fixture.dir, { recursive: true });
for (const s of [procedural, many, pair, backdrop]) {
  mkdirSync(join(s.dir, 'assets'), { recursive: true });
  cpSync(join(fixtureAssets, 'assets/orbit.webp'), join(s.dir, 'assets/poster.webp'));
}
await buildSites([fixture, procedural, many, pair, backdrop], work);
for (const s of [fixture, procedural, many, pair, backdrop]) {
  if (!s.compiled) throw new Error(`3d: ${s.dir} did not compile: ${s.error}`);
}

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

await browser.close();

/* ---- the other engines: the page never breaks ------------------------------ */
for (const [name, engine] of [['firefox', firefox], ['webkit', webkit]]) {
  const other = await engine.launch();
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
  await other.close();
}

await server.close();
if (failures === 0) rmSync(work, { recursive: true, force: true });
console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED — work dir kept: ${work}`);
process.exitCode = failures === 0 ? 0 : 1;
