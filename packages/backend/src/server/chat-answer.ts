/**
 * @az server chat-answer
 * Purpose: the answer parser: a model's text, read line by line, becomes the closed set of page events — prose, or a component validated whole.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §5.3, §6.1, §6.2)
 * Exports: createAnswerParser, cleanText, stripText, AnswerParser, AnswerEvent, AnswerBlock, AnswerRules, AnswerQuote, DropReason, ANSWER_LIMITS, ANSWER_WORDS, ANSWER_FORMS, lineTokens, quoteKey
 * Edit guide: linear in the characters read, no regular expression that can backtrack; a line that does not parse is prose; a component that breaks a rule is dropped whole and never shown as syntax.
 * Tests: packages/backend/test/chat-answer.test.ts, packages/backend/test/chat-attacks.test.ts
 */

/**
 * What a model may put in an answer (chat-block-spec §5.3): prose, and a
 * few components written as a small subset of `.az`:
 *
 *     show pricing /pricing          the site's own pricing block, quoted
 *     faq                            questions and answers, composed
 *       item "Can I switch plans?"
 *         text "Yes, at any time."
 *     cta "Talk to us" /contact      one call to action
 *     feature                        a short list, composed
 *       item "Fast"
 *         text "Pages are pre-rendered."
 *
 * The model is an untrusted author, so its text is read here, on the
 * server, and the page only ever receives the typed events below:
 *
 *   - a line whose first word cannot start a component is prose, streamed
 *     as it arrives; a line that starts with one is held to its end and
 *     parsed — when it does not have a component's shape it is prose too;
 *   - a component is held until its block ends (a line at the margin, a
 *     blank line, or the end of the answer), then checked whole: the page's
 *     `show` list, the site's quotable blocks, the destination allow-list,
 *     every count and length. One that breaks any rule is DROPPED — it
 *     leaves no trace, not even as text, so an injection that fails is
 *     invisible rather than half-rendered;
 *   - `pricing` is quote-only: a pricing block the model composes is
 *     dropped, so a visitor only ever sees the author's prices (L8);
 *   - strings lose control, bidirectional and zero-width characters and are
 *     NFC-normalised; nothing is decoded as an HTML entity.
 *
 * Caps per answer: ANSWER_LIMITS. Past the prose cap or the component cap
 * the parser ends (`ended`), and the route stops reading the model.
 *
 * Copied into a generated server; imports nothing.
 */

/** Every cap the parser holds (chat-block-spec §5.3, §6.1). The prompt is generated from these too. */
export const ANSWER_LIMITS = {
  /** Components in one answer; the next one ends the answer. */
  components: 4,
  /** Characters of prose in one answer. */
  prose: 4_000,
  /** Characters of one line that is held to be parsed (a component, or prose that starts like one). */
  line: 2_000,
  /** Items of an faq or a feature list. */
  items: 6,
  question: 160,
  answer: 600,
  title: 80,
  text: 300,
  label: 40,
  /**
   * The answer as the page sends it back as history (`record`): prose and
   * every shown component in its canonical lines. A component that would
   * pass this is dropped, so a tagged answer always fits a history turn.
   */
  record: 12_000,
} as const;

/** The components an answer may hold — the closed list `show` takes (chat-block-spec §3.2). */
export const ANSWER_WORDS = ['pricing', 'faq', 'cta', 'feature'] as const;
export type AnswerWord = (typeof ANSWER_WORDS)[number];

/** A block the site lets answers quote, as context.json lists it: its word, its page, its position there. */
export interface AnswerQuote { readonly word: AnswerWord; readonly route: string; readonly n: number }

/** What one chat page's answers may show, quote and link to (from context.json). */
export interface AnswerRules {
  readonly show: readonly AnswerWord[];
  readonly quotes: readonly AnswerQuote[];
  readonly destinations: readonly string[];
}

/** One component, validated: exactly what the page's templates are filled with. */
export type AnswerBlock =
  | { readonly quote: 'pricing'; readonly route: string; readonly n: number }
  | { readonly faq: readonly { readonly q: string; readonly a: string }[] }
  | { readonly cta: { readonly label: string; readonly to: string } }
  | { readonly feature: readonly { readonly title: string; readonly text: string }[] };

export type AnswerEvent =
  | { readonly type: 'text'; readonly s: string }
  | { readonly type: 'block'; readonly block: AnswerBlock };

