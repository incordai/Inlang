/**
 * @az module az
 * Purpose: the az binary: build, dev, spec, check, lint, migrate, eject, backend, mcp, explain, doctor, audit.
 * Spec: docs/PRD.md §6.7 · docs/ARCHITECTURE.md §1a
 * Exports: main, build, specOf, wordsFor, parseDotenv, DOTENV_FILES, EXIT
 * Edit guide: filesystem work lives here, never in core; a new command needs USAGE, COMMANDS and a test.
 * Tests: packages/cli/test/cli.test.ts, packages/cli/test/hardening.test.ts
 */

/**
 * The `az` binary.
 *
 * ARCHITECTURE §1a: this is ONE caller of the compiler, not the compiler.
 * Everything filesystem-shaped lives here, because `core` has to run in a
 * browser where none of it exists.
 *
 * PRD §6.7 — actions live in the CLI, never in the `.az` file. The file
 * describes the site; this does things to it.
 */

import {
  readFileSync, readdirSync, writeFileSync, existsSync, realpathSync, statSync,
  openSync, fstatSync, readSync, closeSync,
} from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compile, envMessage, explain, formatDiagnostics, formatExplained, scanEnv, serialiseSpec,
} from '../../core/src/index.ts';
import { emitProject, PathEscapeError, RUNTIME_DIR, safeAssetPath, USER_DIR } from '../../target-web/src/emit.ts';
import { isFromMark } from '../../core/src/emit-contract.ts';
import type { Spec } from '../../core/src/spec.ts';
import { ROWS_RUNTIME_FILES } from '../../target-web/src/data-rows.ts';
import { SvgError } from '../../target-web/src/svg.ts';
import { IconError } from '../../target-web/src/head.ts';
import { MarkdownError } from '../../target-web/src/markdown.ts';
import { AUTH_DIR, GUARD_DIR } from '../../target-web/src/auth.ts';
import { THREE_DIR } from '../../target-web/src/three.ts';
import { backendFiles, SERVER_DIR } from '../../backend/src/emit.ts';
// dev.ts imports `build` from here; the cycle is safe because neither module
// touches the other's exports until a command runs.
import { dev, devLine } from './dev.ts';
import { findNpmCli, serve, DEFAULT_SITE_PORT, type Served } from './serve.ts';
import { lintWords } from './lint.ts';
import { BUNDLED_WORDS, eject, loadWords } from './words.ts';
import { migrate, GRAMMAR_VERSION } from './migrate.ts';
import { initBackendEnv } from './backend-init.ts';
import { lockOption, readLockSteps, runDataPlan, runDataSchema } from './data-schema.ts';
import { writeOutput } from './output.ts';
import { createResizer, imageCacheDir } from './images.ts';
// mcp.ts imports build/wordsFor from here; the cycle is safe for the same
// reason as dev.ts's — nothing is touched until a command runs.
import { runMcp } from './mcp.ts';
// doctor-checks.ts imports compileReader, wordsFor and the .env reader from here; the same.
import { doctor } from './doctor-checks.ts';
import { formatReport, systemProbe } from './doctor.ts';
import { formatFindings } from '../../theme/src/lint.ts';

const MB = 1024 * 1024;
/** A8 and the hero/scene manifests' `maxBytes`: a 3D model's budget. */
const MODEL_BUDGET_BYTES = 5 * MB;
const KB = 1024;
/** gallery-spec §11 and the gallery manifest's image `maxBytes`: one gallery image's budget. */
const GALLERY_IMAGE_BUDGET_BYTES = 500 * KB;

/** Exit codes are meaningful — word-quality-gate §5.2. */
export const EXIT = { ok: 0, missing: 1, config: 2 } as const;

export interface BuildOptions {
  readonly source: string;      // path to the .az file
  readonly outDir: string;
  /** The word set: the bundled words, or `AZ_WORDS`. */
  readonly wordsDir: string;
  /**
   * The project's own words, overriding the set by name — where `az eject`
   * puts a word. Defaults to `words/` beside the source; null for none.
   */
  readonly projectWordsDir?: string | null;
  readonly write?: boolean;
  /**
   * Where resized images are cached (gallery-spec §7 rule 3) — outside the
   * output. Defaults to imageCacheDir(); null builds without resizing, as a
   * build that writes nothing (`az check`) does.
   */
  readonly imageCache?: string | null;
}

