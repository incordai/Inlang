/**
 * End-to-end proof: a .az file becomes a site that actually renders.
 *
 * `pnpm test` proves the compiler produces the right FILES. It cannot prove
 * those files build and render, because that needs react and vite installed —
 * a network install, which the unit suite must never require. So this lives
 * apart and is run deliberately:
 *
 *     node scripts/verify-build.mjs
 *
 * It does four things the unit suite cannot:
 *   1. compiles the GRAMMAR §8 fixture through the real CLI entry point
 *   2. installs the emitted package.json and runs `vite build`
 *   3. EXECUTES the generated app (react-dom/server) to get real DOM
 *   4. asserts that DOM against the rules the specs state
 *
 * Step 3 is the point. A green `vite build` proves the code COMPILED; only
 * rendering it proves the hero has one <h1>, that the eyebrow is not a
 * heading, and that a title containing </script> is inert.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** PRD §9: "Bundle, non-3D pages < 150KB gz". */
const NON_3D_BUDGET_BYTES = 150 * 1024;
const WORDS = join(ROOT, 'packages/words');
const CLI = join(ROOT, 'packages/cli/bin/az.js');

/**
 * Run a command without a shell.
 *
 * `npm` and `npx` are batch files on Windows. Naming them needs `shell: true`,
 * which is what Node's DEP0190 warns about (arguments get concatenated, not
 * escaped); naming `npm.cmd` instead fails outright with EINVAL, because Node
 * refuses to spawn a .cmd without a shell at all.
 *
 * So neither wrapper is used. npm ships as JavaScript with the node install,
 * and vite installs its own JS entry point — running those with `process
 * .execPath` is the same program, one process shallower, with a real argv.
 *
 * Where npm's JS lives depends on the platform layout: beside node.exe on
 * Windows (<prefix>/node_modules), under <prefix>/lib/node_modules on macOS
 * and Linux, where node itself sits in <prefix>/bin.
 */
const NODE_DIR = dirname(process.execPath);
const NPM_CLI = [
  join(NODE_DIR, 'node_modules/npm/bin/npm-cli.js'),
  join(NODE_DIR, '../lib/node_modules/npm/bin/npm-cli.js'),
].find((candidate) => existsSync(candidate));
if (!NPM_CLI) {
  throw new Error(`verify-build: npm's npm-cli.js was not found in the node install at ${NODE_DIR}`);
}

const run = (file, args, cwd) =>
  execFileSync(file, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AZ_WORDS: WORDS },
  });

/** node <script> … */
const node = (script, args, cwd) => run(process.execPath, [script, ...args], cwd);
/** npm … , via npm's own JS rather than the .cmd wrapper */
const npm = (args, cwd) => node(NPM_CLI, args, cwd);
/** vite … , from the project's own install */
const vite = (args, cwd) => node(join(cwd, 'node_modules/vite/bin/vite.js'), args, cwd);

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`${pass ? 'PASS ' : 'FAIL '} ${name}${detail ? '   ' + detail : ''}`);
};

/**
 * Find an element by one of its classes, whatever order React emitted its
 * attributes in. A styled element also carries its generated `az-s-…` class,
 * so the match is on the class TOKEN, not the whole attribute.
 */
function elementWithClass(html, cls) {
  const m = new RegExp(`class="(?:[^"]* )?${cls}(?: [^"]*)?"`).exec(html);
  if (!m) return null;
  return html.slice(html.lastIndexOf('<', m.index), html.indexOf('>', m.index) + 1);
}

const work = mkdtempSync(join(tmpdir(), 'az-verify-'));
console.log(`working in ${work}\n`);

