/**
 * @az module az
 * Purpose: the az binary: build, dev, spec, check, add, lint, migrate, eject, backend, mcp, explain, palette, prompt, doctor, audit.
 * Spec: docs/PRD.md §6.7 · docs/ARCHITECTURE.md §1a
 * Exports: main, build, specOf, wordsFor, promptInput, parseDotenv, DOTENV_FILES, EXIT
 * Edit guide: filesystem work lives here, never in core; a new command needs USAGE, COMMANDS and a test; a module only it needs is imported through later().
 * Tests: packages/cli/test/cli.test.ts, packages/cli/test/hardening.test.ts, packages/cli/test/prompt-cli.test.ts, packages/cli/test/startup-imports.test.ts
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
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  compile, envMessage, explain, formatDiagnostics, formatExplained, scanEnv, serialiseSpec,
} from '../../core/src/index.ts';
import { emitProject, PathEscapeError, RUNTIME_DIR, safeAssetPath, USER_DIR } from '../../target-web/src/emit.ts';
import type { ByteSource } from '../../target-web/src/image-size.ts';
import { isFromMark } from '../../core/src/emit-contract.ts';
import { compilePreview } from '../../core/src/preview.ts';
import { bannerHtml, withBanner } from './preview-banner.ts';
import type { Spec } from '../../core/src/spec.ts';
import { ROWS_RUNTIME_FILES } from '../../target-web/src/data-rows.ts';
import { CHAT_RUNTIME_FILES, MAP_RUNTIME_FILES } from '../../target-web/src/chat.ts';
import { SvgError } from '../../target-web/src/svg.ts';
import { IconError } from '../../target-web/src/head.ts';
import { MarkdownError, markdownText } from '../../target-web/src/markdown.ts';
import { AUTH_DIR, BACKEND_URL_FILES, GUARD_DIR } from '../../target-web/src/auth.ts';
import { THREE_DIR } from '../../target-web/src/three.ts';
import { backendFiles, BASEMAP_SOURCE, SERVER_DIR, SERVER_PACKAGES } from '../../backend/src/emit.ts';
import { BUNDLED_WORLD } from '../../backend/src/server/env.ts';
import { CONTEXT_MAX, chatBackend, checkPreset, type BackendChat } from '../../backend/src/chat-context.ts';
import type { Served } from './serve.ts';
import { BUNDLED_WORDS, eject, loadWords, wordExamples } from './words.ts';
import { migrate, GRAMMAR_VERSION } from './migrate.ts';
import { initBackendEnv } from './backend-init.ts';
import { lockOption, readLockSteps, runDataPlan, runDataSchema } from './data-schema.ts';
import { writeOutput } from './output.ts';
import { createResizer, imageCacheDir } from './images.ts';
import type { PromptInput } from '../../core/src/prompt.ts';
// A module only some commands use — az dev's watcher and servers, mcp,
// doctor, audit, lint, palette, prompt — is imported by the command when it
// runs (see `later`), never here: `az build` and `az check` start without
// it (m1-exit's cold CPU budget; startup-imports.test.ts holds the line).
// dev.ts, mcp.ts and doctor-checks.ts import from this module; by the time
// a command loads them, this module has finished loading.

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
  /**
   * `az dev` only (docs/partial-preview.md): a file that fails the strict
   * compile is built from its longest valid prefix of whole blocks, with the
   * "still writing" banner on every page. Every other caller leaves it unset.
   */
  readonly preview?: boolean;
  /**
   * The file's text when the caller holds an edit not yet written (`az add
   * chat` checks it as `az check` would before writing a byte); read from
   * `source` otherwise. Everything else — the lock, assets, words — is still
   * found beside `source`.
   */
  readonly sourceText?: string;
}

