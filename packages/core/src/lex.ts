/**
 * @az module lex
 * Purpose: text → tokens with positions; indentation, strings, escapes, pairs.
 * Spec: docs/GRAMMAR.md §1–§2
 * Exports: lex, Token, Diagnostic, Pos
 * Edit guide: a new token kind needs parse.ts to accept it; diagnostics use the GRAMMAR codes (AZ10xx).
 * Tests: packages/core/test/lex.test.ts, packages/core/test/escapes.test.ts
 */

/**
 * Lexer — text to tokens.
 *
 * Implements GRAMMAR.md §1 (lexical structure) and §2 (indentation).
 *
 * Two things this stage owes the rest of the compiler:
 *   1. POSITIONS on every token. The LSP needs them and diagnostics are
 *      useless without them (ARCHITECTURE §3).
 *   2. Diagnostics COLLECTED, never thrown. A file with three mistakes must
 *      report three, not the first one.
 */

export type TokenKind =
  | 'word'      // a bare name: hero, split, peek
  | 'string'    // "quoted content"
  | 'number'    // 29, 2019
  | 'path'      // ./assets/shoe.glb
  | 'route'     // /work, /
  | 'anchor'    // #pricing
  | 'pair'      // tel:+504…  — real-world URI schemes ONLY (GRAMMAR §1.7)
  | 'indent'
  | 'dedent'
  | 'newline'
  | 'eof';

export interface Pos {
  readonly line: number;   // 1-based
  readonly col: number;    // 1-based
}

export interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly pos: Pos;
}

export interface Diagnostic {
  readonly code: string;   // AZ1xxx — stable, documentable (CONVENTIONS §5)
  readonly message: string;
  readonly pos: Pos;
  readonly severity: 'error' | 'warning';
}

export interface LexResult {
  readonly tokens: Token[];
  readonly diagnostics: Diagnostic[];
}

/** GRAMMAR §2.2 — the indent unit is exactly two spaces. */
const INDENT_UNIT = 2;
/** GRAMMAR §2.5 — maximum nesting depth. */
const MAX_DEPTH = 4;

import { quotable } from './secrets.ts';

const isWordChar = (c: string) => /[a-z0-9]/.test(c);

/** GRAMMAR §1.1 — every C0 and C1 control character except tab (§2 permits it). */
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
/** GRAMMAR §1.1 — non-ASCII is legal only inside a string or a comment. */
const NON_ASCII = /[^\u0000-\u007f]/u;
/** Token separators after the first non-whitespace character (GRAMMAR §2.1). */
const isSeparator = (c: string) => c === ' ' || c === '\t';

/**
 * Classify a bare (unquoted) run of characters.
 *
 * Order matters: a route and a path both start with a punctuation mark, and a
 * scheme pair must be distinguished from a word before the colon is consumed.
 */
function classifyBare(raw: string): TokenKind {
  if (raw.startsWith('./') || raw.startsWith('../')) return 'path';
  if (raw.startsWith('/')) return 'route';
  if (raw.startsWith('#')) return 'anchor';
  // GRAMMAR §1.7: PAIR is for real-world URI schemes only. AZ's own properties
  // never use a colon — that was `font display:Sora`, since removed.
  if (/^[a-z][a-z0-9]*:/.test(raw)) return 'pair';
  if (/^-?\d+(\.\d+)?$/.test(raw)) return 'number';
  return 'word';
}

