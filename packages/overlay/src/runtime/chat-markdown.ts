/**
 * @az runtime chat-markdown
 * Purpose: the prose subset an answer may be formatted in, read into a closed tree — paragraphs, two kinds of list, code blocks; strong, em, code.
 * Spec: docs/chat-block-spec.md §21.1.2, §21.1.3
 * Exports: proseBlocks, proseInlines, plainText, spokenText, ProseBlock, ProseInline, CODE_LANG, FENCE, SPOKEN_CODE
 * Edit guide: no DOM here; one pass per piece, no regular expression that can backtrack; anything outside the subset stays the text it is —
 *   the tree has no attribute, no URL and no tag name a model can choose.
 * Tests: packages/overlay/test/chat-markdown.test.ts
 */

/**
 * The model's prose reaches the page as text (`text` events). C5 lets it
 * carry a small markdown subset (chat-block-spec §21.1.2). This reads it into
 * a tree whose every node is one of a closed set and whose every leaf is a
 * string the page writes with `textContent`:
 *
 *   blocks   paragraph · bullet list (`- `, `* `) · numbered list (`N. `) ·
 *            code block (a line at the margin starting ```, up to a line
 *            that is ``` alone)
 *   inlines  text · `code` · **strong** / __strong__ · *em* / _em_
 *
 * Everything else — headings, quotes, tables, links, images, autolinks,
 * HTML, entities — is text, exactly as written: nothing here can name an
 * element, an attribute or an address. Nesting stops at two (strong in em,
 * em in strong); a list is one level; a list item is one line.
 */

/** The line that opens and closes a code block, at the margin (the server's chat-answer.ts FENCE). */
export const FENCE = '```';

/** A code block's language word: shown as a text label, or none. */
export const CODE_LANG = /^[A-Za-z0-9_+#.-]{1,20}$/;

export type ProseInline =
  | { readonly t: 'text'; readonly s: string }
  | { readonly t: 'code'; readonly s: string }
  | { readonly t: 'strong' | 'em'; readonly c: readonly ProseInline[] };

export type ProseBlock =
  | { readonly t: 'p'; readonly c: readonly ProseInline[] }
  | { readonly t: 'ul'; readonly items: readonly (readonly ProseInline[])[] }
  | { readonly t: 'ol'; readonly start: number; readonly items: readonly (readonly ProseInline[])[] }
  | { readonly t: 'code'; readonly lang: string | null; readonly s: string; readonly open: boolean };

/** The deepest emphasis may nest. */
const DEPTH = 2;

const isSpace = (ch: string | undefined): boolean => ch === undefined || ch === ' ' || ch === '\n' || ch === '\t';
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

/** A line without its trailing spaces (only spaces: the server's fence rule is the same). */
const trimSpaces = (line: string): string => {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') end--;
  return line.slice(0, end);
};

/** A list line's marker and its text, or null: `- x`, `* x` (bullet) or `12. x` (numbered); spaces before the marker are ignored. */
function listLine(line: string): { readonly kind: 'ul' | 'ol'; readonly n: number; readonly text: string } | null {
  let i = 0;
  while (line[i] === ' ') i++;
  const c = line[i];
  if ((c === '-' || c === '*') && line[i + 1] === ' ') return { kind: 'ul', n: 0, text: line.slice(i + 2) };
  let j = i;
  while (j < line.length && j - i < 4 && line[j] >= '0' && line[j] <= '9') j++;
  const digits = j - i;
  if (digits >= 1 && digits <= 3 && line[j] === '.' && line[j + 1] === ' ') return { kind: 'ol', n: Number(line.slice(i, j)), text: line.slice(j + 2) };
  return null;
}

/**
 * The text of `s` as inlines: code spans first (a run of n backticks closed
 * by the next run of exactly n), then emphasis by a stack — a closer matches
 * only the innermost opener, so the pass is linear. Unmatched delimiters are
 * text.
 */
export function proseInlines(s: string): ProseInline[] {
  // Where each run of backticks starts, by its length — so finding a code span's closer never re-scans.
  const runs = new Map<number, number[]>();
  for (let i = 0; i < s.length;) {
    if (s[i] === '\\' && i + 1 < s.length) { i += 2; continue; }
    if (s[i] !== '`') { i++; continue; }
    let j = i;
    while (s[j] === '`') j++;
    const list = runs.get(j - i) ?? [];
    list.push(i);
    runs.set(j - i, list);
    i = j;
  }
  const next = new Map<number, number>();
  /** The first run of `n` backticks that starts after `at`, or -1. */
  const closer = (n: number, at: number): number => {
    const list = runs.get(n);
    if (!list) return -1;
    let k = next.get(n) ?? 0;
    while (k < list.length && list[k] <= at) k++;
    next.set(n, k);
    return k < list.length ? list[k] : -1;
  };

  interface Frame { readonly ch: string; readonly n: number; readonly c: ProseInline[] }
  const root: ProseInline[] = [];
  const stack: Frame[] = [];
  let text = '';
  const here = () => (stack.length > 0 ? stack[stack.length - 1].c : root);
  const flush = () => {
    if (text === '') return;
    const into = here();
    const last = into[into.length - 1];
    if (last?.t === 'text') into[into.length - 1] = { t: 'text', s: last.s + text };
    else into.push({ t: 'text', s: text });
    text = '';
  };
  const put = (node: ProseInline, into: ProseInline[]) => {
    const last = into[into.length - 1];
    if (node.t === 'text' && last?.t === 'text') into[into.length - 1] = { t: 'text', s: last.s + node.s };
    else into.push(node);
  };

  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\' && (s[i + 1] === '*' || s[i + 1] === '_' || s[i + 1] === '`' || s[i + 1] === '\\')) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      let j = i;
      while (s[j] === '`') j++;
      const n = j - i;
      const end = closer(n, i);
      if (end < 0) { text += s.slice(i, j); i = j; continue; }
      let code = s.slice(j, end);
      // One space either side is padding, when both are there and the code is not all spaces.
      if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim() !== '') code = code.slice(1, -1);
      flush();
      here().push({ t: 'code', s: code });
      i = end + n;
      continue;
    }
    if (ch === '*' || ch === '_') {
      let j = i;
      while (s[j] === ch) j++;
      const n = j - i;
      const before = s[i - 1];
      const after = s[j];
      if (n >= 3) { text += s.slice(i, j); i = j; continue; }
      const left = !isSpace(after);
      const right = i > 0 && !isSpace(before);
      const opens = ch === '_' ? left && !isWordChar(before) : left;
      const closes = ch === '_' ? right && !isWordChar(after) : right;
      const top = stack[stack.length - 1];
      if (closes && top && top.ch === ch && top.n === n) {
        flush();
        stack.pop();
        put({ t: n === 2 ? 'strong' : 'em', c: top.c }, here());
      } else if (opens && stack.length < DEPTH) {
        flush();
        stack.push({ ch, n, c: [] });
      } else {
        text += s.slice(i, j);
      }
      i = j;
      continue;
    }
    text += ch;
    i++;
  }
  flush();
  // Openers never closed are the text they were, their contents kept in place.
  while (stack.length > 0) {
    const f = stack.pop()!;
    const into = here();
    put({ t: 'text', s: f.ch.repeat(f.n) }, into);
    for (const node of f.c) put(node, into);
  }
  return root;
}

