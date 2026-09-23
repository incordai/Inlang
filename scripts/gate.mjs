/**
 * `pnpm gate [words/<name> …]` — the 12-point word gate as one command.
 *
 * word-quality-gate §1 and VERIFICATION §3. Each item is run by the command
 * that owns it, and the gate only aggregates, so a gate result and a local
 * run of that command can never disagree:
 *
 *    1  typecheck                     tsc --noEmit (once, for the repository)
 *    2  theme lint                    az lint <word>
 *    3  renders 390/768/1440          test:visual — overflow in three engines,
 *                                     plus the responsive-table rows
 *    4  axe, zero violations          test:visual
 *    5  keyboard and visible focus    test:visual — keyboard walk, skip link
 *    6  reduced motion                test:visual
 *    7  light and dark                test:visual
 *    8  combined with nav + footer    the preview with a site nav and footer,
 *                                     built and server-rendered here
 *    9  bundle within budget          the JS + CSS the page loads, gzipped
 *                                     (a 3D word's lazy chunk reported apart)
 *   10  deps pinned exactly           word.json
 *   11  docs page + preview           README links the spec; every preview
 *                                     compiles (az check)
 *   12  tested populated honestly     word.json `tested`
 *
 * No argument gates every word. Prints one row per word and exits non-zero
 * if any item fails. `--every-variant` also runs items 3–7 on every variant
 * that has no preview of its own (see scripts/visual.mjs).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { ROOT, WORDS, CLI, buildSites, firstRoute } from './visual/pipeline.mjs';

/** PRD §9: "Bundle, non-3D pages < 150KB gz". */
const NON_3D_BUDGET_BYTES = 150 * 1024;
/** word-quality-gate §1 item 10: an exact version, never a range. */
const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
/** Item 12: an engine the gate runs, at the version it ran. */
const RAN = /^(chromium|firefox|webkit)-\d+(\.\d+)?$/;
/** Items 3–7: which test:visual checks each gate item is made of. */
const VISUAL = {
  3: ['compile', 'overflow', 'restack', 'column', 'disclosure', 'solid', 'hide-shrink', 'scroll-padding', 'firefox', 'webkit'],
  4: ['axe', 'copy'],
  5: ['keyboard', 'skip-link', 'drawer', 'dropdown', 'faq', 'faq-deep-link', 'carousel', 'lightbox', 'play'],
  6: ['reduced-motion', 'overlay-motion', 'nav-motion'],
  7: ['schemes'],
};
const ITEMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

const SSR = 'import { renderToStaticMarkup } from "react-dom/server";\n' +
  'import App from "./src/App.tsx";\n' +
  'process.stdout.write(renderToStaticMarkup(<App route={process.argv[2]} />));\n';

/* ---- which words -------------------------------------------------------- */

const all = readdirSync(WORDS).filter((w) => existsSync(join(WORDS, w, 'word.json'))).sort();

/** `hero`, `words/hero` and `packages/words/hero` all name the word hero. */
function wordsFrom(argv) {
  const names = argv.map((a) => a.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop());
  const unknown = names.filter((n) => !all.includes(n));
  if (unknown.length) {
    console.error(`gate: no such word: ${unknown.join(', ')} — words: ${all.join(', ')}`);
    process.exit(2);
  }
  return names.length ? names : all;
}

/* ---- results ------------------------------------------------------------ */

const results = {};   // word -> item -> { pass, detail }
const put = (word, item, pass, detail = '') => { (results[word] ??= {})[item] = { pass, detail }; };

const run = (cmd, args) => spawnSync(cmd, args, {
  cwd: ROOT, encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS }, maxBuffer: 64 * 1024 * 1024,
});
const lastLines = (text, n = 5) => text.trim().split('\n').slice(-n).join(' | ');

/* ---- items -------------------------------------------------------------- */

function typecheck(words) {
  const r = run(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '--noEmit']);
  for (const w of words) put(w, 1, r.status === 0, r.status === 0 ? '' : lastLines(r.stdout + r.stderr));
}

function lint(word, dir = join(WORDS, word)) {
  const r = run(process.execPath, [CLI, 'lint', dir]);
  put(word, 2, r.status === 0, r.status === 0 ? '' : lastLines(r.stderr));
}

function manifestItems(word, dir = join(WORDS, word)) {
  const m = JSON.parse(readFileSync(join(dir, 'word.json'), 'utf8'));
  const loose = Object.entries(m.deps ?? {}).filter(([, v]) => !EXACT.test(v));
  put(word, 10, loose.length === 0, loose.map(([k, v]) => `${k}@${v}`).join(', '));

  const browsers = m.tested?.browsers ?? [];
  const bad = browsers.filter((b) => !RAN.test(b));
  put(word, 12, browsers.length > 0 && bad.length === 0,
    browsers.length === 0 ? 'tested.browsers is empty' : bad.length ? `not a gate run: ${bad.join(', ')}` : '');
}

