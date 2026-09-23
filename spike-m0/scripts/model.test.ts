/**
 * The opt-in .glb path — ASSUMPTIONS A8 and motion-tiers-spec §8.1 check 5.
 *
 * What it proves, in order:
 *   1. the shipped Draco model is under the 5 MB budget (A8, hero manifest
 *      "maxBytes": 5242880); the size-by-complexity sweep is `pnpm model --sweep`
 *   2. the build succeeds with every network path poisoned (PRD §6.7)
 *   3. the default page never fetches the model code, decoder or file
 *   4. with `?az-model=sample`, every request is same-origin, only the glTF
 *      decoder is fetched, and the model becomes drawable
 *   5. the poster stands in while the model loads, and stays if it fails
 *   6. `?az-model=` cannot be pointed at an arbitrary path
 *   7. load time (local, and a throttled-network PROXY) and heap growth across
 *      5 mount/unmount cycles (hero-spec §8 dispose())
 *
 * Runs on the GPU channel like m0.test.ts. Requires `pnpm build` and the
 * preview server: pnpm preview --port 4173 --strictPort
 * Run: pnpm test:model
 */

import { statSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
/** A8 and the hero manifest's model `maxBytes`. */
const BUDGET_BYTES = 5 * 1024 * 1024;
/** hero-spec §8 dispose(): the same bound as m0.test.ts check 2. */
const HEAP_GROWTH_BYTES = 5 * 1024 * 1024;
const MOUNT_CYCLES = 5;
/** What make-model.ts builds for the shipped sample. */
const SAMPLE_TRIANGLES = 218_880;
/** Artificial latency on the model file, so the loading state is observable. */
const SLOW_MODEL_MS = 1500;
/** A throttled link for the load-time proxy: ~10 Mbps down, 60 ms RTT. */
const PROXY_NETWORK = { offline: false, latency: 60, downloadThroughput: 1_250_000, uploadThroughput: 500_000 };

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const note = (name: string, detail: string) => console.log(`  NOTE  ${name}  — ${detail}`);

interface ModelReport { url: string; state: string; readyMs: number | null; triangles: number; error: string | null }
const report = (page: Page) =>
  page.evaluate(() => (window as unknown as { __AZ_MODEL__?: ModelReport }).__AZ_MODEL__ ?? null);

async function untilState(page: Page, state: string, ms = 20_000): Promise<ModelReport> {
  const end = Date.now() + ms;
  for (;;) {
    const r = await report(page);
    if (r?.state === state) return r;
    if (Date.now() > end) throw new Error(`model never reached '${state}'; last ${JSON.stringify(r)}`);
    await page.waitForTimeout(50);
  }
}

console.log('\nA8 — the opt-in .glb path\n');

/* 1. Size — A8. */
const glb = statSync(join(ROOT, 'dist/models/sample.glb')).size;
check('A8: the Draco sample model is under 5 MB', glb < BUDGET_BYTES,
      `${(glb / 1024 / 1024).toFixed(2)} MB for ${SAMPLE_TRIANGLES} triangles`);

/* 2. Offline build — the poison preload makes every socket, DNS lookup and fetch throw. */
{
  const out = mkdtempSync(join(tmpdir(), 'spike-offline-'));
  const poison = join(ROOT, '../packages/cli/test/no-network.mjs');
  const r = spawnSync(process.execPath,
    ['--import', poison, join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--logLevel', 'error'],
    { cwd: ROOT, encoding: 'utf8' });
  check('PRD §6.7: the model build succeeds with the network poisoned',
        r.status === 0 && !/NETWORK ATTEMPT/.test(r.stderr), r.status === 0 ? '' : r.stderr.slice(0, 200));
  rmSync(out, { recursive: true, force: true });
}

const browser = await chromium.launch({ channel: 'chromium' });
try {
  /* 3. The default page pays nothing for the model path. */
  {
    const page = await browser.newPage();
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    await page.goto(`${BASE}/?az-tier=full&az-probe=off`, { waitUntil: 'networkidle' });
    const paid = urls.filter((u) => /model-|draco|\.glb/.test(u));
    check('the default (procedural) page fetches no model code, decoder or file', paid.length === 0,
          paid.join(' '));
    await page.close();
  }

  /* 4. The model path: same-origin only, glTF decoder only, drawable. */
  {
    const page = await browser.newPage();
    const urls: string[] = [];
    const errors: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    page.on('pageerror', (e) => errors.push(e.message));
    const t0 = Date.now();
    await page.goto(`${BASE}/?az-model=sample&az-tier=full&az-probe=off`);
    const ready = await untilState(page, 'ready');
    const wall = Date.now() - t0;
    const origin = new URL(BASE).origin;
    const foreign = urls.filter((u) => !u.startsWith(origin) && !u.startsWith('data:') && !u.startsWith('blob:'));
    check('every request is same-origin — the decoder is self-hosted, no CDN', foreign.length === 0,
          foreign.join(' '));
    const wasm = urls.filter((u) => u.endsWith('.wasm'));
    const fallbackJs = urls.filter((u) => /draco_decoder-[^/]*\.js$/.test(u));
    check('only the glTF decoder is fetched (one wasm, no JS fallback)',
          wasm.length === 1 && fallbackJs.length === 0, wasm.map((u) => u.split('/').pop()).join(' '));
    check('the model decodes to the triangles that were encoded', ready.triangles === SAMPLE_TRIANGLES,
          `${ready.triangles} triangles`);
    const tier = await page.evaluate(() => (window as unknown as { __AZ_TIER__: { vertices: number } }).__AZ_TIER__);
    check('the renderer draws the model (vertices measured, not assumed)', tier.vertices > 0,
          `${tier.vertices} vertices`);
    check('the poster is gone once the model is drawable',
          (await page.locator('.poster').count()) === 0);
    check('no page errors on the model path', errors.length === 0, errors.join('; '));
    note('load time, local preview server',
         `${ready.readyMs?.toFixed(0)} ms from navigation to drawable (${wall} ms wall)`);
    await page.close();
  }

  /* 7a. Load time on a throttled link — PROXY, not a device measurement. */
  {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', PROXY_NETWORK);
    await page.goto(`${BASE}/?az-model=sample&az-tier=full&az-probe=off`);
    const ready = await untilState(page, 'ready', 60_000);
    note('load time, throttled ~10 Mbps / 60 ms RTT (proxy)', `${ready.readyMs?.toFixed(0)} ms to drawable`);
    await page.close();
  }

  /* 5. The poster stands in while loading, and stays on failure. */
  {
    const page = await browser.newPage();
    await page.route('**/models/sample.glb', async (route) => {
      await new Promise((r) => setTimeout(r, SLOW_MODEL_MS));
      await route.continue();
    });
    await page.goto(`${BASE}/?az-model=sample&az-tier=full&az-probe=off`);
    await page.waitForSelector('.poster[data-model-state="loading"]', { timeout: 5000 });
    check('hero-spec §8: the poster shows while the model loads', true);
    await untilState(page, 'ready');
    check('CONTROL: the poster leaves once it loads', (await page.locator('.poster').count()) === 0);
    await page.close();
  }
  {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/models/sample.glb', (route) => route.fulfill({ status: 404, body: '' }));
    await page.goto(`${BASE}/?az-model=sample&az-tier=full&az-probe=off`);
    const failed = await untilState(page, 'failed');
    check('a model that cannot load leaves the poster up',
          (await page.locator('.poster[data-model-state="failed"]').count()) === 1, failed.error ?? '');
    check('the failure is handled, not thrown to the page', errors.length === 0, errors.join('; '));
    await page.close();
  }

  /* 6. The query string only names models; it never supplies a path. */
  {
    const page = await browser.newPage();
    const urls: string[] = [];
    page.on('request', (r) => urls.push(r.url()));
    await page.goto(`${BASE}/?az-model=../../etc/passwd&az-tier=full&az-probe=off`, { waitUntil: 'networkidle' });
    // The page's own URL carries the hostile value; only what it LOADS counts.
    const loaded = urls.filter((u) => new URL(u).pathname !== '/');
    check('an unknown ?az-model= value loads nothing and keeps the procedural default',
          !loaded.some((u) => /\.glb|passwd|model-|draco/.test(u)) && (await report(page)) === null,
          loaded.filter((u) => /\.glb|passwd|model-|draco/.test(u)).join(' '));
    await page.close();
  }

  /* 7b. dispose(): heap growth across mount/unmount cycles of the model path. */
  {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    const heap = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      await cdp.send('HeapProfiler.collectGarbage');
      return (await cdp.send('Runtime.getHeapUsage')).usedSize;
    };
    await page.goto(`${BASE}/?az-model=sample&az-tier=full&az-probe=off&az-test=mount`);
    await untilState(page, 'ready');
    const cycle = async () => {
      await page.evaluate(() => (window as unknown as { __azUnmount: () => void }).__azUnmount());
      await page.evaluate(() => { (window as unknown as { __AZ_MODEL__?: unknown }).__AZ_MODEL__ = undefined; });
      await page.evaluate(() => (window as unknown as { __azMount: () => void }).__azMount());
      await untilState(page, 'ready');
    };
    await cycle();                       // warm: first-mount allocations are not a leak
    const before = await heap();
    for (let i = 0; i < MOUNT_CYCLES; i++) await cycle();
    const after = await heap();
    check(`hero-spec §8: heap growth over ${MOUNT_CYCLES} model mount/unmount cycles < 5 MB`,
          after - before < HEAP_GROWTH_BYTES, `${((after - before) / 1024 / 1024).toFixed(2)} MB (JS heap only)`);
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
