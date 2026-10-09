/**
 * @az module html-scan
 * Purpose: one pass over a page's markup — every start tag, its attributes, and the text of each raw-text element — for the build's policy and az audit.
 * Spec: docs/word-quality-gate.md §5.5 · HTML §13.2.5 (tokenization)
 * Exports: StartTag, startTags
 * Edit guide: imports nothing — the CLI copies this file verbatim into az-vite/ beside csp.ts, which imports it.
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
 * Values are returned as written, character references NOT decoded: each
 * caller decodes as it must. The caller normalises line breaks when it needs
 * the text as the browser receives it (csp.ts does).
 *
 * Why not regular expressions: a pattern such as `<a\b([^>]*)>` restarts at
 * every `<` of an unclosed tag and reads to the end of the page each time —
 * quadratic, so a 900KB page of 300 000 `<a ` held a build for minutes. This
 * reads each character a bounded number of times, whatever the page holds.
 */

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
