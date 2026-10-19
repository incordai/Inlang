/**
 * @az module shipped
 * Purpose: the secret scan over a built site's files on disk — what the build guard and az audit both run.
 * Spec: docs/word-quality-gate.md §4 rule 2, §5.5 · docs/auth-block-spec.md §4
 * Exports: walkShipped, shippedSecrets, publishedCopies, readRegular, removeOutput, FILE_MAX_BYTES, MAX_FILES, Shipped, ShippedTree, ShippedHit
 * Edit guide: imports only node built-ins — the CLI copies this file verbatim into every site's az-vite/, beside secrets.ts; the scanner is passed in, never imported; links are never followed; every walk is capped.
 * Tests: packages/cli/test/shipped.test.ts, packages/cli/test/audit.test.ts, scripts/verify-build.mjs
 */

/**
 * One scan for every file a built site ships — the generated build's guard
 * runs it once Vite has written the output (its chunks, the assets it read
 * as bytes, and the files it copied from `public/`), the generated
 * build.mjs over every page the pre-render then fills, and `az audit` again
 * over the finished folder. All judge with the same scanner (core
 * secrets.ts, scanText), passed in so this file needs no path to it.
 *
 * The one exception both make: a shipped file that is byte-for-byte a file
 * an installed package published (the 3D runtime's decoder) is judged by the
 * key-shape rules only. The entropy rule is a heuristic for a value inlined
 * into the site; a published file is not one, and compiled decoders are
 * dense by nature.
 */

import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rm } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, sep } from 'node:path';

/** A shipped file larger than this is not read: it is reported as unscanned instead. */
export const FILE_MAX_BYTES = 16 * 1024 * 1024;
/** A built site with more files than this is not walked further; the rest are reported as unscanned. */
export const MAX_FILES = 20_000;
/** The installed packages' folder is walked at most this far looking for a published original. */
const MAX_PACKAGE_ENTRIES = 200_000;

/** Formats that cannot carry a readable key in text; everything else is scanned. */
const BINARY: ReadonlySet<string> = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
  '.glb', '.bin', '.ktx2', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm', '.mov', '.mp3', '.ogg', '.wav', '.pdf', '.zip', '.gz', '.br', '.wasm',
]);

/** Vite names an emitted asset `<name>-<8-character hash><ext>` (its default assetFileNames). */
const HASHED = /-[A-Za-z0-9_-]{8}(\.[^./]+)$/;

/** One shipped file, as read; `path` is relative to the walk's base, `/`-separated. */
export interface Shipped {
  readonly path: string;
  readonly text: string;
}

/**
 * A walked folder: the text files read; `unread` names what was too large or
 * past the cap, never read; `names` is every regular file within the cap,
 * text or binary, read or not — what the folder holds, by path.
 */
export interface ShippedTree {
  readonly files: readonly Shipped[];
  readonly unread: readonly string[];
  readonly names: readonly string[];
}

/** One finding in one file. */
export interface ShippedHit<F> {
  readonly path: string;
  readonly finding: F;
}

/** A real folder, not a link to one: a walk that starts through a link could read outside the build. */
const isRealDir = (path: string) => lstat(path).then((s) => s.isDirectory(), () => false);

/** Why an open finds no file to read: nothing there, a path through a non-folder, a folder, or a link it may not follow. */
const NO_FILE = new Set(['ENOENT', 'ENOTDIR', 'EISDIR', 'ELOOP']);

/**
 * A regular file's text through one handle, or null when there is none at
 * `path` or it is larger than `maxBytes`. Opened without blocking and judged
 * on the handle itself, never by a check before the open: a named pipe would
 * block the read with no end, and one put in the file's place after a check
 * would still be read. `flags` adds open flags (O_NOFOLLOW for a walk).
 * O_NONBLOCK and O_NOFOLLOW are POSIX; where they are missing, so are the
 * pipes and links they guard against.
 */
async function readThroughHandle(path: string, flags: number, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | flags);
  } catch (e) {
    if (NO_FILE.has((e as NodeJS.ErrnoException).code ?? '')) return null;
    throw e;
  }
  try {
    const s = await handle.stat();
    return s.isFile() && s.size <= maxBytes ? await handle.readFile('utf8') : null;
  } finally {
    await handle.close();
  }
}

/** A file's text, or null when it is missing or not a regular file (a named pipe would block the read). */
export function readRegular(path: string): Promise<string | null> {
  return readThroughHandle(path, 0, Number.POSITIVE_INFINITY);
}