export interface BuildOutcome {
  readonly ok: boolean;
  readonly files: { path: string; content: string }[];
  /** Project-relative asset paths, copied to `<out>/public/`. */
  readonly assets: string[];
  readonly report: string;
  readonly exit: number;
  /**
   * Set when the files are a preview of a file that does not compile
   * (BuildOptions.preview): `ok` stays false, `report` is the whole file's,
   * and the files hold the blocks before `cutLine`.
   */
  readonly preview?: { readonly cutLine: number; readonly errors: number };
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

/**
 * What the chat server is told (chat-block-spec §8.1) for `spec`, whose
 * file is in `projectDir`: az build writes it as server/chat/context.json,
 * and az doctor judges AZ1257 by it — one builder, so the two never disagree.
 * A `text` body kept in a file is read too, as the plain text of its
 * markdown, through the same sandbox as the page (a path outside the project
 * throws PathEscapeError, a body that is not markdown MarkdownError).
 */
export function chatContextFor(spec: Spec, projectDir: string): BackendChat | undefined {
  return chatBackend(spec, {
    bodyText: (path) => {
      const source = readProjectText(projectDir, safeAssetPath(path));
      return source === null ? null : markdownText(source);
    },
  });
}

/** How much of a file readProjectHead reads: an icon's header, an SVG's root. */
const IMAGE_HEAD_BYTES = 1024 * 1024;

/**
 * The start of a project file, for compile()'s icon check and the target's
 * icon type (an image's size goes through openProjectImage) — the same
 * sandbox as readProjectText, and never more than IMAGE_HEAD_BYTES, however
 * large the file.
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
 * A project file opened for the target to read an image's size anywhere in
 * it (gallery-spec §7 rule 1: a JPEG's frame header may lie megabytes in,
 * behind EXIF and XMP) — the same sandbox as readProjectHead, one file
 * descriptor, positioned reads only; the target closes it. How much it
 * reads is the target's bound (image-size.ts MAX_READ_BYTES).
 */
function openProjectImage(projectDir: string, path: string): ByteSource | null {
  const found = locateAssets(projectDir, [path]);
  if (found.sources.length === 1) {
    const fd = openSync(found.sources[0], 'r');
    let size: number;
    try {
      size = fstatSync(fd).size;
    } catch (e) {
      closeSync(fd);
      throw e;
    }
    return {
      size,
      read: (offset, length) => {
        const into = Buffer.alloc(length);
        return into.subarray(0, readSync(fd, into, 0, length, offset));
      },
      close: () => closeSync(fd),
    };
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
  const src = options.sourceText ?? readFileSync(options.source, 'utf8');
  const words = wordsFor(options);
  // A chat's answer presets are judged by the chat server's own parser (chat-block-spec §19.16, AZ1277).
  const compileOptions = { manifests: words.manifests, lock: lockOption(options.source), readBytes: compileReader(options.source), checkAnswer: checkPreset };
  const { strict, preview } = options.preview
    ? compilePreview(src, compileOptions)
    : { strict: compile(src, compileOptions), preview: null };
  const result = preview?.result ?? strict;

  const report = strict.diagnostics.length
    ? formatDiagnostics(strict.diagnostics, options.source)
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
    openImage: (path) => openProjectImage(projectDir, path),
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
  // What the chat server is told (chat-block-spec §8.1), only for a site with a chat panel and a backend.
  const chat = project.chat && result.spec.site.backend ? chatContextFor(result.spec, projectDir) : undefined;
  // The behaviour runtime ships with every site, copied verbatim from the
  // overlay package into RUNTIME_DIR — part of the output, so it is written
  // and checked like any emitted file. The build guard's scanner and the
  // page policy ship with every site too; the auth runtime only with a site
  // that uses auth.
  const generated = [
    ...project.files,
    // Its rows module only with a `from` block (data-spec §10.3), its chat module only with a chat panel, its map
    // modules only with a chat that shows maps (chat-block-spec §21.4). A file both lists name (rows-logic.ts: a row
    // image's srcset, chat-block-spec §20.6) ships with either.
    ...copied('../../overlay/src/runtime/', RUNTIME_DIR, (f) => (project.rows && ROWS_RUNTIME_FILES.includes(f))
      || (project.chat && CHAT_RUNTIME_FILES.includes(f))
      || (project.map && MAP_RUNTIME_FILES.includes(f))
      || (!ROWS_RUNTIME_FILES.includes(f) && !CHAT_RUNTIME_FILES.includes(f) && !MAP_RUNTIME_FILES.includes(f))),
    ...copied('../../core/src/', GUARD_DIR, (f) => f === 'secrets.ts'),
    // And the walk that reads back what the build wrote (az audit's too).
    ...copied('./', GUARD_DIR, (f) => f === 'shipped.ts'),
    // And the page policy the build gives every page (word-quality-gate §2 B), with the page scanner it reads them by
    // and the named character reference table the scanner decodes attribute values with; and the head order
    // the bundler's own tags are put in (stylesheets before scripts), which reads pages with the same scanner.
    ...copied('../../target-web/src/', GUARD_DIR, (f) => f === 'csp.ts' || f === 'html-scan.ts' || f === 'named-references.ts' || f === 'head-order.ts'),
    ...(project.auth ? copied('../../auth-runtime/src/runtime/', AUTH_DIR) : []),
    // A chat on a backend without accounts: only the backend address check the build guard imports (§19.15).
    ...(project.backendUrlCheck ? copied('../../auth-runtime/src/runtime/', AUTH_DIR, (f) => BACKEND_URL_FILES.includes(f)) : []),
    // The 3D runtime only with a site whose pages declare a 3D view (scene-spec §5).
    ...(project.three ? copied('../../scene-runtime/src/runtime/', THREE_DIR) : []),
    // The built-in backend only with a site that declares one (backend-spec §8);
    // its data modules only with a site that declares tables (data-spec §6),
    // whose lock compile() has already checked against the file.
    // Its chat modules, prompt and context only with a chat panel (chat-block-spec §4.4).
    ...(result.spec.site.backend
      ? [...backendFiles(result.spec.site.name, result.spec.site.backend,
          tables ? { tables, steps: readLockSteps(options.source) } : undefined, chat),
         ...copied('../../backend/src/server/', `${SERVER_DIR}/src`, (f) => (tables !== undefined || !f.startsWith('data-'))
           && (chat !== undefined || !f.startsWith('chat'))
           // A chat's figures and the rows it knows read the tables (chat-block-spec §20.5, §8.2): with both only.
           && ((f !== 'chat-query.ts' && f !== 'chat-knows.ts') || (chat !== undefined && tables !== undefined))),
         // The chat packages it imports by alias, each whole into server/src/<name>/ — without a chat, only what every server reads.
         ...SERVER_PACKAGES.flatMap((p) => copied(`../../${p.name}/src/`, `${SERVER_DIR}/src/${p.name}`, (f) => chat !== undefined || p.withoutChat.includes(f)))]
      : []),
  ].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  // A preview says so on every page, with the whole file's problems.
  const files = preview
    ? withBanner(generated, bannerHtml(strict.diagnostics, basename(options.source), preview.cutLine))
    : generated;

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
      // A chat that shows maps: the default world basemap, drawn when the server's AZ_MAP_WORLD is unset (chat-block-spec §19.15).
      ...(chat?.map ? [{ path: `${SERVER_DIR}/${BUNDLED_WORLD}`, copyFrom: BASEMAP_SOURCE }] : []),
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
  // chat-block-spec §8.1: a page that would push the site context past its cap is left out whole, and said (AZ1257).
  const leftOut = (chat?.omitted ?? []).map((route) => `AZ1257 chat: the site context is over ${CONTEXT_MAX} characters — ${route} is left out; shorten pages or move chat to fewer`);
  const read = [...project.warnings, ...(resizer?.warnings ?? []), ...galleryOverBudget(spec, projectDir), ...leftOut]
    .map((w) => `warning: ${w}`);
  const full = [report, ...read, ...heavy].filter(Boolean).join('\n');
  if (preview) {
    const errors = strict.diagnostics.filter((d) => d.severity === 'error').length;
    return { ok: false, files, assets, report: full, exit: EXIT.missing, preview: { cutLine: preview.cutLine, errors } };
  }
  return { ok: true, files, assets, report: full, exit: EXIT.ok };
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
  const r = compile(src, { manifests: wordsFor(options).manifests, lock: lockOption(options.source), readBytes: compileReader(options.source), checkAnswer: checkPreset });
  const report = r.diagnostics.length ? formatDiagnostics(r.diagnostics, options.source) : '';
  return { json: r.ok && r.spec ? serialiseSpec(r.spec) : null, report };
}

/* ------------------------------------------------------------------ */

const USAGE = `az — Incord Intelligent Language (inlang): words to a website

  az build <file.az> [--out dir]   compile to a runnable project
  az dev   <file.az> [--port N] [--open] [--no-serve]
                                   build, serve and reload on every save;
                                   a site with a backend runs it locally too
  az spec  <file.az>               print the Spec as JSON
  az check <file.az>               report diagnostics only, write nothing
  az add chat <file.az> [--page /route | --float] [--show all|<word,…>]
                                   add a working chat in place: the backend
                                   lines, a chat with a greeting and suggested
                                   questions, the model keys for az dev;
                                   backs the file up, ends with az check passing
  az lint  [words-dir]             theme-token check of every word pack
  az migrate <file.az>             upgrade the file to this grammar version
  az eject <word> [--dir project]  take ownership of a word's source — one-way
  az backend init <server-dir>     write the backend's .env with a fresh secret
  az backend plan <file.az>        show the data schema step the file needs
  az backend schema <file.az> [--rename a=b] [--drop x] [--unique t.f] [--expose t]
                                   record that step in <file>.data.json
  az backend images <server-dir> [--confirm]
                                   count stored images without width copies;
                                   with --confirm, make them
  az backend probe <server-dir> [--json]
                                   ask the configured chat model the production
                                   prompt; times, tokens, what was dropped
  az backend usage <server-dir> [--json]
                                   the chat's daily counts and budget left;
                                   reads only, never a message
  az backend shares <server-dir> --delete <id>
                                   delete one shared chat answer by its id or
                                   link; prints an audit line, never the answer
  az mcp  [--root dir]            serve these tools to an AI agent (MCP, stdio)
  az explain <term...>             one line per term: az explain hero center
  az palette [--theme t] [--accent h] [--out dir]
                                   write the colour gallery
  az palette --list | --json [--theme t] [--accent h]
                                   print every colour choice
  az prompt [--words a,b] [--compact] [--budget N] [--json]
                                   print what any AI model needs to write .az
  az doctor [file.az] [--out dir] [--json]
                                   check this machine and project; changes nothing
  az audit [--out dir] [--online] [--json]
                                   check a build's output; changes nothing
`;

const COMMANDS = new Set(['build', 'dev', 'spec', 'check', 'add', 'lint', 'migrate', 'eject', 'backend', 'mcp', 'explain', 'palette', 'prompt', 'doctor', 'audit']);

/**
 * Runs a command that imports its own modules, so that no other command
 * loads them. Until `run` settles the process stays up (its import is
 * pending). A failing exit code is set when it resolves; ok sets nothing, so
 * a failure the command recorded itself (az dev's servers, which outlive
 * `run`) is never overwritten. A module that fails to load, or a command
 * that throws, is reported under the command's name with the usage code.
 */
function later(name: string, run: () => Promise<number>): number {
  void run().then((code) => {
    if (code !== EXIT.ok) process.exitCode = code;
  }, (e: unknown) => {
    process.stderr.write(`az: ${name}: ${(e as Error).message}\n`);
    process.exitCode = EXIT.config;
  });
  return EXIT.ok;
}

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
  if (sub === 'images' && rest[0]) return runBackendImages(resolve(rest[0]), rest.slice(1));
  if (sub === 'probe' && rest[0]) return runBackendProbe(resolve(rest[0]), rest.slice(1));
  if (sub === 'usage' && rest[0]) return runBackendUsage(resolve(rest[0]), rest.slice(1));
  if (sub === 'shares' && rest[0]) return runBackendShares(resolve(rest[0]), rest.slice(1));
  if (sub !== 'init' || !rest[0]) {
    process.stderr.write('az: try: az backend init <server-dir>  (the server/ folder of a build), az backend plan site.az, az backend schema site.az, az backend images <server-dir>, az backend probe <server-dir>, az backend usage <server-dir> or az backend shares <server-dir> --delete <id>\n');
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

/**
 * The server's backfill (`--images`) is given this long: it starts no image
 * after 20 minutes (main.ts IMAGES_RUN_MS), and one image is at most a few
 * seconds. Past it the child is killed; a second run resumes.
 */
const IMAGES_CHILD_MS = 25 * 60 * 1000;

/**
 * `az backend images <server-dir> [--confirm]` (data-spec §8): the built
 * server's own backfill, run in its folder so it reads its `.env`, its
 * database and its files — the server does the work, this only starts it.
 * Without --confirm it counts; with it, it makes the width copies.
 */
function runBackendImages(dir: string, flags: readonly string[]): number {
  if (flags.some((f) => f !== '--confirm')) {
    process.stderr.write('az: try: az backend images <server-dir> [--confirm]\n');
    return EXIT.config;
  }
  if (!existsSync(join(dir, 'az.config.json')) || !existsSync(join(dir, 'src/main.ts'))) {
    process.stderr.write(`az: no built server in ${dir} — point at the server/ folder az build wrote\n`);
    return EXIT.missing;
  }
  const r = spawnSync(process.execPath, ['src/main.ts', '--images', ...(flags.includes('--confirm') ? ['--confirm'] : [])], {
    cwd: dir, stdio: 'inherit', timeout: IMAGES_CHILD_MS, killSignal: 'SIGKILL',
  });
  if (r.error || r.signal) {
    process.stderr.write(`az: the backfill stopped (${r.signal ?? r.error?.name}) — what it finished is kept; run it again to continue\n`);
    return EXIT.missing;
  }
  return r.status === 0 ? EXIT.ok : EXIT.missing;
}

/**
 * The probe is given this long: it asks no question after 10 minutes
 * (server chat-probe.ts PROBE_MS) and each answer ends within the server's
 * own AZ_CHAT_TIMEOUT_SECONDS (at most 300 s). Past it the child is killed.
 */
export const PROBE_CHILD_MS = 16 * 60 * 1000;

/**
 * `az backend probe <server-dir> [--json]` (chat-block-spec §11.3): the
 * built server's own probe, run in its folder so it reads its `.env`, its
 * prompt and its context — the only CLI step that calls a model, so it is
 * never part of build, doctor or audit. It prints times, token counts and
 * what the filter dropped; never the key, never the model's words.
 */
function runBackendProbe(dir: string, flags: readonly string[]): number {
  if (flags.some((f) => f !== '--json')) {
    process.stderr.write('az: try: az backend probe <server-dir> [--json]\n');
    return EXIT.config;
  }
  if (!existsSync(join(dir, 'az.config.json')) || !existsSync(join(dir, 'src/chat-probe.ts'))) {
    process.stderr.write(`az: no built server with a chat in ${dir} — point at the server/ folder az build wrote for a site that shows chat\n`);
    return EXIT.missing;
  }
  const r = spawnSync(process.execPath, ['src/chat-probe.ts', ...flags], {
    cwd: dir, stdio: 'inherit', timeout: PROBE_CHILD_MS, killSignal: 'SIGKILL',
  });
  if (r.error || r.signal) {
    process.stderr.write(`az: the probe stopped (${r.signal ?? r.error?.name}) after ${PROBE_CHILD_MS / 60_000} minutes at most — check AZ_CHAT_URL is reachable\n`);
    return EXIT.missing;
  }
  return r.status === 0 ? EXIT.ok : EXIT.missing;
}

/** The usage report reads three bounded queries; past this its database did not answer, and the child is killed. */
export const USAGE_CHILD_MS = 60 * 1000;

/**
 * `az backend usage <server-dir> [--json]` (chat-block-spec §11.4): the
 * built server's own report, run in its folder so it reads its `.env` and
 * its database — today's spend against the daily budget, the last 30 days'
 * counts, the shared answers kept. It reads only and prints counts only.
 */
function runBackendUsage(dir: string, flags: readonly string[]): number {
  if (flags.some((f) => f !== '--json')) {
    process.stderr.write('az: try: az backend usage <server-dir> [--json]\n');
    return EXIT.config;
  }
  if (!existsSync(join(dir, 'az.config.json')) || !existsSync(join(dir, 'src/chat-report.ts'))) {
    process.stderr.write(`az: no built server with a chat in ${dir} — point at the server/ folder az build wrote for a site that shows chat\n`);
    return EXIT.missing;
  }
  const r = spawnSync(process.execPath, ['src/chat-report.ts', ...flags], {
    cwd: dir, stdio: 'inherit', timeout: USAGE_CHILD_MS, killSignal: 'SIGKILL',
  });
  if (r.error || r.signal) {
    process.stderr.write(`az: the usage report stopped (${r.signal ?? r.error?.name}) after ${USAGE_CHILD_MS / 1000} s at most — check the database is reachable\n`);
    return EXIT.missing;
  }
  return r.status === 0 ? EXIT.ok : EXIT.missing;
}

/** One share delete is one bounded statement; past this its database did not answer, and the child is killed. */
export const SHARES_CHILD_MS = 60 * 1000;

/**
 * `az backend shares <server-dir> --delete <id | link>` (chat-block-spec
 * §20.7): the operator deletes one shared answer, run in the built server's
 * folder so it reads its `.env` and its database. The child prints one audit
 * line — the id, the outcome, the time — and never the answer.
 */
function runBackendShares(dir: string, flags: readonly string[]): number {
  if (flags.length !== 2 || flags[0] !== '--delete') {
    process.stderr.write('az: try: az backend shares <server-dir> --delete <share id or link>\n');
    return EXIT.config;
  }
  if (!existsSync(join(dir, 'az.config.json')) || !existsSync(join(dir, 'src/chat-shares.ts'))) {
    process.stderr.write(`az: no built server with a chat in ${dir} — point at the server/ folder az build wrote for a site that shows chat\n`);
    return EXIT.missing;
  }
  const r = spawnSync(process.execPath, ['src/chat-shares.ts', ...flags], {
    cwd: dir, stdio: 'inherit', timeout: SHARES_CHILD_MS, killSignal: 'SIGKILL',
  });
  if (r.error || r.signal) {
    process.stderr.write(`az: the share delete stopped (${r.signal ?? r.error?.name}) after ${SHARES_CHILD_MS / 1000} s at most — check the database is reachable\n`);
    return EXIT.missing;
  }
  return r.status === 0 ? EXIT.ok : r.status === 2 ? EXIT.config : EXIT.missing;
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

const PALETTE_USAGE = `az palette — colour comes first: every theme, accent, pair and pattern

  az palette [--theme t] [--accent h] [--out dir]
      write the gallery page (default .az-build/.palette)
  az palette --list [--theme t] [--accent h]
      print the choices for a terminal
  az palette --json [--theme t] [--accent h]
      print the choices as JSON, each with its .az line
`;

/**
 * `az palette` — PRD §6.1a, theme-spec §14: every colour choice, by eye
 * (a static page with its .az lines) or as text. Changes nothing but the
 * page it writes. Exit 0 done, 1 the page could not be written, 2 usage.
 * The choices are core's colour.ts, the one list az_palette serves too.
 */
async function runPalette(args: string[]): Promise<number> {
  const colour = await import('../../core/src/colour.ts');
  let mode: 'page' | 'list' | 'json' = 'page';
  let out: string | null = null;
  const filter: { theme?: string; accent?: string } = {};
  const usage = (why: string) => {
    process.stderr.write(`az: palette: ${why}\n\n${PALETTE_USAGE}`);
    return EXIT.config;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
    if (a === '--help' || a === '-h') {
      process.stdout.write(PALETTE_USAGE);
      return EXIT.ok;
    }
    if (a === '--list' || a === '--json') {
      const next = a === '--list' ? 'list' : 'json';
      if (mode !== 'page' && mode !== next) return usage('--list and --json are two ways to print — pick one');
      mode = next;
    } else if ((a === '--theme' || a === '--accent' || a === '--out') && value !== undefined) {
      if (a === '--out') out = value;
      else filter[a === '--theme' ? 'theme' : 'accent'] = value;
      i++;
    } else if (a === '--theme' || a === '--accent' || a === '--out') {
      return usage(`${a} needs a value`);
    } else {
      return usage(`unexpected '${a}'`);
    }
  }
  if (mode !== 'page' && out !== null) return usage('--out writes the page; --list and --json print instead');
  const chosen = colour.filterColourChoices(colour.colourChoices(), filter);
  if (!chosen.ok) return usage(chosen.message);
  if (mode === 'list') {
    process.stdout.write(colour.formatColourChoices(chosen.choices));
    return EXIT.ok;
  }
  if (mode === 'json') {
    process.stdout.write(`${JSON.stringify(colour.colourChoicesJson(chosen.choices), null, 2)}\n`);
    return EXIT.ok;
  }
  // The page proves every pair it paints; it is loaded only for the page.
  const page = await import('./palette-page.ts');
  const dir = out ?? page.PALETTE_DIR;
  const written = writeOutput(dir, [{ path: page.PALETTE_FILE, content: page.palettePage(chosen.choices, filter.accent ?? null) }]);
  if (!written.ok) {
    process.stderr.write(`${written.problems.join('\n')}\n`);
    return EXIT.missing;
  }
  process.stdout.write(`az: wrote ${join(dir, page.PALETTE_FILE)} — open it in a browser\n`);
  return EXIT.ok;
}

/** `az prompt`'s usage: prompt.ts's own trim order and token rule. */
const promptUsage = ({ TRIM_ORDER, TOKEN_RULE }: typeof import('../../core/src/prompt.ts')): string => `az prompt — the instructions any AI model needs to write .az, as Markdown

  az prompt                  the full prompt: order, syntax, colour, every word, errors
  az prompt --words hero,cta only these words in the words section
  az prompt --compact        the smallest prompt, for a small context window
  az prompt --budget N       fit N tokens, dropping in order: ${TRIM_ORDER.join(', ')}
  az prompt --json           the prompt and its size as JSON, for tools

Sizes are ${TOKEN_RULE}; the size goes to stderr.
`;

/**
 * What `az prompt` and az_prompt describe: the bundled words (or AZ_WORDS),
 * overridden by the project's own `words/` — manifests and previews read as
 * data; no word code runs.
 */
export function promptInput(projectWords: string): PromptInput {
  const dir = process.env.AZ_WORDS ?? BUNDLED_WORDS;
  return { manifests: loadWords(dir, projectWords, { code: false }).manifests, examples: wordExamples(dir, projectWords) };
}

/**
 * `az prompt` — the system-prompt block for any model, generated from the
 * compiler's tables (core's prompt.ts, which az_prompt serves too). Writes
 * nothing. Exit 0 printed, 2 usage (a bad flag, an unknown word, a budget
 * below the smallest prompt).
 */
async function runPrompt(args: string[]): Promise<number> {
  const prompt = await import('../../core/src/prompt.ts');
  const PROMPT_USAGE = promptUsage(prompt);
  const raw: { words?: string; compact?: boolean; budget?: string } = {};
  let json = false;
  const usage = (why: string) => {
    process.stderr.write(`az: prompt: ${why}\n\n${PROMPT_USAGE}`);
    return EXIT.config;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const value = args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
    if (a === '--help' || a === '-h') {
      process.stdout.write(PROMPT_USAGE);
      return EXIT.ok;
    }
    if (a === '--compact') raw.compact = true;
    else if (a === '--json') json = true;
    else if ((a === '--words' || a === '--budget') && value !== undefined) {
      if (raw[a === '--words' ? 'words' : 'budget'] !== undefined) return usage(`${a} given twice — give it once`);
      raw[a === '--words' ? 'words' : 'budget'] = value;
      i++;
    } else if (a === '--words' || a === '--budget') {
      return usage(`${a} needs a value`);
    } else {
      return usage(`unexpected '${a}'`);
    }
  }
  const parsed = prompt.promptOptionsFrom(raw);
  if (!parsed.ok) return usage(parsed.message);
  const built = prompt.buildPrompt(promptInput(resolve('words')), parsed.options);
  if (!built.ok) return usage(built.message);
  const p = built.prompt;
  if (json) {
    process.stdout.write(`${JSON.stringify(prompt.promptJson(p), null, 2)}\n`);
    return EXIT.ok;
  }
  process.stdout.write(p.markdown);
  const dropped = p.dropped.length ? `; left out: ${p.dropped.join(', ')}` : '';
  process.stderr.write(`az: prompt is ${p.chars} characters, about ${p.tokens} tokens (${prompt.TOKEN_RULE})${dropped}\n`);
  return EXIT.ok;
}

/**
 * `az doctor [file.az] [--out dir] [--json]` — word-quality-gate §5: detect
 * everything, install nothing. Without a file, the one .az file in this
 * folder is checked; with none or several, only the machine is. Exit 0 when
 * nothing failed (warnings never fail), 1 when something did, 2 for a usage
 * error. The report is written when every check has answered or hit its
 * deadline, so the exit code is set then.
 */
async function runDoctor(args: string[]): Promise<number> {
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
  const [{ doctor }, { formatReport, systemProbe }, { findNpmCli }] = await Promise.all([
    import('./doctor-checks.ts'), import('./doctor.ts'), import('./serve.ts'),
  ]);
  const r = await doctor({
    source: file === null ? null : resolve(file),
    outDir: resolve(out),
    cwd: process.cwd(),
    wordsDir: process.env.AZ_WORDS ?? BUNDLED_WORDS,
    probe: systemProbe(findNpmCli),
    projectModules: true,
  });
  process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : formatReport(r));
  return r.exit;
}

/**
 * `az audit [--out dir] [--online] [--json]` — word-quality-gate §5: the
 * built output, checked. Reads only; the advisory query is the one network
 * call and runs only with --online. Exit 0 when nothing failed, 1 when
 * something did, 2 for a usage error; set when every check has answered.
 */
async function runAudit(args: string[]): Promise<number> {
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
  const [{ audit }, { formatReport, systemProbe }, { findNpmCli }] = await Promise.all([
    import('./audit.ts'), import('./doctor.ts'), import('./serve.ts'),
  ]);
  const r = await audit({ outDir: resolve(out), cwd: process.cwd(), probe: systemProbe(findNpmCli), online });
  process.stdout.write(json ? `${JSON.stringify(r, null, 2)}\n` : formatReport(r, 'az audit'));
  return r.exit;
}

async function runLint(wordsDir: string): Promise<number> {
  if (!existsSync(wordsDir) || !statSync(wordsDir).isDirectory()) {
    process.stderr.write(`az: no words directory at '${wordsDir}' — try: az lint path/to/words\n`);
    return EXIT.config;
  }
  const [{ lintWords }, { formatFindings }] = await Promise.all([import('./lint.ts'), import('../../theme/src/lint.ts')]);
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
  // Read, not checked first: a file that goes between a check and the read is missing, never a crash.
  let source: string;
  try {
    source = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    process.stderr.write(`az: ${file} does not exist — try: az migrate site.az\n`);
    return EXIT.missing;
  }
  const result = migrate(source);
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
 * `az add chat <file.az> [--page /route | --float] [--show …]` (chat-block-spec
 * §19.15): the edit is add-chat.ts's; here only the arguments, and what it
 * did, said a line each. Exit 0 done (or nothing to add), 1 refused with
 * nothing changed, 2 usage.
 */
async function runAdd(what: string, args: string[]): Promise<number> {
  const { addChat, ADD_CHAT_USAGE } = await import('./add-chat.ts');
  const usage = (why: string) => {
    process.stderr.write(`az: add: ${why}\n\n${ADD_CHAT_USAGE}`);
    return EXIT.config;
  };
  if (what === '--help' || what === '-h') {
    process.stdout.write(ADD_CHAT_USAGE);
    return EXIT.ok;
  }
  if (what !== 'chat') return usage(`'${what}' is not something az can add — try: az add chat site.az`);
  let file: string | null = null;
  let float = false;
  let page: string | null = null;
  let show: string[] | null = null;
  let outDir = '.az-build';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1];
    if (a === '--help' || a === '-h') {
      process.stdout.write(ADD_CHAT_USAGE);
      return EXIT.ok;
    } else if (a === '--float') float = true;
    else if (a === '--page' || a === '--show' || a === '--out') {
      if (next === undefined || next.startsWith('--')) return usage(`${a} needs a value`);
      if (a === '--page') page = next;
      else if (a === '--out') outDir = next;
      else show = next.split(',').map((w) => w.trim()).filter(Boolean);
      i++;
    } else if (a.startsWith('--')) return usage(`unknown option '${a}'`);
    else if (file === null) file = a;
    else return usage(`one file at a time — '${a}' is a second`);
  }
  if (file === null) return usage('needs a file — try: az add chat site.az');
  if (float && page !== null) return usage('--float is on every page; --page puts a panel on one — pick one');
  if (show !== null && show.length === 0) return usage('--show needs a component or a group, e.g. --show all');
  const r = addChat({ file, float, page, show, wordsDir: process.env.AZ_WORDS ?? BUNDLED_WORDS, outDir });
  if (!r.ok) {
    process.stderr.write(`az: add chat: ${r.message}\n`);
    return r.exit;
  }
  for (const line of r.changes) process.stdout.write(`az: ${line}\n`);
  for (const line of r.kept) process.stdout.write(`az: ${line} — kept as it is\n`);
  if (r.changes.length === 0) process.stdout.write(`az: nothing to add — ${file} already has its chat\n`);
  for (const b of r.backups) process.stdout.write(`az: backed up to ${b}\n`);
  process.stdout.write(`${r.check}\n`);
  if (r.changes.length > 0) process.stdout.write(`az: next: az dev ${file} — the chat answers from a demo script until a model is set\n`);
  return EXIT.ok;
}

/**
 * `az dev`: compile on every save and, unless `--no-serve`, serve the result
 * — the site on Vite's dev server, and for a site that declares `backend`,
 * the backend with its development profile (serve.ts, dev-backend.ts).
 * Serving starts after the first build that succeeds; Ctrl-C stops it all.
 */
async function runDev(file: string, outDir: string, wordsDir: string, rest: string[]): Promise<number> {
  const [{ dev, devLine }, { serve, DEFAULT_SITE_PORT }] = await Promise.all([import('./dev.ts'), import('./serve.ts')]);
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
      // A preview (a file still being written) is served like a build.
      if ((!outcome.ok && !outcome.preview) || !serving) return;
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
      // Each chat's prompt and the context, as the build wrote them (docs/chat-block-spec.md §8.1, §19.16).
      const prompts = Object.fromEntries(outcome.files.filter((f) => /^server\/chat\/prompt-[0-9]+\.txt$/.test(f.path))
        .map((f) => [f.path.slice('server/chat/'.length), f.content]));
      const context = outcome.files.find((f) => f.path === 'server/chat/context.json')?.content;
      const server = config ? JSON.parse(config.content) as { siteName: string; email?: string; map?: boolean } : null;
      const backend = server
        ? {
            siteName: server.siteName,
            // No email: the site needs no accounts, and its dev server keeps none either (chat-block-spec §19.15).
            accounts: server.email !== undefined,
            ...(dataJson !== undefined ? { data: dataJson } : {}),
            ...(context !== undefined ? { chat: { prompts, context, ...(server.map === true ? { map: true } : {}) } } : {}),
          }
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
  if (cmd === 'lint') return later(cmd, () => runLint(file ?? process.env.AZ_WORDS ?? 'words'));
  if (cmd === 'explain') return runExplain(argv.slice(1));
  if (cmd === 'palette') return later(cmd, () => runPalette(argv.slice(1)));
  if (cmd === 'prompt') return later(cmd, () => runPrompt(argv.slice(1)));
  if (cmd === 'doctor') return later(cmd, () => runDoctor(argv.slice(1)));
  if (cmd === 'audit') return later(cmd, () => runAudit(argv.slice(1)));
  if (cmd === 'mcp') {
    // stdin keeps the process alive; the server ends when the client closes it.
    const rootFlag = argv.indexOf('--root');
    const root = rootFlag >= 0 && argv[rootFlag + 1] ? argv[rootFlag + 1] : process.cwd();
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      process.stderr.write(`az: mcp: '${root}' is not a folder — try: az mcp --root path/to/project\n`);
      return EXIT.config;
    }
    return later(cmd, () => import('./mcp.ts').then(({ runMcp }) => runMcp(root)).then(() => EXIT.ok));
  }
  if (!file) {
    process.stderr.write(`az: ${cmd} needs a file — try: az ${cmd} site.az\n`);
    return EXIT.config;
  }
  if (cmd === 'migrate') return runMigrate(file);
  if (cmd === 'add') return later(cmd, () => runAdd(file, rest));
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
      return later(cmd, () => runDev(file, outDir, wordsDir, rest));
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
