/**
 * @az module html-scan
 * Purpose: one pass over a page's markup — every start tag, its attributes, and the text of each raw-text element — for the build's policy and az audit.
 * Spec: docs/word-quality-gate.md §5.5 · HTML §13.2.5 (tokenization)
 * Exports: StartTag, startTags, decodeAttribute
 * Edit guide: imports only named-references.ts, which imports nothing — the CLI copies both verbatim into az-vite/ beside csp.ts, which imports this file.
 *   Linear in the page's length on any input: every character is read a bounded number of times, and nothing backtracks.
 * Tests: packages/target-web/test/html-scan.test.ts
 */

/**
 * A page's markup as a browser's tokenizer reads it, as far as a policy and
 * an audit need: start tags with their attributes, and the text of each
 * script and style element. Comments, end tags, doctypes and processing
 * instructions are passed over; so is the text of a script or style, which
 * is not markup.
 *
 * It follows HTML §13.2.5 where a regular expression could not: a `>` inside
 * a quoted attribute value does not end the tag; a script's text ends at the
 * first `</script` followed by a space, `/` or `>`; and input that ends
 * inside a tag, a quoted value or a comment ends the scan there, as the
 * browser's parser drops the unfinished token. A script or style the page
 * ends inside is dropped too: a browser never runs a script the page ends
 * in, and the regular expressions this replaced never hashed either.
 *
 * Values are returned as written, character references NOT decoded: a
 * caller that needs a value as the browser reads it decodes it with
 * `decodeAttribute`, the one decoder the build and az audit share. The
 * caller normalises line breaks when it needs the text as the browser
 * receives it (csp.ts does).
 *
 * Why not regular expressions: a pattern such as `<a\b([^>]*)>` restarts at
 * every `<` of an unclosed tag and reads to the end of the page each time —
 * quadratic, so a 900KB page of 300 000 `<a ` held a build for minutes. This
 * reads each character a bounded number of times, whatever the page holds.
 */

import { LEGACY_NAMES, NAMED_REFERENCES } from './named-references.ts';

/** One start tag in a page. */
export interface StartTag {
  /** The element's name, lowercased. */
  readonly name: string;
  /** Its attributes by lowercased name, values as written; the first of a name wins, as in HTML. */
  readonly attrs: ReadonlyMap<string, string>;
  /** For a raw-text element (script, style): its exact text, up to its end tag. */
  readonly text?: string;
}

/** HTML's raw text elements: their content is text, not markup. */
const RAW_TEXT: ReadonlySet<string> = new Set(['script', 'style']);

const TAB = 0x09;
const LF = 0x0a;
const FF = 0x0c;
const CR = 0x0d;
const SPACE = 0x20;
const BANG = 0x21;
const DQUOTE = 0x22;
const SQUOTE = 0x27;
const DASH = 0x2d;
const SLASH = 0x2f;
const EQUALS = 0x3d;
const GT = 0x3e;
const QUESTION = 0x3f;

/** HTML's whitespace: tab, line feed, form feed, carriage return, space. */
const isSpace = (c: number) => c === SPACE || c === TAB || c === LF || c === FF || c === CR;
const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);

/** A tag read from `<`: its name, its attributes, and the index just past its `>`. */
interface Read {
  readonly name: string;
  readonly attrs: Map<string, string>;
  readonly end: number;
}

/**
 * The tag whose name starts at `at` (just past `<` or `</`), or null when the
 * page ends inside it — in its name, an attribute, or a quoted value.
 */
