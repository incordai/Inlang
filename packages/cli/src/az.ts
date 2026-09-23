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
  readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, copyFileSync, realpathSync, statSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, formatDiagnostics, serialiseSpec } from '../../core/src/index.ts';
import { emitProject, PathEscapeError, RUNTIME_DIR, USER_DIR } from '../../target-web/src/emit.ts';
// dev.ts imports `build` from here; the cycle is safe because neither module
// touches the other's exports until a command runs.
import { dev, devLine } from './dev.ts';
import { lintWords } from './lint.ts';
import { BUNDLED_WORDS, eject, loadWords } from './words.ts';
import { migrate, GRAMMAR_VERSION } from './migrate.ts';
import { formatFindings } from '../../theme/src/lint.ts';

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
  projectDir: string, assets: string[], kind: 'asset' | 'component' = 'asset',
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

/** The words one build compiles with: the set, plus the project's own. */
const wordsFor = (options: Omit<BuildOptions, 'outDir'>) => loadWords(options.wordsDir,
  options.projectWordsDir === undefined ? resolve(dirname(options.source), 'words') : options.projectWordsDir);

export function build(options: BuildOptions): BuildOutcome {
  const src = readFileSync(options.source, 'utf8');
  const words = wordsFor(options);
  const result = compile(src, { manifests: words.manifests });

  const report = result.diagnostics.length
    ? formatDiagnostics(result.diagnostics, options.source)
    : '';

  // Errors block; warnings never do — CONVENTIONS §5.
  if (!result.ok || !result.spec) {
    return { ok: false, files: [], assets: [], report, exit: EXIT.missing };
  }

  let project;
  try {
    project = emitProject(result.spec, { emitters: words.emitters });
  } catch (e) {
    if (e instanceof PathEscapeError) {
      return { ok: false, files: [], assets: [], report: `${report}\n${e.message}`.trim(), exit: EXIT.missing };
    }
    throw e;
  }
  const { assets, modules } = project;
  // The behaviour runtime ships with every site, copied verbatim from the
  // overlay package into RUNTIME_DIR — part of the output, so it is written
  // and checked like any emitted file.
  const files = [...project.files, ...runtimeFiles()].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  // The author's components go through the same sandbox as assets: they must
  // exist and really be inside the project, symlinks followed.
  const projectDir = dirname(resolve(options.source));
  const located = locateAssets(projectDir, assets);
  const components = locateAssets(projectDir, modules, 'component');
  const problems = [...located.problems, ...components.problems];
  if (problems.length > 0) {
    return {
      ok: false, files: [], assets: [],
      report: [report, ...problems].filter(Boolean).join('\n'),
      exit: EXIT.missing,
    };
  }

  if (options.write !== false) {
    for (const f of files) {
      const target = resolve(options.outDir, f.path);
      mkdirSync(dirname(target), { recursive: true });
      // Newline style is fixed, not inherited from the platform — otherwise
      // the same source produces different bytes on Windows and Linux and the
      // determinism claim dies quietly (CONVENTIONS §6).
      writeFileSync(target, f.content.replace(/\r\n/g, '\n'), 'utf8');
    }
    // Vite serves `public/` at the site root and copies it into the build
    // untouched, which is what makes the page's `/assets/...` URLs resolve.
    assets.forEach((a, i) => {
      const target = resolve(options.outDir, 'public', a);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(located.sources[i], target);
    });
    // The generated App imports each one from here (target-web USER_DIR).
    modules.forEach((m, i) => {
      const target = resolve(options.outDir, USER_DIR, m);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(components.sources[i], target);
    });
  }

  return { ok: true, files, assets, report, exit: EXIT.ok };
}

/** The overlay runtime's modules, as files of the generated project. */
function runtimeFiles(): { path: string; content: string }[] {
  const dir = fileURLToPath(new URL('../../overlay/src/runtime/', import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => ({ path: `${RUNTIME_DIR}/${f}`, content: readFileSync(join(dir, f), 'utf8') }));
}

export function specOf(options: Omit<BuildOptions, 'outDir'>): string | null {
  const src = readFileSync(options.source, 'utf8');
  const r = compile(src, { manifests: wordsFor(options).manifests });
  return r.spec ? serialiseSpec(r.spec) : null;
}

/* ------------------------------------------------------------------ */

const USAGE = `az — words to a website

  az build <file.az> [--out dir]   compile to a runnable project
  az dev   <file.az> [--out dir]   build, then rebuild on every save
  az spec  <file.az>               print the Spec as JSON
  az check <file.az>               report diagnostics only, write nothing
  az lint  [words-dir]             theme-token check of every word pack
  az migrate <file.az>             upgrade the file to this grammar version
  az eject <word> [--dir project]  take ownership of a word's source — one-way
`;

const COMMANDS = new Set(['build', 'dev', 'spec', 'check', 'lint', 'migrate', 'eject']);

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** `az lint`: findings are errors (exit 1), and a clean run says how much it checked. */
function runLint(wordsDir: string): number {
  if (!existsSync(wordsDir)) {
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
  if (!file) {
    process.stderr.write(`az: ${cmd} needs a file — try: az ${cmd} site.az\n`);
    return EXIT.config;
  }
  if (cmd === 'migrate') return runMigrate(file);
  if (cmd === 'eject') {
    const dirFlag = rest.indexOf('--dir');
    return runEject(file, dirFlag >= 0 ? rest[dirFlag + 1] : process.cwd());
  }

  const outFlag = rest.indexOf('--out');
  const outDir = outFlag >= 0 ? rest[outFlag + 1] : '.az-build';
  // The bundled words (or AZ_WORDS); the project's own `words/` beside the
  // file overrides them by name inside build().
  const wordsDir = process.env.AZ_WORDS ?? BUNDLED_WORDS;

  try {
    if (cmd === 'spec') {
      const json = specOf({ source: file, wordsDir });
      if (!json) { process.stderr.write('az: nothing to print\n'); return EXIT.missing; }
      process.stdout.write(json);
      return EXIT.ok;
    }

    if (cmd === 'dev') {
      // The watcher keeps the process alive; Ctrl-C closes it cleanly.
      const handle = dev({
        source: file,
        outDir,
        wordsDir,
        onResult: (outcome, ms) => {
          const stream = outcome.ok ? process.stdout : process.stderr;
          stream.write(devLine(outcome, ms) + '\n');
        },
      });
      process.once('SIGINT', () => handle.close());
      return EXIT.ok;
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