/** Why a component was dropped — counted and logged by kind, never with its text. */
export type DropReason =
  | 'not_shown' | 'no_quote' | 'composed_pricing' | 'destination' | 'shape'
  | 'too_long' | 'too_many' | 'empty' | 'components' | 'record';

/**
 * Each form the model is taught, in the order the prompt lists them: what
 * it writes, and what it is for. The parser above is the rule; this is its
 * description, kept beside it so the two never drift.
 */
export const ANSWER_FORMS: Readonly<Record<AnswerWord, { readonly lines: readonly string[]; readonly about: string }>> = {
  pricing: {
    lines: ['show pricing /pricing'],
    about: `the site's own pricing block of a page, exactly as the site shows it, #2 after the page for its second one; never write a price or a plan yourself — a pricing block you write is not shown`,
  },
  faq: {
    lines: ['faq', `  item "A question, at most ${ANSWER_LIMITS.question} characters"`, `    text "Its answer, at most ${ANSWER_LIMITS.answer} characters"`],
    about: `questions and answers, 1 to ${ANSWER_LIMITS.items} items, each item with its text`,
  },
  cta: {
    lines: [`cta "A label, at most ${ANSWER_LIMITS.label} characters" /contact`],
    about: 'one button to a destination from the list at the end, written exactly as listed; any other destination is not shown',
  },
  feature: {
    lines: ['feature', `  item "A title, at most ${ANSWER_LIMITS.title} characters"`, `    text "One or two sentences, at most ${ANSWER_LIMITS.text} characters"`],
    about: `a short list, 1 to ${ANSWER_LIMITS.items} items; the text line is optional`,
  },
};

/** The key a quote is found by, in context.json and the page's templates: `/pricing#0`. */
export const quoteKey = (route: string, n: number): string => `${route}#${n}`;

/**
 * Characters that never reach the page from a model: C0/C1 controls except
 * \n, bidirectional embeddings, overrides and isolates, and zero-width
 * characters (a hidden instruction or a reordered route, chat-block-spec
 * §6.1). Each is one UTF-16 unit, so removing them is safe on any piece of
 * a stream. A CR goes with them: a CRLF reads as a LF.
 */
const STRIPPED = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
/** Model text without those characters. */
export const stripText = (s: string): string => s.replace(STRIPPED, '');
/** Model text as inert prose: stripped and NFC-normalised. Entities stay as written — nothing is decoded. */
export const cleanText = (s: string): string => stripText(s).normalize('NFC');

/** The first words a line may start a component with; any other first word makes the line prose at once. */
const KEYWORDS: readonly string[] = ['text', 'show', 'faq', 'cta', 'feature', 'pricing'];
const LONGEST_KEYWORD = Math.max(...KEYWORDS.map((k) => k.length));
const isKeywordPrefix = (s: string) => KEYWORDS.some((k) => k.startsWith(s));

/** The variants a model may write after `faq`, `feature` or `pricing`; the page draws its own template either way. */
const OPENER_WORDS: Readonly<Record<string, readonly string[]>> = {
  faq: ['list', 'columns'],
  feature: ['grid', 'rows', 'bento'],
  pricing: ['cards', 'table', 'reveal'],
};

/** One token of a held line: a quoted string (decoded) or a bare run. */
export interface LineToken { readonly kind: 'string' | 'bare'; readonly value: string }

/**
 * A line's tokens by GRAMMAR §1.5–1.6's rules — strings in double quotes
 * with exactly three escapes (\" \\ \n), bare runs between spaces — or null
 * when the line does not lex (an unterminated string, another escape, a
 * quote inside a bare run). One pass, no backtracking.
 */
export function lineTokens(line: string): LineToken[] | null {
  const out: LineToken[] = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === ' ') { i++; continue; }
    if (c === '"') {
      let value = '';
      i++;
      let closed = false;
      while (i < line.length) {
        const d = line[i];
        if (d === '"') { closed = true; i++; break; }
        if (d === '\\') {
          const e = line[i + 1];
          if (e === '"' || e === '\\') value += e;
          else if (e === 'n') value += '\n';
          else return null;
          i += 2;
          continue;
        }
        value += d;
        i++;
      }
      if (!closed) return null;
      // A string ends its token: `"a"b` is two values glued, which az never writes.
      if (i < line.length && line[i] !== ' ') return null;
      out.push({ kind: 'string', value });
      continue;
    }
    const start = i;
    while (i < line.length && line[i] !== ' ') {
      if (line[i] === '"') return null;
      i++;
    }
    out.push({ kind: 'bare', value: line.slice(start, i) });
  }
  return out;
}