function docs(word, dir = join(WORDS, word)) {
  const problems = [];
  const readme = join(dir, 'README.md');
  if (!existsSync(readme)) problems.push('no README.md');
  else if (!readFileSync(readme, 'utf8').includes(`docs/${word}-block-spec.md`)) problems.push('README does not link its spec');
  const previews = readdirSync(dir).filter((f) => /^preview(\.[a-z]+)?\.az$/.test(f));
  if (!previews.includes('preview.az')) problems.push('no preview.az');
  for (const p of previews) {
    const r = run(process.execPath, [CLI, 'check', join(dir, p)]);
    if (r.status !== 0) problems.push(`${p}: ${lastLines(r.stderr, 2)}`);
  }
  put(word, 11, problems.length === 0, problems.join('; '));
}

function visual(words) {
  const flags = process.argv.includes('--every-variant') ? ['--every-variant'] : [];
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/visual.mjs'), ...words, ...flags], {
    cwd: ROOT, stdio: 'inherit', env: process.env,
  });
  const reportFile = join(ROOT, '.visual-out/report.json');
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')).results : {};
  // A check test:visual gained that the gate does not map would otherwise
  // be silently left out of every item.
  const mapped = new Set(Object.values(VISUAL).flat());
  const unmapped = [...new Set(Object.values(report).flatMap((c) => Object.keys(c)))].filter((c) => !mapped.has(c));
  for (const w of words) {
    if (unmapped.length) put(w, 3, false, `test:visual check(s) not mapped to a gate item: ${unmapped.join(', ')}`);
    for (const [item, checks] of Object.entries(VISUAL)) {
      if (Number(item) === 3 && unmapped.length) continue;
      const cells = checks.map((c) => report[w]?.[c]).filter(Boolean);
      const failures = cells.flatMap((c) => c.failures);
      const ran = cells.reduce((n, c) => n + c.pass + c.fail, 0);
      // A check that did not run is a failure, not a pass: an empty report
      // (a crash) must not read as a clean gate.
      put(w, Number(item), ran > 0 && failures.length === 0,
        ran === 0 ? `test:visual produced no result (exit ${r.status})` : failures.slice(0, 2).join('; '));
    }
  }
}

/**
 * Items 8 and 9: the word's preview with a site-level nav and footer added
 * (unless it declares its own), built, served by SSR, and measured.
 */
