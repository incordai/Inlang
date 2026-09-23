/**
 * @az module parse
 * Purpose: tokens → statements (the AST) with the version marker checked.
 * Spec: docs/GRAMMAR.md §3
 * Exports: parse, Statement, Arg, AzFile, SUPPORTED_VERSION
 * Edit guide: grammar shape changes go here and in GRAMMAR.md together; codes AZ11xx.
 * Tests: packages/core/test/parse.test.ts
 */

/**
 * Parser — tokens to AST.
 *
 * Implements GRAMMAR.md §3.1 (core grammar) and §7 (error recovery).
 *
 * The parser is deliberately tiny and knows NOTHING about `hero`, `site` or
 * any other word. Every construct is one statement shape; what a statement
 * MEANS is decided at link stage against `word.json`. That ignorance is what
 * lets a word be added as a folder without touching core (PRD principle 5).
 */

import type { Diagnostic, Pos, Token } from './lex.ts';

export type ArgKind = 'word' | 'string' | 'number' | 'path' | 'route' | 'anchor' | 'pair';

export interface Arg {
  readonly kind: ArgKind;
  readonly value: string;
  readonly pos: Pos;
}

export interface Statement {
  /** The leading word. Meaning is resolved later, not here. */
  readonly word: string;
  readonly args: Arg[];
  /** The `as` override, GRAMMAR §3.1 — the language's only keyword besides `az`. */
  readonly as: string | null;
  readonly children: Statement[];
  readonly pos: Pos;
}

export interface AzFile {
  /** The version marker's value — `1` today. PRD §5 stability policy. */
  readonly version: string | null;
  readonly body: Statement[];
}

export interface ParseResult {
  readonly file: AzFile;
  readonly diagnostics: Diagnostic[];
  /** A version error stopped parsing (GRAMMAR §7.3); the body is empty. */
  readonly fatal: boolean;
}

/** GRAMMAR §1.9: the one version this compiler reads. */
export const SUPPORTED_VERSION = '1';

const ARG_KINDS: ReadonlySet<string> =
  new Set(['word', 'string', 'number', 'path', 'route', 'anchor', 'pair']);