export interface BuildOutcome {
  readonly ok: boolean;
  readonly files: { path: string; content: string }[];
  /** Project-relative asset paths, copied to `<out>/public/`. */
  readonly assets: string[];
  readonly report: string;
  readonly exit: number;
}

/**
 * Where each referenced asset really is on disk, or why it cannot be used.
 *
 * The target already refused `..` and absolute paths as STRINGS. That cannot
 * see a symlink: `./assets/x.webp -> /home/me/.ssh/id_ed25519` is a clean
 * string and would be copied into `public/` and deployed. So the real path is
 * resolved and must still sit inside the project directory. Everything is
 * checked before anything is written, so a failed build writes nothing.
 */
function locateAssets(
  projectDir: string, assets: string[], kind: 'asset' | 'component' | 'icon' = 'asset',
): { sources: string[]; problems: string[] } {
  const root = realpathSync(projectDir);
  const sources: string[] = [];
  const problems: string[] = [];
  for (const a of assets) {
    const candidate = resolve(root, a);
    if (!existsSync(candidate)) {
      problems.push(`${kind}: './${a}' does not exist — add the file or fix the path`);
      continue;
    }
    const real = realpathSync(candidate);
    if (real !== root && !real.startsWith(root + sep)) {
      problems.push(`${kind}: './${a}' resolves outside the project — ${kind}s must live inside it`);
      continue;
    }
    if (!statSync(real).isFile()) {
      problems.push(`${kind}: './${a}' is not a file`);
      continue;
    }
    sources.push(real);
  }
  return { sources, problems };
}

/**
 * A project file's text, for the target to inline (an SVG icon, feature-spec
 * §7) — through the same sandbox as copied assets, symlinks followed. Null
 * when the file does not exist; a path that resolves outside the project is
 * refused outright.
 */
function readProjectText(projectDir: string, path: string): string | null {
  const found = locateAssets(projectDir, [path], 'icon');
  if (found.sources.length === 1) return readFileSync(found.sources[0], 'utf8');
  if (!existsSync(resolve(realpathSync(projectDir), path))) return null;
  throw new PathEscapeError(found.problems[0]);
}

/** How much of an image is read for its size: past any EXIF, ICC or XMP a header carries. */
const IMAGE_HEAD_BYTES = 1024 * 1024;

/**
 * The start of a project file, for the target to read an image's size from
 * its header (gallery-spec §7) — the same sandbox as readProjectText, and
 * never more than IMAGE_HEAD_BYTES, however large the file.
 */
function readProjectHead(projectDir: string, path: string): Uint8Array | null {
  const found = locateAssets(projectDir, [path]);
  if (found.sources.length === 1) {
    const fd = openSync(found.sources[0], 'r');
    try {
      const head = Buffer.alloc(Math.min(IMAGE_HEAD_BYTES, fstatSync(fd).size));
      const n = readSync(fd, head, 0, head.length, 0);
      return head.subarray(0, n);
    } finally {
      closeSync(fd);
    }
  }
  if (!existsSync(resolve(realpathSync(projectDir), path))) return null;
  throw new PathEscapeError(found.problems[0]);
}

/**
 * compile()'s reader (the `site icon` check, AZ1421): readProjectHead, with
 * a file that is missing or resolves outside the project read as null —
 * a diagnostic at the icon's line, not a thrown error.
 */
export const compileReader = (source: string) => (path: string): Uint8Array | null => {
  try {
    return readProjectHead(dirname(resolve(source)), path);
  } catch (e) {
    if (e instanceof PathEscapeError) return null;
    throw e;
  }
};

/** The real file of a project path through the asset sandbox, or null — for the resizer. */
function locateImage(projectDir: string, path: string): string | null {
  const found = locateAssets(projectDir, [path]);
  return found.sources.length === 1 ? found.sources[0] : null;
}

const sizeText = (bytes: number) => (bytes >= MB ? `${(bytes / MB).toFixed(1)}MB` : `${Math.round(bytes / KB)}KB`);

/**
 * gallery-spec §11: a gallery image over 500KB is a warning — every visitor
 * may download the original (it is the srcset's fallback and, up to 1800px,
 * its widest candidate). Only the CLI has the file's size, so it lives here.
 */
