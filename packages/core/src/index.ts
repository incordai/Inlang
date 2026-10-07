/**
 * @az module core
 * Purpose: the compiler API — compile() runs lex → parse → link → spec and returns diagnostics.
 * Spec: docs/ARCHITECTURE.md §3
 * Exports: compile, formatDiagnostics, explain, serialiseSpec, blocksFor
 * Edit guide: add a stage by exporting it here; keep this file free of node: imports (core runs in a browser).
 * Tests: packages/core/test/compile.test.ts, packages/core/test/deps.test.ts
 */

/**
 * The compiler API — the single entry point.
 *
 * `az build` is NOT the compiler; it is one caller of it. The other is the
 * browser: distribution-and-hosting §3 puts the Playground in a Web Worker
 * with **no backend at all**, so the compiler must be callable as a library in
 * a browser exactly as it is in Node.
 *
 * That is why this is a JS API and not an HTTP one. An HTTP compile service
 * would contradict the offline promise (PRD principle 1) and reintroduce the
 * per-request cost that distribution-and-hosting §2 says AZ does not have.
 *
 * Nothing here touches the filesystem or the network. Manifests are PASSED IN,
 * so the caller decides where they came from — `node:fs` in the CLI, a bundled
 * JSON object in the browser. That is what keeps `core` importable in both,
 * and it is required by ARCHITECTURE §2: core imports nothing network-capable.
 */

import { lex, type Diagnostic } from './lex.ts';
import { parse } from './parse.ts';
import { link, type Manifest } from './link.ts';
import { buildSpec, serialiseSpec, type Spec } from './spec.ts';
import { secretLiterals } from './literals.ts';
import { checkLock } from './data-lock.ts';
import { ICON_FORMATS, TOUCH_ICON_SIZE, iconFormat, pngSize } from './icon.ts';
import { quotable } from './secrets.ts';

export type { Diagnostic, Pos, Token } from './lex.ts';
export type { Arg, Statement, AzFile } from './parse.ts';
export type { Manifest, LinkedWord, PropSpec } from './link.ts';
export { COMPONENT_EXT, INJECTION_POINTS, META_DESCRIPTION_MAX } from './link.ts';
export { ICON_FORMATS, ICON_HEAD_BYTES, TOUCH_ICON_SIZE, iconFormat, pngSize, type IconFormat } from './icon.ts';
export type { Spec, SpecBlock, SpecPage, SpecSite } from './spec.ts';
export type { SpecFrom } from './spec-block.ts';
export { FROM_EMPTY, FROM_SETTINGS, type FromField, type FromManifest } from './from.ts';
export { serialiseSpec, blocksFor } from './spec.ts';
export { BACKEND_DATABASES, BACKEND_EMAIL, BACKEND_SETTINGS } from './backend.ts';
export {
  ACTIONS, DATA_MODIFIERS, DATA_TYPES, WHO, TEXT_LIMITS, buildTables,
  type Action, type DataType, type SpecField, type SpecRules, type SpecTable, type Who,
} from './data.ts';
export {
  LOCK_FORMAT, LockError, applyOp, canonicalSteps, checkLock, parseLock, plan, replay, serialiseLock, storageOf,
  type Change, type DataLock, type Fill, type LockField, type LockFlags, type LockOp, type LockStep,
  type LockTable, type PlanResult,
} from './data-lock.ts';
export { DESCRIPTION_MAX, STRUCTURE_DESCRIPTIONS, explain, formatExplained } from './describe.ts';
export type { Explained, ExplainedLine } from './describe.ts';
export type { BackendDatabase, BackendEmail, SpecBackend } from './backend.ts';
export { INTENTS, intentOf, defaultHierarchy, isHierarchy, ACTION_WORDS, type Intent } from './actions.ts';
export { HIERARCHIES, type Hierarchy, type ActionOptions, type SubmitOptions } from './emit-contract.ts';

export interface CompileResult {
  /** Null only when the file could not produce a Spec at all. */
  readonly spec: Spec | null;
  readonly diagnostics: Diagnostic[];
  /** True when no diagnostic has severity `error`. Warnings never block. */
  readonly ok: boolean;
}

export interface CompileOptions {
  /**
   * Word manifests, keyed by word name.
   *
   * Passed in rather than loaded, because `core` must run in a browser where
   * there is no filesystem. The CLI reads `words/*&#47;word.json`; the Playground
   * bundles them.
   */
  readonly manifests: Map<string, Manifest>;
  /**
   * The data schema lock beside the file (data-spec §6.1), read by the
   * caller. Absent, no lock check runs (the Playground has no lock); present,
   * the file's tables must equal the lock's final schema (AZ1701, AZ1706).
   */
  readonly lock?: {
    /** The lock's text, or null when the file does not exist. */
    readonly text: string | null;
    /** Names for the message: the source and the lock as the author knows them. */
    readonly source: string;
    readonly name: string;
    /** The digest the lock was written with (sha256 hex in the CLI). */
    readonly digest: (text: string) => string;
  };
  /**
   * Reads the start of a project file — at least ICON_HEAD_BYTES of it —
   * through the caller's sandbox; null when it cannot be read (missing, not
   * a file, or outside the project). Given it, the `site icon` file's
   * content must be the format its extension names (AZ1421), and an icon no
   * home-screen icon can be made from warns (AZ1422). Absent (the
   * Playground has no files), the content is not checked here; the target
   * still reads it before declaring a type.
   */
  readonly readBytes?: (projectPath: string) => Uint8Array | null;
}

/**
 * Compile `.az` source to a Spec.
 *
 * Diagnostics are COLLECTED through every stage — ARCHITECTURE §3: "Errors are
 * collected, never thrown mid-stage, so the LSP can show all problems at once
 * rather than the first." A stage that fails still passes its partial result
 * on, so later stages can report their own problems too.
 */
