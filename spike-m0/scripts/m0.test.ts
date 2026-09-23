/**
 * motion-tiers-spec §8.1 checks 1–3 and 6–8, and the §8.3 synthetic-throttle
 * protocol, on this machine's real GPU.
 *
 * Playwright's `chromium` channel runs headless on the GPU (ANGLE/Metal on
 * macOS); the default headless shell renders with SwiftShader, which would
 * measure a software rasteriser. The renderer string is printed first so the
 * record says which one produced the numbers.
 *
 * §8.3 numbers are PROXY: CPU throttling reproduces main-thread starvation,
 * not mobile GPU, thermal or memory behaviour. They test the detector, not a
 * device, and must never be quoted as device evidence.
 *
 * Requires the preview server: pnpm preview --port 4173 --strictPort
 * Run: pnpm test:m0            (M0_THROTTLE_SECONDS=60 by default)
 */

import { chromium, type Browser, type Page } from 'playwright';
import { LADDER, STATIC_RUNG } from '../src/tiers.ts';

const BASE = process.env.BASE_URL ?? 'http://localhost:4173';
const THROTTLE_SECONDS = Number(process.env.M0_THROTTLE_SECONDS ?? 60);
const FPS_SECONDS = 10;

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};
const note = (name: string, detail: string) => console.log(`  NOTE  ${name}  — ${detail}`);

interface AzTier {
  rung: number; decidedRung: number; tier: string; canvas: boolean; probe: boolean;
  pixelRatio: number; postPasses: number; cameraSubscriptions: number; shadowMap: boolean;
  vertices: number; frameloop: string; probeCostP95Ms: number;
  engine: null | { settled: boolean; armed: boolean; windowsJudged: number;
    lastWindow: { p50: number; p95: number } | null;
    transitions: { from: number; to: number; reason: string; atMs: number }[] };
}
const az = (page: Page) => page.evaluate(() => (window as unknown as { __AZ_TIER__: AzTier }).__AZ_TIER__);

/** Wait until the page's instrumentation says `pred`. */
async function until(page: Page, pred: (t: AzTier) => boolean, ms = 10_000): Promise<AzTier> {
  const end = Date.now() + ms;
  for (;;) {
    const t = await az(page).catch(() => undefined);
    if (t && pred(t)) return t;
    if (Date.now() > end) throw new Error(`timed out; last state ${JSON.stringify(t)}`);
    await page.waitForTimeout(100);
  }
}

/**
 * Scroll the page continuously (a triangle wave over the scroll range) and
 * record every rAF interval, independently of the probe. Returns p50/p95 ms.
 */
async function scrollAndSample(page: Page, seconds: number): Promise<{ p50: number; p95: number; n: number }> {
  return page.evaluate(async (secs) => {
    const intervals: number[] = [];
    const max = document.documentElement.scrollHeight - innerHeight;
    const t0 = performance.now();
    let last = t0;
    await new Promise<void>((done) => {
      const tick = (now: number) => {
        intervals.push(now - last);
        last = now;
        const phase = ((now - t0) / 4000) % 2;           // 4s down, 4s up
        scrollTo(0, max * (phase < 1 ? phase : 2 - phase));
        if (now - t0 < secs * 1000) requestAnimationFrame(tick); else done();
      };
      requestAnimationFrame(tick);
    });
    const s = intervals.slice(1).sort((a, b) => a - b);
    const at = (p: number) => s[Math.max(0, Math.ceil(p * s.length) - 1)];
    return { p50: at(0.5), p95: at(0.95), n: s.length };
  }, seconds);
}