export function parse(tokens: Token[], lexDiagnostics: Diagnostic[] = []): ParseResult {
  const diagnostics: Diagnostic[] = [...lexDiagnostics];
  let i = 0;
  let fatal = false;

  const peek = () => tokens[i];
  const at = (kind: string) => tokens[i]?.kind === kind;
  const err = (code: string, message: string, pos: Pos) =>
    diagnostics.push({ code, message, pos, severity: 'error' });

  /** Discard the rest of the current line. Recovery is line-granular (§7.2). */
  const skipLine = () => {
    while (i < tokens.length && !at('newline') && !at('eof')) i++;
    if (at('newline')) i++;
  };

  /**
   * Skip a body whose parent failed to parse (§7.2 rule 3).
   * Returns how many lines were discarded, so one summary diagnostic can be
   * emitted rather than a cascade of them.
   */
  const skipBody = (): number => {
    if (!at('indent')) return 0;
    let depth = 0;
    let lines = 0;
    do {
      if (at('indent')) depth++;
      else if (at('dedent')) depth--;
      else if (at('newline')) lines++;
      i++;
    } while (i < tokens.length && depth > 0 && !at('eof'));
    return lines;
  };

  function parseStatement(): Statement | null {
    const head = peek();
    if (!head || head.kind === 'eof') return null;

    // A line whose only word the lexer refused (AZ1008 `Nav`) leaves just its
    // NEWLINE — already reported, so consumed silently. A body indented under
    // that vanished line is skipped with the one summary diagnostic.
    if (head.kind === 'newline') { i++; return null; }
    if (head.kind === 'indent') {
      const skipped = skipBody();
      err('AZ1106',
          `syntax: skipped ${skipped} lines nested under the error above — fix the line above first`,
          head.pos);
      return null;
    }

    // §7.1 AZ1102 — a statement must start with a word.
    if (head.kind === 'string' || head.kind === 'pair') {
      const shown = head.kind === 'string' ? `"${head.value}"` : head.value;
      err('AZ1102',
          `syntax: line starts with '${shown}' — a statement must start with a word`,
          head.pos);
      skipLine();
      const skipped = skipBody();
      if (skipped > 0) {
        err('AZ1106',
            `syntax: skipped ${skipped} lines nested under the error above — fix the line above first`,
            head.pos);
      }
      return null;
    }

    if (head.kind !== 'word') {
      // Anything else leading a line is not a word-name (§7.1 AZ1104).
      err('AZ1104',
          `syntax: '${head.value}' is not a word — words are lowercase, letters and digits`,
          head.pos);
      skipLine();
      const skipped = skipBody();
      if (skipped > 0) {
        err('AZ1106',
            `syntax: skipped ${skipped} lines nested under the error above — fix the line above first`,
            head.pos);
      }
      return null;
    }

    i++;   // consume the word
    const args: Arg[] = [];
    let asName: string | null = null;

    while (i < tokens.length && !at('newline') && !at('eof')) {
      const t = peek();

      // `as` is recognised POSITIONALLY: arguments end at the first bare `as`.
      // A value that must literally be "as" is written quoted (§3.1).
      if (t.kind === 'word' && t.value === 'as') {
        const asTok = t;
        i++;
        if (at('newline') || at('eof') || peek()?.kind !== 'word') {
          err('AZ1101', "syntax: 'as' with no name — write: as dropdown", asTok.pos);
          break;
        }
        if (asName !== null) {
          err('AZ1103', "syntax: two 'as' clauses — one override per statement", asTok.pos);
          // §7.2 rule 2: bad argument, good word — keep the statement.
          break;
        }
        asName = peek().value;
        i++;
        continue;
      }

      if (!ARG_KINDS.has(t.kind)) break;
      args.push({ kind: t.kind as ArgKind, value: t.value, pos: t.pos });
      i++;
    }

    // §7.2 rule 2 — discard any remaining tokens on a broken line, KEEP the
    // statement. Its body still parses. One bad prop must not silence a block.
    while (i < tokens.length && !at('newline') && !at('eof')) i++;
    if (at('newline')) i++;

    const children: Statement[] = [];
    if (at('indent')) {
      i++;
      while (i < tokens.length && !at('dedent') && !at('eof')) {
        const child = parseStatement();
        if (child) children.push(child);
      }
      if (at('dedent')) i++;
    }

    return { word: head.value, args, as: asName, children, pos: head.pos };
  }

  // ---- version marker, PRD §5 ------------------------------------------
  let version: string | null = null;
  if (at('word') && peek().value === 'az') {
    const marker = peek();
    i++;
    if (at('number') || at('word')) { version = peek().value; i++; }
    while (i < tokens.length && !at('newline') && !at('eof')) i++;
    if (at('newline')) i++;
    // §7.1 AZ1105 — the marker takes no body.
    if (at('indent')) {
      err('AZ1105',
          "syntax: 'az 1' takes no body — start the site on the next line at column 0",
          marker.pos);
      skipBody();
    }
    if (version === null) {
      err('AZ1020', "file: line 1 must be 'az 1' — add the version marker at the top", marker.pos);
      fatal = true;
    } else if (version !== SUPPORTED_VERSION) {
      err('AZ1021',
          `file: version '${version}' is not supported by this compiler (supports ${SUPPORTED_VERSION}) — run az migrate`,
          marker.pos);
      fatal = true;
    }
  } else if (tokens.length <= 1) {
    // An empty file (AZ1023 from the lexer) is as fatal as a missing marker.
    fatal = true;
  } else {
    err('AZ1020', "file: line 1 must be 'az 1' — add the version marker at the top",
        peek()?.pos ?? { line: 1, col: 1 });
    fatal = true;
  }

  // GRAMMAR §7.3: both version errors are fatal — a future grammar may lex
  // differently, so nothing after the marker is read.
  const body: Statement[] = [];
  if (fatal) return { file: { version, body }, diagnostics, fatal };
  while (i < tokens.length && !at('eof')) {
    if (at('newline') || at('indent') || at('dedent')) { i++; continue; }
    const s = parseStatement();
    if (s) body.push(s);
  }

  return { file: { version, body }, diagnostics, fatal };
}