function galleryOverBudget(spec: Spec, projectDir: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const block of [...spec.site.inherited, ...spec.pages.flatMap((p) => p.blocks)]) {
    if (block.word !== 'gallery') continue;
    for (const image of block.children) {
      const raw = image.word === 'image' ? image.args[0]?.value : undefined;
      if (!raw || isFromMark(raw)) continue;
      const path = safeAssetPath(raw);
      if (seen.has(path)) continue;
      seen.add(path);
      const file = locateImage(projectDir, path);
      const bytes = file === null ? 0 : statSync(file).size;
      if (bytes > GALLERY_IMAGE_BUDGET_BYTES) {
        out.push(`gallery: '${basename(path)}' is ${sizeText(bytes)} — export it under ${GALLERY_IMAGE_BUDGET_BYTES / KB}KB or the gallery blocks the page`);
      }
    }
  }
  return out;
}

/**
 * The words one build compiles with: the set, plus the project's own. With
 * `code: false` the project's emitters are not loaded — manifests only, for a
 * caller that must compile without running the project's code.
 */
export const wordsFor = (options: Omit<BuildOptions, 'outDir'>, code = true) => loadWords(options.wordsDir,
  options.projectWordsDir === undefined ? resolve(dirname(options.source), 'words') : options.projectWordsDir,
  { code });