function readTag(html: string, at: number): Read | null {
  const n = html.length;
  let i = at;
  while (i < n) {
    const c = html.charCodeAt(i);
    if (isSpace(c) || c === SLASH || c === GT) break;
    i++;
  }
  const name = html.slice(at, i).toLowerCase();
  const attrs = new Map<string, string>();
  for (;;) {
    while (i < n && (isSpace(html.charCodeAt(i)) || html.charCodeAt(i) === SLASH)) i++;
    if (i >= n) return null;
    if (html.charCodeAt(i) === GT) return { name, attrs, end: i + 1 };
    // An attribute's name: an `=` as its first character is part of it, as in the tokenizer.
    const start = i++;
    while (i < n) {
      const c = html.charCodeAt(i);
      if (isSpace(c) || c === SLASH || c === GT || c === EQUALS) break;
      i++;
    }
    const key = html.slice(start, i).toLowerCase();
    while (i < n && isSpace(html.charCodeAt(i))) i++;
    let value = '';
    if (i < n && html.charCodeAt(i) === EQUALS) {
      i++;
      while (i < n && isSpace(html.charCodeAt(i))) i++;
      if (i >= n) return null;
      const q = html.charCodeAt(i);
      if (q === DQUOTE || q === SQUOTE) {
        const close = html.indexOf(q === DQUOTE ? '"' : "'", i + 1);
        if (close < 0) return null;
        value = html.slice(i + 1, close);
        i = close + 1;
      } else {
        const from = i;
        while (i < n) {
          const c = html.charCodeAt(i);
          if (isSpace(c) || c === GT) break;
          i++;
        }
        value = html.slice(from, i);
      }
    }
    if (!attrs.has(key)) attrs.set(key, value);
  }
}

/**
 * Where the raw text that starts at `from` ends: the index of its end tag
 * `</name` (any case, then a space, `/` or `>`), or -1 when the page ends first.
 */
function rawTextEnd(html: string, from: number, name: string): number {
  let i = from;
  for (;;) {
    const at = html.indexOf('</', i);
    if (at < 0) return -1;
    const after = at + 2 + name.length;
    if (html.slice(at + 2, after).toLowerCase() === name) {
      const c = html.charCodeAt(after);
      if (isSpace(c) || c === SLASH || c === GT) return at;
    }
    i = at + 2;
  }
}

/** Every start tag in `html`, in document order. */
export function startTags(html: string): StartTag[] {
  const out: StartTag[] = [];
  const n = html.length;
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    const c = lt + 1 < n ? html.charCodeAt(lt + 1) : -1;
    if (isAlpha(c)) {
      const tag = readTag(html, lt + 1);
      if (tag === null) break;
      i = tag.end;
      if (RAW_TEXT.has(tag.name)) {
        const close = rawTextEnd(html, i, tag.name);
        // Its end tag must be whole: one the page ends inside ends nothing.
        const endTag = close < 0 ? null : readTag(html, close + 2);
        if (endTag === null) break;
        out.push({ name: tag.name, attrs: tag.attrs, text: html.slice(i, close) });
        i = endTag.end;
      } else {
        out.push({ name: tag.name, attrs: tag.attrs });
      }
    } else if (c === SLASH && lt + 2 < n && isAlpha(html.charCodeAt(lt + 2))) {
      // An end tag: read like a start tag (its quoted values may hold a `>`), then dropped.
      const tag = readTag(html, lt + 2);
      if (tag === null) break;
      i = tag.end;
    } else if (html.startsWith('<!--', lt)) {
      // A comment; `<!-->` and `<!--->` are empty ones, as the tokenizer reads them.
      const body = lt + 4;
      if (html.charCodeAt(body) === GT) i = body + 1;
      else if (html.charCodeAt(body) === DASH && html.charCodeAt(body + 1) === GT) i = body + 2;
      else {
        const close = html.indexOf('-->', body);
        if (close < 0) break;
        i = close + 3;
      }
    } else if (c === BANG || c === SLASH || c === QUESTION) {
      // A doctype, a bogus comment, `</>` or a processing instruction: to the next `>`.
      const close = html.indexOf('>', lt + 2);
      if (close < 0) break;
      i = close + 1;
    } else {
      // A `<` that opens nothing is text.
      i = lt + 1;
    }
  }
  return out;
}

/* ---- character references in an attribute value (HTML §13.2.5.72–80) ---- */

/** The highest Unicode code point; a reference past it is U+FFFD. */
const MAX_CODE_POINT = 0x10ffff;
const REPLACEMENT = '\uFFFD';

/**
 * HTML §13.2.5.80's C1 table: a reference to one of these code points
 * names the character the legacy single-byte encoding put there. 0x81,
 * 0x8D, 0x8F, 0x90 and 0x9D are not in it and are kept as they are.
 */
const C1_REMAP: ReadonlyMap<number, number> = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021],
  [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d],
  [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
]);

/** HTML's table, read from named-references.ts. */
interface Table {
  /** Every name the table spells with its `;` (left off here), to its characters. */
  readonly named: ReadonlyMap<string, string>;
  /** The names the table also allows without their `;`, each for the characters of its `name;`. */
  readonly legacy: ReadonlySet<string>;
  /** The longest name in `legacy`, so a match is looked for in a bounded prefix of the run. */
  readonly legacyMax: number;
}