/**
 * A piece of an answer's prose as blocks. A blank (or all-space) line ends a
 * paragraph or a list; a list line starts a list or continues one of its
 * kind; a fence at the margin starts a code block whose lines are kept
 * verbatim up to a fence alone — or to the end, still `open`.
 */
export function proseBlocks(text: string): ProseBlock[] {
  const out: ProseBlock[] = [];
  const lines = text.split('\n');
  let para: string[] = [];
  let list: { kind: 'ul' | 'ol'; start: number; items: string[] } | null = null;
  const endPara = () => {
    if (para.length > 0) out.push({ t: 'p', c: proseInlines(para.join('\n')) });
    para = [];
  };
  const endList = () => {
    if (!list) return;
    const items = list.items.map(proseInlines);
    out.push(list.kind === 'ul' ? { t: 'ul', items } : { t: 'ol', start: list.start, items });
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(FENCE)) {
      endPara();
      endList();
      const info = line.slice(FENCE.length).trim();
      const body: string[] = [];
      let open = true;
      for (i++; i < lines.length; i++) {
        if (trimSpaces(lines[i]) === FENCE) { open = false; break; }
        body.push(lines[i]);
      }
      out.push({ t: 'code', lang: CODE_LANG.test(info) ? info : null, s: body.join('\n'), open });
      continue;
    }
    if (line.trim() === '') { endPara(); endList(); continue; }
    const item = listLine(line);
    if (item) {
      endPara();
      if (list && list.kind !== item.kind) endList();
      if (!list) list = { kind: item.kind, start: item.n, items: [] };
      list.items.push(item.text);
      continue;
    }
    endList();
    para.push(line);
  }
  endPara();
  endList();
  return out;
}

/** The inlines' text without formatting. */
export function plainText(nodes: readonly ProseInline[]): string {
  let s = '';
  for (const n of nodes) s += n.t === 'text' || n.t === 'code' ? n.s : plainText(n.c);
  return s;
}

/** What a code block is called in the status region. */
export const SPOKEN_CODE = 'A code block.';

/**
 * Prose as the status region says it (§9, §21.1.6): the words without their
 * marks — no asterisk or backtick read aloud — each list item and paragraph
 * its own sentence, and a code block named, not spelt out.
 */
export function spokenText(text: string): string {
  const parts: string[] = [];
  for (const b of proseBlocks(text)) {
    if (b.t === 'p') parts.push(plainText(b.c));
    else if (b.t === 'code') parts.push(SPOKEN_CODE);
    else for (const item of b.items) parts.push(plainText(item));
  }
  return parts.map((p) => p.trim()).filter((p) => p !== '').join(' ');
}