export function build(options: BuildOptions): BuildOutcome {
  const src = readFileSync(options.source, 'utf8');
  const words = wordsFor(options);
  const result = compile(src, { manifests: words.manifests, lock: lockOption(options.source), readBytes: compileReader(options.source) });

  const report = result.diagnostics.length
    ? formatDiagnostics(result.diagnostics, options.source)
    : '';

  // Errors block; warnings never do — CONVENTIONS §5.
  if (!result.ok || !result.spec) {
    return { ok: false, files: [], assets: [], report, exit: EXIT.missing };
  }

  let project;
  const spec = result.spec;
  const projectDir = dirname(resolve(options.source));
  // gallery-spec §7 rule 3: images resized at build, unless nothing is written.
  const resizer = options.write === false || options.imageCache === null
    ? undefined
    : createResizer(options.imageCache ?? imageCacheDir(), (path) => locateImage(projectDir, path));
  const emitted = () => emitProject(spec, {
    emitters: words.emitters,
    readText: (path) => readProjectText(projectDir, path),
    readBytes: (path) => readProjectHead(projectDir, path),
    resize: resizer?.resize,
    touchIcon: resizer?.touchIcon,
  });
  try {
    project = emitted();
    // A miss is encoded now; an image that came out with nothing is emitted
    // again without its srcset.
    if (resizer?.encode()) {
      resizer.restart();
      project = emitted();
    }
  } catch (e) {
    if (e instanceof PathEscapeError || e instanceof SvgError || e instanceof MarkdownError || e instanceof IconError) {
      return { ok: false, files: [], assets: [], report: `${report}\n${e.message}`.trim(), exit: EXIT.missing };
    }
    throw e;
  }
  const { assets, modules } = project;
  const tables = result.spec.site.data;
  // The behaviour runtime ships with every site, copied verbatim from the
  // overlay package into RUNTIME_DIR — part of the output, so it is written
  // and checked like any emitted file. The build guard's scanner ships with
  // every site too; the auth runtime only with a site that uses auth.
  const files = [
    ...project.files,
    // Its rows module only with a `from` block (data-spec §10.3).
    ...copied('../../overlay/src/runtime/', RUNTIME_DIR, (f) => project.rows || !ROWS_RUNTIME_FILES.includes(f)),
    ...copied('../../core/src/', GUARD_DIR, (f) => f === 'secrets.ts'),
    ...(project.auth ? copied('../../auth-runtime/src/runtime/', AUTH_DIR) : []),
    // The 3D runtime only with a site whose pages declare a 3D view (scene-spec §5).
    ...(project.three ? copied('../../scene-runtime/src/runtime/', THREE_DIR) : []),
    // The built-in backend only with a site that declares one (backend-spec §8);
    // its data modules only with a site that declares tables (data-spec §6),
    // whose lock compile() has already checked against the file.
    ...(result.spec.site.backend
      ? [...backendFiles(result.spec.site.name, result.spec.site.backend,
          tables ? { tables, steps: readLockSteps(options.source) } : undefined),
         ...copied('../../backend/src/server/', `${SERVER_DIR}/src`, (f) => tables !== undefined || !f.startsWith('data-'))]
      : []),
  ].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  // The author's components go through the same sandbox as assets: they must
  // exist and really be inside the project, symlinks followed.
  const located = locateAssets(projectDir, assets);
  const components = locateAssets(projectDir, modules, 'component');
  // auth-spec §4 rule 1, before anything is written: the environment this
  // project's build will inline must hold no service key. The generated
  // build checks again (its own env, then the bundle) — this is the early,
  // loud copy of the same unsuppressible rule.
  // The generated project is Vite's root, so its .env files are the ones in
  // the OUTPUT folder; a .env beside the source is never read by the build.
  const secrets = scanEnv({ ...dotenv(resolve(options.outDir)), ...process.env }).map(envMessage);
  const problems = [...located.problems, ...components.problems, ...secrets];
  if (problems.length > 0) {
    return {
      ok: false, files: [], assets: [],
      report: [report, ...problems].filter(Boolean).join('\n'),
      exit: EXIT.missing,
    };
  }

  if (options.write !== false) {
    // output.ts: nothing outside the folder, nothing through a link, no file
    // az did not generate overwritten, stale generated files removed. An
    // unchanged file is not rewritten: `az dev` rebuilds on every save, and
    // touching an identical vite.config.ts restarts the dev server instead of
    // hot-updating the one file that changed.
    const written = writeOutput(options.outDir, [
      // Newline style is fixed, not inherited from the platform — otherwise
      // the same source produces different bytes on Windows and Linux and the
      // determinism claim dies quietly (CONVENTIONS §6).
      ...files.map((f) => ({ path: f.path, content: f.content.replace(/\r\n/g, '\n') })),
      // Vite serves `public/` at the site root and copies it into the build
      // untouched, which is what makes the page's `/assets/...` URLs resolve.
      ...assets.map((a, i) => ({ path: `public/${a}`, copyFrom: located.sources[i] })),
      // The generated App imports each one from here (target-web USER_DIR).
      ...modules.map((m, i) => ({ path: `${USER_DIR}/${m}`, copyFrom: components.sources[i] })),
      // The resized copies the pages' srcsets name, from the cache.
      ...(resizer?.files() ?? []).map((f) => ({ path: `public/${f.path}`, copyFrom: f.copyFrom })),
    ]);
    if (!written.ok) {
      return { ok: false, files: [], assets: [], report: [report, ...written.problems].filter(Boolean).join('\n'), exit: EXIT.config };
    }
  }

  // hero-spec §11 / scene-spec §11: a model over the budget is a warning —
  // the build still stands, but the page will stall on a phone. Only the CLI
  // has the file's bytes, so the check lives here.
  const heavy = located.sources
    .filter((source) => source.toLowerCase().endsWith('.glb') && statSync(source).size > MODEL_BUDGET_BYTES)
    .map((source) => `warning: model '${basename(source)}' is ${(statSync(source).size / MB).toFixed(1)}MB — Draco-compress it or the page will stall on mobile (budget ${MODEL_BUDGET_BYTES / MB}MB)`);
  const read = [...project.warnings, ...(resizer?.warnings ?? []), ...galleryOverBudget(spec, projectDir)]
    .map((w) => `warning: ${w}`);
  return { ok: true, files, assets, report: [report, ...read, ...heavy].filter(Boolean).join('\n'), exit: EXIT.ok };
}

/** A package directory's modules, copied verbatim into the generated project at `to`. */
function copied(from: string, to: string, keep: (file: string) => boolean = () => true): { path: string; content: string }[] {
  const dir = fileURLToPath(new URL(from, import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && keep(f))
    .sort()
    .map((f) => ({ path: `${to}/${f}`, content: readFileSync(join(dir, f), 'utf8') }));
}

/**
 * The `.env` files Vite would load for a production build, merged in its
 * order (later wins). Only read to check them — values never leave this
 * process.
 */
function dotenv(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of DOTENV_FILES) {
    const file = join(dir, name);
    if (existsSync(file)) parseDotenv(readFileSync(file, 'utf8'), out);
  }
  return out;
}

