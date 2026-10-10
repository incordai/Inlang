/**
 * `pnpm test:palette` — the `az palette` gallery in real browsers
 * (theme-spec §14).
 *
 * The page is written by the real binary, twice, and must be the same bytes.
 * Then, in Chromium, Firefox and WebKit, served over http and opened from
 * the file as a user would:
 *   - csp       zero Content-Security-Policy violations (the build's own
 *               policy: its one script and stylesheet allowed by hash), and
 *               the copy script ran — its buttons are shown;
 *   - axe       zero violations;
 *   - overflow  no sideways scroll at a phone's width.
 * In Chromium also: every copy button and link is reachable by Tab with a
 * focus indicator (on one theme's page: the same cards, fewer stops), a copy
 * button writes its lines and says so, and one screenshot per theme in a
 * light and a dark browser — rendered twice, identical bytes — written to
 * .palette-shots/<theme>-<scheme>.png (gitignored, like .thumbnails/).
 * The CSP watch's control (a page that refuses its own script) must fail.
 *
 *     node scripts/palette.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { ROOT } from './visual/pipeline.mjs';
import { startServer } from './visual/serve.mjs';
import { axe, keyboard, overflow, PHONE_WIDTH } from './visual/checks.mjs';
import { cspResult, violationControl, watchedContext } from './visual/csp.mjs';
import { Overdue, closeWithin, human, within, watchdog } from './lib/bounded.mjs';

const BIN = join(ROOT, 'packages/cli/bin/az.js');
const OUT = join(ROOT, '.palette-shots');
const THEMES = Object.keys((await import(join(ROOT, 'packages/theme/src/themes.ts'))).THEMES);
const DESKTOP = { width: 1280, height: 900 };
/** One az palette run proves every pair it paints: a few seconds. */
const WRITE_MS = 120_000;
/** One check on one page (a load, axe over ~400 panels, a tab walk). */
const CHECK_MS = 120_000;
const CLOSE_MS = 15_000;
const RUN_MS = 30 * 60_000;
/** Between two looks for the copy status. */
const POLL_MS = 50;

