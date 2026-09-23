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

/** node <script> …, with the bundled words; rejects with stdout/stderr attached. */
export const node = (script, args, cwd) => execFileP(process.execPath, [script, ...args], {
  cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  // AZ_BUILD_LOG quiets a project's own build (az-vite/build.mjs) to errors.
  env: { AZ_BUILD_LOG: 'error', ...process.env, AZ_WORDS: WORDS },
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
      await node(CLI, ['build', join(s.dir, 'site.az'), '--out', s.proj], s.dir);
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
    await node(NPM_CLI, ['install', '--no-audit', '--no-fund'], dir);
  }

  await pool(built, BUILD_CONCURRENCY, async (s) => {
    symlinkSync(join(s.install, 'node_modules'), join(s.proj, 'node_modules'), 'dir');
    // The project's OWN build (`npm run build`): the client bundle, then every
    // page pre-rendered into its HTML — so every check sees what ships.
    await node(join(s.proj, 'az-vite/build.mjs'), [], s.proj);
    s.dist = join(s.proj, 'dist');
  });
}