try {
  /* ---- 1. compile ------------------------------------------------------ */
  const site = join(work, 'site.az');
  cpSync(join(ROOT, 'packages/core/test/fixture-site.az'), site);
  // The images the fixture names. It must stay byte-identical to GRAMMAR §8,
  // so its files live beside it rather than being edited out of it.
  cpSync(join(ROOT, 'packages/core/test/fixture-assets'), work, { recursive: true });
  const proj = join(work, 'proj');
  node(CLI, ['build', site, '--out', proj], work);
  console.log('compiled the GRAMMAR §8 fixture\n');

  /* ---- 2. install and build -------------------------------------------- */
  npm(['install', '--no-audit', '--no-fund'], proj);
  vite(['build'], proj);
  console.log('npm install + vite build succeeded\n');

  /* ---- 3. execute it --------------------------------------------------- */
  writeFileSync(join(proj, 'ssr.tsx'),
    'import { renderToStaticMarkup } from "react-dom/server";\n' +
    'import App from "./src/App.tsx";\n' +
    '// Each route renders on its own, as a browser loading that page would.\n' +
    'const routes = JSON.parse(process.argv[2]);\n' +
    'process.stdout.write(JSON.stringify(Object.fromEntries(\n' +
    '  routes.map((r) => [r, renderToStaticMarkup(<App route={r} />)]))));\n');
  vite(['build', '--ssr', 'ssr.tsx', '--outDir', 'ssr-out'], proj);

  // The routes are whatever pages the BUILD produced as HTML files, so this
  // also proves every page got one: `/` is index.html, `/work` work/index.html.
  const htmlFiles = (dir, prefix = '') => readdirSync(join(proj, 'dist', dir), { withFileTypes: true })
    .flatMap((e) => e.isDirectory() && e.name !== 'assets'
      ? htmlFiles(join(dir, e.name), `${prefix}/${e.name}`)
      : e.name === 'index.html' ? [prefix || '/'] : []);
  const routes = htmlFiles('.');
  // stderr is kept: React reports a misspelt DOM attribute there as a
  // warning, and the page still renders — so only stderr shows it.
  const ssr = spawnSync(process.execPath,
    [join(proj, 'ssr-out/ssr.js'), JSON.stringify([...routes, '/no-such-page'])],
    { cwd: proj, encoding: 'utf8' });
  if (ssr.status !== 0) throw new Error(`ssr failed: ${ssr.stderr}`);
  const rendered = JSON.parse(ssr.stdout);
  const notFound = rendered['/no-such-page'];
  delete rendered['/no-such-page'];
  // Every page in route order, so the page-level checks below still see /
  // first and can find each page by its data-route.
  const html = routes.map((r) => rendered[r]).join('');

  check('every page of the fixture is its own HTML file',
    ['/', '/login', '/legal'].every((r) => routes.includes(r)), routes.join(' '));
  check('a route renders only its own page — one <main> each',
    routes.every((r) => (rendered[r].match(/<main/g) ?? []).length === 1 && rendered[r].includes(`data-route="${r}"`)));
  check('an unknown path renders not-found, not a site page',
    /az-not-found/.test(notFound) && !/data-route="\/"/.test(notFound));
  check('React renders without warnings', ssr.stderr.trim() === '', ssr.stderr.trim().split('\n')[0]);
  check('the app renders a non-trivial DOM', html.length > 1000, `${html.length} bytes`);

  /* ---- M3: the escape hatch mounts author components with the theme --- */
  {
    const home = rendered['/'];
    // The hero's own root element, whatever tag the emitter chose.
    const root = /<([a-z]+)[^>]*class="az-hero[ "]/.exec(home);
    const heroClose = root ? home.indexOf(`</${root[1]}>`, root.index) + `</${root[1]}>`.length : -1;
    check('M3: `slot after` mounts the component right after its block',
      root !== null && home.slice(heroClose).startsWith('<p class="fixture-ticker"'),
      root ? home.slice(heroClose, heroClose + 40) : 'no hero root');
    check('M3: a custom component receives theme tokens, not colours',
      /class="fixture-ticker"[^>]*style="color:var\(--az-color-accent\)"|style="color:var\(--az-color-accent\)"[^>]*class="fixture-ticker"/.test(home));
    check('M3: a page-level `raw` component renders in the page flow',
      /class="fixture-badge"/.test(home) && home.indexOf('fixture-badge') < home.indexOf('<footer'));
  }

  /* ---- gate item 9: the bundle is inside the PRD §9 budget ------------ */
  // Non-3D pages ship under 150KB gzipped (PRD §9), so 3D never taxes a page
  // that does not use it. No generated site carries the 3D runtime yet, so the
  // whole fixture is a non-3D page. Measured as the browser receives it.
  {
    const assetsDir = join(proj, 'dist/assets');
    const code = readdirSync(assetsDir).filter((f) => /\.(js|css)$/.test(f));
    const gz = code.reduce((n, f) => n + gzipSync(readFileSync(join(assetsDir, f))).length, 0);
    check('gate 9 / PRD §9: non-3D bundle under 150KB gzipped', gz < NON_3D_BUDGET_BYTES,
      `${(gz / 1024).toFixed(1)}KB gz across ${code.length} files`);
  }

  /* ---- the images the page names are in the build ---------------------- */
  for (const a of ['assets/logo.svg', 'assets/logo-w.svg', 'assets/orbit.webp']) {
    check(`asset shipped: dist/${a}`, existsSync(join(proj, 'dist', a)));
    check(`asset linked from the site root: /${a}`, html.includes(`src="/${a}"`));
  }

  /* ---- structure: every <li> is inside a list --------------------------- */
  // Slot fills render as <li>; a container that is not a list makes invalid
  // HTML (and a <p> cannot hold one at all). Walk the tags with a stack.
  {
    const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
      'link', 'meta', 'source', 'track', 'wbr']);
    const stack = [];
    const strays = [];
    for (const m of html.matchAll(/<(\/?)([a-z][a-z0-9-]*)\b[^>]*?(\/?)>/g)) {
      const [, closing, tag, selfClosing] = m;
      if (closing) { stack.pop(); continue; }
      if (tag === 'li' && !['ul', 'ol', 'menu'].includes(stack.at(-1))) strays.push(stack.at(-1));
      if (!VOID.has(tag) && !selfClosing) stack.push(tag);
    }
    check('every <li> sits directly in a <ul>, <ol> or <menu>', strays.length === 0,
      strays.length ? `${strays.length} inside: ${[...new Set(strays)].join(', ')}` : '');
  }

  /* ---- 4. the DOM obeys the specs -------------------------------------- */
  const eyebrow = elementWithClass(html, 'az-hero-eyebrow');
  const title = elementWithClass(html, 'az-hero-title');

  // One <h1> per PAGE: the hero's on /, the auth form title's on /login
  // (auth-spec §11 — auth pages have no hero).
  const h1On = (r) => (rendered[r].match(/<h1/g) ?? []).length;
  check('exactly one <h1> on the page — hero-spec §4', h1On('/') === 1, `h1=${h1On('/')}`);
  check('auth §11: the login form title is that page\'s <h1>',
    h1On('/login') === 1 && /<h1[^>]*class="az-auth-title(?: [^"]*)?"/.test(rendered['/login']));
  check('no page has more than one <h1>', routes.every((r) => h1On(r) <= 1),
    routes.map((r) => `${r}=${h1On(r)}`).join(' '));
  check('section headings are <h2>', (html.match(/<h2/g) ?? []).length > 0);
  check('the eyebrow is a <p>, not a heading — hero-spec §4',
    !!eyebrow && eyebrow.startsWith('<p'));
  check('the title is the <h1>', !!title && title.startsWith('<h1'));
  // Styles live in the generated az.css, one class per element: read an
  // element's own rule rather than an inline style attribute.
  const azCss = readFileSync(join(proj, 'src/az.css'), 'utf8');
  const ruleOf = (element) => {
    const c = /\baz-s-[0-9a-z]+/.exec(element ?? '');
    if (!c) return '';
    return new RegExp(`^\\.${c[0]} \\{ ([^}]*) \\}`, 'm').exec(azCss)?.[1] ?? '';
  };
  const hero = elementWithClass(html, 'az-hero');
  check('the measure is on the TEXT — hero-spec §3',
    /max-width: \d+ch/.test(ruleOf(title)),
    (ruleOf(title).match(/max-width: [^;]+/) ?? ['none'])[0]);
  check('the CONTAINER carries no measure — hero-spec §3',
    !!hero && ruleOf(hero) !== '' && !/max-width/.test(ruleOf(hero)));
  check('hero uses svh, not vh — hero-spec §6', /min-height: \d+svh/.test(ruleOf(hero)));
  // Word markup carries no inline style; only the author's own components
  // (the fixture's, class fixture-…) style themselves.
  check('word markup has no inline style — every style is a generated class',
    !/style="/.test(html.replace(/<[^>]*class="fixture-[^"]*"[^>]*>/g, '')));
  // GRAMMAR §8's hero has `alt "Call the studio" tel:…` — the secondary
  // button. It was once swallowed as the poster's alt text, with no error.
  check('hero §1: the secondary `alt` button renders beside the primary',
    /class="az-hero-actions(?: [^"]*)?"[^]*href="tel:\+50412345678"/.test(html));
  // theme-spec §3.3: words' styles carry references; theme.css the colours.
  check('theme colour tokens reached the styles as references',
    /var\(--az-color-/.test(azCss) && !/hsl\(|rgb\(|#[0-9a-fA-F]{3,8}\b/.test(azCss));
  check('no colour literal reached the DOM', !/hsl\(|rgb\(/.test(html));
  {
    const cssFile = readdirSync(join(proj, 'dist/assets')).find((f) => f.endsWith('.css'));
    const css = cssFile ? readFileSync(join(proj, 'dist/assets', cssFile), 'utf8') : '';
    check('theme-spec §3.2: the built CSS defines both colour schemes',
      /--az-color-bg:/.test(css) && /prefers-color-scheme:\s*light/.test(css) && /\[data-scheme="?light"?\]/.test(css),
      cssFile ?? 'no css in dist/assets');
  }
  check('a behaviour prop is an attribute, never prose',
    /data-mobile="drawer"/.test(html) && !/>drawer</.test(html));

  /* ---- nav and footer, in the rendered document ------------------------ */
  const firstFocusable = /<(a|button)\b[^>]*>/.exec(html);
  check('nav §7: the skip link is the FIRST focusable element',
    !!firstFocusable && firstFocusable[0].includes('az-skip-link'),
    firstFocusable ? firstFocusable[0].slice(0, 48) : 'none found');
  check('nav §7: the logo link is named by the site, not left empty',
    /class="az-nav-logo(?: [^"]*)?"[^>]*>(?:(?!<\/a>)[^])*class="az-visually-hidden(?: [^"]*)?"[^>]*>aurora<\/span>/.test(html));
  // The fixture declares `adapter azbackend` once at site level; /login's
  // `auth login` must carry it rather than fall back to `custom`.
  check('auth §2: the login form uses the adapter declared at site level',
    /class="az-auth-form(?: [^"]*)?"[^>]*data-adapter="azbackend"|data-adapter="azbackend"[^>]*class="az-auth-form(?: [^"]*)?"/.test(html));
  check('auth §8: every field label is tied to its input (for → htmlFor)',
    /<label[^>]*for="[^"]+"/.test(html));
  check('auth §8: autocomplete reaches the inputs',
    /<input[^>]*autocomplete="current-password"/i.test(html));
  check('nav §7: the skip link lands on an element that exists and takes focus',
    routes.every((r) => !/href="#az-content"/.test(rendered[r]) ||
      /<main[^>]*id="az-content"[^>]*tabindex="-1"|<main[^>]*tabindex="-1"[^>]*id="az-content"/i.test(rendered[r])));
  check('nav §7: the main landmark is labelled',
    /<nav[^>]*aria-label="Main"/.test(html));
  check('nav §6: the toggle is a button wired to a panel that exists',
    /<button[^>]*aria-controls="az-nav-panel"/.test(html) && /id="az-nav-panel"/.test(html));

  /**
   * The markup of one page.
   *
   * App.tsx renders EVERY page into one document — there is no router yet —
   * so a check that scanned the whole string would happily find `/`'s nav
   * while looking at `/login`.
   */
  const pageHtml = (route) => {
    const open = html.indexOf(`data-route="${route}"`);
    if (open < 0) return '';
    const rest = html.slice(open);
    const next = rest.indexOf('<main', 1);
    return next < 0 ? rest : rest.slice(0, next);
  };

  const home = pageHtml('/');
  check('CONTROL: both fixture pages rendered', !!home && !!pageHtml('/login'));

  // The ORDER is the point: targets used to concatenate inherited blocks in
  // front of the page, which rendered the footer above the hero.
  check('the nav opens the page and the footer closes it',
    home.indexOf('<nav') < home.indexOf('<h1') &&
    home.indexOf('<footer') > home.indexOf('<h1'),
    `nav@${home.indexOf('<nav')} h1@${home.indexOf('<h1')} footer@${home.indexOf('<footer')}`);

  const footerHtml = home.slice(home.indexOf('<footer'));
  check('footer §9: no <h1> inside the footer', !/<h1/.test(footerHtml));
  check('footer §9: `minimal` with <=3 links emits no nav landmark',
    !/<nav/.test(footerHtml), 'the fixture footer has three links');

  // GRAMMAR §5.2 — `page /login` declares `nav none`.
  const login = pageHtml('/login');
  check('GRAMMAR §5.2: `nav none` suppresses the inherited nav entirely',
    !/<nav[^>]*aria-label="Main"/.test(login));
  check('CONTROL: that same page still has its inherited footer',
    /<footer/.test(login));

  /* ---- the security claim, at DOM level -------------------------------- */
  const evil = join(work, 'evil.az');
  writeFileSync(evil,
    'az 1\nsite evil\n\npage /\n  hero center\n' +
    '    title "</script><script>alert(1)</script>"\n');
  const evilProj = join(work, 'evil');
  node(CLI, ['build', evil, '--out', evilProj], work);
  cpSync(join(proj, 'node_modules'), join(evilProj, 'node_modules'), { recursive: true });
  cpSync(join(proj, 'ssr.tsx'), join(evilProj, 'ssr.tsx'));
  vite(['build', '--ssr', 'ssr.tsx', '--outDir', 'ssr-out'], evilProj);
  const evilHtml = JSON.parse(node(join(evilProj, 'ssr-out/ssr.js'), [JSON.stringify(['/'])], evilProj))['/'];

  check('SECURITY: no executable <script> reaches the DOM', !/<script/i.test(evilHtml));
  check('SECURITY: the text survives ESCAPED, not silently dropped',
    evilHtml.includes('&lt;/script&gt;'));

  /* ---- determinism ------------------------------------------------------ */
  const a = join(work, 'a'), b = join(work, 'b');
  node(CLI, ['build', site, '--out', a], work);
  node(CLI, ['build', site, '--out', b], work);
  const read = (d) => readFileSync(join(d, 'src/App.tsx'), 'utf8');
  check('DETERMINISM: two builds of one source are identical', read(a) === read(b));

  const changed = join(work, 'changed.az');
  writeFileSync(changed, readFileSync(site, 'utf8').replace('site aurora', 'site borealis'));
  const c = join(work, 'c');
  node(CLI, ['build', changed, '--out', c], work);
  check('CONTROL: a CHANGED source produces different output', read(a) !== read(c));
} finally {
  // Keep the directory when something failed — it is the evidence.
  if (failures === 0) rmSync(work, { recursive: true, force: true });
  else console.log(`\nleft ${work} in place for inspection`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;