const failures = [];
const passed = [];
const progress = { last: 'writing the page' };
const record = (name, r) => {
  if (r.pass) passed.push(name);
  else failures.push(`${name}: ${r.detail}`);
  console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${name}${r.pass || !r.detail ? '' : ` — ${r.detail}`}`);
};

/** The gallery written by the real binary into `dir`; its bytes. */
function write(dir, ...args) {
  const r = spawnSync(process.execPath, [BIN, 'palette', '--out', dir, ...args], { encoding: 'utf8', timeout: WRITE_MS });
  if (r.status !== 0) throw new Error(`az palette ${args.join(' ')} exited ${r.status ?? r.signal}: ${r.stderr}`);
  return readFileSync(join(dir, 'index.html'));
}

/** `check` on a fresh watched page at `url`, bounded; an overdue check is a FAIL that names it. */
async function onPage(browser, sinks, label, url, options, check) {
  let ctx;
  try {
    return await within(CHECK_MS, label, async () => {
      ctx = await watchedContext(browser, sinks, options);
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'load', timeout: CHECK_MS });
      return check(page);
    });
  } catch (e) {
    if (!(e instanceof Overdue)) throw e;
    return { pass: false, detail: e.message };
  } finally {
    if (ctx) await closeWithin(ctx, CLOSE_MS, `${label} context.close`);
  }
}

/** The copy script ran under the policy: every button is shown. */
const buttonsShown = (page) => page.evaluate(() => {
  const all = [...document.querySelectorAll('button[data-copy]')];
  const hidden = all.filter((b) => b.hidden).length;
  return { pass: all.length > 0 && hidden === 0, detail: `${hidden}/${all.length} copy buttons still hidden` };
});

async function copies(page) {
  await page.locator('button[data-copy]').first().click();
  const status = page.locator('#copy-status');
  for (const until = Date.now() + CHECK_MS / 4; Date.now() < until;) {
    const text = await status.textContent();
    if (text) {
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      const pass = text.startsWith('Copied: theme ') && clip.startsWith('theme ');
      return { pass, detail: `status '${text}', clipboard '${clip}'` };
    }
    await page.waitForTimeout(POLL_MS);
  }
  return { pass: false, detail: 'no copy status' };
}

async function main() {
  const run = watchdog(RUN_MS, 'test:palette', progress);
  console.log(`deadlines: write ${human(WRITE_MS)} · check ${human(CHECK_MS)} · run ${human(RUN_MS)}`);
  const work = mkdtempSync(join(tmpdir(), 'az-palette-check-'));
  const full = join(work, 'all');
  const again = join(work, 'again');
  const one = join(work, 'one');
  const first = write(full);
  record('deterministic: two runs write the same bytes', { pass: first.equals(write(again)), detail: 'the two pages differ' });
  write(one, '--theme', THEMES[0]);

  const server = await startServer();
  server.serve(work);
  const sinks = {};
  const browsers = {};
  try {
    for (const [name, type] of [['chromium', chromium], ['firefox', firefox], ['webkit', webkit]]) {
      progress.last = `${name}: launch`;
      browsers[name] = await within(CHECK_MS, `${name}.launch`, () => type.launch());
    }
    for (const [name, browser] of Object.entries(browsers)) {
      progress.last = `${name}: checks`;
      const control = await violationControl(browser, `${server.url}control.html`, CHECK_MS);
      record(`${name} control: a page that refuses its own script is reported`, { pass: control.length > 0, detail: 'the CSP watch saw nothing' });
      for (const [where, url] of [['http', `${server.url}all/index.html`], ['file', pathToFileURL(join(full, 'index.html')).href]]) {
        record(`${name} ${where}: copy script runs under the policy`, await onPage(browser, sinks, `${name} ${where} script`, url, { viewport: DESKTOP }, buttonsShown));
      }
      for (const scheme of ['light', 'dark']) {
        record(`${name} axe (${scheme} browser)`, await onPage(browser, sinks, `${name} axe ${scheme}`, `${server.url}all/index.html`,
          { viewport: DESKTOP, colorScheme: scheme }, axe));
      }
      record(`${name} overflow at ${PHONE_WIDTH}px`, await onPage(browser, sinks, `${name} overflow`, `${server.url}all/index.html`,
        { viewport: { width: PHONE_WIDTH, height: 800 } }, overflow));
      record(`${name} csp: zero violations`, cspResult(sinks[name] ?? []));
    }

    const c = browsers.chromium;
    progress.last = 'chromium: keyboard';
    record(`chromium keyboard (${THEMES[0]} page)`, await onPage(c, sinks, 'keyboard', `${server.url}one/index.html`, { viewport: DESKTOP }, keyboard));
    record('chromium copy: the lines reach the clipboard', await onPage(c, sinks, 'copy', `${server.url}one/index.html`,
      { viewport: DESKTOP, permissions: ['clipboard-read', 'clipboard-write'] }, copies));

    progress.last = 'chromium: screenshots';
    const shots = {};
    for (const pass of [0, 1]) {
      for (const scheme of ['light', 'dark']) {
        await onPage(c, sinks, `screenshots ${scheme} ${pass}`, `${server.url}all/index.html`,
          { viewport: DESKTOP, colorScheme: scheme, deviceScaleFactor: 1, reducedMotion: 'reduce' }, async (page) => {
            await page.evaluate(() => document.fonts.ready);
            for (const theme of THEMES) {
              const png = await page.locator(`#theme-${theme}`).screenshot({ animations: 'disabled', caret: 'hide', timeout: CHECK_MS });
              const key = `${theme}-${scheme}`;
              if (pass === 0) shots[key] = png;
              else record(`screenshot ${key}: two renders identical`, { pass: shots[key]?.equals(png) ?? false, detail: 'the renders differ' });
            }
            return { pass: true };
          });
      }
    }
    record(`screenshots: ${THEMES.length} themes × light and dark`, { pass: Object.keys(shots).length === THEMES.length * 2, detail: `${Object.keys(shots).length} taken` });
    record('chromium csp after keyboard, copy and screenshots: zero violations', cspResult(sinks.chromium ?? []));
    rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    for (const [key, png] of Object.entries(shots)) writeFileSync(join(OUT, `${key}.png`), png);
  } finally {
    for (const [name, b] of Object.entries(browsers)) await closeWithin(b, CLOSE_MS, `${name}.close`);
    await closeWithin(server, CLOSE_MS, 'server.close');
    rmSync(work, { recursive: true, force: true });
  }
  run.clear();
  console.log(`${passed.length} passed, ${failures.length} failed — screenshots in .palette-shots/`);
  console.log(failures.length === 0 ? 'PALETTE OK' : `${failures.length} PALETTE CHECK(S) FAILED`);
  return failures.length === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
