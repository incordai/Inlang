/**
 * `az dev` previews a file while it is still being written
 * (docs/partial-preview.md), end to end in a real browser.
 *
 * Spawns the real `az dev` on a file that starts half-written, then appends
 * the rest in chunks cut mid-line — the way an AI streams a file — and at
 * each step requires the open page to show the finished sections and only
 * those, with the "still writing" banner naming the line the preview stops
 * before. When the file is complete the banner is gone, the generated
 * project is byte-identical to a strict `az build`, and the browser logged
 * no error at any step.
 *
 * First run installs the generated project's dependencies (network).
 *
 * Run: pnpm test:dev (after scripts/dev-e2e.mjs)
 */

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { closeWithin, watchdog, human } from './lib/bounded.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = join(ROOT, 'packages/cli/bin/az.js');
const WORDS = join(ROOT, 'packages/words');
/** First run includes an npm install. */
const READY_TIMEOUT_MS = 180_000;
/** One chunk's way to the page: debounce, compile, write, Vite reload (or restart, for a new page). */
const STEP_TIMEOUT_MS = 30_000;
const EXIT_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 2 * 60_000;
/** The gap between the pieces of one chunk: faster than the debounce, as a streaming writer saves. */
const PIECE_MS = 15;
const PIECES = 4;
const POLL_MS = 200;

/* A normal run takes about a minute after the first install; past RUN_MS it is stuck. */
const RUN_MS = 10 * 60_000;
const CLOSE_MS = 15_000;
const progress = { last: 'starting' };
const run = watchdog(RUN_MS, 'test:dev preview', progress);
console.log(`deadlines: run ${human(RUN_MS)} · step ${human(STEP_TIMEOUT_MS)} · close ${human(CLOSE_MS)}`);

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  progress.last = name;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? `   ${detail}` : ''}`);
};

const SITE = `az 1

site studio
  nav bar
    link "Work" /work
  footer
    link "Work" /work

page /
  hero center
    title "Made by hand"
    sub   "Small batches, one bench."

  feature grid
    item "Leather"
      text "Cut from one hide."
    item "Thread"
      text "Waxed linen, sewn by hand."

  cta band
    title "Visit the studio"
    cta   "Book a visit" /work

page /work
  text
    title "Selected work"
    body  "Forty pairs a month."
