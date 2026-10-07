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
 *   2. installs the emitted package.json and runs the project's OWN build,
 *      which bundles the client and pre-renders every page (ASSUMPTIONS A6)
 *   3. reads the pages the build SHIPS — each route's HTML in dist/
 *   4. asserts that markup against the rules the specs state
 *
 * Step 3 is the point. A green build proves the code COMPILED; only the
 * shipped markup proves the hero has one <h1>, that the eyebrow is not a
 * heading, and that a title containing </script> is inert — as a crawler
 * and a visitor with JavaScript off receive it.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname, basename, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { watchdog, human, within, closeWithin } from './lib/bounded.mjs';
import { startServer } from './visual/serve.mjs';

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

/**
 * The fixture's `auth` is `adapter hosted`, whose build requires the
 * provider's URL and PUBLIC key (auth-spec §3.2). Placeholders — no example
 * anywhere carries a real key (§4) — and a reserved, unresolvable host.
 */
const PUBLIC_AUTH = { AZ_PUBLIC_AUTH_URL: 'https://auth.invalid', AZ_PUBLIC_AUTH_KEY: '<PLACEHOLDER>' };

/*
 * Deadlines: every child is killed past COMMAND_MS (the slowest, an npm
 * install, takes about a minute), and the whole run past RUN_MS — the
 * watchdog names the last check that finished.
 */
const COMMAND_MS = 10 * 60_000;
const RUN_MS = 15 * 60_000;
/** One browser step (a navigation, an image settling, a close): seconds, measured, with margin. */
const BROWSER_MS = 30_000;
const progress = { last: 'starting' };
const deadline = watchdog(RUN_MS, 'verify:build', progress);
console.log(`deadlines: command ${human(COMMAND_MS)} · run ${human(RUN_MS)}`);
/** A child stopped at its deadline: never read as an expected failure. */
const stopped = (e) => e.code === 'ETIMEDOUT' || Boolean(e.signal);

const run = (file, args, cwd, env = {}) =>
  execFileSync(file, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, AZ_WORDS: WORDS, ...PUBLIC_AUTH, ...env },
    timeout: COMMAND_MS, killSignal: 'SIGKILL',
  });

