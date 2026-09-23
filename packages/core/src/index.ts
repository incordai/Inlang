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

export type { Diagnostic, Pos, Token } from './lex.ts';
export type { Arg, Statement, AzFile } from './parse.ts';
export type { Manifest, LinkedWord, PropSpec } from './link.ts';
export { COMPONENT_EXT, INJECTION_POINTS } from './link.ts';
export type { Spec, SpecBlock, SpecPage, SpecSite } from './spec.ts';
export { serialiseSpec, blocksFor } from './spec.ts';
export { BACKEND_DATABASES, BACKEND_EMAIL, BACKEND_SETTINGS } from './backend.ts';
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
  const ok = !all.some((d) => d.severity === 'error');

  return { spec: built.spec, diagnostics: capped(all), ok };
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
