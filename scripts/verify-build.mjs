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
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { watchdog, human } from './lib/bounded.mjs';

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
  check('the build and its pre-render report nothing (React warnings fail it)', buildLog.trim() === '', buildLog.trim().split('\n')[0]);
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
    // CONTROL: the untouched project built above, with its public key shipped.
    check('CONTROL: the clean build (public key present) passed the same guard', existsSync(join(proj, 'dist/index.html')));
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
deadline.clear();