/** A command that must FAIL: its combined output, or null if it succeeded. */
const failing = (file, args, cwd, env = {}) => {
  try {
    run(file, args, cwd, env);
    return null;
  } catch (e) {
    if (stopped(e)) throw e;
    return `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
};

/**
 * A generated project's own build: `npm run build` (az-vite/build.mjs).
 * Returns its stderr — with logging at `error`, anything there is a problem
 * (a React warning while pre-rendering fails the build outright).
 */
function shippedBuild(proj, env = {}) {
  const r = spawnSync(process.execPath, [join(proj, 'az-vite/build.mjs')], {
    cwd: proj, encoding: 'utf8',
    env: { ...process.env, AZ_WORDS: WORDS, ...PUBLIC_AUTH, AZ_BUILD_LOG: 'error', ...env },
    timeout: COMMAND_MS, killSignal: 'SIGKILL',
  });
  if (r.error || r.signal) throw new Error(`the project build was stopped: ${r.error?.message ?? r.signal}`);
  if (r.status !== 0) throw new Error(`the project build failed:\n${r.stderr}`);
  return r.stderr;
}

/** The markup a built page ships: the contents of its #root, as written into dist/. */
function shippedRoot(proj, route) {
  const file = join(proj, 'dist', route === '/' ? '' : route.slice(1), 'index.html');
  const page = readFileSync(file, 'utf8');
  const open = '<div id="root">';
  const start = page.indexOf(open) + open.length;
  return page.slice(start, page.lastIndexOf('</div>', page.indexOf('</body>')));
}

/**
 * One route drawn by the App on its own — for the not-found page, which no
 * static file holds. Bundled like the build's server entry.
 */
function renderRoute(proj, route) {
  writeFileSync(join(proj, 'ssr.tsx'),
    'import { renderToString } from "react-dom/server";\n' +
    'import App from "./src/App.tsx";\n' +
    'process.stdout.write(renderToString(<App route={process.argv[2]} />));\n');
  vite(['build', '--ssr', 'ssr.tsx', '--outDir', 'ssr-out'], proj);
  return node(join(proj, 'ssr-out/ssr.js'), [route], proj);
}

/** base64url, for building test tokens with a chosen role claim. */
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** node <script> … */
const node = (script, args, cwd) => run(process.execPath, [script, ...args], cwd);
/** `az build` with its report: the warnings are on stderr, which `run` drops on success. */
function azBuild(source, out, cwd, env = {}) {
  const r = spawnSync(process.execPath, [CLI, 'build', source, '--out', out], {
    cwd, encoding: 'utf8',
    env: { ...process.env, AZ_WORDS: WORDS, ...PUBLIC_AUTH, ...env },
    timeout: COMMAND_MS, killSignal: 'SIGKILL',
  });
  if (r.error || r.signal) throw new Error(`az build was stopped: ${r.error?.message ?? r.signal}`);
  if (r.status !== 0) throw new Error(`az build failed:\n${r.stderr}`);
  return r.stderr;
}
/** npm … , via npm's own JS rather than the .cmd wrapper */
const npm = (args, cwd) => node(NPM_CLI, args, cwd);
/** vite … , from the project's own install */
const vite = (args, cwd) => node(join(cwd, 'node_modules/vite/bin/vite.js'), args, cwd);

let failures = 0;
const check = (name, pass, detail = '') => {
  if (!pass) failures++;
  progress.last = name;
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

  /* ---- 2. install and build — the project's OWN build --------------------- */
  // `npm run build` is az-vite/build.mjs: the client bundle, then every page
  // pre-rendered into its HTML file (ASSUMPTIONS A6). It runs the render in
  // Node, where no `window` exists, and fails on any React warning — so a
  // page that renders differently from what the browser hydrates, or touches
  // the DOM while rendering, fails here.
  npm(['install', '--no-audit', '--no-fund'], proj);
  const buildLog = shippedBuild(proj);
  console.log('npm install + the project build (client + pre-render) succeeded\n');

  /* ---- 3. the SHIPPED pages -------------------------------------------- */
  // The routes are whatever pages the BUILD produced as HTML files, so this
  // also proves every page got one: `/` is index.html, `/work` work/index.html.
  const htmlFiles = (dir, prefix = '') => readdirSync(join(proj, 'dist', dir), { withFileTypes: true })
    .flatMap((e) => e.isDirectory() && e.name !== 'assets'
      ? htmlFiles(join(dir, e.name), `${prefix}/${e.name}`)
      : e.name === 'index.html' ? [prefix || '/'] : []);
  const routes = htmlFiles('.');
  // Every check below reads the markup the site SHIPS: each page's #root, as
  // written into dist/ by the build — what a crawler and a no-JS visitor get.
  const rendered = Object.fromEntries(routes.map((r) => [r, shippedRoot(proj, r)]));
  check('A6: every page ships its markup pre-rendered, not an empty root',
    routes.every((r) => rendered[r].includes('<main')), routes.join(' '));
  // An unknown path has no file on a static host: its not-found page is the
  // App's, drawn in the browser. That one render is checked on its own.
  const notFound = renderRoute(proj, '/no-such-page');
  // Every page in route order, so the page-level checks below still see /
  // first and can find each page by its data-route.
  const html = routes.map((r) => rendered[r]).join('');

  // The behaviour runtime ships with the site, byte for byte from its source;
  // its rows module only with a `from` block (data-spec §10.3), which this
  // fixture has none of.
  {
    const runtimeDir = join(ROOT, 'packages/overlay/src/runtime');
    const ROWS = ['rows.ts', 'rows-logic.ts'];
    const shipped = readdirSync(runtimeDir).filter((f) => f.endsWith('.ts') && !ROWS.includes(f));
    check('behaviour runtime shipped verbatim into src/az/',
      shipped.length > 0 && shipped.every((f) =>
        existsSync(join(proj, 'src/az', f)) &&
        readFileSync(join(proj, 'src/az', f), 'utf8') === readFileSync(join(runtimeDir, f), 'utf8')),
      shipped.join(' '));
    check('a site without a from block ships no rows runtime', ROWS.every((f) => !existsSync(join(proj, 'src/az', f))));
  }
  // The 3D runtime ships only with a 3D site — this fixture is one — verbatim.
  {
    const threeDir = join(ROOT, 'packages/scene-runtime/src/runtime');
    const shipped = readdirSync(threeDir).filter((f) => f.endsWith('.ts'));
    check('3D runtime shipped verbatim into src/az3d/',
      shipped.length > 0 && shipped.every((f) =>
        readFileSync(join(proj, 'src/az3d', f), 'utf8') === readFileSync(join(threeDir, f), 'utf8')),
      shipped.join(' '));
    const pkg = JSON.parse(readFileSync(join(proj, 'package.json'), 'utf8'));
    check('a 3D site depends on three, at the verified pin', pkg.dependencies.three === '0.186.0', pkg.dependencies.three);
  }
  // hero-spec §8 / scene-spec §5: the server renders the VIEW — its box, its
  // seed, its sandboxed model — never a renderer. The runtime starts later,
  // in the browser, and only if the page view is allowed one.
  {
    const view = elementWithClass(rendered['/'], 'az-hero-visual') ?? '';
    check('hero 3d: the server renders the view the renderer will draw into',
      /data-az-3d="hero"/.test(view) && /data-az-camera="scroll"/.test(view) && /data-az-seed="\d+"/.test(view),
      view.slice(0, 160));
    check('hero 3d: the model goes through the asset sandbox and ships',
      /data-az-model="\/assets\/shoe\.glb"/.test(view) && existsSync(join(proj, 'dist/assets/shoe.glb')));
    check('no <canvas> in the server render — the canvas is the runtime\'s, never the page\'s',
      routes.every((r) => !/<canvas/.test(rendered[r])));
    const orbit = elementWithClass(rendered['/'], 'az-gallery-orbit') ?? '';
    check('gallery orbit: the ring view carries its aspect, and the list keeps every image (§9)',
      /data-az-3d="orbit"/.test(orbit) && /data-az-aspect="[\d.]+"/.test(orbit) &&
        (rendered['/'].match(/data-az-ring=""/g) ?? []).length === 4);
  }
  check('nav §6: the menu is a <dialog> drawer its toggle controls',
    /<button[^>]*aria-controls="az-nav-panel"/.test(rendered['/']) &&
    /<dialog[^>]*id="az-nav-panel"[^>]*>|<dialog[^>]*data-az-overlay="drawer"[^>]*id="az-nav-panel"/.test(rendered['/']));
  {
    // text-spec §5/§8: the .md body ships as markup, its heading under the
    // title's h2, its table in a keyboard-reachable scroll region.
    const at = rendered['/'].indexOf('az-text-body');
    const body = at < 0 ? '' : rendered['/'].slice(at, rendered['/'].indexOf('</section>', at));
    check('text §5: the .md body is pre-rendered markup, not its path',
      /<h3[^>]*>What we repair<\/h3>/.test(body) && /<strong>Resoling<\/strong>/.test(body) && !body.includes('repair.md'),
      body.slice(0, 120));
    check('text §8: the table scrolls in a focusable region; the external link says it opens a tab',
      /<div(?=[^>]*tabindex="0")(?=[^>]*role="region")[^>]*>\s*<table/.test(body) &&
        /<a(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>care guide<span[^>]*> \(opens in new tab\)/.test(body));
  }

  check('every page of the fixture is its own HTML file',
    ['/', '/login', '/legal'].every((r) => routes.includes(r)), routes.join(' '));
  check('a route renders only its own page — one <main> each',
    routes.every((r) => (rendered[r].match(/<main/g) ?? []).length === 1 && rendered[r].includes(`data-route="${r}"`)));
  check('an unknown path renders not-found, not a site page',
    /az-not-found/.test(notFound) && !/data-route="\/"/.test(notFound));
  // pnpm test:lighthouse (pre-M5): every page lacked a description, and the
  // browser's /favicon.ico request was a 404 and a console error. The head
  // as it ships: the hero's sub describes /, the text body describes
  // /legal, and every page — /login too — declares its (empty) icon.
  {
    const head = (r) => {
      const file = readFileSync(join(proj, 'dist', r === '/' ? '' : r.slice(1), 'index.html'), 'utf8');
      return file.slice(0, file.indexOf('</head>'));
    };
    const described = (r) => /<meta name="description" content="([^"]*)"/.exec(head(r))?.[1] ?? null;
    check('A6: a page ships its lead copy as its meta description — / its hero sub, /legal its text body',
      described('/') === 'Handmade. Forty pairs a month.' &&
        described('/legal') === 'We keep your order and your address, and nothing else.',
      `${described('/')} | ${described('/legal')}`);
    check('every page declares its icon, so the browser requests no /favicon.ico',
      routes.every((r) => head(r).includes('<link rel="icon" href="data:," />')));
  }
  check('the build and its pre-render report nothing (React warnings fail it)', buildLog.trim() === '', buildLog.trim().split('\n')[0]);
  check('the app renders a non-trivial DOM', html.length > 1000, `${html.length} bytes`);

  /* ---- word-quality-gate §5: `az audit` on the shipped build ------------ */
  // Offline (no --online): the advisory query is the one network call.
  {
    const audit = (out) => {
      const r = spawnSync(process.execPath, [CLI, 'audit', '--out', out, '--json'], {
        cwd: work, encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS, ...PUBLIC_AUTH }, timeout: COMMAND_MS, killSignal: 'SIGKILL',
      });
      if (r.error || r.signal) throw new Error(`az audit was stopped: ${r.error?.message ?? r.signal}`);
      return { status: r.status, out: r.stdout, report: JSON.parse(r.stdout) };
    };
    const by = (r, id) => r.report.checks.find((c) => c.id === id) ?? {};
    const clean = audit(proj);
    check('az audit: the shipped build has no key-shaped string (the public key allowed, as by the guard)',
      by(clean, 'bundle-secrets').status === 'pass', by(clean, 'bundle-secrets').line);
    // A finding, not a gate: word-quality-gate §2 B asks for a CSP the pages do not ship yet.
    check('az audit: the pages\' missing CSP is reported, and only warns', clean.status === 0 && by(clean, 'page-csp').status === 'warn',
      by(clean, 'page-csp').line);
    check('az audit: the advisory query is skipped without --online', by(clean, 'dependencies').status === 'skip');

    const planted = join(work, 'proj-audit');
    mkdirSync(planted);
    cpSync(join(proj, 'dist'), join(planted, 'dist'), { recursive: true });
    cpSync(join(proj, '.az-manifest.json'), join(planted, '.az-manifest.json'));
    // The 3D decoder's published originals, so the copy is judged as the build is.
    const libs = 'node_modules/three/examples/jsm/libs';
    cpSync(join(proj, libs), join(planted, libs), { recursive: true });
    const key = `sk_live_${'P1a'.repeat(10)}`;
    const js = readdirSync(join(planted, 'dist/assets')).find((f) => /^main-.*\.js$/.test(f));
    writeFileSync(join(planted, 'dist/assets', js), `${readFileSync(join(planted, 'dist/assets', js), 'utf8')}\nconst k="${key}";\n`);
    const leaked = audit(planted);
    check('az audit: a key planted in the shipped bundle fails, by file and offset — never by value',
      leaked.status === 1 && by(leaked, 'bundle-secrets').line.startsWith('bundle secrets: 1 key-shaped string in the built site')
        && (by(leaked, 'bundle-secrets').fix ?? []).some((f) => f.startsWith(`dist/assets/${js}:`) && f.endsWith('(secret-prefix)'))
        && !leaked.out.includes(key) && !leaked.out.includes('P1aP1a'),
      by(leaked, 'bundle-secrets').line);
  }

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

  /* ---- M4: secret leakage is a hard, unsuppressible build error -------- */
  // auth-spec §4 / word-quality-gate §4. The guard runs inside the generated
  // project's own `vite build`; each case below must FAIL that build.
  {
    const viteBin = join(proj, 'node_modules/vite/bin/vite.js');
    check('M4: the build guard ships the compiler\'s scanner verbatim',
      readFileSync(join(proj, 'az-vite/secrets.ts'), 'utf8') === readFileSync(join(ROOT, 'packages/core/src/secrets.ts'), 'utf8'));
    check('M4: only the AZ_PUBLIC_ prefix reaches the browser, through the guard',
      /envPrefix: "AZ_PUBLIC_"/.test(readFileSync(join(proj, 'vite.config.ts'), 'utf8'))
      && /plugins: \[secretGuard\(\)\]/.test(readFileSync(join(proj, 'vite.config.ts'), 'utf8')));

    const named = failing(process.execPath, [viteBin, 'build'], proj, { AZ_PUBLIC_SERVICE_KEY: 'x'.repeat(40) });
    check('M4 exit: the build FAILS when a service key is present in the env (by name)',
      named !== null && /'AZ_PUBLIC_SERVICE_KEY' is a service key/.test(named));
    const privileged = `${b64url({ alg: 'HS256' })}.${b64url({ role: 'service_role', iss: 'probe' })}.c2lnbmF0dXJlLXByb2Jl`;
    const valued = failing(process.execPath, [viteBin, 'build'], proj, { AZ_PUBLIC_DB_KEY: privileged });
    check('M4 exit: the build FAILS when a public-named variable holds a service-role token',
      valued !== null && /'AZ_PUBLIC_DB_KEY' is a service key/.test(valued) && !valued.includes(privileged));

    // A key pasted straight into source, past the env rule: the bundle scan.
    const leak = join(work, 'proj-leak');
    cpSync(proj, leak, { recursive: true, filter: (f) => !f.includes(`${join(proj, 'node_modules')}`) && !f.includes(join(proj, 'dist')) });
    cpSync(join(proj, 'node_modules'), join(leak, 'node_modules'), { recursive: true });
    writeFileSync(join(leak, 'src/main.tsx'),
      readFileSync(join(leak, 'src/main.tsx'), 'utf8') + '\nconsole.info("-----BEGIN PRIVATE KEY-----");\n');
    const bundled = failing(process.execPath, [join(leak, 'node_modules/vite/bin/vite.js'), 'build'], leak);
    check('M4 exit: the bundle scan FAILS a build with a key pattern in its output',
      bundled !== null && /a service-key pattern was found in the built bundle/.test(bundled));
    // The guard reads dist/ once it is written; a refused build removes it.
    const leftWith = (dir, text) => (existsSync(dir) ? readdirSync(dir, { recursive: true, withFileTypes: true }) : [])
      .filter((e) => e.isFile() && readFileSync(join(e.parentPath, e.name), 'utf8').includes(text))
      .map((e) => relative(dir, join(e.parentPath, e.name)));
    check('§5.5 fixed: the refused build leaves no output folder behind',
      !existsSync(join(leak, 'dist')),
      existsSync(join(leak, 'dist')) ? `dist/ remains: ${leftWith(join(leak, 'dist'), 'BEGIN PRIVATE KEY').join(', ') || 'no file with the key'}` : '');
    // CONTROL: the untouched project built above, with its public key shipped.
    check('CONTROL: the clean build (public key present) passed the same guard', existsSync(join(proj, 'dist/index.html')));

    // word-quality-gate §5.5, fixed: the guard reads back every file the build
    // wrote. A project file az build copies into public/ — which Vite copies
    // into dist/ outside the bundle — fails the build like the bundle does.
    const pubWork = join(work, 'pub');
    mkdirSync(pubWork);
    cpSync(site, join(pubWork, 'site.az'));
    cpSync(join(ROOT, 'packages/core/test/fixture-assets'), pubWork, { recursive: true });
    const pubKey = `sk_live_${'Pb7'.repeat(10)}`;
    const logo = join(pubWork, 'assets/logo.svg');
    writeFileSync(logo, `${readFileSync(logo, 'utf8')}<!-- ${pubKey} -->\n`);
    const pubProj = join(pubWork, 'proj');
    node(CLI, ['build', join(pubWork, 'site.az'), '--out', pubProj], pubWork);
    cpSync(join(proj, 'node_modules'), join(pubProj, 'node_modules'), { recursive: true });
    const inPublic = existsSync(join(pubProj, 'public/assets/logo.svg'));
    const pubOut = failing(process.execPath, [join(pubProj, 'node_modules/vite/bin/vite.js'), 'build'], pubProj);
    check('§5.5 fixed: a key in a project file az build copies into public/ FAILS the build, by file — never by value',
      inPublic && pubOut !== null && /found in the built bundle — remove it from source and rebuild \(assets\/logo\.svg@\d+, secret-prefix/.test(pubOut)
        && !pubOut.includes(pubKey),
      pubOut === null ? 'the build succeeded' : pubOut.split('\n').find((l) => l.includes('logo.svg')) ?? pubOut.split('\n')[0]);
    check('§5.5 fixed: the refused build removed its output — no file left holding the planted key',
      !existsSync(join(pubProj, 'dist')) && leftWith(join(pubProj, 'dist'), pubKey).length === 0,
      existsSync(join(pubProj, 'dist')) ? `dist/ remains: ${leftWith(join(pubProj, 'dist'), pubKey).join(', ') || 'no file with the key'}` : '');
    // The project's own build (npm run build): the refused client build stops
    // it — the server build and the pre-render never run, nothing is written.
    const full = spawnSync(process.execPath, [join(pubProj, 'az-vite/build.mjs')], {
      cwd: pubProj, encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS, ...PUBLIC_AUTH, AZ_BUILD_LOG: 'error' },
      timeout: COMMAND_MS, killSignal: 'SIGKILL',
    });
    if (full.error || full.signal) throw new Error(`the project build was stopped: ${full.error?.message ?? full.signal}`);
    check('§5.5 fixed: npm run build FAILS on the key and writes nothing after — no dist/, no server build, no pre-render',
      full.status !== 0 && /found in the built bundle/.test(full.stderr) && !full.stderr.includes(pubKey)
        && !existsSync(join(pubProj, 'dist')) && !existsSync(join(pubProj, '.az-ssr')) && !/prerender/.test(full.stderr),
      `exit ${full.status}; dist ${existsSync(join(pubProj, 'dist')) ? 'remains' : 'gone'}; .az-ssr ${existsSync(join(pubProj, '.az-ssr')) ? 'present' : 'absent'}`);

    // The 3D decoder ships byte-for-byte from three's own files: the clean
    // build above passed with it read (key shape only, as az audit judges it).
    // A key shape planted in the vendored copy is still caught.
    const libs = join(proj, 'node_modules/three/examples/jsm/libs');
    const filesUnder = (dir) => readdirSync(dir, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []));
    const published = filesUnder(libs);
    // A script: the guard does not read binary formats (a .wasm), so only a text copy proves anything.
    const decoder = readdirSync(join(proj, 'dist/assets')).filter((f) => f.endsWith('.js')).flatMap((f) => {
      const name = f.replace(/-[A-Za-z0-9_-]{8}(\.[^./]+)$/, '$1');
      const text = readFileSync(join(proj, 'dist/assets', f), 'utf8');
      const src = published.find((p) => basename(p) === name && readFileSync(p, 'utf8') === text);
      return src ? [{ shipped: f, src }] : [];
    })[0];
    check('CONTROL: the clean build shipped a package\'s file verbatim (the 3D decoder) and the guard passed it',
      decoder !== undefined, decoder?.shipped ?? 'no shipped file matches a file under three/examples/jsm/libs');
    if (decoder) {
      const vendored = join(work, 'proj-decoder');
      cpSync(proj, vendored, { recursive: true, filter: (f) => !f.startsWith(join(proj, 'dist')) });
      const copy = join(vendored, relative(proj, decoder.src));
      const decoderKey = `sk_live_${'Dc4'.repeat(10)}`;
      writeFileSync(copy, `${readFileSync(copy, 'utf8')}\n// ${decoderKey}\n`);
      const decoderOut = failing(process.execPath, [join(vendored, 'node_modules/vite/bin/vite.js'), 'build'], vendored);
      const stem = basename(decoder.src).replace(/\.[^.]+$/, '');
      check('§5.5 fixed: a key shape planted in the vendored decoder copy still FAILS the build',
        decoderOut !== null && new RegExp(`\\(assets/${stem}-[A-Za-z0-9_-]{8}\\.[a-z]+@\\d+, secret-prefix`).test(decoderOut) && !decoderOut.includes(decoderKey),
        decoderOut === null ? 'the build succeeded' : decoderOut.split('\n').find((l) => l.includes(stem)) ?? decoderOut.split('\n')[0]);
    }
  }

  /* ---- M4: `azbackend` — the build refuses a URL the cookie cannot cross -- */
  // auth-spec §3.4: one public base URL, https (plain http only for
  // loopback). The fixture must stay byte-identical to GRAMMAR §8, so this
  // compiles a copy with only the adapter changed.
  {
    const backendSite = join(work, 'site-backend.az');
    writeFileSync(backendSite, readFileSync(site, 'utf8').replace('adapter hosted', 'adapter azbackend'));
    const backendProj = join(work, 'proj-backend');
    node(CLI, ['build', backendSite, '--out', backendProj], work);
    cpSync(join(proj, 'node_modules'), join(backendProj, 'node_modules'), { recursive: true });
    const backendVite = [join(backendProj, 'node_modules/vite/bin/vite.js'), 'build'];
    const plain = failing(process.execPath, backendVite, backendProj, { AZ_PUBLIC_BACKEND_URL: 'http://api.example.org' });
    check('M4 §3.4: an azbackend build FAILS for a plain-http backend URL',
      plain !== null && /adapter azbackend — 'http:\/\/api\.example\.org' must use https/.test(plain));
    const unset = failing(process.execPath, backendVite, backendProj, { AZ_PUBLIC_BACKEND_URL: '' });
    check('M4 §3.4: an azbackend build FAILS when the backend URL is not set',
      unset !== null && /adapter azbackend needs AZ_PUBLIC_BACKEND_URL/.test(unset));
    const good = failing(process.execPath, backendVite, backendProj, { AZ_PUBLIC_BACKEND_URL: 'https://api.example.org' });
    check('CONTROL: the same build passes with an https backend URL, and ships it',
      good === null && readdirSync(join(backendProj, 'dist/assets'))
        .some((f) => f.endsWith('.js') && readFileSync(join(backendProj, 'dist/assets', f), 'utf8').includes('https://api.example.org')),
      good?.split('\n').find((l) => /error|Error/.test(l)) ?? '');
  }

  /* ---- M4: the login page's form is wired, and marked up per §6 ------- */
  {
    const login = rendered['/login'] ?? '';
    check('M4: the login form is marked for the auth runtime',
      /<form[^>]*data-az-behaviour="auth"/.test(login) && /data-flow="login"/.test(login));
    check('auth §6: the email field files under `username` for password managers',
      /<input[^>]*autocomplete="username"/i.test(login));
    check('auth §6: an error summary (role=alert, focusable, hidden) and a polite status line exist',
      /class="az-auth-summary[^"]*"[^>]*role="alert"|role="alert"[^>]*class="az-auth-summary/.test(login)
      && /aria-live="polite"/.test(login));
    check('auth §6: every field has its own (hidden) error element',
      /id="az-auth-email-error"/.test(login) && /id="az-auth-password-error"/.test(login));
  }

  /* ---- gate item 9: the bundle is inside the PRD §9 budget ------------ */
  // Non-3D pages ship under 150KB gzipped (PRD §9), so 3D never taxes a page
  // that does not use it. What a page costs is what its HTML makes the
  // browser fetch at load: the entry and its stylesheet. The 3D chunk and its
  // decoder are fetched later, and only by a page view the gate lets through,
  // so they are measured apart and reported (the PRD sets no 3D budget).
  {
    const assetsDir = join(proj, 'dist/assets');
    const gz = (f) => gzipSync(readFileSync(join(assetsDir, f))).length;
    const kb = (n) => `${(n / 1024).toFixed(1)}KB gz`;
    const html = readFileSync(join(proj, 'dist/legal/index.html'), 'utf8');
    const initial = [...html.matchAll(/(?:src|href)="[^"]*?assets\/([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    const initialGz = initial.reduce((n, f) => n + gz(f), 0);
    check('gate 9 / PRD §9: a non-3D page loads under 150KB gzipped', initialGz < NON_3D_BUDGET_BYTES,
      `${kb(initialGz)} across ${initial.length} files (${initial.join(', ')})`);
    const lazy = readdirSync(assetsDir).filter((f) => /\.(js|wasm)$/.test(f) && !initial.includes(f));
    check('3D ships as a separate lazy chunk, never in a page\'s initial load',
      lazy.some((f) => /^az3d-.*\.js$/.test(f)) && !initial.some((f) => /^az3d/.test(f)),
      `lazy: ${lazy.map((f) => `${f} ${kb(gz(f))}`).join(', ')}`);
  }

  /* ---- the images the page names are in the build ---------------------- */
  for (const a of ['assets/logo.svg', 'assets/logo-w.svg', 'assets/orbit.webp']) {
    check(`asset shipped: dist/${a}`, existsSync(join(proj, 'dist', a)));
    check(`asset linked from the site root: /${a}`, html.includes(`src="/${a}"`));
  }
  // gallery-spec §7 rule 1: every image the build copied ships with its
  // file's width and height, so the browser reserves its box (CLS 0).
  {
    const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
    const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0])
      .filter((t) => attr(t, 'src')?.startsWith('/assets/'));
    const unsized = imgs.filter((t) => !/^[1-9]\d*$/.test(attr(t, 'width') ?? '') || !/^[1-9]\d*$/.test(attr(t, 'height') ?? ''));
    check('§7 rule 1: every shipped <img> of a project file carries width and height',
      imgs.length >= 7 && unsized.length === 0,
      `${imgs.length} imgs; unsized: ${unsized.map((t) => attr(t, 'src')).join(' ')}`);
    const logo = imgs.find((t) => attr(t, 'src') === '/assets/logo.svg') ?? '';
    check('§7 rule 1: the size is the file\'s own — logo.svg is 96×32',
      attr(logo, 'width') === '96' && attr(logo, 'height') === '32', logo);
    // A logo's CSS fixes its height only; width:auto keeps the attribute
    // from drawing it at its file's width (image-dims.ts).
    const logoClass = /\baz-s-[0-9a-z]+/.exec(logo)?.[0] ?? 'none';
    const logoRule = new RegExp(`^\\.${logoClass} \\{ ([^}]*) \\}`, 'm')
      .exec(readFileSync(join(proj, 'src/az.css'), 'utf8'))?.[1] ?? '';
    check('§7 rule 1: a height-only logo gets width:auto, so the attribute cannot stretch it',
      /(^|; )width: auto(;|$)/.test(logoRule), logoRule);
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
  // theme-spec §8.1: the fixture writes `font` / `display serif` / `body sans`.
  // The role overrides type.display, so the h1's rule carries the serif
  // stack; theme.css gives the page the body family, so text a word does
  // not style itself no longer falls back to the browser's default face.
  check('font: `display serif` reaches the <h1>', /font-family: ui-serif, serif/.test(ruleOf(title)),
    (ruleOf(title).match(/font-family: [^;]+/) ?? ['none'])[0]);
  check('font: theme.css sets the page body family (`body sans`)',
    readFileSync(join(proj, 'src/theme.css'), 'utf8').includes('body { font-family: system-ui, sans-serif; }'));
  // The pilot of the style contract: a responsive row and a state, as CSS.
  const classOf = (element) => /\baz-s-[0-9a-z]+/.exec(element ?? '')?.[0] ?? 'none';
  const sm = azCss.slice(azCss.indexOf('@media (width < 768px) {'));
  check('hero-spec §10: split restacks to one column below sm',
    azCss.includes('@media (width < 768px) {') &&
      new RegExp(`^  \\.${classOf(hero)} \\{ [^}]*grid-template-columns: minmax\\(0, 1fr\\);`, 'm').test(sm.slice(0, sm.indexOf('\n}'))));
  check('nav-spec §7: the skip link is shown when focused',
    azCss.includes(`.${classOf(elementWithClass(html, 'az-skip-link'))}:focus-visible { transform: none; }`));
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
    // The fixture's nav is `sticky`: nav-spec §5's one line must ship.
    check('nav-spec §5: a pinned nav ships scroll-padding from the nav-height variable',
      /scroll-padding-top:\s*calc\(var\(--az-size-nav\)/.test(css) && /--az-size-nav:\s*\d+px/.test(css));
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
  // The fixture declares `adapter hosted` once at site level; /login's
  // `auth login` must carry it rather than fall back to `custom`.
  check('auth §2: the login form uses the adapter declared at site level',
    /class="az-auth-form(?: [^"]*)?"[^>]*data-adapter="hosted"|data-adapter="hosted"[^>]*class="az-auth-form(?: [^"]*)?"/.test(html));
  check('auth §8: every field label is tied to its input (for → htmlFor)',
    /<label[^>]*for="[^"]+"/.test(html));
  check('auth §8: autocomplete reaches the inputs',
    /<input[^>]*autocomplete="current-password"/i.test(html));
  check('nav §7: the skip link lands on an element that exists and takes focus',
    routes.every((r) => !/href="#az-content"/.test(rendered[r]) ||
      /<main[^>]*id="az-content"[^>]*tabindex="-1"|<main[^>]*tabindex="-1"[^>]*id="az-content"/i.test(rendered[r])));
  // The skip link must skip something: <main> is its target, so the nav has
  // to sit BEFORE <main>, not inside it — inside, focus landed on <main> and
  // the next Tab went straight back to the skip link. And a <footer> inside
  // <main> is not a contentinfo landmark: it belongs after it.
  for (const r of routes) {
    const page = rendered[r];
    if (!page.includes('az-skip-link')) continue;
    const main = page.indexOf('<main');
    const mainEnd = page.lastIndexOf('</main>');
    check(`nav §7 (${r}): the nav and its skip link come before <main>, not inside it`,
      page.indexOf('az-skip-link') < main && page.indexOf('<nav') < main);
    if (page.includes('<footer')) {
      check(`footer (${r}): the <footer> comes after </main>, so it is a landmark`,
        page.indexOf('<footer') > mainEnd);
    }
  }
  check('nav §7: the main landmark is labelled',
    /<nav[^>]*aria-label="Main"/.test(html));
  check('nav §6: the toggle is a button wired to a panel that exists',
    /<button[^>]*aria-controls="az-nav-panel"/.test(html) && /id="az-nav-panel"/.test(html));

  /** The markup of one page — each route is rendered on its own. */
  const pageHtml = (route) => rendered[route] ?? '';

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
  // As shipped: the project's own build, pre-rendered into dist/index.html.
  shippedBuild(evilProj);
  const evilHtml = shippedRoot(evilProj, '/');

  // M4: auth code is emitted only for a site that uses auth — this one does not.
  check('M4: a site without auth ships no auth runtime or wiring',
    !existsSync(join(evilProj, 'src/az-auth'))
    && !readFileSync(join(evilProj, 'src/App.tsx'), 'utf8').includes('az-auth')
    && !readFileSync(join(evilProj, 'src/theme.css'), 'utf8').includes('.az-session'));
  check('CONTROL: the auth fixture does ship it',
    existsSync(join(proj, 'src/az-auth/form.ts')) && readFileSync(join(proj, 'src/App.tsx'), 'utf8').includes('./az-auth/react.tsx'));
  check('SECURITY: no executable <script> reaches the DOM', !/<script/i.test(evilHtml));
  check('SECURITY: the text survives ESCAPED, not silently dropped',
    evilHtml.includes('&lt;/script&gt;'));

  /* ---- PRD §6.1a: `theme accent` and `theme pattern` reach the shipped CSS ---- */
  // The GRAMMAR §8 fixture must stay byte-identical to the doc and sets
  // neither, so a second small site carries them through the real build.
  const tuned = join(work, 'tuned.az');
  writeFileSync(tuned,
    'az 1\nsite tuned\n  theme midnight\n    accent teal\n    pattern glow left\n\n' +
    'page /\n  hero center\n    title "Tuned"\n    sub "Accent and pattern from the theme."\n');
  const tunedProj = join(work, 'tuned');
  node(CLI, ['build', tuned, '--out', tunedProj], work);
  cpSync(join(proj, 'node_modules'), join(tunedProj, 'node_modules'), { recursive: true });
  shippedBuild(tunedProj);
  {
    // The minifier rewrites colours (hsl → hex), so the reference is the
    // default-midnight site built above, minified the same way.
    const shippedCss = (dir) => {
      const f = readdirSync(join(dir, 'dist/assets')).find((n) => n.endsWith('.css'));
      return f ? readFileSync(join(dir, 'dist/assets', f), 'utf8') : '';
    };
    const accentsOf = (text) => [...text.matchAll(/--az-color-accent:\s*([^;}]+)/g)].map((m) => m[1].trim());
    const css = shippedCss(tunedProj);
    const accents = accentsOf(css);
    const defaults = accentsOf(shippedCss(evilProj));
    check('theme accent: the shipped CSS carries the regenerated accent, not the theme default',
      accents.length >= 2 && defaults.length >= 2 && accents.every((v) => !defaults.includes(v)),
      `tuned ${accents.join(' | ')} vs default ${defaults.join(' | ')}`);
    check('theme pattern: declared once from the accent token',
      /--az-pattern-image:\s*radial-gradient\([^;]*var\(--az-color-accent\)/.test(css));
    check('theme pattern: the hero paints it', /background-image:\s*var\(--az-pattern-image\)/.test(css));
  }
  check('CONTROL: a site without pattern ships no pattern declaration',
    !readFileSync(join(evilProj, 'src/theme.css'), 'utf8').includes('--az-pattern-image'));

  /* ---- GRAMMAR §4.4: `description` and `icon`, as the pages ship them ---- */
  // The fixture writes neither (it must stay byte-identical to GRAMMAR §8),
  // so a small site does: a site description with characters HTML must
  // escape, a page's own description over its hero's lead copy, a real PNG
  // icon — and two builds that must fail: a GIF named .png, and a path out.
  // The icon is 192px square, so the build also resizes it to the 180×180
  // PNG home-screen icon, in a cache of the run's own.
  const headDir = join(work, 'head-site');
  mkdirSync(join(headDir, 'brand'), { recursive: true });
  await sharp({ create: { width: 192, height: 192, channels: 4, background: { r: 20, g: 120, b: 90, alpha: 1 } } })
    .png().toFile(join(headDir, 'brand/icon.png'));
  const headSite = join(headDir, 'site.az');
  writeFileSync(headSite,
    'az 1\nsite head\n  description "Shoes & boots — \\"made\\" <by hand>"\n  icon ./brand/icon.png\n\n' +
    'page /\n  description "Reserve a pair from the autumn run."\n  hero center\n    title "Head"\n    sub "Lead copy the written description replaces."\n\n' +
    'page /about\n');
  const headProj = join(headDir, 'proj');
  const headReport = azBuild(headSite, headProj, headDir, { AZ_IMAGE_CACHE: join(work, 'touch-cache-a') });
  cpSync(join(proj, 'node_modules'), join(headProj, 'node_modules'), { recursive: true });
  shippedBuild(headProj);
  {
    const shippedHead = (r) => {
      const file = readFileSync(join(headProj, 'dist', r === '/' ? '' : r.slice(1), 'index.html'), 'utf8');
      return file.slice(0, file.indexOf('</head>'));
    };
    const described = (r) => /<meta name="description" content="([^"]*)"/.exec(shippedHead(r))?.[1] ?? null;
    check("§4.4: a page's own description ships over its lead copy",
      described('/') === 'Reserve a pair from the autumn run.', described('/'));
    check("§4.4: the site's description ships on a page without its own — HTML-escaped",
      described('/about') === 'Shoes &amp; boots — &quot;made&quot; &lt;by hand&gt;' && !shippedHead('/about').includes('<by hand>'),
      described('/about'));
    // The project build makes the href relative to each page, as it does the
    // bundle's (vite.config `base: "./"`): it must resolve, from the page's
    // own file, to the icon's root URL.
    const iconOf = (r) => /<link rel="icon" type="image\/png" href="([^"]+)" \/>/.exec(shippedHead(r))?.[1] ?? null;
    const fileUrl = (r) => `http://site.invalid${r === '/' ? '' : r}/index.html`;
    check('§4.4: every page declares the icon with the type its bytes say, resolving to its URL, and no empty one',
      ['/', '/about'].every((r) => iconOf(r) !== null && new URL(iconOf(r), fileUrl(r)).pathname === '/brand/icon.png' &&
        !shippedHead(r).includes('data:,')),
      `${iconOf('/')} | ${iconOf('/about')}`);
    check('§4.4: the icon file ships byte for byte at the URL it is declared at',
      existsSync(join(headProj, 'dist/brand/icon.png')) &&
        readFileSync(join(headProj, 'dist/brand/icon.png')).equals(readFileSync(join(headDir, 'brand/icon.png'))));
    // The home-screen icon: a 180×180 PNG, declared on every page with a
    // href relative to the page like the icon's, content-hash named, the
    // same name and bytes from a second cold cache.
    const touchOf = (r) => /<link rel="apple-touch-icon" href="([^"]+)" \/>/.exec(shippedHead(r))?.[1] ?? null;
    const touchUrls = ['/', '/about'].map((r) => (touchOf(r) === null ? null : new URL(touchOf(r), fileUrl(r)).pathname));
    check('§4.4 touch icon: every page declares one, resolving to one content-hash-named PNG under the variant folder',
      touchUrls.every((u) => u !== null && u === touchUrls[0]) && /^\/az-img\/[0-9a-f]{16}-180\.png$/.test(touchUrls[0] ?? '') &&
        !/^\//.test(touchOf('/about') ?? '/'),
      `${touchOf('/')} | ${touchOf('/about')}`);
    const touchFile = touchUrls[0] === null ? null : join(headProj, 'dist', touchUrls[0]);
    const touchMeta = touchFile !== null && existsSync(touchFile) ? await sharp(touchFile).metadata() : null;
    check('§4.4 touch icon: the file ships at that URL and is a 180×180 PNG',
      touchMeta?.format === 'png' && touchMeta.width === 180 && touchMeta.height === 180,
      `${touchFile} ${touchMeta?.format} ${touchMeta?.width}×${touchMeta?.height}`);
    check('§4.4 touch icon: a usable icon warns nothing', !/AZ1422|home-screen/.test(headReport), headReport.trim());
    const headAgain = join(headDir, 'proj-again');
    azBuild(headSite, headAgain, headDir, { AZ_IMAGE_CACHE: join(work, 'touch-cache-b') });
    check('§4.4 touch icon: deterministic — a second cold cache gives the same pages, name and bytes',
      ['index.html', 'about/index.html'].every((f) => readFileSync(join(headProj, f), 'utf8') === readFileSync(join(headAgain, f), 'utf8')) &&
        touchUrls[0] !== null && readFileSync(join(headAgain, 'public', touchUrls[0])).equals(readFileSync(join(headProj, 'public', touchUrls[0]))));
    // CONTROLS: an SVG icon and a PNG under 180px ship the icon and no touch
    // icon — never an SVG rasterised, never a small one upscaled — and warn.
    writeFileSync(join(headDir, 'brand/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="12"/></svg>\n');
    await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 20, g: 120, b: 90, alpha: 1 } } })
      .png().toFile(join(headDir, 'brand/small.png'));
    for (const [name, icon, type, warning] of [
      ['svg', 'icon.svg', 'image/svg+xml', /svg\.az:3:8 warning AZ1422 {2}site: icon '\.\/brand\/icon\.svg' is an SVG, and a home-screen icon must be a PNG/],
      ['small', 'small.png', 'image/png', /small\.az:3:8 warning AZ1422 {2}site: icon '\.\/brand\/small\.png' is 64×64, and a home-screen icon needs a square PNG of 180×180 or more/],
    ]) {
      writeFileSync(join(headDir, `${name}.az`), `az 1\nsite head\n  icon ./brand/${icon}\n\npage /\n`);
      const out = join(headDir, `${name}-proj`);
      const cache = join(work, `touch-cache-${name}`);
      const report = azBuild(join(headDir, `${name}.az`), out, headDir, { AZ_IMAGE_CACHE: cache });
      cpSync(join(proj, 'node_modules'), join(out, 'node_modules'), { recursive: true });
      shippedBuild(out);
      const shipped = readFileSync(join(out, 'dist/index.html'), 'utf8');
      check(`CONTROL §4.4: a${name === 'svg' ? 'n SVG icon' : ' PNG icon under 180px'} ships with no touch icon, nothing resized, and warns AZ1422`,
        !shipped.includes('apple-touch-icon') && shipped.includes(`rel="icon" type="${type}"`) &&
          !existsSync(join(out, 'dist/az-img')) && !existsSync(cache) && warning.test(report),
        report.trim().split('\n')[0]);
    }
    writeFileSync(join(headDir, 'gif.az'), 'az 1\nsite head\n  icon ./brand/fake.png\n\npage /\n');
    writeFileSync(join(headDir, 'brand/fake.png'), 'GIF89a\x01\x00\x01\x00');
    const gifOut = failing(process.execPath, [CLI, 'build', join(headDir, 'gif.az'), '--out', join(headDir, 'gif')], headDir) ?? '';
    check('§4.4: a GIF named .png fails the build with AZ1421 at its line, and writes nothing',
      /gif\.az:3:8 error AZ1421 {2}site: icon '\.\/brand\/fake\.png' is not a PNG or an SVG file/.test(gifOut) &&
        !existsSync(join(headDir, 'gif/index.html')), gifOut.trim().split('\n')[0]);
    writeFileSync(join(headDir, 'out.az'), 'az 1\nsite head\n  icon ../../etc/icon.png\n\npage /\n');
    const outOut = failing(process.execPath, [CLI, 'build', join(headDir, 'out.az'), '--out', join(headDir, 'out')], headDir) ?? '';
    check('SECURITY §4.4: an icon path out of the project fails at link stage (AZ1210) and writes nothing',
      /AZ1210 {2}site: '\.\.\/\.\.\/etc\/icon\.png' points outside the project/.test(outOut) &&
        !/AZ1421/.test(outOut) && !existsSync(join(headDir, 'out/index.html')), outOut.trim().split('\n')[0]);
  }

  /* ---- gallery-spec §7 rule 3: responsive images, resized at build ------ */
  // The GRAMMAR §8 fixture's images are placeholders too small to resize, so
  // a gallery of real photographs — made here, in a cache of its own —
  // goes through the real build, and the checks read the pages it ships.
  // A feature's `rows` media and a cta's `split` media use the same files,
  // and so do the hero posters: `full` on / and `split` on /reserve.
  // /tiles crops them into square and 4:3 tiles (cover crops widen sizes).
  const gallerySite = join(work, 'gallery.az');
  mkdirSync(join(work, 'photos'));
  const photo = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: { r: 120, g: 60, b: 30 } } })
    .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 3}" fill="#fff"/></svg>`) }]);
  await photo(2400, 1600).jpeg({ quality: 85 }).toFile(join(work, 'photos/big.jpg'));
  await photo(1000, 667).png().toFile(join(work, 'photos/mid.png'));
  await photo(1200, 1200).jpeg({ quality: 85 }).toFile(join(work, 'photos/square.jpg'));
  await photo(400, 300).webp().toFile(join(work, 'photos/small.webp'));
  // A header that parses over data that does not decode.
  writeFileSync(join(work, 'photos/broken.jpg'), (await photo(900, 600).jpeg().toBuffer()).subarray(0, 700));
  writeFileSync(gallerySite,
    'az 1\nsite photos\n\npage /\n  hero full 3d\n    title "Photos"\n    poster ./photos/big.jpg\n    describe "A circle of light"\n' +
    '  gallery grid lightbox\n    columns 3\n' +
    ['big.jpg', 'mid.png', 'small.webp', 'broken.jpg'].map((f) => `    image ./photos/${f}\n      alt "${f}"\n`).join('') +
    '  feature rows\n' +
    ['big.jpg', 'mid.png'].map((f) => `    item "${f}"\n      text "A photograph."\n      media ./photos/${f}\n`).join('') +
    '  cta split\n    title "Reserve"\n    media ./photos/big.jpg\n    cta "Reserve a pair" /reserve\n\npage /reserve\n' +
    '  hero split 3d\n    title "Reserve"\n    poster ./photos/mid.png\n    describe "A circle of light"\n\npage /tiles\n' +
    ['square', '4:3'].map((ratio) => `  gallery grid\n    ratio ${ratio}\n    columns 3\n` +
      ['big.jpg', 'square.jpg'].map((f) => `    image ./photos/${f}\n      alt "${f} in ${ratio}"\n`).join('')).join(''));
  const galleryProj = join(work, 'gallery');
  const galleryReport = azBuild(gallerySite, galleryProj, work, { AZ_IMAGE_CACHE: join(work, 'image-cache-a') });
  cpSync(join(proj, 'node_modules'), join(galleryProj, 'node_modules'), { recursive: true });
  shippedBuild(galleryProj);
  {
    const page = shippedRoot(galleryProj, '/');
    // HTML attribute names are case-blind, and React writes `srcSet`.
    const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1]
      ?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const imgTags = (html) => [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    const tags = imgTags(page);
    const MEDIA = /\baz-(?:feature-media|cta-media-img|hero-poster)\b/;
    const of = (file) => tags.filter((t) => attr(t, 'src') === `/photos/${file}` && !MEDIA.test(attr(t, 'class') ?? ''));
    const set = (t) => (attr(t, 'srcset') ?? '').split(', ').filter(Boolean).map((c) => {
      const [url, w] = c.split(' ');
      return { url, width: Number(w?.slice(0, -1)) };
    });
    const [big, bigBox] = of('big.jpg');
    const [mid] = of('mid.png');
    // big.jpg is 3:2 in the default 3:2 tile: a cover crop that matches its box, so sizes is the layout's own.
    check('§7 rule 3: a large photograph ships a srcset of the four widths, with the layout\'s sizes (CONTROL: a 3:2 file in a 3:2 tile)',
      set(big).map((c) => c.width).join() === '480,768,1200,1800' && attr(big, 'sizes') === '(width < 768px) 50vw, min(34vw, 480px)',
      `${attr(big, 'srcset')} | ${attr(big, 'sizes')}`);
    check('§7 rule 3: the original stays the src, with its own width and height',
      attr(big, 'width') === '2400' && attr(big, 'height') === '1600');
    check('§7 rule 3: never upscaled — a 1000px original gets 480 and 768, then itself',
      set(mid).map((c) => `${c.url} ${c.width}`).join() ===
        `${set(mid)[0]?.url} 480,${set(mid)[1]?.url} 768,/photos/mid.png 1000`, attr(mid, 'srcset'));
    check('§7 rule 3: the lightbox\'s image has the srcset at the dialog\'s width',
      !!bigBox && set(bigBox).length === 4 && attr(bigBox, 'srcset') === attr(big, 'srcset') &&
        /^min\(90vw, \d+px\)$/.test(attr(bigBox, 'sizes') ?? ''),
      bigBox ?? 'no second img');
    const none = [...of('small.webp'), ...of('broken.jpg')];
    check('§7 rule 3: a small original and an undecodable file ship no srcset and no sizes',
      none.length === 2 && none.every((t) => attr(t, 'srcset') === undefined && attr(t, 'sizes') === undefined));
    check('§7 rule 3: an undecodable file is a warning, and ships its original only',
      galleryReport.includes("warning: image: can't resize './photos/broken.jpg' — it does not decode") &&
        existsSync(join(galleryProj, 'dist/photos/broken.jpg')), galleryReport.trim());
    // Every candidate a shipped page names is a file in dist/, exactly as
    // wide as it says and narrower than its original.
    const reserve = imgTags(shippedRoot(galleryProj, '/reserve'));
    const tiles = imgTags(shippedRoot(galleryProj, '/tiles'));
    const named = [...tags, ...reserve, ...tiles].flatMap((t) => set(t).map((c) => ({ ...c, original: Number(attr(t, 'width')), src: attr(t, 'src') })));
    const wrong = [];
    for (const c of named) {
      const file = join(galleryProj, 'dist', c.url);
      if (!existsSync(file)) { wrong.push(`${c.url} missing`); continue; }
      const { width } = await sharp(file).metadata();
      if (width !== c.width) wrong.push(`${c.url} is ${width}px, says ${c.width}w`);
      if (c.url !== c.src && !(c.width < c.original)) wrong.push(`${c.url} is not narrower than its ${c.original}px original`);
    }
    // The same rule for feature and cta media, with the sizes of their own layouts.
    const media = (cls, file) => tags.find((t) => attr(t, 'src') === `/photos/${file}` && (attr(t, 'class') ?? '').split(' ').includes(cls));
    const featureBig = media('az-feature-media', 'big.jpg');
    const featureMid = media('az-feature-media', 'mid.png');
    const ctaBig = media('az-cta-media-img', 'big.jpg');
    check('§7 rule 3: feature rows media ships the four widths, with half the row\'s sizes capped by the frame',
      !!featureBig && set(featureBig).map((c) => c.width).join() === '480,768,1200,1800' &&
        attr(featureBig, 'sizes') === '(width < 768px) 100vw, min(50vw, 720px)' &&
        attr(featureBig, 'srcset') === attr(big, 'srcset') && attr(featureBig, 'width') === '2400',
      featureBig ? `${attr(featureBig, 'srcset')} | ${attr(featureBig, 'sizes')}` : 'no feature media');
    check('§7 rule 3: feature media is never upscaled — a 1000px original gets 480 and 768, then itself',
      !!featureMid && set(featureMid).map((c) => c.width).join() === '480,768,1000' &&
        set(featureMid)[2]?.url === '/photos/mid.png', featureMid ? attr(featureMid, 'srcset') : 'no feature media');
    check('§7 rule 3: cta split media ships the four widths, with its column\'s sizes capped by the frame',
      !!ctaBig && set(ctaBig).map((c) => c.width).join() === '480,768,1200,1800' &&
        attr(ctaBig, 'sizes') === '(width < 768px) 100vw, min(50vw, 720px)' && attr(ctaBig, 'height') === '1600',
      ctaBig ? `${attr(ctaBig, 'srcset')} | ${attr(ctaBig, 'sizes')}` : 'no cta media');
    // hero-spec §8: the poster, with the sizes of its own box — `full` is
    // full-bleed, so never capped by the frame; `split` is its column.
    const heroFull = media('az-hero-poster', 'big.jpg');
    // The 3:2 file is cropped into the header — 100vw wide, 85svh tall at
    // least, bounded by 85vh — so it is drawn up to 85vh × 1.5 = 128vh wide.
    check('hero §8: a full poster ships the four widths, the box or its crop (max(100vw, 128vh)), loading as before',
      !!heroFull && set(heroFull).map((c) => c.width).join() === '480,768,1200,1800' &&
        attr(heroFull, 'srcset') === attr(big, 'srcset') && attr(heroFull, 'sizes') === 'max(100vw, min(128vh, 1800px))' &&
        attr(heroFull, 'width') === '2400' && attr(heroFull, 'loading') === undefined &&
        attr(heroFull, 'fetchpriority') === undefined,
      heroFull ? `${attr(heroFull, 'srcset')} | ${attr(heroFull, 'sizes')}` : 'no hero poster');
    const heroSplit = reserve.find((t) => attr(t, 'src') === '/photos/mid.png' &&
      (attr(t, 'class') ?? '').split(' ').includes('az-hero-poster'));
    // A 1000×667 file in the 4:3 column is drawn 1.1244× the column.
    check('hero §8: a split poster is never upscaled — 480 and 768, then its 1000px self — at its column\'s sizes, widened for its crop',
      !!heroSplit && set(heroSplit).map((c) => c.width).join() === '480,768,1000' &&
        set(heroSplit)[2]?.url === '/photos/mid.png' && attr(heroSplit, 'srcset') === attr(mid, 'srcset') &&
        attr(heroSplit, 'sizes') === '(width < 768px) 113vw, min(57vw, 810px)',
      heroSplit ? `${attr(heroSplit, 'srcset')} | ${attr(heroSplit, 'sizes')}` : 'no hero poster');
    // The renderer preloads every eager image from the page's head, the
    // poster included: that preload must carry the poster's own srcset and
    // sizes, or the browser fetches a second file before the <img> asks for
    // its own — and no preload may name the original by href alone.
    const preloads = (route) => {
      const file = join(galleryProj, 'dist', route === '/' ? '' : route.slice(1), 'index.html');
      return [...readFileSync(file, 'utf8').matchAll(/<link\b[^>]*>/g)].map((m) => m[0])
        .filter((l) => /\srel="preload"/i.test(l) && /\sas="image"/i.test(l));
    };
    for (const [route, poster] of [['/', heroFull], ['/reserve', heroSplit]]) {
      const links = preloads(route);
      const matching = links.filter((l) => !!poster &&
        attr(l, 'imagesrcset') === attr(poster, 'srcset') && attr(l, 'imagesizes') === attr(poster, 'sizes'));
      const byHref = links.filter((l) => !!poster && attr(l, 'href') === attr(poster, 'src'));
      check(`hero §8: ${route}'s poster preload carries the poster's srcset and sizes, and none names the original alone`,
        matching.length === 1 && byHref.length === 0, links.join(' ') || 'no image preload');
    }
    // Cover crops (gallery-spec §7 rule 3): a file wider than its tile is
    // drawn wider than the tile, so its sizes is widened by fileAspect /
    // tileAspect; a file the tile's shape or narrower is left as it was.
    const tile = (file, ratio) => tiles.find((t) => attr(t, 'alt') === `${file} in ${ratio}`);
    const LAYOUT = '(width < 768px) 50vw, min(34vw, 480px)';
    for (const [file, ratio, sizes, why] of [
      ['big.jpg', 'square', '(width < 768px) 75vw, min(51vw, 720px)', 'a 3:2 file in a square tile is drawn 1.5× the tile'],
      ['big.jpg', '4:3', '(width < 768px) 57vw, min(39vw, 540px)', 'a 3:2 file in a 4:3 tile is drawn 1.125× the tile'],
      ['square.jpg', 'square', LAYOUT, 'CONTROL: a square file in a square tile matches it'],
      ['square.jpg', '4:3', LAYOUT, 'a square file in a 4:3 tile is drawn at the tile\'s width'],
    ]) {
      const t = tile(file, ratio);
      check(`§7 rule 3 cover: ${why} — ${sizes}`,
        !!t && attr(t, 'sizes') === sizes && attr(t, 'data-az-cover') === undefined && set(t).length === (file === 'big.jpg' ? 4 : 3),
        t ? `${attr(t, 'sizes')} | ${attr(t, 'srcset')}` : `no ${file} tile in ${ratio}`);
    }
    // gallery 4 + lightbox 4 + 3, feature 4 + 3, cta 4, hero full 4 (/), hero split 3 (/reserve),
    // tiles 4 + 3 + 4 + 3 (/tiles): every one checked against the file it names.
    check('§7 rule 3: every srcset candidate ships, at its stated width, none upscaled',
      named.length === 4 + 4 + 3 + 4 + 3 + 4 + 4 + 3 + 14 && wrong.length === 0, wrong.join('; ') || `${named.length} candidates`);

    // In a browser: on a 375×812 phone the full poster's box is the header,
    // ~690px tall, so the crop draws the 3:2 file ~1035px wide. The file the
    // browser picks must be at least that wide at the device's density, or
    // the largest there is. `100vw` alone (the old sizes) picks 480px at 1x.
    const server = await startServer();
    server.serve(join(galleryProj, 'dist'));
    const browser = await within(BROWSER_MS, 'chromium.launch', () => chromium.launch());
    try {
      for (const dpr of [1, 2]) {
        const context = await browser.newContext({ viewport: { width: 375, height: 812 }, deviceScaleFactor: dpr });
        try {
          const tab = await context.newPage();
          tab.setDefaultTimeout(BROWSER_MS);
          await tab.goto(server.url, { waitUntil: 'load', timeout: BROWSER_MS });
          await tab.waitForFunction(() => {
            const img = document.querySelector('img.az-hero-poster');
            return !!img && img.complete && img.currentSrc !== '';
          }, null, { timeout: BROWSER_MS });
          const seen = await within(BROWSER_MS, `poster currentSrc @ ${dpr}x`, () => tab.evaluate(() => {
            const img = document.querySelector('img.az-hero-poster');
            const box = document.querySelector('header.az-hero').getBoundingClientRect();
            return { current: new URL(img.currentSrc).pathname, srcset: img.srcset, height: box.height, width: box.width };
          }));
          const widths = new Map(seen.srcset.split(', ').map((c) => c.split(' ')).map(([u, w]) => [u, Number(w.slice(0, -1))]));
          const chosen = widths.get(seen.current);
          const largest = Math.max(...widths.values());
          const needed = Math.ceil(Math.max(seen.width, seen.height * 1.5) * dpr);
          check(`hero §8 browser: at 375×812 ${dpr}x the full poster's file covers its crop (≥ ${needed}px, or the largest)`,
            chosen !== undefined && (chosen >= needed || chosen === largest),
            `chose ${seen.current} (${chosen}px) for a ${seen.width}×${Math.round(seen.height)} box`);
        } finally {
          await closeWithin(context, BROWSER_MS, `context.close @ ${dpr}x`);
        }
      }
    } finally {
      await closeWithin(browser, BROWSER_MS, 'chromium.close');
      await closeWithin(server, BROWSER_MS, 'server.close');
    }
  }

  /* ---- determinism ------------------------------------------------------ */
  const a = join(work, 'a'), b = join(work, 'b');
  node(CLI, ['build', site, '--out', a], work);
  node(CLI, ['build', site, '--out', b], work);
  const read = (d) => readFileSync(join(d, 'src/App.tsx'), 'utf8');
  check('DETERMINISM: two builds of one source are identical', read(a) === read(b));
  // CONVENTIONS §6 with §7 rule 3: resized images from a second, cold cache
  // are the same names and the same bytes.
  {
    const ga = join(work, 'gallery-a');
    azBuild(gallerySite, ga, work, { AZ_IMAGE_CACHE: join(work, 'image-cache-b') });
    const variants = (d) => {
      const dir = join(d, 'public/az-img');
      return existsSync(dir) ? readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f))]) : [];
    };
    const first = variants(galleryProj);
    const second = variants(ga);
    check('DETERMINISM: resized images from a cold cache are byte-identical, and the pages name them alike',
      first.length === 8 && second.length === first.length && read(galleryProj) === read(ga) &&
        first.every(([f, bytes], i) => second[i][0] === f && second[i][1].equals(bytes)),
      `${first.length} variants`);
  }

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
deadline.clear();
