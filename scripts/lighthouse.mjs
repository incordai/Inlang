/**
 * `pnpm test:lighthouse [site …]` — Lighthouse on generated sites, before M5.
 *
 * ROADMAP M5's exit asks for Lighthouse perf ≥ 85 on mobile, SEO ≥ 95 and
 * a11y 100 (ASSUMPTIONS A6) on a real client site. This measures the sites
 * the repository already has, so a defect the compiler, target-web or a word
 * puts into every site is found before M5, not during it:
 *
 *   - every word preview (`preview.az` and each `preview.<variant>.az`) —
 *     the sites `pnpm thumbnails` and `pnpm gate` build;
 *   - the GRAMMAR §8 fixture (packages/core/test/fixture-site.az), as
 *     `pnpm verify:build` builds it;
 *   - `combined`: a site with nav, hero `full 3d`, feature, gallery,
 *     pricing and cta on one page.
 *
 * Each site is the production build (`az build`, then the project's own
 * build, every page pre-rendered), served locally with gzip as a static host
 * serves it, and its first page audited with Lighthouse's default config:
 * mobile emulation and simulated (default) throttling. The sites run one at
 * a time, each in a fresh headless Chromium (Playwright's) with a fresh
 * profile — and only while no other browser check (gate, visual, test-3d) is
 * running, since a performance score on a loaded machine is noise. Each
 * site is audited `--runs N` times (default 3) and the run with the median
 * performance score is reported, with the spread and the machine's load.
 *
 * Prints perf, a11y, best-practices and SEO per site against the M5
 * targets (lib/lighthouse-targets.mjs), then the failing audits ranked by
 * how many sites fail them. Exits non-zero when a site could not be built
 * or audited. A score below target is reported ("!") and, without
 * `--fail-under`, not failed. `--fail-under m5` also fails the run when any
 * site is below an M5 target — perf on the median run, the other categories
 * on every run — and `--fail-under perf=90,seo=100` enforces only the
 * scores it names. `--json <file>` also writes the results as JSON, and
 * `--reports <dir>` each site's full Lighthouse report as <dir>/<site>.json.
 *
 * A site on the built-in backend is built against the pipeline's preview
 * backend (`https://backend.invalid`, which never resolves); as in every other
 * browser check, its requests there are answered as a backend with nobody
 * signed in would answer them (pipeline.mjs answerPreviewBackend), through a
 * Playwright connection to the same browser — so the page's session read
 * succeeds instead of logging a failed load. Sites without a backend are
 * audited with no connection at all.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, loadavg, availableParallelism } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import lighthouse from 'lighthouse';
import { ROOT, WORDS, answerPreviewBackend, buildSites, firstRoute } from './visual/pipeline.mjs';
import { startServer } from './visual/serve.mjs';
import { Overdue, within, closeWithin, stopChild, watchdog, human } from './lib/bounded.mjs';
import { M5_TARGETS, SHORT, belowTargets, parseFailUnder } from './lib/lighthouse-targets.mjs';

const CATEGORIES = Object.keys(M5_TARGETS);

/*
 * Deadlines (lib/bounded.mjs). One audit takes 10–30s; one past AUDIT_MS
 * is a FAIL naming the site, and its browser is killed. Chromium prints its
 * DevTools port within a second or two. Waiting for a quiet machine (before
 * every site) polls every QUIET_POLL_MS, for at most QUIET_MS over the
 * whole run, then fails rather than measure noise. The run's backstop
 * covers the builds (each child bounded in pipeline.mjs), the wait and
 * every audit.
 */
const AUDIT_MS = 3 * 60_000;
const DEFAULT_RUNS = 3;
const MAX_RUNS = 9;
const LAUNCH_MS = 30_000;
const CLOSE_MS = 15_000;
const QUIET_MS = 30 * 60_000;
const QUIET_POLL_MS = 5_000;
const BUILD_BACKSTOP_MS = 40 * 60_000;

/** The other checks that drive browsers; any one running makes perf noise. */
const BUSY = /scripts\/(gate|visual|test-3d)\.mjs/;

