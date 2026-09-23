/**
 * @az module words
 * Purpose: the word set a project compiles with (bundled + project overrides) and az eject.
 * Spec: docs/ARCHITECTURE.md §7
 * Exports: loadWords, loadManifests, eject, BUNDLED_WORDS
 * Edit guide: read-only tools load manifests only ({ code: false }) — project code never runs for them.
 * Tests: packages/cli/test/escape-hatch.test.ts
 */

/**
 * The words a project compiles with — and `az eject`, which hands one over.
 *
 * A project uses the bundled words, and its own `words/` folder overrides
 * them by name: that is where an ejected word lives, and where an author can
 * keep a word of their own. The loader lives in the CLI, not in `core`: the
 * Playground has no filesystem and bundles the same objects instead
 * (ARCHITECTURE §1a).
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, copyFileSync } from 'node:fs';
import { writeProblem } from './output.ts';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest } from '../../core/src/index.ts';
import type { WordEmitter } from '../../core/src/emit-contract.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

/** The words that ship with az. `AZ_WORDS` points the CLI somewhere else. */
export const BUNDLED_WORDS = fileURLToPath(new URL('../../words/', import.meta.url));

/** The two core modules an emitter imports; eject carries copies of them. */
const CORE_SRC = fileURLToPath(new URL('../../core/src/', import.meta.url));
const CONTRACT_FILES = ['emit-contract.ts', 'spec-block.ts'];

/** Where eject puts those copies, beside the project's words. */
const SHIM_DIR = '_az';

/** A word's imports of core, and what an ejected copy imports instead. */
const REWRITES: [string, string][] = [
  ["'../../core/src/emit-contract.ts'", `'../${SHIM_DIR}/emit-contract.ts'`],
  ["'../../core/src/spec.ts'", `'../${SHIM_DIR}/spec-block.ts'`],
];

/** Synchronous, so `build` stays synchronous: Node 22 can require an ES module. */
const load = createRequire(import.meta.url);

function readManifest(dir: string, name: string): Manifest {
  try {
    return JSON.parse(readFileSync(join(dir, 'word.json'), 'utf8')) as Manifest;
  } catch (e) {
    // A manifest that exists but is broken IS an error — silence here would
    // make a word vanish with no explanation.
    throw new Error(`words: ${name}/word.json is unreadable — ${(e as Error).message}`);
  }
}

/** Every word folder under `wordsDir`: a directory holding a `word.json` (CONVENTIONS §3). */
function wordDirs(wordsDir: string): string[] {
  return readdirSync(wordsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(wordsDir, e.name, 'word.json')))
    .map((e) => e.name)
    .sort();
}

/**
 * Load word manifests from disk.
 *
 * A directory without a manifest is not a word — treating every
 * subdirectory as one made a single stray folder break the whole compiler.
 */
export function loadManifests(wordsDir: string): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>();
  for (const name of wordDirs(wordsDir)) {
    const m = readManifest(join(wordsDir, name), name);
    manifests.set(m.name, m);
  }
  return manifests;
}

export interface WordSet {
  readonly manifests: Map<string, Manifest>;
  readonly emitters: Readonly<Record<string, WordEmitter>>;
}

/**
 * The bundled words, overridden by name by the project's `words/` folder.
 *
 * A project word's emitter is the project's own code and runs in this
 * process, as a build config would — which is what owning a word means. So
 * it is loaded only when `code` is true: compiling to diagnostics or a Spec
 * needs the manifests alone (plain JSON), and a caller that must not run the
 * project's code — the MCP server's read-only tools — asks for exactly that.
 */