/** The files dotenv() reads, in the order a later one wins (az doctor reads the same). */
export const DOTENV_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'] as const;

/** One `.env` file's lines into `out`, as dotenv() reads them. */
export function parseDotenv(text: string, out: Record<string, string>): void {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/**
 * The Spec as JSON, or null when the file has errors — with the report either
 * way. A Spec is always BUILT (so later stages can report), but a broken
 * file's Spec is not the site the author wrote and is never printed.
 */
export function specOf(options: Omit<BuildOptions, 'outDir'>): { json: string | null; report: string } {
  const src = readFileSync(options.source, 'utf8');
  const r = compile(src, { manifests: wordsFor(options).manifests, lock: lockOption(options.source), readBytes: compileReader(options.source) });
  const report = r.diagnostics.length ? formatDiagnostics(r.diagnostics, options.source) : '';
  return { json: r.ok && r.spec ? serialiseSpec(r.spec) : null, report };
}

/* ------------------------------------------------------------------ */

const USAGE = `az — words to a website

  az build <file.az> [--out dir]   compile to a runnable project
  az dev   <file.az> [--port N] [--open] [--no-serve]
                                   build, serve and reload on every save;
                                   a site with a backend runs it locally too
  az spec  <file.az>               print the Spec as JSON
  az check <file.az>               report diagnostics only, write nothing
  az lint  [words-dir]             theme-token check of every word pack
  az migrate <file.az>             upgrade the file to this grammar version
  az eject <word> [--dir project]  take ownership of a word's source — one-way
  az backend init <server-dir>     write the backend's .env with a fresh secret
  az backend plan <file.az>        show the data schema step the file needs
  az backend schema <file.az> [--rename a=b] [--drop x] [--unique t.f] [--expose t]
                                   record that step in <file>.data.json
  az mcp   [--root dir]            serve these tools to an AI agent (MCP, stdio)
  az explain <term...>             one line per term: az explain hero center
  az doctor [file.az] [--out dir] [--json]
                                   check this machine and project; changes nothing
  az audit [--out dir] [--online] [--json]
                                   check a build's output; changes nothing
`;

const COMMANDS = new Set(['build', 'dev', 'spec', 'check', 'lint', 'migrate', 'eject', 'backend', 'mcp', 'explain', 'doctor', 'audit']);

/**
 * `az backend init <server-dir>` — write `.env` beside a generated server's
 * `az.config.json` (backend-spec §4): every key its setup reads, a fresh
 * random session secret, owner-only permissions. Refuses to overwrite: a
 * second init would silently rotate the secret and sign everyone out.
 */
function runBackend(sub: string, rest: string[]): number {
  const io = { out: (s: string) => process.stdout.write(s), err: (s: string) => process.stderr.write(s) };
  if ((sub === 'plan' || sub === 'schema') && rest[0]) {
    if (!existsSync(rest[0])) {
      process.stderr.write(`az: ${rest[0]} does not exist — try: az backend ${sub} site.az\n`);
      return EXIT.missing;
    }
    // Manifests only: planning a schema never runs the project's word code.
    const manifests = wordsFor({ source: rest[0], wordsDir: process.env.AZ_WORDS ?? BUNDLED_WORDS }, false).manifests;
    return sub === 'plan'
      ? runDataPlan(rest[0], manifests, io)
      : runDataSchema(rest[0], manifests, rest.slice(1), io);
  }
  if (sub !== 'init' || !rest[0]) {
    process.stderr.write('az: try: az backend init <server-dir>  (the server/ folder of a build), az backend plan site.az or az backend schema site.az\n');
    return EXIT.config;
  }
  const r = initBackendEnv(resolve(rest[0]));
  if (!r.ok) {
    process.stderr.write(`az: ${r.message}\n`);
    return r.kind === 'missing' ? EXIT.missing : EXIT.config;
  }
  process.stdout.write(`az: wrote ${r.path} (owner read/write only) with a fresh AZ_SESSION_SECRET — fill in the empty values\n`);
  return EXIT.ok;
}

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** `az lint`: findings are errors (exit 1), and a clean run says how much it checked. */
/**
 * `az explain <term...>`: one ≤60-character line per term, from the manifests
 * only — no project code runs. Unknown terms exit 1 with a suggestion.
 */
function runExplain(terms: string[]): number {
  if (terms.length === 0) {
    process.stderr.write('az: explain needs a term — try: az explain hero center\n');
    return EXIT.config;
  }
  const words = loadWords(process.env.AZ_WORDS ?? BUNDLED_WORDS, resolve('words'), { code: false });
  const result = explain(terms, words.manifests);
  process.stdout.write(formatExplained(result) + '\n');
  return result.unknown.length > 0 ? EXIT.missing : EXIT.ok;
}

/**
 * `az doctor [file.az] [--out dir] [--json]` — word-quality-gate §5: detect
 * everything, install nothing. Without a file, the one .az file in this
 * folder is checked; with none or several, only the machine is. Exit 0 when
 * nothing failed (warnings never fail), 1 when something did, 2 for a usage
 * error. The report is written when every check has answered or hit its
 * deadline, so the exit code is set then.
 */
function runDoctor(args: string[]): number {
  let json = false;
  let out = '.az-build';
  let file: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--out' && args[i + 1] && !args[i + 1].startsWith('--')) out = args[++i];
    else if (!a.startsWith('--') && a.endsWith('.az') && file === null) file = a;
    else {
      process.stderr.write(`az: doctor: unexpected '${a}' — try: az doctor site.az [--out dir] [--json]\n`);
      return EXIT.config;
    }
  }
  if (file !== null && !(existsSync(file) && statSync(file).isFile())) {
    process.stderr.write(`az: doctor: ${file} does not exist — try: az doctor site.az\n`);
    return EXIT.config;
  }
  if (file === null) {
    const here = readdirSync(process.cwd(), { withFileTypes: true }).filter((d) => d.isFile() && d.name.endsWith('.az'));
    if (here.length === 1) file = here[0].name;
  }
  void doctor({
    source: file === null ? null : resolve(file),
    outDir: resolve(out),
    cwd: process.cwd(),
    wordsDir: process.env.AZ_WORDS ?? BUNDLED_WORDS,
    probe: systemProbe(findNpmCli),
    projectModules: true,
  }).then((r) => {
    process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : formatReport(r));
    process.exitCode = r.exit;
  }, (e: unknown) => {
    process.stderr.write(`az: doctor: ${(e as Error).message}\n`);
    process.exitCode = EXIT.config;
  });
  return EXIT.ok;
}