async function run() {
  const browser: Browser = await chromium.launch({ channel: 'chromium' });
  console.log('\nM0 — §8.1 / §8.3 on this machine\n');

  {
    const page = await browser.newPage();
    await page.setContent('<canvas></canvas>');
    const gpu = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const d = gl?.getExtension('WEBGL_debug_renderer_info');
      return d && gl ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'unknown';
    });
    note('renderer', gpu);
    await page.close();
  }

  /* Check 1 — `full` sustained FPS over a 10s scroll. */
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(`${BASE}/?az-tier=full&az-probe=off`, { waitUntil: 'domcontentloaded' });
    await until(page, (t) => t.pixelRatio > 0);
    await page.waitForTimeout(2000);                     // past shader compile and upload
    const r = await scrollAndSample(page, FPS_SECONDS);
    check('#1 `full` sustained: p95 ≤ 20.0ms (p5 ≥ 50fps) over a 10s scroll, DPR 2',
      r.p95 <= 20.0, `p50 ${r.p50.toFixed(1)}ms, p95 ${r.p95.toFixed(1)}ms (p5 ${(1000 / r.p95).toFixed(0)}fps), ${r.n} frames`);
    await page.close();
  }

  /* Check 2 — heap growth over 5 mount/unmount cycles < 5 MB. */
  {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await page.goto(`${BASE}/?az-tier=full&az-probe=off&az-test=mount`, { waitUntil: 'domcontentloaded' });
    await until(page, (t) => t.pixelRatio > 0);
    await page.waitForTimeout(1500);
    const heap = async () => {
      await cdp.send('HeapProfiler.collectGarbage');
      await cdp.send('HeapProfiler.collectGarbage');
      return (await cdp.send('Runtime.getHeapUsage')).usedSize;
    };
    const cycle = async () => {
      await page.evaluate(() => (window as unknown as { __azUnmount: () => void }).__azUnmount());
      await page.waitForTimeout(300);
      await page.evaluate(() => (window as unknown as { __azMount: () => void }).__azMount());
      await page.waitForSelector('canvas');
      await page.waitForTimeout(1200);
    };
    await cycle();                                        // first cycle warms caches
    const before = await heap();
    for (let i = 0; i < 5; i++) await cycle();
    const after = await heap();
    const growthMb = (after - before) / 1024 / 1024;
    check('#2 heap growth over 5 mount/unmount cycles < 5 MB',
      growthMb < 5, `${(before / 1048576).toFixed(1)} → ${(after / 1048576).toFixed(1)} MB (${growthMb >= 0 ? '+' : ''}${growthMb.toFixed(2)} MB)`);
    const canvases = await page.locator('canvas').count();
    check('CONTROL: after the cycles exactly one canvas is mounted', canvases === 1, `${canvases}`);
    await page.close();
  }

  /* Check 3 — the headline, not the canvas, is the LCP element. */
  {
    const page = await browser.newPage();
    await page.goto(`${BASE}/?az-tier=full&az-probe=off`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const lcp = await page.evaluate(() => new Promise<string>((done) => {
      new PerformanceObserver((list) => {
        const e = list.getEntries().at(-1) as PerformanceEntry & { element?: Element };
        done(e?.element ? `${e.element.tagName.toLowerCase()}${e.element.className ? '.' + e.element.className : ''}` : 'none');
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      setTimeout(() => done('no entry'), 2000);
    }));
    check('#3 the LCP element is the <h1> (or its text), not the canvas',
      lcp.startsWith('h1') || lcp.startsWith('em'), lcp);
    await page.close();
  }

  /* Check 6 — every rung forceable, and its EFFECT read back from the renderer. */
  for (const rung of LADDER) {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    await page.goto(`${BASE}/?az-rung=${rung.index}&az-probe=off`, { waitUntil: 'domcontentloaded' });
    const t = await until(page, (s) => s.rung === rung.index && (!rung.canvas || s.pixelRatio > 0));
    await page.waitForTimeout(400);
    const m = await az(page);
    const canvas = (await page.locator('canvas').count()) > 0;
    const want = {
      canvas: rung.canvas,
      pixelRatio: rung.canvas ? Math.min(2, rung.dprCap) : undefined,
      postPasses: 0,                                       // the scene has no post chain
      shadowMap: rung.canvas ? rung.shadows : undefined,
      cameraSubscriptions: rung.scrollLinkedCamera ? 1 : 0,
      frameloop: rung.canvas ? (rung.scrollLinkedCamera ? 'always' : 'demand') : undefined,
    };
    const got = {
      canvas,
      pixelRatio: rung.canvas ? m.pixelRatio : undefined,
      postPasses: m.postPasses,
      shadowMap: rung.canvas ? m.shadowMap : undefined,
      cameraSubscriptions: m.cameraSubscriptions,
      frameloop: rung.canvas ? m.frameloop : undefined,
    };
    const ok = JSON.stringify(want) === JSON.stringify(got) && t.rung === rung.index;
    check(`#6 rung ${rung.index} (${rung.label}) — effect matches the ladder`, ok,
      `dpr ${got.pixelRatio ?? '—'}, post ${got.postPasses}, shadowMap ${got.shadowMap ?? '—'}, ` +
      `camera subs ${got.cameraSubscriptions}, loop ${got.frameloop ?? '—'}, ` +
      `verts ${rung.canvas ? m.vertices : '—'}${ok ? '' : ` · wanted ${JSON.stringify(want)}`}`);
    await page.close();
  }
  {
    // The LOD rung must change the geometry, or rung 5 is cosmetic.
    const verts = async (r: number) => {
      const page = await browser.newPage();
      await page.goto(`${BASE}/?az-rung=${r}&az-probe=off`, { waitUntil: 'domcontentloaded' });
      const t = await until(page, (s) => s.vertices > 0);
      await page.close();
      return t.vertices;
    };
    const [hi, lo] = [await verts(4), await verts(5)];
    check('#6 rung 5 swaps to the low LOD (fewer vertices than rung 4)', lo < hi, `${hi} → ${lo}`);
  }

  /* Check 7 — probe overhead: same scene, probe on vs off, p95 delta < 0.5 ms. */
  {
    const trial = async (probe: boolean) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      await page.goto(`${BASE}/?az-tier=full${probe ? '' : '&az-probe=off'}`, { waitUntil: 'domcontentloaded' });
      await until(page, (t) => t.pixelRatio > 0);
      await page.waitForTimeout(2000);
      const r = await scrollAndSample(page, FPS_SECONDS);
      const t = await az(page);
      await page.close();
      return { p95: r.p95, cost: t.probeCostP95Ms, rung: t.rung };
    };
    const on: number[] = [], off: number[] = [], cost: number[] = [];
    for (let i = 0; i < 3; i++) {                          // interleaved, so drift hits both
      const a = await trial(true); on.push(a.p95); cost.push(a.cost);
      const b = await trial(false); off.push(b.p95);
    }
    const med = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1];
    const delta = med(on) - med(off);
    check('#7 probe overhead: frame p95 delta (on − off) < 0.5 ms',
      delta < 0.5, `on ${on.map((x) => x.toFixed(2)).join('/')} · off ${off.map((x) => x.toFixed(2)).join('/')} ms · median delta ${delta.toFixed(2)}ms`);
    check('#7 the probe\'s own per-frame cost p95 < 0.5 ms (timed inside the frame)',
      med(cost) < 0.5, `${cost.map((x) => x.toFixed(3)).join('/')} ms`);
  }

  /* Check 8 — context loss → static: poster, alt, no console error. */
  {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${BASE}/?az-tier=full`, { waitUntil: 'domcontentloaded' });
    await until(page, (t) => t.pixelRatio > 0);
    await page.waitForTimeout(1000);
    const lost = await page.evaluate(() => {
      const c = document.querySelector('canvas') as HTMLCanvasElement;
      const ext = c.getContext('webgl2')?.getExtension('WEBGL_lose_context');
      ext?.loseContext();
      return !!ext;
    });
    const t = await until(page, (s) => s.rung === STATIC_RUNG, 5000).catch(() => undefined);
    const poster = page.locator('.poster[role="img"]');
    const alt = (await poster.count()) ? await poster.getAttribute('aria-label') : null;
    check('#8 WEBGL_lose_context → static, canvas gone',
      lost && t?.rung === STATIC_RUNG && (await page.locator('canvas').count()) === 0,
      `rung ${t?.rung}, reason ${t?.engine?.transitions.at(-1)?.reason ?? '—'}`);
    check('#8 the poster shows with its text alternative', !!alt, alt ?? 'no poster');
    await page.waitForTimeout(500);
    check('#8 no console or page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.close();
  }

  /* §8.3 — CPU throttle at 4× and 6×, 60s of scroll each. PROXY numbers. */
  for (const rate of [4, 6]) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await until(page, (t) => t.rung !== undefined, 20_000);
    const rungs: number[] = [];
    const poll = setInterval(async () => {
      const t = await az(page).catch(() => undefined);
      if (t) rungs.push(t.rung);
    }, 500);
    const r = await scrollAndSample(page, THROTTLE_SECONDS);
    clearInterval(poll);
    const t = await az(page);
    const seq = rungs.filter((x, i) => i === 0 || x !== rungs[i - 1]);
    const oneWay = seq.every((x, i) => i === 0 || x > seq[i - 1]);
    note(`§8.3 ${rate}× CPU throttle [proxy]`,
      `frame p50 ${r.p50.toFixed(1)} p95 ${r.p95.toFixed(1)}ms over ${THROTTLE_SECONDS}s; settled at rung ${t.rung} ` +
      `(${LADDER[t.rung].label}); applied path ${seq.join('→')}; decisions ` +
      `${t.engine?.transitions.map((x) => `${x.from}→${x.to}@${(x.atMs / 1000).toFixed(1)}s[${x.reason}]`).join(', ') || 'none'}`);
    check(`§8.3 ${rate}× [proxy]: no oscillation over a ${THROTTLE_SECONDS}s scroll — rungs only increase`,
      oneWay, `applied path ${seq.join('→')}`);
    check(`§8.3 ${rate}× [proxy]: the rung it rests on holds the floor, or it is the floor`,
      t.rung === STATIC_RUNG || (t.engine?.lastWindow?.p95 ?? Infinity) <= (LADDER[t.rung].tier === 'full' ? 20 : 33.3)
        || t.rung === 6,
      `last probe window p95 ${t.engine?.lastWindow?.p95?.toFixed(1) ?? '—'}ms at rung ${t.rung}`);
    await page.close();
  }

  /* §8.3 by synthetic per-frame load — the throttle above cannot starve this
     scene on a fast GPU, so load is injected instead. PROXY. Also measures
     §5's deferral: rungs 1–2 applied at once, 3–7 at scroll-idle or ≤ 2s. */
  {
    const LOAD_MS = Number(process.env.M0_LOAD_MS ?? 22);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(`${BASE}/?az-load=${LOAD_MS}`, { waitUntil: 'domcontentloaded' });
    await until(page, (t) => t.pixelRatio > 0, 20_000);
    const seen: { at: number; rung: number; decided: number }[] = [];
    const t0 = Date.now();
    const poll = setInterval(async () => {
      const t = await az(page).catch(() => undefined);
      if (t) seen.push({ at: Date.now() - t0, rung: t.rung, decided: t.decidedRung });
    }, 100);
    const r = await scrollAndSample(page, THROTTLE_SECONDS);
    clearInterval(poll);
    const t = await az(page);
    const applied = seen.map((x) => x.rung).filter((x, i, a) => i === 0 || x !== a[i - 1]);
    // Lag from the engine deciding a rung to the page applying it.
    const lags: string[] = [];
    let worstDeferred = 0, worstImmediate = 0;
    for (let k = 1; k <= STATIC_RUNG; k++) {
      const decided = seen.find((x) => x.decided >= k);
      const shown = seen.find((x) => x.rung >= k);
      if (!decided || !shown) continue;
      const lag = shown.at - decided.at;
      lags.push(`${k}:${lag}ms`);
      if (LADDER[k].deferred) worstDeferred = Math.max(worstDeferred, lag);
      else worstImmediate = Math.max(worstImmediate, lag);
    }
    note(`§8.3 synthetic load ${LOAD_MS}ms/frame [proxy]`,
      `frame p50 ${r.p50.toFixed(1)} p95 ${r.p95.toFixed(1)}ms over ${THROTTLE_SECONDS}s of continuous scroll; ` +
      `applied path ${applied.join('→')}; decisions ${t.engine?.transitions.map((x) => `${x.from}→${x.to}@${(x.atMs / 1000).toFixed(1)}s`).join(', ') || 'none'}; ` +
      `decide→apply lag ${lags.join(' ') || '—'}`);
    check(`§8.3 load [proxy]: the probe steps down under sustained load`, applied.length > 1, applied.join('→'));
    check(`§8.3 load [proxy]: one-way — no oscillation over ${THROTTLE_SECONDS}s`,
      applied.every((x, i) => i === 0 || x > applied[i - 1]), applied.join('→'));
    check('§5 rungs 1–2 apply at once (≤ 300ms of polling slack)', worstImmediate <= 300, `${worstImmediate}ms`);
    check('§5 rungs 3–7 wait, but never past the 2s deadline under continuous scroll (≤ 2300ms)',
      worstDeferred <= 2300, `${worstDeferred}ms`);
    await page.close();
  }

  await browser.close();
  console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
  process.exitCode = failures === 0 ? 0 : 1;
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
