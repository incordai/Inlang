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
import { WIDTHS, overflow, axe, keyboard, reducedMotion, bodyBackground } from './visual/checks.mjs';
import { startServer } from './visual/serve.mjs';

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
  cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, AZ_WORDS: WORDS },
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

const CHECKS = ['compile', 'overflow', 'axe', 'keyboard', 'reduced-motion', 'schemes', 'firefox', 'webkit'];
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

async function buildAll(words, work) {
  const sites = words.flatMap((word) => THEMES.map((theme) => ({ word, theme })));
  for (const s of sites) {
    s.dir = join(work, `${s.word}-${s.theme}`);
    mkdirSync(s.dir, { recursive: true });
    const src = join(WORDS, s.word);
    writeFileSync(join(s.dir, 'site.az'), themed(readFileSync(join(src, 'preview.az'), 'utf8'), s.theme));
    if (existsSync(join(src, 'preview-assets'))) cpSync(join(src, 'preview-assets'), join(s.dir, 'preview-assets'), { recursive: true });
  }
  // A preview that no longer compiles is a finding for that word, not a
  // reason to skip every other word.
  await pool(sites, BUILD_CONCURRENCY, async (s) => {
    try {
      await node(CLI, ['build', join(s.dir, 'site.az'), '--out', join(s.dir, 'proj')], s.dir);
      s.compiled = true;
      record(s.word, 'compile', s.theme, { pass: true });
    } catch (e) {
      const errors = String(e.stderr ?? e.message).split('\n').filter((l) => / error /.test(l))
        .map((l) => l.replace(/^.*?error /, ''));
      record(s.word, 'compile', s.theme, { pass: false, detail: errors.join(' | ') || 'az build failed' });
    }
  });
  const built = sites.filter((s) => s.compiled);
  console.log(`compiled ${built.length}/${sites.length} sites`);
  if (built.length === 0) return [];

  // One install serves every site: the emitted pins are identical by design,
  // and this checks that rather than assuming it.
  const pkg = readFileSync(join(built[0].dir, 'proj/package.json'), 'utf8');
  const depsOf = (text) => JSON.stringify({ ...JSON.parse(text), name: '' });
  for (const s of built) {
    if (depsOf(readFileSync(join(s.dir, 'proj/package.json'), 'utf8')) !== depsOf(pkg)) {
      throw new Error(`visual: ${s.word}/${s.theme} emits different dependencies — one install cannot serve it`);
    }
  }
  const shared = join(work, 'shared');
  mkdirSync(shared);
  writeFileSync(join(shared, 'package.json'), pkg);
  await node(NPM_CLI, ['install', '--no-audit', '--no-fund'], shared);
  console.log('installed shared node_modules');

  await pool(built, BUILD_CONCURRENCY, async (s) => {
    const proj = join(s.dir, 'proj');
    symlinkSync(join(shared, 'node_modules'), join(proj, 'node_modules'), 'dir');
    await node(join(proj, 'node_modules/vite/bin/vite.js'), ['build', '--logLevel', 'error'], proj);
    s.dist = join(proj, 'dist');
  });
  console.log(`built ${built.length} sites with vite\n`);
  return built;
}

/* ---- check one site ----------------------------------------------------- */

async function checkSite(s, browsers, server) {
  server.serve(s.dist);
  const shots = join(OUT, s.word);
  mkdirSync(shots, { recursive: true });
  const tag = (scheme, width) => `${s.theme}/${scheme}/${width}`;

  const ctx = await browsers.chromium.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  const bg = {};
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'no-preference' });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(server.url, { waitUntil: 'load' });
      record(s.word, 'overflow', tag(scheme, width), await overflow(page));
      await page.screenshot({ path: join(shots, `${s.theme}-${scheme}-${width}.png`), fullPage: true });
      if (width !== 768) record(s.word, 'axe', tag(scheme, width), await axe(page));
      if (width === 1440) {
        bg[scheme] = await bodyBackground(page);
        record(s.word, 'keyboard', tag(scheme, width), await keyboard(page));
      }
    }
  }
  record(s.word, 'schemes', s.theme, {
    pass: bg.light !== bg.dark,
    detail: `light and dark paint the same body background (${bg.light})`,
  });

  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(server.url, { waitUntil: 'load' });
  record(s.word, 'reduced-motion', `${s.theme}/light/1440`, await reducedMotion(page));
  await ctx.close();

  // The smaller pass: another engine at one width, overflow and page errors.
  for (const [name, width] of [['firefox', 1440], ['webkit', 390]]) {
    const other = await browsers[name].newPage({ viewport: { width, height: 900 } });
    const errors = [];
    other.on('pageerror', (e) => errors.push(e.message));
    await other.goto(server.url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    const o = await overflow(other);
    record(s.word, name, `${s.theme}/light/${width}`, {
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
  <main><h1>Bad</h1>
  <div style="width:800px;height:10px"></div>
  <button></button>
  <button class="spin">Spin</button>
  <input aria-label="trap" onkeydown="if (event.key === 'Tab') event.preventDefault()">
  </main></body></html>`;

const GOOD = `<!doctype html><html lang="en"><head><title>good</title><style>
  body { background: white; }
  @media (prefers-color-scheme: dark) { body { background: black; color: white; } }
  @media (prefers-reduced-motion: no-preference) {
    @keyframes fade { from { opacity: .5; } } .fade { animation: fade 1s infinite; }
  }
</style></head><body>
  <main><h1>Good</h1>
  <p class="fade">Fits.</p>
  <a href="#x">A link</a> <button>A button</button>
  </main></body></html>`;

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
    expect('item 3 overflow at 390', await overflow(page), shouldPass);
    expect('item 4 axe', await axe(page), shouldPass);
    expect('item 5 keyboard', await keyboard(page), shouldPass);
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
  await browser.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(`\n${wrong === 0 ? 'SELF-TEST PASSED — every check fails the bad page and passes the good one' : `SELF-TEST FAILED — ${wrong} check(s) misjudged`}`);
  return wrong === 0 ? 0 : 1;
}

/* ---- main --------------------------------------------------------------- */

async function main(argv) {
  if (argv.includes('--self-test')) return selfTest();

  const all = readdirSync(WORDS).filter((w) => existsSync(join(WORDS, w, 'preview.az'))).sort();
  const words = argv.length ? all.filter((w) => argv.includes(w)) : all;
  const unknown = argv.filter((a) => !all.includes(a));
  if (unknown.length) throw new Error(`visual: no preview for: ${unknown.join(', ')}`);

  const started = performance.now();
  const work = mkdtempSync(join(tmpdir(), 'az-visual-'));
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const sites = await buildAll(words, work);
  const browsers = { chromium: await chromium.launch(), firefox: await firefox.launch(), webkit: await webkit.launch() };
  const versions = Object.fromEntries(Object.entries(browsers).map(([k, b]) => [k, b.version()]));
  const server = await startServer();
  try {
    for (const s of sites) {
      await checkSite(s, browsers, server);
      process.stdout.write(`checked ${s.word}/${s.theme}\n`);
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