/**
 * `az audit [--out dir] [--online] [--json]` — word-quality-gate §5: the
 * built output, checked. Reads only; the advisory query is the one network
 * call and runs only with --online. Exit 0 when nothing failed, 1 when
 * something did, 2 for a usage error; set when every check has answered.
 */
function runAudit(args: string[]): number {
  let json = false;
  let online = false;
  let out = '.az-build';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--online') online = true;
    else if (a === '--out' && args[i + 1] && !args[i + 1].startsWith('--')) out = args[++i];
    else {
      const hint = a.endsWith('.az') ? ' — audit reads a build, not the .az file' : '';
      process.stderr.write(`az: audit: unexpected '${a}'${hint} — try: az audit [--out dir] [--online] [--json]\n`);
      return EXIT.config;
    }
  }
  // Loaded only for this command: every az build starts without it (m1-exit's cold budget).
  void import('./audit.ts').then(({ audit }) => audit({ outDir: resolve(out), cwd: process.cwd(), probe: systemProbe(findNpmCli), online })).then((r) => {
    process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : formatReport(r, 'az audit'));
    process.exitCode = r.exit;
  }, (e: unknown) => {
    process.stderr.write(`az: audit: ${(e as Error).message}\n`);
    process.exitCode = EXIT.config;
  });
  return EXIT.ok;
}

function runLint(wordsDir: string): number {
  if (!existsSync(wordsDir) || !statSync(wordsDir).isDirectory()) {
    process.stderr.write(`az: no words directory at '${wordsDir}' — try: az lint path/to/words\n`);
    return EXIT.config;
  }
  const report = lintWords(wordsDir);
  if (report.words.length === 0) {
    process.stderr.write(`az: no word packs in '${wordsDir}' — a word pack is a folder with a word.json\n`);
    return EXIT.missing;
  }
  if (report.findings.length > 0) {
    process.stderr.write(formatFindings(report.findings) + '\n');
    process.stderr.write(`az: ${count(report.findings.length, 'theme violation')} in ${count(report.words.length, 'word')}\n`);
    return EXIT.missing;
  }
  process.stdout.write(`az: ${count(report.words.length, 'word')}, no theme violations\n`);
  return EXIT.ok;
}