async function integration(words, work) {
  const sites = words.map((word) => {
    const preview = readFileSync(join(WORDS, word, 'preview.az'), 'utf8');
    const route = firstRoute(preview);
    const home = route === '/' ? '/' : route.replace(/\/$/, '');
    const add = [];
    if (!/^\s+nav\b/m.test(preview)) add.push('  nav bar', `    link "Home" ${home}`);
    if (!/^\s+footer\b/m.test(preview)) add.push('  footer minimal', `    link "Home" ${home}`);
    const lines = preview.split('\n');
    const at = lines.findIndex((l) => /^site\b/.test(l));
    lines.splice(at + 1, 0, ...add);
    return { word, route, dir: join(work, word), source: lines.join('\n'),
      assetsFrom: join(WORDS, word, 'preview-assets') };
  });
  await buildSites(sites, work, { ssr: SSR });

  for (const s of sites) {
    if (!s.compiled) {
      put(s.word, 8, false, `does not compile with nav + footer: ${s.error}`);
      put(s.word, 9, false, 'not built');
      continue;
    }
    const r = spawnSync(process.execPath, [join(s.proj, 'ssr-out/ssr.js'), s.route.replace(/(.)\/$/, '$1')],
      { cwd: s.proj, encoding: 'utf8' });
    const html = r.stdout;
    // A whole class token: `az-nav` must not match `az-nav-logo`.
    const at = (cls) => html.search(new RegExp(`class="(?:[^"]*\\s)?${cls}(?:\\s|")`));
    const [nav, own, footer] = [at('az-nav'), at(`az-${s.word}`), at('az-footer')];
    const problems = [];
    if (r.status !== 0) problems.push(`render failed: ${lastLines(r.stderr, 2)}`);
    if (r.stderr.trim()) problems.push(`React: ${r.stderr.trim().split('\n')[0]}`);
    if (nav < 0 || footer < 0 || own < 0) problems.push(`missing: ${[['nav', nav], [s.word, own], ['footer', footer]].filter(([, i]) => i < 0).map(([n]) => n).join(', ')}`);
    else if (!(nav <= own && own <= footer)) problems.push('nav does not open the page or footer does not close it');
    const mains = (html.match(/<main\b/g) ?? []).length;
    if (mains !== 1) problems.push(`${mains} <main> elements`);
    put(s.word, 8, problems.length === 0, problems.join('; '));

    // PRD §9 budgets what a page loads: the JS and CSS its HTML references.
    // A 3D word's chunk and decoder load later, lazily, and only for a page
    // view the gate lets through — reported beside the budget, never in it.
    const assets = join(s.dist, 'assets');
    const page = readFileSync(join(s.dist, s.route === '/' ? 'index.html' : `${s.route.slice(1)}index.html`), 'utf8');
    const initial = [...page.matchAll(/(?:src|href)="[^"]*?assets\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    const gz = (f) => gzipSync(readFileSync(join(assets, f))).length;
    const loaded = initial.reduce((n, f) => n + gz(f), 0);
    const lazy = readdirSync(assets).filter((f) => /\.js$/.test(f) && !initial.includes(f))
      .reduce((n, f) => n + gz(f), 0);
    put(s.word, 9, initial.length > 0 && loaded < NON_3D_BUDGET_BYTES,
      `${(loaded / 1024).toFixed(1)}KB gz at load${lazy ? `, ${(lazy / 1024).toFixed(1)}KB gz lazy 3D` : ''}`);
  }
}

/* ---- self-test: each non-browser item must be able to fail ------------ */

/**
 * Copies one real word, breaks the copy one way per item, and requires the
 * item to FAIL on the break and PASS on the clean copy. Items 3-7 are proved
 * by `node scripts/visual.mjs --self-test`. Items 8 and 9 are not self-tested
 * here: they need a full build, and their render assertions mirror the ones
 * verify-build already proves against the GRAMMAR §8 fixture.
 */
function selfTest() {
  const base = mkdtempSync(join(tmpdir(), 'az-gate-self-'));
  const copy = (name) => { const d = join(base, name, 'hero'); cpSync(join(WORDS, 'hero'), d, { recursive: true }); return d; };
  const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, 'utf8')));
  const json = (dir, fn) => edit(join(dir, 'word.json'), (t) => JSON.stringify(fn(JSON.parse(t)), null, 2));
  const cases = [
    [2, 'raw hex in the emitter', (d) => edit(join(d, 'emit.web.ts'), (t) => `${t}\nexport const leak = '#ff0066';\n`), lint],
    [10, 'a ^ range in deps', (d) => json(d, (m) => ({ ...m, deps: { three: '^0.170.0' } })), manifestItems],
    [11, 'README without its spec link', (d) => edit(join(d, 'README.md'), (t) => t.replaceAll('hero-block-spec.md', 'elsewhere.md')), docs],
    [11, 'a preview that does not compile', (d) => edit(join(d, 'preview.az'), (t) => t.replace('hero center', 'hero nonsense')), docs],
    [12, 'an unverified browser claim', (d) => json(d, (m) => ({ ...m, tested: { ...m.tested, browsers: ['chrome-latest'] } })), manifestItems],
  ];
  let wrong = 0;
  const judge = (label, item, shouldPass) => {
    const r = results.hero?.[item];
    const ok = r?.pass === shouldPass;
    if (!ok) wrong++;
    console.log(`  ${ok ? 'ok   ' : 'WRONG'}  item ${item} ${label}: ${r?.pass ? 'PASS' : 'FAIL'}${r?.detail ? ` — ${r.detail}` : ''}`);
  };
  for (const [item, label, breakIt, check] of cases) {
    const clean = copy(`clean-${item}-${label.length}`);
    delete results.hero; check('hero', clean); judge(`clean copy (${label})`, item, true);
    const broken = copy(`broken-${item}-${label.length}`);
    breakIt(broken);
    delete results.hero; check('hero', broken); judge(label, item, false);
  }
  rmSync(base, { recursive: true, force: true });
  console.log(`\n${wrong === 0 ? 'GATE SELF-TEST PASSED — every item fails its break and passes the clean copy' : `GATE SELF-TEST FAILED — ${wrong} misjudged`}`);
  return wrong === 0 ? 0 : 1;
}

/* ---- main --------------------------------------------------------------- */

if (process.argv.includes('--self-test')) {
  process.exitCode = selfTest();
  process.exit();
}

const words = wordsFrom(process.argv.slice(2).filter((a) => !a.startsWith('--')));
const started = performance.now();
const work = mkdtempSync(join(tmpdir(), 'az-gate-'));

typecheck(words);
for (const w of words) { lint(w); manifestItems(w); docs(w); }
await integration(words, work);
visual(words);

const pad = (s, n) => String(s).padEnd(n);
console.log(`\n12-point word gate — ${words.length} word(s)\n`);
console.log(pad('word', 10) + ITEMS.map((i) => pad(i, 6)).join(''));
let failed = 0;
for (const w of words) {
  console.log(pad(w, 10) + ITEMS.map((i) => {
    const r = results[w]?.[i];
    if (!r?.pass) failed++;
    return pad(r?.pass ? 'pass' : 'FAIL', 6);
  }).join(''));
}
for (const w of words) {
  for (const i of ITEMS) {
    const r = results[w]?.[i];
    if (!r?.pass) console.log(`  ${w} item ${i}: ${r?.detail || 'no result'}`);
  }
}
const seconds = ((performance.now() - started) / 1000).toFixed(1);
console.log(`\n${failed === 0 ? 'GATE PASSED' : `GATE FAILED — ${failed} item(s)`} in ${seconds}s`);
if (failed === 0) rmSync(work, { recursive: true, force: true });
else console.log(`work dir kept for inspection: ${work}`);
process.exitCode = failed === 0 ? 0 : 1;