/** A string as the canonical lines write it: the three escapes, nothing else. */
const quoted = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;


/** Whether `ch` (one code point) is a combining mark — it may still join the character before it. */
const MARK = /\p{M}/u;

type BlockKind = 'faq' | 'feature' | 'cta' | 'show' | 'pricing' | 'dropped';

/** A component being read: its first line, its items, and the first rule it broke. */
interface Open {
  readonly kind: BlockKind;
  readonly head: readonly LineToken[];
  readonly items: { title: string; text: string | null }[];
  broken: DropReason | null;
}

export interface AnswerParser {
  /** Text in, as it arrives; the events it completed out. Nothing is read once `ended`. */
  push(text: string): AnswerEvent[];
  /** The rest, at the end of the answer: the last line and any component still open. */
  end(): AnswerEvent[];
  /** A cap was passed: stop reading the model. */
  readonly ended: boolean;
  /** Characters of prose sent. */
  readonly prose: number;
  /** Components dropped so far, by reason. */
  readonly dropped: readonly DropReason[];
  /** The answer as the page will send it back: prose, and each shown component's canonical lines. */
  readonly record: string;
}

/**
 * A parser for one answer under `rules`. Line states: at the start of a
 * line (`start`), deciding on its first word (`word`), holding it whole to
 * parse at its end (`hold`), or streaming it as prose (`prose`).
 */
