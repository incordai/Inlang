/**
 * @az module preview
 * Purpose: az dev's preview of a partial file — the longest prefix of whole blocks that compiles.
 * Spec: docs/partial-preview.md
 * Exports: compilePreview, blockStarts, PREVIEW_ATTEMPTS, Preview, PreviewResult
 * Edit guide: strict compile first, always; a prefix only ever ends before a block start; never edit the source.
 * Tests: packages/core/test/preview.test.ts
 */

/**
 * A file still being written does not compile: its last block is unfinished,
 * and its nav and footer link to pages not written yet. `az build` rightly
 * refuses it. `az dev` shows the author what IS finished instead: the
 * longest prefix of whole blocks that compiles (docs/partial-preview.md §2).
 *
 * The prefix is a slice of the author's own text, cut just before a line
 * that starts a block. Nothing is inserted, closed or guessed, so every block
 * that renders is one the compiler read in full and accepted. The only
 * check relaxed is that a route must already be a page (§3).
 */

import { compile, type CompileOptions, type CompileResult } from './index.ts';

/**
 * The most prefixes one preview compiles. Each is a whole compile, so this
 * bounds a save's work. The search starts at the block holding the first
 * error, so it is almost always one or two compiles; a file whose valid
 * prefix lies further back than this shows no preview.
 */
export const PREVIEW_ATTEMPTS = 64;

export interface Preview {
  /** The prefix that compiled: the source up to, not including, `cutLine`. */
  readonly source: string;
  /** The first line (1-based) the preview leaves out. */
  readonly cutLine: number;
  /** The prefix's compile, with routes open; `ok` is always true. */
  readonly result: CompileResult;
}

export interface PreviewResult {
  /** The whole file, compiled as `az build` compiles it. */
  readonly strict: CompileResult;
  /** Null when the strict compile succeeded (render that), or no prefix compiles. */
  readonly preview: Preview | null;
}

/** A line that starts a block: a statement at column 0, or one indent unit (2 spaces) in. */
const BLOCK_START = /^(?: {2})?[^ \t#\r]/;

/**
 * Where each block after the first line starts: its 1-based line and the
 * offset of its first character in `source`. Blank and comment lines never
 * start a block. Lines are split as the lexer splits them (`\n`, with an
 * optional `\r` before it), so the line numbers are the diagnostics' lines.
 */
export function blockStarts(source: string): { line: number; offset: number }[] {
  const out: { line: number; offset: number }[] = [];
  let offset = 0;
  for (let line = 1; offset <= source.length; line++) {
    const end = source.indexOf('\n', offset);
    const text = source.slice(offset, end < 0 ? source.length : end);
    if (line > 1 && BLOCK_START.test(text)) out.push({ line, offset });
    if (end < 0) break;
    offset = end + 1;
  }
  return out;
}

/**
 * The strict compile of `source`, and — when that fails — the longest
 * prefix ending before a block start that compiles with routes open.
 *
 * The end of the file is never a cut: the block there may be half-written,
 * and nothing says it is finished until the next block begins. So a file
 * whose only fault is its unfinished last block previews everything before
 * that block, and a file with an error in the middle previews everything
 * before the block holding it.
 *
 * A prefix that holds an error's line holds the text that caused it, so the
 * search starts at the last block start at or before the first error the
 * whole file has with routes open, and works back from there.
 */
export function compilePreview(source: string, options: CompileOptions): PreviewResult {
  const strict = compile(source, options);
  if (strict.ok) return { strict, preview: null };
  const open = compile(source, { ...options, openRoutes: true });
  const first = Math.min(...open.diagnostics.filter((d) => d.severity === 'error').map((d) => d.pos.line));
  const starts = blockStarts(source).filter((s) => s.line <= first).reverse().slice(0, PREVIEW_ATTEMPTS);
  for (const { line, offset } of starts) {
    const prefix = source.slice(0, offset);
    const result = compile(prefix, { ...options, openRoutes: true });
    if (result.ok && result.spec) return { strict, preview: { source: prefix, cutLine: line, result } };
  }
  return { strict, preview: null };
}
