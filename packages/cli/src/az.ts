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

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { compile, formatDiagnostics, serialiseSpec, type Manifest } from '../../core/src/index.ts';
import { emit, PathEscapeError } from '../../target-web/src/emit.ts';
// The CLI is the composition root (ARCHITECTURE §1a): it owns which target and
// which words are in play, and hands both to a compiler that knows neither.
import { WEB_EMITTERS } from '../../words/registry.ts';
// dev.ts imports `build` from here; the cycle is safe because neither module
// touches the other's exports until a command runs.
import { dev, devLine } from './dev.ts';

/** Exit codes are meaningful — word-quality-gate §5.2. */
export const EXIT = { ok: 0, missing: 1, config: 2 } as const;

/**
 * Load word manifests from disk.
 *
 * This is why the loader lives in the CLI and not in `core`: the Playground
 * has no filesystem and bundles the same objects instead (ARCHITECTURE §1a).
 */
export function loadManifests(wordsDir: string): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>();
  for (const entry of readdirSync(wordsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = join(wordsDir, entry.name, 'word.json');
    // A directory without a manifest is not a word — CONVENTIONS §3 says a
    // word IS its manifest. Treating every subdirectory as a word made a
    // single stray folder break the whole compiler.
    if (!existsSync(file)) continue;
    try {
      const m = JSON.parse(readFileSync(file, 'utf8')) as Manifest;
      manifests.set(m.name, m);
    } catch (e) {
      // A manifest that exists but is broken IS an error — silence here would
      // make a word vanish with no explanation.
      throw new Error(`words: ${entry.name}/word.json is unreadable — ${(e as Error).message}`);
    }
  }
  return manifests;
}

export interface BuildOptions {
  readonly source: string;      // path to the .az file
  readonly outDir: string;
  readonly wordsDir: string;
  readonly write?: boolean;
}

export interface BuildOutcome {
  readonly ok: boolean;
  readonly files: { path: string; content: string }[];
  readonly report: string;
  readonly exit: number;
}

export function build(options: BuildOptions): BuildOutcome {
  const src = readFileSync(options.source, 'utf8');
  const manifests = loadManifests(options.wordsDir);
  const result = compile(src, { manifests });

  const report = result.diagnostics.length
    ? formatDiagnostics(result.diagnostics, options.source)
    : '';

  // Errors block; warnings never do — CONVENTIONS §5.
  if (!result.ok || !result.spec) {
    return { ok: false, files: [], report, exit: EXIT.missing };
  }

  let files;
  try {
    files = emit(result.spec, { emitters: WEB_EMITTERS });
  } catch (e) {
    if (e instanceof PathEscapeError) {
      return { ok: false, files: [], report: `${report}\n${e.message}`.trim(), exit: EXIT.missing };
    }
    throw e;
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
  }

  return { ok: true, files, report, exit: EXIT.ok };
}

export function specOf(options: Omit<BuildOptions, 'outDir'>): string | null {
  const src = readFileSync(options.source, 'utf8');
  const r = compile(src, { manifests: loadManifests(options.wordsDir) });
  return r.spec ? serialiseSpec(r.spec) : null;
}

/* ------------------------------------------------------------------ */

const USAGE = `az — words to a website

  az build <file.az> [--out dir]   compile to a runnable project
  az dev   <file.az> [--out dir]   build, then rebuild on every save
  az spec  <file.az>               print the Spec as JSON
  az check <file.az>               report diagnostics only, write nothing
`;

const COMMANDS = new Set(['build', 'dev', 'spec', 'check']);

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
  if (!file) {
    process.stderr.write(`az: ${cmd} needs a file — try: az ${cmd} site.az\n`);
    return EXIT.config;
  }

  const outFlag = rest.indexOf('--out');
  const outDir = outFlag >= 0 ? rest[outFlag + 1] : '.az-build';
  const wordsDir = process.env.AZ_WORDS ?? resolve(dirname(file), 'words');

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