export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  const stack: number[] = [0];   // open indent columns

  const push = (kind: TokenKind, value: string, line: number, col: number) =>
    tokens.push({ kind, value, pos: { line, col } });
  const err = (code: string, message: string, line: number, col: number) =>
    diagnostics.push({ code, message, pos: { line, col }, severity: 'error' });

  // GRAMMAR §1.2 step 1 — a leading BOM is stripped and ignored. Left in, it
  // made the version marker read as the invisible non-word '\uFEFFaz'.
  const body = source.startsWith('\uFEFF') ? source.slice(1) : source;
  const lines = body.split(/\r?\n/);
  let statements = 0;

  for (let i = 0; i < lines.length; i++) {
    // §1.2 step 3 — trailing whitespace (spaces AND tabs) is stripped first,
    // so a trailing tab can never become part of a word.
    const raw = lines[i].replace(/[ \t]+$/, '');
    const lineNo = i + 1;

    // §1.1 — a control byte anywhere on the line (outside tab) is refused.
    const control = CONTROL.exec(raw);
    if (control) {
      const hex = control[0].charCodeAt(0).toString(16).padStart(2, '0');
      err('AZ1022', `file: byte 0x${hex} is not allowed — save the file as plain UTF-8 text`,
          lineNo, control.index + 1);
      continue;
    }

    // GRAMMAR §2.6 — blank and comment-only lines do not affect indent state.
    // Treating them as dedents is the classic indentation-parser bug: a blank
    // line inside a block would close it.
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    statements++;

    // ---- measure indentation -------------------------------------------
    let width = 0;
    while (width < raw.length && raw[width] === ' ') width++;
    if (raw[width] === '\t') {
      err('AZ1001', 'indent: tab character in leading whitespace — use spaces, 2 per level',
          lineNo, width + 1);
      continue;
    }
    if (width % INDENT_UNIT !== 0) {
      err('AZ1002',
          `indent: ${width} spaces is not a multiple of ${INDENT_UNIT} — use ${INDENT_UNIT} spaces per level`,
          lineNo, width + 1);
      continue;
    }

    const top = stack[stack.length - 1];
    if (width > top) {
      if (width !== top + INDENT_UNIT) {
        err('AZ1003',
            `indent: jumps ${(width - top) / INDENT_UNIT} levels at once — indent one level at a time`,
            lineNo, width + 1);
        continue;
      }
      if (stack.length >= MAX_DEPTH + 1) {
        err('AZ1005',
            `indent: ${stack.length} levels of nesting, max is ${MAX_DEPTH} — move this content into a word or flatten it`,
            lineNo, width + 1);
        continue;
      }
      stack.push(width);
      push('indent', '', lineNo, width + 1);
    } else if (width < top) {
      // GRAMMAR §2.4 — pop until the top equals the column. With a fixed
      // 2-space unit (§2.2) and one level per indent (§2.3) the open columns
      // are always 0, 2, 4…, so every even column is on the stack and a
      // dedent always lands: AZ1004 cannot occur (GRAMMAR §2.7).
      while (stack.length > 1 && stack[stack.length - 1] > width) {
        stack.pop();
        push('dedent', '', lineNo, width + 1);
      }
    }

    // ---- tokenise the rest of the line ----------------------------------
    let c = width;
    while (c < raw.length) {
      const ch = raw[c];

      if (isSeparator(ch)) { c++; continue; }

      // GRAMMAR §1.8 — a comment runs to end of line, but `#` inside a quoted
      // string is content, and a bare `#anchor` is a value. Only a `#` that
      // starts a token and is followed by space, tab or end is a comment.
      if (ch === '#' && (c + 1 >= raw.length || isSeparator(raw[c + 1]))) break;

      if (ch === '"') {
        const start = c;
        c++;
        let out = '';
        let closed = false;
        while (c < raw.length) {
          // GRAMMAR §1.5: exactly three escapes. `\n` is a newline — keeping
          // the bare `n` made an inline paragraph break impossible to write.
          if (raw[c] === '\\' && c + 1 < raw.length) {
            const next = raw[c + 1];
            if (next === 'n') out += '\n';
            else if (next === '"' || next === '\\') out += next;
            else {
              err('AZ1011', `string: '\\${next}' is not a legal escape — use \\" \\\\ or \\n`, lineNo, c + 1);
              out += next;
            }
            c += 2;
            continue;
          }
          if (raw[c] === '"') { closed = true; c++; break; }
          out += raw[c]; c++;
        }
        if (!closed) {
          err('AZ1006', 'string: no closing quote on this line — add "', lineNo, start + 1);
        }
        push('string', out, lineNo, start + 1);
        continue;
      }

      // a bare run: everything up to whitespace
      const start = c;
      while (c < raw.length && !isSeparator(raw[c])) c++;
      const text = raw.slice(start, c);
      const kind = classifyBare(text);

      // §1.1 AZ1024 — names, routes and paths are ASCII; copy goes in quotes.
      const foreign = NON_ASCII.exec(text);
      if (foreign) {
        err('AZ1024', `token: non-ASCII character '${foreign[0]}' outside a string — quote the value`,
            lineNo, start + foreign.index + 1);
        continue;
      }

      // The SPECIFIC diagnostic must be reached before the general one.
      // `Aurora` fails the first-character test too, but "words are lowercase"
      // names the fix and "not a word, a path or a route" does not —
      // CONVENTIONS §5: a diagnostic with no action is a complaint.
      if (kind === 'word' && /[A-Z_]/.test(text)) {
        err('AZ1008',
            `syntax: '${quotable(text)}' — words are lowercase with no underscore`,
            lineNo, start + 1);
        continue;
      }
      if (kind === 'word' && !isWordChar(text[0])) {
        err('AZ1007',
            `syntax: '${quotable(text)}' is not a word, a path, a route or a quoted string`,
            lineNo, start + 1);
        continue;
      }
      push(kind, text, lineNo, start + 1);
    }

    push('newline', '', lineNo, raw.length + 1);
  }

  // §1.1 AZ1023 — nothing but blank and comment lines.
  if (statements === 0) err('AZ1023', "file: empty — start with 'az 1'", 1, 1);

  // close any blocks still open at EOF
  const lastLine = lines.length;
  while (stack.length > 1) { stack.pop(); push('dedent', '', lastLine, 1); }
  push('eof', '', lastLine, 1);

  return { tokens, diagnostics };
}