let table: Table | undefined;

/** The table, built on the first named reference read — a compile that decodes none never pays for it. */
function references(): Table {
  if (table === undefined) {
    const named = new Map(NAMED_REFERENCES.trim().split(/\s+/).map((entry): [string, string] => {
      const [name, points] = entry.split(':');
      return [name, String.fromCodePoint(...points.split('+').map((p) => parseInt(p, 16)))];
    }));
    const legacy = new Set(LEGACY_NAMES.trim().split(/\s+/));
    table = { named, legacy, legacyMax: Math.max(...[...legacy].map((name) => name.length)) };
  }
  return table;
}

/**
 * A numeric reference's character, as HTML §13.2.5.80 (numeric character
 * reference end state) makes it. The value is capped once it passes
 * U+10FFFF while its digits are read, so no digit string overflows; 0, a
 * value past U+10FFFF and a surrogate are U+FFFD; 0x80–0x9F go through the
 * C1 table; every other code point — noncharacters and controls among
 * them — is kept.
 */
function numeric(digits: string, radix: 10 | 16): string {
  let n = 0;
  for (let i = 0; i < digits.length && n <= MAX_CODE_POINT; i++) n = n * radix + parseInt(digits[i], radix);
  if (n === 0 || n > MAX_CODE_POINT || (n >= 0xd800 && n <= 0xdfff)) return REPLACEMENT;
  return String.fromCodePoint(C1_REMAP.get(n) ?? n);
}

/**
 * Hexadecimal or decimal digits after `&#` (the `;` is optional, as in the
 * tokenizer), or the run of ASCII letters and digits after `&` with the
 * `;` that may end it. Every name in HTML's table is such a run, alone or
 * with its `;`, so the run holds the longest match there is. A match that
 * starts never fails later, so nothing backtracks.
 */
const REFERENCE = /&(?:#[xX]([0-9a-fA-F]+);?|#([0-9]+);?|([A-Za-z0-9]+)(;?))/g;

/** One ASCII letter or digit. */
const ALPHANUMERIC = /^[A-Za-z0-9]$/;

/**
 * A run of letters and digits after `&`, as HTML §13.2.5.73 (named
 * character reference state) reads it in an attribute value: the longest
 * name in the table the run begins with is decoded and the rest of the run
 * kept as text. A match that does not end in `;` is NOT decoded, for
 * historical reasons, when the character after it is `=` or a letter or
 * digit (`&ampx`, `&copy=`). With no match, the `&` and the run are text.
 * `next` is the character after the run and its `;` ('' at the end).
 */
function named(run: string, semicolon: boolean, next: string): string {
  const { named: names, legacy, legacyMax } = references();
  if (semicolon) {
    const characters = names.get(run);
    if (characters !== undefined) return characters;
  }
  // No `name;` matched, so the match, if any, is the longest legacy name the run begins with.
  for (let length = Math.min(run.length, legacyMax); length > 0; length--) {
    const name = run.slice(0, length);
    if (!legacy.has(name)) continue;
    const after = length < run.length ? run[length] : semicolon ? ';' : next;
    if (after === '=' || ALPHANUMERIC.test(after)) break;
    return `${names.get(name) ?? ''}${run.slice(length)}${semicolon ? ';' : ''}`;
  }
  return `&${run}${semicolon ? ';' : ''}`;
}

/**
 * An attribute value as the browser's tokenizer reads it: character
 * references decoded exactly as HTML §13.2.5 decodes them in an attribute
 * value — numeric ones, and every name in HTML's table (named-references.ts)
 * with the attribute's historical exception; any other `&` is kept as
 * written. Never throws, whatever the value holds — it is an author's
 * markup.
 */
export function decodeAttribute(value: string): string {
  return value.replace(REFERENCE, (whole: string, hex: string | undefined, dec: string | undefined,
    run: string | undefined, semicolon: string | undefined, offset: number) => {
    if (hex !== undefined) return numeric(hex, 16);
    if (dec !== undefined) return numeric(dec, 10);
    return named(run ?? '', semicolon === ';', value.charAt(offset + whole.length));
  });
}