/** The GRAMMAR §8 fixture's `adapter hosted` needs a public URL and key at build: placeholders, an unresolvable host (as verify-build). */
const PUBLIC_AUTH = { AZ_PUBLIC_AUTH_URL: 'https://auth.invalid', AZ_PUBLIC_AUTH_KEY: '<PLACEHOLDER>' };

/** nav, hero `full 3d`, feature, gallery, pricing and cta on one page. */
const COMBINED = `az 1

site aurora
  nav split sticky solid
    logo    ./preview-assets/assets/logo.svg
    inverse ./preview-assets/assets/logo-w.svg
    link   "Work"   /work
    link   "Studio" /studio
    cta    "Reserve" /reserve

page /
  hero full 3d
    eyebrow  "Limited run"
    title    "Built in the dark"
    sub      "Handmade. Forty pairs a month."
    poster   ./preview-assets/assets/poster-dark.webp
    describe "A plain backdrop behind the title"
    cta      "Reserve a pair" /reserve
    alt      "See the process" /work

  feature grid
    title   "Made properly, or not at all"
    columns 3
    item "Hand-cut leather"
      icon ./preview-assets/icons/knife.svg
      text "Every panel is cut by hand from a single hide."
    item "Sewn, not glued"
      icon ./preview-assets/icons/stitch.svg
      text "A stitched welt, so the sole is replaceable."
    item "Forty a month"
      icon ./preview-assets/icons/clock.svg
      text "The workshop holds two people. That is the ceiling."

  gallery grid
    title   "The workshop"
    columns 3
    ratio   3:2
    image ./preview-assets/assets/bench.webp
      alt "An empty workbench under a single lamp"
    image ./preview-assets/assets/welt.webp
      alt "A welt being stitched by hand"
    image ./preview-assets/assets/lasts.webp
      alt "Wooden lasts lined up on a shelf"

  pricing cards
    title    "Simple pricing"
    currency usd
    period   "per pair"
    plan "Standard"
      monthly 290
      feature "Resoling" "Two years"
      cta     "Reserve Standard" /reserve
    plan "Bespoke"
      highlight on
      badge   "Made to measure"
      monthly 790
      feature "Resoling" "For life"
      cta     "Reserve Bespoke" /reserve

  cta band
    title "Reserve for the autumn run"
    cta   "Reserve a pair" /reserve

page /work

page /studio

page /reserve
`;

/** Every site this run can audit: `{ name, source, assets: [dir…] }`. */
export function catalogue() {
  const sites = [];
  for (const word of readdirSync(WORDS).filter((w) => existsSync(join(WORDS, w, 'preview.az'))).sort()) {
    const dir = join(WORDS, word);
    for (const f of readdirSync(dir).filter((f) => /^preview(\.[a-z0-9-]+)?\.az$/.test(f)).sort()) {
      const variant = f.slice('preview.'.length, -'.az'.length);
      sites.push({
        name: variant ? `${word}.${variant}` : word,
        source: readFileSync(join(dir, f), 'utf8'),
        assets: [{ from: join(dir, 'preview-assets'), to: 'preview-assets' }],
      });
    }
  }
  const fixture = join(ROOT, 'packages/core/test');
  sites.push({
    name: 'grammar-fixture',
    source: readFileSync(join(fixture, 'fixture-site.az'), 'utf8'),
    assets: [{ from: join(fixture, 'fixture-assets'), to: '.' }],
  });
  sites.push({
    name: 'combined',
    source: COMBINED,
    assets: ['hero', 'nav', 'feature', 'gallery'].map((w) => ({ from: join(WORDS, w, 'preview-assets'), to: 'preview-assets' })),
  });
  return sites;
}

/** The other browser checks running now, by command line (empty when the machine is quiet). */
function busy() {
  const ps = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 10_000 });
  return ps.split('\n').map((l) => l.trim()).filter((l) => BUSY.test(l) && !l.startsWith(`${process.pid} `));
}