export function loadWords(bundledDir: string, projectDir: string | null, options: { code?: boolean } = {}): WordSet {
  const code = options.code ?? true;
  const manifests = loadManifests(bundledDir);
  const emitters: Record<string, WordEmitter> = { ...WEB_EMITTERS };
  if (!projectDir || !existsSync(projectDir) || resolve(projectDir) === resolve(bundledDir)) {
    return { manifests, emitters };
  }
  for (const name of wordDirs(projectDir)) {
    const dir = join(projectDir, name);
    const m = readManifest(dir, name);
    manifests.set(m.name, m);
    if (!code) continue;
    const file = join(dir, 'emit.web.ts');
    if (!existsSync(file)) continue;
    const mod = load(file) as Partial<WordEmitter>;
    if (typeof mod.emit !== 'function') {
      throw new Error(`words: ${name}/emit.web.ts exports no emit function`);
    }
    emitters[m.name] = mod as WordEmitter;
  }
  return { manifests, emitters };
}

/* ---- az eject ------------------------------------------------------------ */

export type EjectResult =
  | { readonly ok: true; readonly target: string; readonly files: string[] }
  | { readonly ok: false; readonly message: string };

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)).map((f) => join(e.name, f)) : [e.name]).sort();
}

/**
 * Copy a bundled word into `<projectDir>/words/<word>` and hand it over.
 *
 * One-way (ARCHITECTURE §7): az never updates, merges or regenerates the
 * copy. The emitter's two imports of core are pointed at verbatim copies of
 * those modules in `words/_az/`, so the ejected word builds without the
 * compiler's source and stays plain, editable TypeScript.
 */
export function eject(word: string, projectDir: string, bundledDir: string = BUNDLED_WORDS): EjectResult {
  // The name becomes a path: nothing but a plain word name may reach join().
  if (!/^[a-z][a-z0-9-]*$/.test(word)) {
    return { ok: false, message: `'${word}' is not a word name` };
  }
  const source = join(bundledDir, word);
  if (!existsSync(join(source, 'word.json'))) {
    return { ok: false, message: `there is no word '${word}' to eject — try: ${wordDirs(bundledDir).join(', ')}` };
  }
  const words = join(projectDir, 'words');
  const target = join(words, word);
  if (existsSync(target)) {
    return { ok: false, message: `${relative(projectDir, target)} already exists — eject never overwrites a word you own` };
  }
  // No write through a symbolic link: `words/` linked elsewhere would put the
  // copy outside the project (output.ts applies the same rule to builds).
  for (const rel of [join('words', word), join('words', SHIM_DIR)]) {
    const problem = writeProblem(realpathSync(projectDir), rel);
    if (problem) return { ok: false, message: problem };
  }

  // Rewrite first, write after: a word with an import eject cannot carry is
  // refused before anything lands in the project.
  const plan: { file: string; text: string | null }[] = [];
  for (const file of filesUnder(source)) {
    if (!file.endsWith('.ts')) { plan.push({ file, text: null }); continue; }
    let text = readFileSync(join(source, file), 'utf8');
    for (const [from, to] of REWRITES) text = text.split(from).join(to);
    const stray = /from\s+['"](\.\.\/\.\.\/[^'"]+)['"]/.exec(text);
    if (stray) {
      return { ok: false, message: `${word}/${file} imports ${stray[1]}, which eject cannot carry` };
    }
    plan.push({ file, text });
  }

  const written: string[] = [];
  for (const { file, text } of plan) {
    const to = join(target, file);
    mkdirSync(dirname(to), { recursive: true });
    if (text === null) copyFileSync(join(source, file), to);
    else writeFileSync(to, text, 'utf8');
    written.push(relative(projectDir, to));
  }
  // The contract copies are shared by every ejected word and never replaced:
  // after the first eject they are the project's, like the words.
  for (const f of CONTRACT_FILES) {
    const to = join(words, SHIM_DIR, f);
    if (existsSync(to)) continue;
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to,
      `/* Copied from az's core by \`az eject\`: the contract ejected words build against.\n`
      + `   Yours now — az does not update it. */\n` + readFileSync(join(CORE_SRC, f), 'utf8'), 'utf8');
    written.push(relative(projectDir, to));
  }
  return { ok: true, target, files: written };
}