/**
 * Every regular text file under `dir`, depth first, paths relative to
 * `base`; null when `dir` is not a real folder. Links are not followed — a
 * Dirent is the link itself, and `dir` itself must not be one — so nothing
 * outside the folder is read.
 */
export async function walkShipped(dir: string, base: string = dir): Promise<ShippedTree | null> {
  if (!(await isRealDir(dir))) return null;
  const files: Shipped[] = [];
  const unread: string[] = [];
  const names: string[] = [];
  const pending = [dir];
  let seen = 0;
  while (pending.length > 0) {
    const at = pending.pop()!;
    const entries = await readdir(at, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
    for (const e of entries) {
      const path = join(at, e.name);
      if (e.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!e.isFile()) continue;
      const rel = relative(base, path).split(sep).join('/');
      if (++seen > MAX_FILES) {
        unread.push(rel);
        continue;
      }
      names.push(rel);
      if (BINARY.has(extname(e.name).toLowerCase())) continue;
      // The entry was a file when listed; read through a handle that is one
      // still — not a link or a pipe put in its place since — or it is unread.
      const text = await readThroughHandle(path, constants.O_NOFOLLOW ?? 0, FILE_MAX_BYTES);
      if (text === null) {
        unread.push(rel);
        continue;
      }
      files.push({ path: rel, text });
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  names.sort();
  return { files, unread, names };
}

/**
 * The shipped files that are byte-for-byte a file an installed package
 * published. Found by name (the hash removed) in `packages` (a project's
 * node_modules), then compared whole. The folder itself may be a link — a
 * project sharing one install, as the gate's sites do — so it is resolved
 * first; links inside it are not followed.
 */
export async function publishedCopies(packages: string, files: readonly Shipped[]): Promise<Set<string>> {
  const out = new Set<string>();
  const wanted = new Map<string, Shipped[]>();
  for (const f of files) {
    const base = f.path.split('/').pop() ?? '';
    if (!HASHED.test(base)) continue;
    const name = base.replace(HASHED, '$1');
    wanted.set(name, [...(wanted.get(name) ?? []), f]);
  }
  if (wanted.size === 0) return out;
  const root = await realpath(packages).catch(() => null);
  if (root === null || !(await isRealDir(root))) return out;
  const pending = [root];
  let seen = 0;
  while (pending.length > 0 && seen < MAX_PACKAGE_ENTRIES) {
    const at = pending.pop()!;
    const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (++seen > MAX_PACKAGE_ENTRIES) break;
      if (e.isDirectory()) pending.push(join(at, e.name));
      else if (e.isFile() && wanted.has(e.name)) {
        const text = await readRegular(join(at, e.name));
        for (const f of wanted.get(e.name) ?? []) if (text === f.text) out.add(f.path);
      }
    }
  }
  return out;
}

/**
 * Every finding `scan` makes in `files`, less the entropy findings in a file
 * an installed package published (looked up in `packages` only for files
 * that have one). `published` is that set of files, for the caller to report.
 */
export async function shippedSecrets<F extends { readonly rule: string }>(
  files: readonly Shipped[],
  packages: string,
  scan: (text: string) => readonly F[],
): Promise<{ readonly hits: readonly ShippedHit<F>[]; readonly published: ReadonlySet<string> }> {
  const found = files.map((f) => ({ f, found: scan(f.text) }));
  const published = await publishedCopies(packages, found.filter((x) => x.found.some((s) => s.rule === 'entropy')).map((x) => x.f));
  const hits = found.flatMap(({ f, found: list }) => list
    .filter((s) => !(s.rule === 'entropy' && published.has(f.path)))
    .map((finding) => ({ path: f.path, finding })));
  return { hits, published };
}

/**
 * Removes a refused build's output folder, so nothing a deploy step could
 * ship is left behind. Only a folder strictly inside `root` is removed: both
 * are resolved through links first, so a link cannot aim the removal
 * elsewhere, and the root itself or anything outside it is refused. Returns
 * null once the folder is gone (or was never written), else why it was left.
 */
export async function removeOutput(root: string, outDir: string): Promise<string | null> {
  let out: string;
  try {
    out = await realpath(outDir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return `${outDir} could not be resolved, so it was left in place`;
  }
  const base = await realpath(root).catch(() => null);
  if (base === null) return `${outDir} was left in place: the project root ${root} could not be resolved`;
  const rel = relative(base, out);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return `${outDir} was left in place: it is not inside the project ${root}`;
  }
  try {
    await rm(out, { recursive: true, force: true });
  } catch (e) {
    return `${outDir} could not be removed (${(e as NodeJS.ErrnoException).code ?? 'error'})`;
  }
  return null;
}