export function compile(source: string, options: CompileOptions): CompileResult {
  const lexed = lex(source);
  const parsed = parse(lexed.tokens, lexed.diagnostics);
  const linked = link(parsed.file, options.manifests);
  const built = buildSpec(parsed.file.version, linked.root, options.manifests);

  // A fatal version error (GRAMMAR §7.3) leaves an empty body; the missing
  // site and pages that follow from it are not the author's mistakes.
  const all = parsed.fatal ? parsed.diagnostics : [
    ...parsed.diagnostics,
    ...linked.diagnostics,
    ...built.diagnostics,
    ...secretLiterals(parsed.file.body),
  ];
  // The lock is compared only with a sound file: one with errors has no
  // trustworthy tables to compare, and already fails.
  const lock = options.lock;
  if (lock && built.spec && !all.some((d) => d.severity === 'error')) {
    const site = parsed.file.body.find((s) => s.word === 'site');
    const at = site?.children.find((s) => s.word === 'data')?.pos ?? site?.pos ?? { line: 1, col: 1 };
    all.push(...checkLock(built.spec.site.data ?? [], lock.text, { source: lock.source, lock: lock.name }, lock.digest, at));
  }
  // The icon's bytes are read only for a sound file: the link stage has
  // then refused a path that leaves the project before anything is read.
  const icon = built.spec.site.icon;
  if (icon !== undefined && options.readBytes && !all.some((d) => d.severity === 'error')) {
    const site = parsed.file.body.find((s) => s.word === 'site');
    const at = site?.children.find((s) => s.word === 'icon')?.args[0]?.pos ?? site?.pos ?? { line: 1, col: 1 };
    const bytes = options.readBytes(icon);
    const problem = iconProblem(icon, bytes);
    if (problem) all.push({ code: 'AZ1421', message: problem, pos: at, severity: 'error' });
    const touch = problem || bytes === null ? null : touchIconProblem(icon, bytes);
    if (touch) all.push({ code: 'AZ1422', message: touch, pos: at, severity: 'warning' });
  }
  const ok = !all.some((d) => d.severity === 'error');

  return { spec: built.spec, diagnostics: capped(all), ok };
}

/**
 * Why the icon file cannot be the site icon, or null. Its first bytes say
 * what it is; its extension must say the same, because a host serves the
 * file by its name — a PNG named `.svg` would be sent as an SVG and shown
 * as nothing.
 */
function iconProblem(raw: string, bytes: Uint8Array | null): string | null {
  const path = quotable(raw);
  if (bytes === null) return `site: icon '${path}' can't be read — add the file inside the project, or fix the path`;
  const format = iconFormat(bytes);
  const named = Object.entries(ICON_FORMATS).find(([, f]) => raw.toLowerCase().endsWith(f.ext))?.[0];
  if (format === null) return `site: icon '${path}' is not a PNG or an SVG file — export it as one`;
  if (format !== named) return `site: icon '${path}' is ${format === 'svg' ? 'an SVG' : 'a PNG'} file — name it ${ICON_FORMATS[format].ext}`;
  return null;
}

/**
 * Why no home-screen icon can be made from a sound icon file, or null. It
 * must be PNG — an SVG is not rasterised at build, a new parser on author
 * bytes for one icon — square, and at least TOUCH_ICON_SIZE a side, since it
 * is never upscaled. The build still ships the icon; only the touch icon is
 * left out.
 */
function touchIconProblem(raw: string, bytes: Uint8Array): string | null {
  const path = quotable(raw);
  const want = `a square PNG of ${TOUCH_ICON_SIZE}×${TOUCH_ICON_SIZE} or more`;
  if (iconFormat(bytes) === 'svg') return `site: icon '${path}' is an SVG, and a home-screen icon must be a PNG — the site has none; use ${want} for one`;
  const size = pngSize(bytes);
  if (size === null) return null;
  if (size.width === size.height && size.width >= TOUCH_ICON_SIZE) return null;
  return `site: icon '${path}' is ${size.width}×${size.height}, and a home-screen icon needs ${want} — the site has none; it is never upscaled`;
}

/** GRAMMAR §7.2 rule 6: report at most this many problems. */
export const DIAGNOSTIC_CEILING = 100;

/** The first DIAGNOSTIC_CEILING diagnostics, then one AZ1099 saying so. */
function capped(diagnostics: Diagnostic[]): Diagnostic[] {
  if (diagnostics.length <= DIAGNOSTIC_CEILING) return diagnostics;
  return [
    ...diagnostics.slice(0, DIAGNOSTIC_CEILING),
    {
      code: 'AZ1099',
      message: `file: ${DIAGNOSTIC_CEILING} problems, stopped reporting — fix these first`,
      pos: diagnostics[DIAGNOSTIC_CEILING].pos,
      severity: 'error',
    },
  ];
}

/**
 * Format diagnostics for a terminal or a browser console.
 *
 * One line each, `file:line:col`, so an editor can jump to it — the same shape
 * a compiler has produced since the 1970s, because it is what tools parse.
 */
export function formatDiagnostics(diagnostics: Diagnostic[], file = 'site.az'): string {
  return diagnostics
    .map((d) => `${file}:${d.pos.line}:${d.pos.col} ${d.severity} ${d.code}  ${d.message}`)
    .join('\n');
}

export { scanText, scanEnv, isSecretLiteral, PUBLIC_ENV_PREFIX, envMessage, bundleMessage, type SecretFinding } from './secrets.ts';
export { lex, parse, link, buildSpec, serialiseSpec as serialise };