`;
const LINES = SITE.split('\n');
/** The 1-based line of `text`, after line `from`. */
const lineOf = (text, from = 0) => LINES.findIndex((l, i) => i >= from && l === text) + 1;
const FEATURE = lineOf('  feature grid');
const CTA = lineOf('  cta band');
const WORK_TEXT = lineOf('  text', lineOf('page /work'));
const upTo = (marker) => SITE.slice(0, SITE.indexOf(marker) + marker.length);

/**
 * Each step ends mid-way through a block: an unterminated string, then a
 * missing value. `shows` must be on the page, `hides` must not, and the
 * banner must say where the preview stops and list the problem's line.
 */
const STEPS = [
  { name: 'a string cut off in the feature', until: upTo('      text "Cut fr'),
    shows: ['Made by hand', 'Small batches'], hides: ['Leather'], stops: FEATURE, problem: `site.az:${FEATURE + 2}:` },
  { name: 'a string cut off in the cta', until: upTo('    cta   "Book a vi'),
    shows: ['Leather', 'Waxed linen'], hides: ['Visit the studio'], stops: CTA, problem: `site.az:${CTA + 2}:` },
  { name: 'a text block with no body yet', until: upTo('    title "Selected work"\n'),
    shows: ['Visit the studio', 'Book a visit'], hides: ['Selected work'], stops: WORK_TEXT, problem: `site.az:${WORK_TEXT}:` },
];
check('CONTROL: the steps cut where they say',
  FEATURE > 0 && CTA > FEATURE && WORK_TEXT > CTA && STEPS.every((s, i) => i === 0 || s.until.startsWith(STEPS[i - 1].until)));

const freePort = () => new Promise((done) => {
  const probe = createServer();
  probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => done(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Append `text` in PIECES pieces, PIECE_MS apart — mid-line cuts included. */
async function stream(file, text) {
  const size = Math.ceil(text.length / PIECES);
  for (let at = 0; at < text.length; at += size) {
    appendFileSync(file, text.slice(at, at + size), 'utf8');
    await sleep(PIECE_MS);
  }
}

/** Every file of a generated project, minus what installing and Vite add. */
function tree(dir) {
  const out = new Map();
  const skip = new Set(['node_modules', 'dist', 'package-lock.json']);
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (skip.has(e)) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.set(relative(dir, p), readFileSync(p, 'utf8'));
    }
  };
  walk(dir);
  return out;
}

const dir = mkdtempSync(join(tmpdir(), 'az-dev-preview-'));
const source = join(dir, 'site.az');
const outDir = join(dir, '.az-build');
// The writer has only just started: no page yet, so nothing to preview.
writeFileSync(source, SITE.slice(0, SITE.indexOf('page /') + 'pag'.length), 'utf8');
const port = await freePort();

let out = '';
const az = spawn(process.execPath, [CLI, 'dev', source, '--out', outDir, '--port', String(port)], {
  cwd: dir,
  env: { ...process.env, AZ_WORDS: WORDS },
  stdio: ['ignore', 'pipe', 'pipe'],
});
progress.cleanup = () => az.kill('SIGINT');
progress.children = [az];
az.stdout.setEncoding('utf8');
az.stderr.setEncoding('utf8');
az.stdout.on('data', (c) => { out += c; });
az.stderr.on('data', (c) => { out += c; });

const until = async (ok, ms) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end && az.exitCode === null) await sleep(POLL_MS);
  return ok();
};

check('before the first page, az dev reports the problems and serves nothing',
  await until(() => /az: \S*site\.az:\d+:\d+ error AZ\d+/.test(out), STEP_TIMEOUT_MS) && !/watching for changes|still writing/.test(out),
  out.slice(-300));

await stream(source, STEPS[0].until.slice(readFileSync(source, 'utf8').length));
const ready = await until(() => /watching for changes/.test(out), READY_TIMEOUT_MS);
check('az dev serves the preview of a partial file', ready, ready ? '' : out.slice(-600));
if (!ready) { az.kill('SIGKILL'); process.exit(1); }
check('the terminal says the file is still being written', /az: still writing — \d+ problems? · preview stops before line \d+/.test(out));
const siteUrl = /site\s+(http:\/\/127\.0\.0\.1:\d+\/)/.exec(out)?.[1];
check('the site is on 127.0.0.1', Boolean(siteUrl), siteUrl);

let closed = true;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(siteUrl);

  /**
   * Wait for the page to show a state: these texts in the root, and a
   * banner holding all of `banner` (or no banner, for null). A chunk lands
   * in pieces, so the page passes through the pieces' states on its way.
   */
  const reached = (shows, banner) => page.waitForFunction(([want, says]) => {
    const text = document.getElementById('root')?.innerText ?? '';
    const aside = document.querySelector('[data-az-preview]');
    const bannerOk = says === null ? aside === null : says.every((s) => (aside?.textContent ?? '').includes(s));
    return bannerOk && want.every((w) => text.includes(w));
  }, [shows, banner], { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false);

  for (const [i, step] of STEPS.entries()) {
    if (i > 0) await stream(source, step.until.slice(STEPS[i - 1].until.length));
    const ok = await reached(step.shows, [`preview stops before line ${step.stops}`, step.problem]);
    const root = await page.locator('#root').innerText();
    const banner = (await page.locator('[data-az-preview]').textContent().catch(() => null)) ?? '';
    check(`${step.name}: the page shows the finished sections`, ok, ok ? '' : `root: ${root.slice(0, 160)} | banner: ${banner.slice(0, 160)}`);
    const hidden = step.hides.every((h) => !root.includes(h));
    check(`${step.name}: the unfinished section is not rendered`, hidden, hidden ? '' : root.slice(0, 160));
    const listed = banner.includes(`preview stops before line ${step.stops}`) && banner.includes(step.problem);
    check(`${step.name}: the banner stops before line ${step.stops} and lists ${step.problem}`, listed, listed ? '' : banner.slice(0, 200));
  }

  /* the last chunk completes the file: no banner, the whole site */
  await stream(source, SITE.slice(STEPS.at(-1).until.length));
  check('complete: the banner disappears and the last section renders', await reached(['Visit the studio'], null));
  await page.goto(new URL('/work', siteUrl).href);
  check('complete: the page written last renders too', await reached(['Selected work', 'Forty pairs a month.'], null));
  check('no console errors or page errors at any step', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('the browser run completed', false, e.message.split('\n')[0]);
} finally {
  closed = (await closeWithin(browser, CLOSE_MS, 'chromium.close')) && closed;
}

/* the final dev output is the strict build's, byte for byte */
{
  const prod = join(dir, 'strict');
  execFileSync(process.execPath, [CLI, 'build', source, '--out', prod], {
    cwd: dir, env: { ...process.env, AZ_WORDS: WORDS }, stdio: 'ignore', timeout: BUILD_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  const dev = tree(outDir);
  const strict = tree(prod);
  const differ = [...new Set([...dev.keys(), ...strict.keys()])].filter((f) => dev.get(f) !== strict.get(f));
  check('the final az dev output is byte-identical to az build', differ.length === 0 && strict.size > 0, differ.slice(0, 5).join(' '));
}

/* Ctrl-C ends it */
{
  const exited = new Promise((done) => az.once('exit', (code) => done(code)));
  az.kill('SIGINT');
  const code = await Promise.race([exited, sleep(EXIT_TIMEOUT_MS).then(() => 'timeout')]);
  check('Ctrl-C exits az dev cleanly', code === 0, `exit ${code}`);
  if (code === 'timeout') az.kill('SIGKILL');
}

if (failures === 0) rmSync(dir, { recursive: true, force: true });
else console.log(`\nwork dir kept: ${dir}\n--- az dev output ---\n${out.slice(-1500)}`);
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
run.clear();
if (!closed) process.exit();
