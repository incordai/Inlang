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

const isWordChar = (c: string) => /[a-z0-9]/.test(c);

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

  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const lineNo = i + 1;

    // GRAMMAR §2.6 — blank and comment-only lines do not affect indent state.
    // Treating them as dedents is the classic indentation-parser bug: a blank
    // line inside a block would close it.
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    // ---- measure indentation -------------------------------------------
    let width = 0;
    while (width < raw.length && raw[width] === ' ') width++;
    if (raw[width] === '\t') {
      err('AZ1001', 'indent: tab used for indentation — use two spaces per level',
          lineNo, width + 1);
      continue;
    }
    if (width % INDENT_UNIT !== 0) {
      err('AZ1002',
          `indent: ${width} spaces is not a multiple of ${INDENT_UNIT} — use two spaces per level`,
          lineNo, width + 1);
      continue;
    }

    const top = stack[stack.length - 1];
    if (width > top) {
      if (width !== top + INDENT_UNIT) {
        err('AZ1003',
            `indent: jumped ${(width - top) / INDENT_UNIT} levels — indent one level at a time`,
            lineNo, width + 1);
        continue;
      }
      if (stack.length >= MAX_DEPTH + 1) {
        err('AZ1004',
            `indent: nested deeper than ${MAX_DEPTH} levels — this is content that wants its own word`,
            lineNo, width + 1);
        continue;
      }
      stack.push(width);
      push('indent', '', lineNo, width + 1);
    } else if (width < top) {
      // GRAMMAR §2.4 — a dedent must land on a column that is actually open.
      while (stack.length > 1 && stack[stack.length - 1] > width) {
        stack.pop();
        push('dedent', '', lineNo, width + 1);
      }
      if (stack[stack.length - 1] !== width) {
        err('AZ1005',
            `indent: dedent to column ${width} matches no open block — check the indentation above`,
            lineNo, width + 1);
        continue;
      }
    }

    // ---- tokenise the rest of the line ----------------------------------
    let c = width;
    while (c < raw.length) {
      const ch = raw[c];

      if (ch === ' ') { c++; continue; }

      // GRAMMAR §1.8 — a comment runs to end of line, but `#` inside a quoted
      // string is content, and a bare `#anchor` is a value. Only a `#` that
      // starts a token and is followed by space-or-end is a comment.
      if (ch === '#' && (c + 1 >= raw.length || raw[c + 1] === ' ')) break;

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
      while (c < raw.length && raw[c] !== ' ') c++;
      const text = raw.slice(start, c);
      const kind = classifyBare(text);

      // The SPECIFIC diagnostic must be reached before the general one.
      // `Aurora` fails the first-character test too, but "words are lowercase"
      // names the fix and "not a word, a path or a route" does not —
      // CONVENTIONS §5: a diagnostic with no action is a complaint.
      if (kind === 'word' && /[A-Z_]/.test(text)) {
        err('AZ1008',
            `syntax: '${text}' — words are lowercase with no underscore`,
            lineNo, start + 1);
        continue;
      }
      if (kind === 'word' && !isWordChar(text[0])) {
        err('AZ1007',
            `syntax: '${text}' is not a word, a path, a route or a quoted string`,
            lineNo, start + 1);
        continue;
      }
      push(kind, text, lineNo, start + 1);
    }

    push('newline', '', lineNo, raw.length + 1);
  }

  // close any blocks still open at EOF
  const lastLine = lines.length;
  while (stack.length > 1) { stack.pop(); push('dedent', '', lastLine, 1); }
  push('eof', '', lastLine, 1);

  return { tokens, diagnostics };
}
