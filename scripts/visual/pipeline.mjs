/**
 * Compile, install and build many small sites — shared by `pnpm gate` and
 * `pnpm thumbnails`.
 *
 * Every site compiles through the real CLI. The emitted package.json pins
 * are identical by design, so ONE npm install serves every site; that is
 * checked, not assumed. npm and vite run as JavaScript under process.execPath
 * rather than through their shell wrappers (see verify-build.mjs for why).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readFileSync, writeFileSync, existsSync, cpSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const WORDS = join(ROOT, 'packages/words');
export const CLI = join(ROOT, 'packages/cli/bin/az.js');

/** Parallel Vite builds; bounded so a laptop stays usable. */
const BUILD_CONCURRENCY = 4;

const NODE_DIR = dirname(process.execPath);
const NPM_CLI = [
  join(NODE_DIR, 'node_modules/npm/bin/npm-cli.js'),
  join(NODE_DIR, '../lib/node_modules/npm/bin/npm-cli.js'),
].find((c) => existsSync(c));

const execFileP = promisify(execFile);

/** Child deadlines: az build, the shared npm install, a project's own build. */
export const COMPILE_MS = 2 * 60_000;
export const INSTALL_MS = 10 * 60_000;
export const PROJECT_BUILD_MS = 5 * 60_000;

/**
 * The backend address a preview of a backend site is built with, unless the
 * caller sets its own (test:data, test:chat start a real one). A preview
 * with `auth adapter azbackend` — the chat word's — cannot build without
 * one (auth-spec §3.4), and nothing it renders at load calls it; `.invalid`
 * never resolves (RFC 2606), so a stray request fails rather than leaves.
 */
export const PREVIEW_BACKEND_URL = 'https://backend.invalid';

/**
 * Answer a browser context's requests to PREVIEW_BACKEND_URL as a backend
 * with nobody signed in would: `GET /auth/session` is `{ session: null }`
 * (CORS for the asking origin, preflight included), anything else 404. A
 * signed-in-only chat panel reads the session on load; without this the
 * request would fail, and a failed load is a console error every engine
 * reports. Nothing is sent anywhere — the route answers before any lookup.
 */
export async function answerPreviewBackend(ctx) {
  await ctx.route(`${PREVIEW_BACKEND_URL}/**`, (route) => {
    const req = route.request();
    const origin = req.headers().origin;
    const cors = origin ? {
      'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type, x-az-request', 'access-control-allow-methods': 'GET, POST', vary: 'Origin',
    } : {};
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const session = req.method() === 'GET' && new URL(req.url()).pathname === '/auth/session';
    return route.fulfill({
      status: session ? 200 : 404, headers: { ...cors, 'content-type': 'application/json' },
      body: session ? '{"session":null}' : '{"error":"unknown"}',
    });
  });
}

/**
 * node <script> …, with the bundled words; rejects with stdout/stderr
 * attached. Bounded: past `timeout` the child is killed and the call rejects.
 */
export const node = (script, args, cwd, timeout = PROJECT_BUILD_MS) => execFileP(process.execPath, [script, ...args], {
  cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout, killSignal: 'SIGKILL',
  // AZ_BUILD_LOG quiets a project's own build (az-vite/build.mjs) to errors.
  env: { AZ_BUILD_LOG: 'error', AZ_PUBLIC_BACKEND_URL: PREVIEW_BACKEND_URL, ...process.env, AZ_WORDS: WORDS },
});

/** Run `fn` over `items`, at most `limit` at a time, results in input order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/** The first `page <route>` of a .az source, as a URL path. */
export function firstRoute(source) {
  const m = /^page\s+(\S+)/m.exec(source);
  if (!m) throw new Error('site has no page');
  return m[1] === '/' ? '/' : `${m[1]}/`;
}

/**
 * Build every site: `{ dir, source, assetsFrom? }` in, and on return each
 * site carries `compiled`, `error` (compiler errors, when it did not
 * compile), `proj` and `dist` — the site as it ships, every page pre-rendered.
 */
export async function buildSites(sites, work) {
  if (!NPM_CLI) throw new Error(`pipeline: npm-cli.js not found in the node install at ${NODE_DIR}`);
  for (const s of sites) {
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(join(s.dir, 'site.az'), s.source);
    if (s.assetsFrom && existsSync(s.assetsFrom)) {
      cpSync(s.assetsFrom, join(s.dir, 'preview-assets'), { recursive: true });
    }
  }
  await pool(sites, BUILD_CONCURRENCY, async (s) => {
    s.proj = join(s.dir, 'proj');
    try {
      await node(CLI, ['build', join(s.dir, 'site.az'), '--out', s.proj], s.dir, COMPILE_MS);
      s.compiled = true;
    } catch (e) {
      s.compiled = false;
      s.error = String(e.stderr ?? e.message).split('\n').filter((l) => / error /.test(l))
        .map((l) => l.replace(/^.*?error /, '')).join(' | ') || 'az build failed';
    }
  });
  const built = sites.filter((s) => s.compiled);
  if (built.length === 0) return;

  // One install per distinct dependency set: a 3D site adds `three`, every
  // other site emits the same set, so this is one or two installs, not one
  // per site. Sites are grouped by their package.json minus the name.
  const depsOf = (p) => JSON.stringify({ ...JSON.parse(readFileSync(join(p, 'package.json'), 'utf8')), name: '' });
  const installs = new Map();
  for (const s of built) {
    const key = depsOf(s.proj);
    if (!installs.has(key)) installs.set(key, { dir: join(work, `shared-${installs.size}`), from: s.proj });
    s.install = installs.get(key).dir;
  }
  for (const { dir, from } of installs.values()) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), readFileSync(join(from, 'package.json')));
    await node(NPM_CLI, ['install', '--no-audit', '--no-fund'], dir, INSTALL_MS);
  }

  await pool(built, BUILD_CONCURRENCY, async (s) => {
    symlinkSync(join(s.install, 'node_modules'), join(s.proj, 'node_modules'), 'dir');
    // The project's OWN build (`npm run build`): the client bundle, then every
    // page pre-rendered into its HTML — so every check sees what ships.
    await node(join(s.proj, 'az-vite/build.mjs'), [], s.proj, PROJECT_BUILD_MS);
    s.dist = join(s.proj, 'dist');
  });
}