/** Wait until no gate, visual or test-3d run is on the machine; `quiet.until` bounds every wait of the run together. */
async function waitForQuiet(quiet, progress) {
  let said = false;
  for (;;) {
    const others = busy();
    if (others.length === 0) return;
    if (Date.now() >= quiet.until) {
      throw new Overdue(`waiting for a quiet machine (still running: ${others.map((l) => l.split(' ')[0]).join(', ')})`, QUIET_MS);
    }
    if (!said) {
      console.log(`waiting for other browser checks to finish (until the run's ${human(QUIET_MS)} of waiting is spent):\n  ${others.join('\n  ')}`);
      said = true;
    }
    progress.last = 'waiting for a quiet machine';
    await sleep(QUIET_POLL_MS);
  }
}

/** A headless Chromium with a DevTools port and its own profile; resolves `{ child, port, profile }`. */
async function launch(children) {
  const profile = mkdtempSync(join(tmpdir(), 'az-lh-profile-'));
  // --no-sandbox matches the test framework's own default launch (its
  // chromiumSandbox option is off): Ubuntu 24.04 blocks the unprivileged user
  // namespaces Chromium's sandbox needs, so without it the browser dies at start
  // on CI. It only ever opens this run's own locally built pages.
  const child = spawn(chromium.executablePath(), [
    '--headless=new', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.add(child);
  child.once('exit', () => children.delete(child));
  try {
    const port = await within(LAUNCH_MS, 'chromium DevTools port', () => new Promise((resolve, reject) => {
      let err = '';
      child.stderr.on('data', (d) => {
        err += d;
        const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(err);
        if (m) resolve(Number(m[1]));
      });
      child.once('exit', (code) => reject(new Error(`chromium exited (${code}) before it listened: ${err.slice(-400)}`)));
      child.once('error', reject);
    }));
    return { child, port, profile };
  } catch (e) {
    await stopChild(child);
    rmSync(profile, { recursive: true, force: true });
    throw e;
  }
}

/** The audits that fail on a page (below 0.9) in a category we report — scored ones, and performance diagnostics. */
function failing(lhr) {
  // An audit's weight in the score: 0 for performance's diagnostics and insights, which move no score.
  const weight = new Map();
  for (const c of CATEGORIES) {
    for (const r of lhr.categories[c].auditRefs) {
      if (r.weight > 0 || c === 'performance') weight.set(r.id, Math.max(weight.get(r.id) ?? 0, r.weight));
    }
  }
  return Object.values(lhr.audits)
    .filter((a) => weight.has(a.id) && typeof a.score === 'number' && a.score < 0.9 &&
      ['binary', 'numeric', 'metricSavings'].includes(a.scoreDisplayMode))
    .map((a) => ({ id: a.id, title: a.title, score: a.score, scored: weight.get(a.id) > 0, value: a.displayValue ?? '', items: offenders(a) }));
}

/** What an audit names as failing (a URL, a node, a message), at most five — for the JSON, so a fix starts from evidence. */
function offenders(audit) {
  const items = audit.details?.items ?? [];
  return items.slice(0, 5).map((it) => it.url ?? it.sourceLocation?.url ?? it.source?.url ?? it.node?.snippet ?? it.description ?? it.label ?? JSON.stringify(it).slice(0, 200));
}

/** A site that talks to the built-in backend — so to the preview backend, in a preview build (auth-spec §3.4). */
const onBackend = (source) => /^ {2}backend$/m.test(source) || /^ {4}adapter azbackend$/m.test(source);

/** One Lighthouse run on a site's first page, in a fresh browser. */
async function audit(site, server, children) {
  const url = new URL(firstRoute(site.source), server.url).href;
  const browser = await launch(children);
  const load = loadavg()[0];
  // The preview backend answered in this browser's default context, where Lighthouse opens its page.
  let answering = null;
  try {
    if (onBackend(site.source)) {
      answering = await within(LAUNCH_MS, 'connect to answer the preview backend', () => chromium.connectOverCDP(`http://127.0.0.1:${browser.port}`));
      await answerPreviewBackend(answering.contexts()[0]);
    }
    const result = await within(AUDIT_MS, `lighthouse ${site.name}`, () => lighthouse(url, {
      port: browser.port, output: 'json', logLevel: 'error', onlyCategories: CATEGORIES,
    }));
    const lhr = result?.lhr;
    if (!lhr) throw new Error('Lighthouse returned no result');
    if (lhr.runtimeError) throw new Error(`${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
    const scores = Object.fromEntries(CATEGORIES.map((c) => [c, lhr.categories[c].score === null ? null : Math.round(lhr.categories[c].score * 100)]));
    const metrics = Object.fromEntries(['first-contentful-paint', 'largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift', 'speed-index']
      .map((id) => [id, lhr.audits[id]?.displayValue ?? '']));
    return {
      url, scores, metrics, load, failing: failing(lhr), warnings: lhr.runWarnings,
      version: lhr.lighthouseVersion, agent: lhr.environment.hostUserAgent, report: result.report,
    };
  } finally {
    if (answering) await closeWithin(answering, CLOSE_MS, 'preview backend connection close');
    await stopChild(browser.child);
    rmSync(browser.profile, { recursive: true, force: true });
  }
}

const pad = (s, n) => String(s).padEnd(n);
const cell = (score, target) => score === null ? 'n/a' : score < target ? `${score}!` : String(score);

function report(results) {
  const width = Math.max(...results.map((r) => r.name.length), 4) + 2;
  console.log(`\n${pad('site', width)}${CATEGORIES.map((c) => pad(SHORT[c], 7)).join('')}${pad('perf runs', 14)}${pad('load', 6)}LCP      TBT      CLS`);
  for (const r of results) {
    if (r.error) { console.log(`${pad(r.name, width)}FAIL  ${r.error}`); continue; }
    console.log(pad(r.name, width) + CATEGORIES.map((c) => pad(cell(r.scores[c], M5_TARGETS[c]), 7)).join('') +
      pad(r.perfRuns.join(' '), 14) + pad(r.load.toFixed(1), 6) +
      `${pad(r.metrics['largest-contentful-paint'], 9)}${pad(r.metrics['total-blocking-time'], 9)}${r.metrics['cumulative-layout-shift']}`);
  }
  console.log(`load: the 1-minute load average when the reported run started (${availableParallelism()} cores)`);
  console.log(`targets (M5): ${CATEGORIES.map((c) => `${SHORT[c]} ≥ ${M5_TARGETS[c]}`).join(', ')} — "!" marks a score below target`);

  const byAudit = new Map();
  for (const r of results.filter((x) => !x.error)) {
    for (const f of r.failing) {
      const e = byAudit.get(f.id) ?? { title: f.title, scored: f.scored, sites: [] };
      e.sites.push(f.value ? `${r.name} (${f.value})` : r.name);
      byAudit.set(f.id, e);
    }
  }
  // Audits that move a score first, then by how many sites fail them.
  const ranked = [...byAudit.entries()].sort((a, b) => Number(b[1].scored) - Number(a[1].scored) || b[1].sites.length - a[1].sites.length);
  console.log(ranked.length ? '\nfailing audits ([scored] moves a category score; the rest are diagnostics), most sites first:' : '\nno failing audits');
  for (const [id, e] of ranked) console.log(`  ${pad(e.sites.length, 3)} ${e.scored ? '[scored] ' : ''}${id} — ${e.title}\n      ${e.sites.join(', ')}`);
}

async function main(argv) {
  const option = (flag) => {
    const at = argv.indexOf(flag);
    if (at < 0) return { at, value: null };
    if (!argv[at + 1] || argv[at + 1].startsWith('--')) throw new Error(`lighthouse: ${flag} needs a value`);
    return { at, value: argv[at + 1] };
  };
  const json = option('--json');
  const reports = option('--reports');
  const runsOpt = option('--runs');
  const failUnder = option('--fail-under');
  const thresholds = failUnder.value === null ? null : parseFailUnder(failUnder.value);
  const runs = runsOpt.value === null ? DEFAULT_RUNS : Number(runsOpt.value);
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) throw new Error(`lighthouse: --runs takes 1–${MAX_RUNS}`);
  const jsonOut = json.value;
  if (reports.value) mkdirSync(reports.value, { recursive: true });
  const values = new Set([json, reports, runsOpt, failUnder].filter((o) => o.at >= 0).map((o) => o.at + 1));
  const names = argv.filter((a, i) => !a.startsWith('--') && !values.has(i));
  const all = catalogue();
  const unknown = names.filter((n) => !all.some((s) => s.name === n));
  if (unknown.length) {
    console.error(`lighthouse: no such site: ${unknown.join(', ')} — sites: ${all.map((s) => s.name).join(', ')}`);
    return 2;
  }
  const chosen = names.length ? all.filter((s) => names.includes(s.name)) : all;

  const children = new Set();
  const progress = { last: 'starting', children };
  const runMs = BUILD_BACKSTOP_MS + QUIET_MS + chosen.length * runs * AUDIT_MS;
  const run = watchdog(runMs, 'test:lighthouse', progress);
  console.log(`deadlines: audit ${human(AUDIT_MS)} · quiet wait ${human(QUIET_MS)} · run ${human(runMs)} (${chosen.length} sites × ${runs} runs)`);

  const work = mkdtempSync(join(tmpdir(), 'az-lighthouse-'));
  Object.assign(process.env, PUBLIC_AUTH);
  const sites = chosen.map((s) => ({ ...s, dir: join(work, s.name) }));
  for (const s of sites) for (const a of s.assets) {
    if (existsSync(a.from)) cpSync(a.from, join(s.dir, a.to), { recursive: true });
  }
  progress.last = 'building';
  await buildSites(sites, work);
  console.log(`built ${sites.filter((s) => s.dist).length}/${sites.length} sites`);

  const quiet = { until: Date.now() + QUIET_MS };
  const server = await startServer({ compress: true });
  const results = [];
  try {
    for (const s of sites) {
      if (!s.dist) { results.push({ name: s.name, error: `does not build — ${s.error ?? 'project build failed'}` }); continue; }
      server.serve(s.dist);
      try {
        const done = [];
        for (let i = 0; i < runs; i++) {
          await waitForQuiet(quiet, progress);
          done.push(await audit(s, server, children));
          progress.last = `lighthouse ${s.name} run ${i + 1}`;
        }
        // The median run by performance score: the category a loaded machine moves.
        const ranked = [...done].sort((a, b) => a.scores.performance - b.scores.performance);
        const { report: lhJson, ...median } = ranked[Math.floor((ranked.length - 1) / 2)];
        if (reports.value) writeFileSync(join(reports.value, `${s.name}.json`), lhJson);
        results.push({ name: s.name, ...median, perfRuns: done.map((d) => d.scores.performance), runs: done.map((d) => d.scores) });
      } catch (e) {
        results.push({ name: s.name, error: e.message });
      }
      const r = results.at(-1);
      console.log(r.error ? `  FAIL ${s.name}: ${r.error}` : `  ${s.name}: ${CATEGORIES.map((c) => `${SHORT[c]} ${r.scores[c]}`).join(' · ')} (perf runs ${r.perfRuns.join(' ')})`);
    }
  } finally {
    await closeWithin(server, CLOSE_MS, 'server.close');
    rmSync(work, { recursive: true, force: true });
  }

  const ok = results.find((r) => !r.error);
  if (ok) console.log(`\nLighthouse ${ok.version} · ${ok.agent}`);
  report(results);
  if (jsonOut) writeFileSync(jsonOut, `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.filter((r) => r.error).length;
  console.log(failed === 0 ? `\nLIGHTHOUSE RAN on ${results.length} sites` : `\n${failed} SITE(S) NOT AUDITED`);
  let below = [];
  if (thresholds) {
    below = belowTargets(results, thresholds);
    const named = Object.entries(thresholds).map(([c, t]) => `${SHORT[c]} ≥ ${t}`).join(', ');
    for (const b of below) {
      console.log(`  BELOW ${b.site}: ${SHORT[b.category]} ${b.score ?? 'n/a'} < ${b.target}${b.run === null ? ` (median of ${results.find((r) => r.name === b.site).perfRuns.join(' ')})` : ` (run ${b.run})`}`);
    }
    const sites = new Set(below.map((b) => b.site)).size;
    console.log(below.length === 0
      ? `THRESHOLDS MET on ${results.length - failed} audited sites (${named})`
      : `${sites} SITE(S) BELOW THRESHOLD (${named})`);
  }
  run.clear();
  return failed === 0 && below.length === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));