export function createAnswerParser(rules: AnswerRules): AnswerParser {
  let state: 'start' | 'word' | 'hold' | 'prose' = 'start';
  let line = '';
  /** A held line passed ANSWER_LIMITS.line; it is read to its end and judged too long. */
  let over = false;
  /** Prose of the current line not sent yet: at most one code point and its marks, held so NFC never splits a character. */
  let tail = '';
  let open: Open | null = null;
  let ended = false;
  let prose = 0;
  let shown = 0;
  let record = '';
  const dropped: DropReason[] = [];
  let out: AnswerEvent[] = [];
  let pendingText = '';

  const flushText = () => {
    if (pendingText === '') return;
    out.push({ type: 'text', s: pendingText });
    pendingText = '';
  };

  /** Send prose, within the cap; past it the answer ends. */
  const say = (s: string) => {
    if (ended || s === '') return;
    let piece = s;
    const room = ANSWER_LIMITS.prose - prose;
    if (piece.length >= room) {
      let end = Math.max(0, room);
      const c = piece.charCodeAt(end - 1);
      if (end > 0 && c >= 0xd800 && c <= 0xdbff) end--;
      piece = piece.slice(0, end);
      ended = true;
    }
    prose += piece.length;
    record += piece;
    pendingText += piece;
  };

  /** Prose of a streamed line, holding back its last character (and marks) until the next arrives. */
  const streamProse = (s: string) => {
    const all = tail + s;
    let cut = all.length;
    // Back over trailing marks to the character they sit on, and that one too.
    while (cut > 0) {
      const cp = all.codePointAt(cut - 1)!;
      const low = cp >= 0xdc00 && cp <= 0xdfff && cut >= 2;
      const start = low ? cut - 2 : cut - 1;
      const ch = all.slice(start, cut);
      cut = start;
      if (!MARK.test(ch)) break;
    }
    tail = all.slice(cut);
    say(cleanText(all.slice(0, cut)));
  };

  const drop = (reason: DropReason) => { dropped.push(reason); };

  /** A component that passed every rule: sent, and its canonical lines added to the record. */
  const emit = (block: AnswerBlock, lines: string) => {
    if (shown >= ANSWER_LIMITS.components) {
      drop('components');
      ended = true;
      return;
    }
    if (record.length + lines.length > ANSWER_LIMITS.record) { drop('record'); return; }
    shown++;
    flushText();
    record += lines;
    out.push({ type: 'block', block });
  };

  const allowed = (word: AnswerWord) => rules.show.includes(word);

  /** A string value for an event: cleaned, then held to its cap — or the rule it breaks. */
  const value = (raw: string, max: number, required: boolean): { readonly v: string } | { readonly why: DropReason } => {
    const v = cleanText(raw).trim();
    if (v === '') return required ? { why: 'empty' } : { v: '' };
    return v.length > max ? { why: 'too_long' } : { v };
  };

  /** Close the open component: check it whole, then emit it or drop it. */
  const close = () => {
    const b = open;
    open = null;
    if (!b) return;
    // A pricing block the model wrote is refused for what it is, whatever its shape (L8).
    if (b.kind === 'pricing') { drop('composed_pricing'); return; }
    if (b.kind === 'dropped' || b.broken) { drop(b.broken ?? 'shape'); return; }
    if (b.kind === 'show') {
      const word = b.head[1].value;
      const dest = b.head[2].value;
      if (word !== 'pricing' || !allowed('pricing')) { drop('not_shown'); return; }
      const hash = dest.indexOf('#');
      const route = hash < 0 ? dest : dest.slice(0, hash);
      const suffix = hash < 0 ? '1' : dest.slice(hash + 1);
      // `#2` is the page's second pricing block; anything else after # is no block.
      const nth = /^[1-9][0-9]{0,2}$/.test(suffix) ? Number(suffix) - 1 : -1;
      if (!rules.quotes.some((q) => q.word === 'pricing' && q.route === route && q.n === nth)) { drop('no_quote'); return; }
      emit({ quote: 'pricing', route, n: nth }, `show pricing ${route}${nth > 0 ? `#${nth + 1}` : ''}\n`);
      return;
    }
    if (b.kind === 'cta') {
      if (!allowed('cta')) { drop('not_shown'); return; }
      const label = value(b.head[1].value, ANSWER_LIMITS.label, true);
      if ('why' in label) { drop(label.why); return; }
      const to = b.head[2].value;
      // The allow-list is exact: the destination as the .az file wrote it, nothing near it.
      if (!rules.destinations.includes(to)) { drop('destination'); return; }
      emit({ cta: { label: label.v, to } }, `cta ${quoted(label.v)} ${to}\n`);
      return;
    }
    // faq / feature: composed lists.
    const word = b.kind;
    if (!allowed(word)) { drop('not_shown'); return; }
    if (b.items.length === 0) { drop('empty'); return; }
    const [titleMax, textMax] = word === 'faq' ? [ANSWER_LIMITS.question, ANSWER_LIMITS.answer] : [ANSWER_LIMITS.title, ANSWER_LIMITS.text];
    const items: { title: string; text: string }[] = [];
    for (const it of b.items) {
      const title = value(it.title, titleMax, true);
      if ('why' in title) { drop(title.why); return; }
      // An faq answer is required; a feature's text is not.
      const text = it.text === null ? (word === 'faq' ? { why: 'empty' as const } : { v: '' }) : value(it.text, textMax, word === 'faq');
      if ('why' in text) { drop(text.why); return; }
      items.push({ title: title.v, text: text.v });
    }
    const lines = `${word}\n${items.map((i) => `  item ${quoted(i.title)}\n${i.text ? `    text ${quoted(i.text)}\n` : ''}`).join('')}`;
    emit(word === 'faq' ? { faq: items.map((i) => ({ q: i.title, a: i.text })) } : { feature: items }, lines);
  };

  /** An indented line inside the open component: an item, or an item's text. Anything else breaks it. */
  const child = (raw: string) => {
    const b = open!;
    if (b.broken) return;
    if (over) { b.broken = 'too_long'; return; }
    if (b.kind !== 'faq' && b.kind !== 'feature') { b.broken = 'shape'; return; }
    let indent = 0;
    while (indent < raw.length && raw[indent] === ' ') indent++;
    const tokens = lineTokens(raw.slice(indent));
    const one = tokens !== null && tokens.length === 2 && tokens[0].kind === 'bare' && tokens[1].kind === 'string';
    if (indent === 2 && one && tokens![0].value === 'item') {
      if (b.items.length >= ANSWER_LIMITS.items) { b.broken = 'too_many'; return; }
      b.items.push({ title: tokens![1].value, text: null });
      return;
    }
    if (indent === 4 && one && tokens![0].value === 'text' && b.items.length > 0 && b.items.at(-1)!.text === null) {
      b.items.at(-1)!.text = tokens![1].value;
      return;
    }
    // Deeper than two levels, a second text, an unknown line: the component goes.
    b.broken = 'shape';
  };

  /** A held line at the margin, whole: a component's first line, explicit prose, or prose after all. */
  const head = (raw: string, newline: boolean) => {
    const asProse = () => say(cleanText(raw) + (newline ? '\n' : ''));
    if (over) {
      // Too long to be a component; too long to show as the line it is.
      open = { kind: 'dropped', head: [], items: [], broken: 'too_long' };
      return;
    }
    const t = lineTokens(raw);
    if (t === null || t.length === 0 || t[0].kind !== 'bare') { asProse(); return; }
    const [first, ...rest] = t;
    const bare = (i: number) => rest[i]?.kind === 'bare';
    const str = (i: number) => rest[i]?.kind === 'string';
    switch (first.value) {
      case 'text':
        if (rest.length === 1 && str(0)) say(cleanText(rest[0].value) + '\n');
        else asProse();
        return;
      case 'show':
        if (rest.length === 2 && bare(0) && bare(1)) open = { kind: 'show', head: t, items: [], broken: null };
        else asProse();
        return;
      case 'cta':
        if (rest.length === 2 && str(0) && bare(1)) open = { kind: 'cta', head: t, items: [], broken: null };
        else asProse();
        return;
      case 'faq':
      case 'feature':
      case 'pricing': {
        const words = OPENER_WORDS[first.value];
        if (rest.every((r) => r.kind === 'bare' && words.includes(r.value)) && rest.length <= 2) {
          open = { kind: first.value, head: t, items: [], broken: null };
        } else asProse();
        return;
      }
      default:
        asProse();
    }
  };

  /** The current line ends (at a newline, or at the end of the answer). */
  const endLine = (newline: boolean) => {
    if (state === 'prose') {
      const rest = tail;
      tail = '';
      say(cleanText(rest) + (newline ? '\n' : ''));
    } else if (state === 'word' || state === 'hold') {
      if (open && line.startsWith(' ')) child(line);
      else head(line, newline);
    } else if (state === 'start' && newline) {
      // A blank line: it ends a component, or it is a paragraph break.
      if (open) close();
      else say('\n');
    }
    state = 'start';
    line = '';
    over = false;
  };

  /** Hold one more character of the current line, within the line cap. */
  const hold = (ch: string) => {
    if (line.length < ANSWER_LIMITS.line) line += ch;
    else over = true;
  };

  const push = (input: string): AnswerEvent[] => {
    out = [];
    const text = stripText(input);
    let i = 0;
    while (i < text.length && !ended) {
      const ch = text[i];
      if (ch === '\n') { endLine(true); i++; continue; }
      if (state === 'start') {
        // The first character decides whether an open component goes on.
        if (open && ch !== ' ') close();
        if (ended) break;
        if (ch === ' ') state = open ? 'hold' : 'prose';
        else state = 'word';
      }
      if (state === 'prose') {
        // Everything up to the next newline at once.
        let j = i;
        while (j < text.length && text[j] !== '\n') j++;
        streamProse(text.slice(i, j));
        i = j;
        continue;
      }
      if (state === 'word') {
        hold(ch);
        i++;
        if (ch === ' ') {
          // The first word is complete: a keyword holds the line, anything else is prose now.
          const word = line.slice(0, -1);
          if (KEYWORDS.includes(word)) state = 'hold';
          else { const held = line; line = ''; state = 'prose'; streamProse(held); }
        } else if (line.length > LONGEST_KEYWORD || !isKeywordPrefix(line)) {
          const held = line;
          line = '';
          state = 'prose';
          streamProse(held);
        }
        continue;
      }
      // hold: to the end of the line, bounded.
      let j = i;
      while (j < text.length && text[j] !== '\n') j++;
      const piece = text.slice(i, j);
      const room = ANSWER_LIMITS.line - line.length;
      if (piece.length > room) { line += piece.slice(0, Math.max(0, room)); over = true; } else line += piece;
      i = j;
    }
    flushText();
    return out;
  };

  return {
    push,
    end(): AnswerEvent[] {
      out = [];
      if (!ended) {
        if (state !== 'start') endLine(false);
        if (!ended) close();
      } else {
        // Ended by a cap: what was sent stands, and nothing open is shown.
        if (open) { open = null; }
      }
      flushText();
      return out;
    },
    get ended() { return ended; },
    get prose() { return prose; },
    get dropped() { return dropped; },
    get record() { return record; },
  };
}