/** `az eject`: loud, because it is the one command that cannot be undone by az. */
function runEject(word: string, projectDir: string | undefined): number {
  if (!projectDir) {
    process.stderr.write('az: --dir needs a directory — try: az eject hero --dir my-site\n');
    return EXIT.config;
  }
  const r = eject(word, resolve(projectDir), process.env.AZ_WORDS ?? BUNDLED_WORDS);
  if (!r.ok) {
    process.stderr.write(`az: eject: ${r.message}\n`);
    return EXIT.config;
  }
  const where = `words/${word}`;
  process.stdout.write(
    `az: ejected ${word} to ${where}\n\n`
    + `  This is ONE-WAY. az will never update, merge or regenerate ${where},\n`
    + `  and fixes to the bundled ${word} will not reach this project.\n`
    + `  It is yours: edit it freely — every build of this project uses it.\n`
    + `  Restart \`az dev\` after editing it. Deleting ${where} returns the\n`
    + `  project to the managed word, and your edits go with it.\n\n`
    + r.files.map((f) => `  wrote ${f}\n`).join(''));
  return EXIT.ok;
}

/** `az migrate`: rewrites the file only when a migration step changed it. */
function runMigrate(file: string): number {
  if (!existsSync(file)) {
    process.stderr.write(`az: ${file} does not exist — try: az migrate site.az\n`);
    return EXIT.missing;
  }
  const result = migrate(readFileSync(file, 'utf8'));
  if (!result.ok) {
    process.stderr.write(`az: ${file}: ${result.message}\n`);
    return EXIT.missing;
  }
  if (!result.changed) {
    process.stdout.write(`az: ${file} is already az ${GRAMMAR_VERSION} — nothing to migrate\n`);
    return EXIT.ok;
  }
  writeFileSync(file, result.source, 'utf8');
  process.stdout.write(`az: migrated ${file} from az ${result.from} to az ${GRAMMAR_VERSION}\n`);
  return EXIT.ok;
}

/**
 * `az dev`: compile on every save and, unless `--no-serve`, serve the result
 * — the site on Vite's dev server, and for a site that declares `backend`,
 * the backend with its development profile (serve.ts, dev-backend.ts).
 * Serving starts after the first build that succeeds; Ctrl-C stops it all.
 */
function runDev(file: string, outDir: string, wordsDir: string, rest: string[]): number {
  const print = (line: string) => process.stdout.write(`${line}\n`);
  const portFlag = rest.indexOf('--port');
  const sitePort = portFlag >= 0 ? Number(rest[portFlag + 1]) : DEFAULT_SITE_PORT;
  if (!Number.isInteger(sitePort) || sitePort < 1 || sitePort > 65535) {
    process.stderr.write('az: --port needs a port number, e.g. --port 5173\n');
    return EXIT.config;
  }
  const serving = !rest.includes('--no-serve');
  /** The serving start, once begun — awaited on Ctrl-C so no child outlives us. */
  let started: Promise<Served | null> | null = null;
  let packageHash: string | null = null;
  let dataAtStart: string | undefined;

  const handle = dev({
    source: file,
    outDir,
    wordsDir,
    onResult: (outcome, ms) => {
      const stream = outcome.ok ? process.stdout : process.stderr;
      stream.write(devLine(outcome, ms) + '\n');
      if (!outcome.ok || !serving) return;
      const pkg = outcome.files.find((f) => f.path === 'package.json')?.content ?? '';
      if (packageHash !== null && pkg !== packageHash) {
        print('az dev: the site\'s dependencies changed — restart az dev to install them');
      }
      packageHash ??= pkg;
      // The dev backend applies the tables' steps once, at start.
      const dataJson = outcome.files.find((f) => f.path === 'server/data.json')?.content;
      if (started && dataJson !== dataAtStart) print('az dev: the data tables changed — restart az dev to apply them');
      if (started) return;
      dataAtStart = dataJson;
      const config = outcome.files.find((f) => f.path === 'server/az.config.json');
      const backend = config
        ? { siteName: (JSON.parse(config.content) as { siteName: string }).siteName, ...(dataJson !== undefined ? { data: dataJson } : {}) }
        : null;
      started = serve({ source: file, outDir, sitePort, open: rest.includes('--open'), backend, print })
        .catch((e: unknown) => {
          process.stderr.write(`az dev: ${(e as Error).message}\n`);
          handle.close();
          process.exitCode = EXIT.config;
          return null;
        });
    },
  });
  process.once('SIGINT', () => {
    handle.close();
    void (started ?? Promise.resolve(null))
      .then((s) => s?.close())
      .then(() => process.exit(process.exitCode ?? EXIT.ok));
  });
  return EXIT.ok;
}

