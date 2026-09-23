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

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? '   ' + detail : ''}`);
};

const work = mkdtempSync(join(tmpdir(), 'az-3d-'));
const fixtureAssets = join(ROOT, 'packages/core/test/fixture-assets');
const fixture = { dir: join(work, 'fixture'), source: readFileSync(join(ROOT, 'packages/core/test/fixture-site.az'), 'utf8') };
const procedural = { dir: join(work, 'procedural'), source: PROCEDURAL };
mkdirSync(fixture.dir, { recursive: true });
cpSync(fixtureAssets, fixture.dir, { recursive: true });
mkdirSync(join(procedural.dir, 'assets'), { recursive: true });
cpSync(join(fixtureAssets, 'assets/orbit.webp'), join(procedural.dir, 'assets/poster.webp'));
await buildSites([fixture, procedural], work);
for (const s of [fixture, procedural]) {
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