export function main(argv: string[]): number {
  const [cmd, file, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE);
    return EXIT.ok;
  }
  // An unknown command must not fall through to `check` — a typo would then
  // report "no problems found" and do nothing, which reads as success.
  if (!COMMANDS.has(cmd)) {
    process.stderr.write(`az: unknown command "${cmd}"\n\n${USAGE}`);
    return EXIT.config;
  }
  if (cmd === 'lint') return runLint(file ?? process.env.AZ_WORDS ?? 'words');
  if (cmd === 'explain') return runExplain(argv.slice(1));
  if (cmd === 'doctor') return runDoctor(argv.slice(1));
  if (cmd === 'audit') return runAudit(argv.slice(1));
  if (cmd === 'mcp') {
    // stdin keeps the process alive; the server ends when the client closes it.
    const rootFlag = argv.indexOf('--root');
    const root = rootFlag >= 0 && argv[rootFlag + 1] ? argv[rootFlag + 1] : process.cwd();
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      process.stderr.write(`az: mcp: '${root}' is not a folder — try: az mcp --root path/to/project\n`);
      return EXIT.config;
    }
    void runMcp(root);
    return EXIT.ok;
  }
  if (!file) {
    process.stderr.write(`az: ${cmd} needs a file — try: az ${cmd} site.az\n`);
    return EXIT.config;
  }
  if (cmd === 'migrate') return runMigrate(file);
  if (cmd === 'backend') return runBackend(file, rest);
  if (cmd === 'eject') {
    const dirFlag = rest.indexOf('--dir');
    return runEject(file, dirFlag >= 0 ? rest[dirFlag + 1] : process.cwd());
  }

  const outFlag = rest.indexOf('--out');
  if (outFlag >= 0 && !rest[outFlag + 1]) {
    process.stderr.write(`az: --out needs a folder — try: az ${cmd} ${file} --out site-build\n`);
    return EXIT.config;
  }
  const outDir = outFlag >= 0 ? rest[outFlag + 1] : '.az-build';
  // The bundled words (or AZ_WORDS); the project's own `words/` beside the
  // file overrides them by name inside build().
  const wordsDir = process.env.AZ_WORDS ?? BUNDLED_WORDS;

  try {
    if (cmd === 'spec') {
      const { json, report } = specOf({ source: file, wordsDir });
      if (report) process.stderr.write(report + '\n');
      if (!json) return EXIT.missing;
      process.stdout.write(json);
      return EXIT.ok;
    }

    if (cmd === 'dev') {
      // Checked up front: a watcher started on a missing file kept the
      // process alive after the error, hanging `az dev typo.az`.
      if (!existsSync(file)) {
        process.stderr.write(`az: ${file} does not exist — try: az dev site.az\n`);
        return EXIT.missing;
      }
      return runDev(file, outDir, wordsDir, rest);
    }

    const outcome = build({ source: file, outDir, wordsDir, write: cmd === 'build' });
    if (outcome.report) process.stderr.write(outcome.report + '\n');
    if (!outcome.ok) return outcome.exit;
    if (cmd === 'build') {
      process.stdout.write(`az: wrote ${outcome.files.length} files to ${outDir}\n`);
    } else {
      process.stdout.write('az: no problems found\n');
    }
    return EXIT.ok;
  } catch (e) {
    process.stderr.write(`az: ${(e as Error).message}\n`);
    return EXIT.config;
  }
}
