/**
 * @az server chat-answer
 * Purpose: the answer parser: a model's text, read line by line, becomes the closed set of page events — prose, or a component validated whole.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §5.3, §6.1, §6.2, §20.3, §21.1.2, §21.2.3, §21.4.2)
 * Exports: createAnswerParser, cleanText, stripText, AnswerParser, AnswerEvent, AnswerBlock, AnswerRules, AnswerQuote, AnswerPreset, DropReason, ANSWER_LIMITS, ANSWER_WORDS, ANSWER_FORMS, ASK_FORM, FENCE, QUOTE_WORDS, lineTokens, quoteKey
 * Edit guide: linear in the characters read, no regular expression that can backtrack; a line that does not parse is prose; a component that breaks a rule is dropped whole and never shown as syntax.
 * Tests: packages/backend/test/chat-answer.test.ts, packages/backend/test/chat-attacks.test.ts
 */

/**
 * What a model may put in an answer (chat-block-spec §5.3): prose, and a
 * few components written as a small subset of `.az`:
 *
 *     show pricing /pricing          the site's own pricing block, quoted
 *     show faq /help #2              the site's own questions (or one of them), quoted
 *     faq                            questions and answers, composed
 *       item "Can I switch plans?" "Yes, at any time."
 *     cta "Talk to us" /contact      one call to action
 *     feature                        a short list, composed
 *       item "Fast" "Pages are pre-rendered."
 *     ask "How do I cancel?"         a follow-up question, a button (C5)
 *     use monthly                    the author's own answer preset (§19.14)
 *
 * An item's text may also be its own line under it (`    text "…"`), the
 * long form; the model is taught the one-line form only (§19.14), and both
 * read the same, under the same caps.
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
 * Prose may carry the page's markdown subset (§21.1.2); the page reads its
 * shape. Here only fences matter: inside a code block (a line at the margin
 * starting ```), every line is prose — a component written in code is the
 * code's text, never a component.
 *
 * Caps per answer: ANSWER_LIMITS. Past the prose cap or the component cap
 * the parser ends (`ended`), and the route stops reading the model.
 *
 * Two copies of the answer are kept as it is read (chat-block-spec §19.14):
 * `record`, the prose and every shown component's canonical lines, which
 * every cap is judged on; and `history`, what the model is sent back on its
 * next question — the same prose, each long component as a one-line
 * stand-in (`[shown: faq "Can I cancel?"]`; a quote, a cta and an ask stay
 * the one line they are), and each component dropped whole as a note of its
 * word and reason code only (`(dropped: chart, number)`). The route tags the
 * history; the page draws from the events.
 *
 * The rich components — chart, table, stats, cards, dashboard (§20),
 * explore (§21.3) and map (§21.4) — are held the same way and read whole by chat-rich.ts;
 * their `from` figures and rows are filled by the route (chat.ts) before the
 * page sees them.
 *
 * Copied into a generated server; imports chat-rich.ts, and env.ts's tool types.
 */

import { linesCap, RICH_FORMS, RICH_LIMITS, RICH_WORDS, richBlock, richLines, richStandIn, type RichBlock, type RichLine, type RichWord } from './chat-rich.ts';
import type { ChatToolShape } from './env.ts';

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
  /** Follow-up questions in one answer (§21.1.2); they are not components. */
  asks: 3,
  /** A follow-up question's characters — the `ask` key's cap (§3.2). */
  ask: 80,
  /**
   * The answer as the page sends it back as history (`record`): prose and
   * every shown component in its canonical lines. A component that would
   * pass this is dropped, so a tagged answer always fits a history turn.
   */
  record: 12_000,
} as const;

/** The components an answer may hold — the closed list `show` takes (chat-block-spec §3.2, §20.1). */
export const ANSWER_WORDS = ['pricing', 'faq', 'cta', 'feature', ...RICH_WORDS] as const;
export type AnswerWord = (typeof ANSWER_WORDS)[number];

/**
 * A block the site lets answers quote, as context.json lists it: its word,
 * its page, its position there, its title; and for an faq or a feature list
 * (chat-block-spec §19.14) the author's own items, which a quote shows whole
 * or one by its number.
 */
export interface AnswerQuote {
  readonly word: AnswerWord; readonly route: string; readonly n: number;
  readonly label?: string;
  readonly items?: readonly { readonly title: string; readonly text: string }[];
}

/** The words an answer may quote from the site's own pages (§5.3, §19.14). */
export const QUOTE_WORDS: readonly AnswerWord[] = ['pricing', 'faq', 'feature'];

/** What one chat page's answers may show, quote and link to (from context.json). */
export interface AnswerRules {
  readonly show: readonly AnswerWord[];
  readonly quotes: readonly AnswerQuote[];
  readonly destinations: readonly string[];
  /** The build's image keys an image card may name (§20.6); none when absent. */
  readonly images?: readonly string[];
  /** The operator's tools a `from tool` may name (§21.2); none when absent. */
  readonly tools?: readonly ChatToolShape[];
  /** AZ_GEOCODER_URL is set: a map's `place` may be looked up (§21.4.2). */
  readonly geocoder?: boolean;
  /** The chat's answer presets (§19.14): `use <name>` shows one, read here from the author's own text. None when absent. */
  readonly presets?: readonly AnswerPreset[];
}

/** An author's answer preset (`answer <name>` in the .az file, §19.14): its name and its one component, as written. */
export interface AnswerPreset { readonly name: string; readonly text: string }

/** One component, validated: exactly what the page's templates are filled with. */
export type AnswerBlock =
  | { readonly quote: 'pricing'; readonly route: string; readonly n: number }
  | { readonly faq: readonly { readonly q: string; readonly a: string }[] }
  | { readonly cta: { readonly label: string; readonly to: string } }
  | { readonly feature: readonly { readonly title: string; readonly text: string }[] }
  | { readonly ask: string }
  | RichBlock;

export type AnswerEvent =
  | { readonly type: 'text'; readonly s: string }
  | { readonly type: 'block'; readonly block: AnswerBlock };

/** Why a component was dropped — counted and logged by kind, never with its text. */
export type DropReason =
  | 'not_shown' | 'no_quote' | 'composed_pricing' | 'destination' | 'shape'
  | 'too_long' | 'too_many' | 'empty' | 'components' | 'record' | 'number' | 'image' | 'figures' | 'tool'
  /** One view of an explore that names a column, a variable or a type that does not fit; the rest of it stands (§21.3). */
  | 'view'
  /** One map place the geocoder found nothing for, or could not look up; the rest of the map stands (§21.4). */
  | 'place';

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
    lines: ['faq', `  item "A question, at most ${ANSWER_LIMITS.question} characters" "Its answer, at most ${ANSWER_LIMITS.answer} characters"`],
    about: `questions and answers, 1 to ${ANSWER_LIMITS.items} items, each a question and its answer`,
  },
  cta: {
    lines: [`cta "A label, at most ${ANSWER_LIMITS.label} characters" /contact`],
    about: 'one button to a destination from the list at the end, written exactly as listed; any other destination is not shown',
  },
  feature: {
    lines: ['feature', `  item "A title, at most ${ANSWER_LIMITS.title} characters" "One or two sentences, at most ${ANSWER_LIMITS.text} characters"`],
    about: `a short list, 1 to ${ANSWER_LIMITS.items} items; an item's sentences are optional`,
  },
  ...RICH_FORMS,
};

/** A follow-up question as the model is taught it (§21.1.2): not a component, so outside ANSWER_FORMS. */
export const ASK_FORM = {
  lines: [`ask "A question the visitor may ask next, at most ${ANSWER_LIMITS.ask} characters"`],
} as const;

/** The line that opens and closes a code block, at the margin (§21.1.2). */
export const FENCE = '```';

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
const KEYWORDS: readonly string[] = ['text', 'show', 'faq', 'cta', 'feature', 'pricing', 'ask', 'use', ...RICH_WORDS];
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

type BlockKind = 'faq' | 'feature' | 'cta' | 'show' | 'pricing' | 'ask' | 'use' | 'rich' | 'dropped';

/** The chart kinds a `chart` head line names (chat-block-spec §20.2). */
const CHART_KINDS: readonly string[] = ['bar', 'line', 'area', 'pie', 'donut'];

/** A component being read: its first line, its items, and the first rule it broke. */
interface Open {
  readonly kind: BlockKind;
  /** The word its note names when it is dropped — always one of KEYWORDS, never the model's own text. */
  readonly word: string;
  readonly head: readonly LineToken[];
  readonly items: { title: string; text: string | null }[];
  /** A rich component's child lines, depth 1 or 2 (chat-rich.ts reads them whole). */
  readonly lines: RichLine[];
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
  /** What the answer's rich components ask of the server so far, against the answer's own caps (RICH_LIMITS). */
  readonly spent: { readonly points: number; readonly queries: number; readonly calls: number; readonly places: number };
  /** The answer whole: prose, and each shown component's canonical lines — what every cap is judged on. */
  readonly record: string;
  /**
   * The answer as the model is sent it back (§19.14): prose, a stand-in for
   * each shown component, a note for each one dropped whole. `lost` names the
   * components the route dropped after the parser passed them (their figures
   * failed, the answer was full): each is its note instead. Never longer than
   * ANSWER_LIMITS.record — a note that would pass it is left out.
   */
  history(lost?: ReadonlyMap<AnswerBlock, DropReason>): string;
}

/** One part of the answer as the model reads it back: prose, a shown component's stand-in, or a dropped one's note. */
type HistoryPart =
  | { readonly kind: 'text'; readonly s: string }
  | { readonly kind: 'shown'; readonly block: AnswerBlock; readonly word: string; readonly line: string }
  | { readonly kind: 'note'; readonly line: string };

/** A component dropped whole, as the model is told of it: its word and the reason code, nothing it wrote. */
const droppedNote = (word: string, why: DropReason): string => `(dropped: ${word}, ${why})\n`;

/** A shown component as the model reads it back: its canonical line when it is one line, else a stand-in. */
function standIn(block: AnswerBlock, lines: string): string {
  if ('faq' in block) return `[shown: faq ${block.faq.map((i) => quoted(i.q)).join(' ')}]\n`;
  if ('feature' in block) return `[shown: feature ${block.feature.map((i) => quoted(i.title)).join(' ')}]\n`;
  if ('quote' in block || 'cta' in block || 'ask' in block) return lines;
  return richStandIn(block);
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
  /** Follow-up questions shown so far (§21.1.2). */
  let asked = 0;
  /** Inside a fenced code block: every line is prose until the closing fence. */
  let fenced = false;
  /**
   * The current line started at the margin; its first characters — enough
   * to tell a fence — and whether anything but spaces follows them (a
   * closing fence is the three backticks alone; an opening one may name a
   * language). The page's chat-markdown.ts reads fences by the same rule.
   */
  let margin = false;
  let prefix = '';
  let extra = false;
  const note = (piece: string) => {
    let k = 0;
    if (prefix.length < FENCE.length) {
      k = Math.min(piece.length, FENCE.length - prefix.length);
      prefix += piece.slice(0, k);
    }
    for (; !extra && k < piece.length; k++) if (piece[k] !== ' ') extra = true;
  };
  let record = '';
  /** The answer as the model reads it back, in parts (§19.14). */
  const parts: HistoryPart[] = [];
  /**
   * The history's length without its notes, a line break counted before each
   * stand-in: held within ANSWER_LIMITS.record as components are shown, so
   * notes are the only part ever left out.
   */
  let base = 0;
  /** Data points and `from` requests across the answer's rich components (§20.2). */
  let points = 0;
  let queries = 0;
  /** `from tool` calls across the answer (§21.2.4). */
  let calls = 0;
  /** Map places to geocode across the answer (§21.4.2). */
  let places = 0;
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
    base += piece.length;
    pendingText += piece;
    const last = parts.at(-1);
    if (last?.kind === 'text') parts[parts.length - 1] = { kind: 'text', s: last.s + piece };
    else parts.push({ kind: 'text', s: piece });
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

  /** A drop counted; with `word`, a whole component, noted in the history by its word and reason (§19.14). */
  const drop = (reason: DropReason, word?: string) => {
    dropped.push(reason);
    if (word !== undefined) parts.push({ kind: 'note', line: droppedNote(word, reason) });
  };

  /** A component that passed every rule: sent, and its canonical lines added to the record; a quote is its own line in the history too. */
  const emit = (block: AnswerBlock, lines: string, word: string, quoted = false) => {
    if (shown >= ANSWER_LIMITS.components) {
      drop('components', word);
      ended = true;
      return;
    }
    const line = quoted ? lines : standIn(block, lines);
    if (record.length + lines.length > ANSWER_LIMITS.record || base + line.length + 1 > ANSWER_LIMITS.record) { drop('record', word); return; }
    shown++;
    flushText();
    record += lines;
    base += line.length + 1;
    parts.push({ kind: 'shown', block, word, line });
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
    if (b.kind === 'pricing') { drop('composed_pricing', b.word); return; }
    if (b.kind === 'dropped' || b.broken) { drop(b.broken ?? 'shape', b.word); return; }
    if (b.kind === 'rich') {
      const read = richBlock(b.head, b.lines, {
        show: rules.show, destinations: rules.destinations, images: rules.images ?? [], tools: rules.tools ?? [], geocoder: rules.geocoder === true,
      }, cleanText);
      if (!read.ok) { drop(read.why, b.word); return; }
      for (let i = 0; i < read.lostImages; i++) drop('image');
      for (let i = 0; i < read.lostViews; i++) drop('view');
      for (const why of read.lostMap) drop(why);
      // The answer's own caps: points across its components, requests the server will run.
      if (points + read.points > RICH_LIMITS.answerPoints || queries + read.queries > RICH_LIMITS.answerQueries
        || calls + read.calls > RICH_LIMITS.answerCalls || places + read.places > RICH_LIMITS.answerPlaces) { drop('too_many', b.word); return; }
      points += read.points;
      queries += read.queries;
      calls += read.calls;
      places += read.places;
      emit(read.block, richLines(read.block), b.word);
      return;
    }
    if (b.kind === 'show') {
      const word = b.head[1].value as AnswerWord;
      const dest = b.head[2].value;
      const item = b.head[3]?.value;
      if (!QUOTE_WORDS.includes(word) || !allowed(word)) { drop('not_shown', b.word); return; }
      const hash = dest.indexOf('#');
      const route = hash < 0 ? dest : dest.slice(0, hash);
      const suffix = hash < 0 ? '1' : dest.slice(hash + 1);
      // `#2` is the page's second block of the word; anything else after # is no block.
      const nth = /^[1-9][0-9]{0,2}$/.test(suffix) ? Number(suffix) - 1 : -1;
      const quote = rules.quotes.find((q) => q.word === word && q.route === route && q.n === nth);
      if (!quote) { drop('no_quote', b.word); return; }
      const at = `${route}${nth > 0 ? `#${nth + 1}` : ''}`;
      if (word === 'pricing') {
        // A pricing block is quoted whole: its plans are one table.
        if (item !== undefined) { drop('shape', b.word); return; }
        emit({ quote: 'pricing', route, n: nth }, `show pricing ${at}\n`, b.word);
        return;
      }
      // An faq or a feature list: the author's own items, whole, or the one `#n` names (§19.14), under the composed form's caps.
      const all = quote.items ?? [];
      const k = item === undefined ? -1 : /^#[1-9][0-9]?$/.test(item) ? Number(item.slice(1)) - 1 : -2;
      if (k === -2 || k >= all.length) { drop('no_quote', b.word); return; }
      const chosen = k < 0 ? all : [all[k]];
      if (chosen.length === 0) { drop('empty', b.word); return; }
      if (chosen.length > ANSWER_LIMITS.items) { drop('too_many', b.word); return; }
      const [titleMax, textMax] = word === 'faq' ? [ANSWER_LIMITS.question, ANSWER_LIMITS.answer] : [ANSWER_LIMITS.title, ANSWER_LIMITS.text];
      const items: { title: string; text: string }[] = [];
      for (const it of chosen) {
        const title = value(it.title, titleMax, true);
        if ('why' in title) { drop(title.why, b.word); return; }
        const text = value(it.text, textMax, word === 'faq');
        if ('why' in text) { drop(text.why, b.word); return; }
        items.push({ title: title.v, text: text.v });
      }
      // The record and the history hold the quote's one line; the page draws the items.
      emit(word === 'faq' ? { faq: items.map((i) => ({ q: i.title, a: i.text })) } : { feature: items }, `show ${word} ${at}${item !== undefined ? ` ${item}` : ''}\n`, b.word, true);
      return;
    }
    if (b.kind === 'use') {
      // The author's own component (§19.14), read as an answer would be, under this page's rules — never another preset.
      const name = b.head[1].value;
      const preset = (rules.presets ?? []).find((p) => p.name === name);
      if (!preset) { drop('no_quote', b.word); return; }
      const sub = createAnswerParser({ ...rules, presets: [] });
      const blocks = [...sub.push(preset.text), ...sub.end()].filter((e) => e.type === 'block');
      if (blocks.length !== 1 || sub.dropped.length > 0 || sub.prose > 0 || sub.ended) { drop(sub.dropped[0] ?? 'shape', b.word); return; }
      // It counts in the answer's caps as the component it is.
      const s = sub.spent;
      if (points + s.points > RICH_LIMITS.answerPoints || queries + s.queries > RICH_LIMITS.answerQueries
        || calls + s.calls > RICH_LIMITS.answerCalls || places + s.places > RICH_LIMITS.answerPlaces) { drop('too_many', b.word); return; }
      points += s.points;
      queries += s.queries;
      calls += s.calls;
      places += s.places;
      // The record and the history hold the one line the model wrote.
      emit(blocks[0].block, `use ${name}\n`, b.word, true);
      return;
    }
    if (b.kind === 'ask') {
      // A follow-up is one line of question: no line break, within the `ask` key's cap; past three, the rest go.
      const q = value(b.head[1].value, ANSWER_LIMITS.ask, true);
      if ('why' in q) { drop(q.why, b.word); return; }
      if (q.v.includes('\n')) { drop('shape', b.word); return; }
      if (asked >= ANSWER_LIMITS.asks) { drop('too_many', b.word); return; }
      const lines = `ask ${quoted(q.v)}\n`;
      if (record.length + lines.length > ANSWER_LIMITS.record || base + lines.length + 1 > ANSWER_LIMITS.record) { drop('record', b.word); return; }
      asked++;
      flushText();
      record += lines;
      base += lines.length + 1;
      const block = { ask: q.v };
      parts.push({ kind: 'shown', block, word: 'ask', line: lines });
      out.push({ type: 'block', block });
      return;
    }
    if (b.kind === 'cta') {
      if (!allowed('cta')) { drop('not_shown', b.word); return; }
      const label = value(b.head[1].value, ANSWER_LIMITS.label, true);
      if ('why' in label) { drop(label.why, b.word); return; }
      const to = b.head[2].value;
      // The allow-list is exact: the destination as the .az file wrote it, nothing near it.
      if (!rules.destinations.includes(to)) { drop('destination', b.word); return; }
      emit({ cta: { label: label.v, to } }, `cta ${quoted(label.v)} ${to}\n`, b.word);
      return;
    }
    // faq / feature: composed lists.
    const word = b.kind;
    if (!allowed(word)) { drop('not_shown', word); return; }
    if (b.items.length === 0) { drop('empty', word); return; }
    const [titleMax, textMax] = word === 'faq' ? [ANSWER_LIMITS.question, ANSWER_LIMITS.answer] : [ANSWER_LIMITS.title, ANSWER_LIMITS.text];
    const items: { title: string; text: string }[] = [];
    for (const it of b.items) {
      const title = value(it.title, titleMax, true);
      if ('why' in title) { drop(title.why, word); return; }
      // An faq answer is required; a feature's text is not.
      const text = it.text === null ? (word === 'faq' ? { why: 'empty' as const } : { v: '' }) : value(it.text, textMax, word === 'faq');
      if ('why' in text) { drop(text.why, word); return; }
      items.push({ title: title.v, text: text.v });
    }
    const lines = `${word}\n${items.map((i) => `  item ${quoted(i.title)}\n${i.text ? `    text ${quoted(i.text)}\n` : ''}`).join('')}`;
    emit(word === 'faq' ? { faq: items.map((i) => ({ q: i.title, a: i.text })) } : { feature: items }, lines, word);
  };

  /** An indented line inside the open component: an item, or an item's text. Anything else breaks it. */
  const child = (raw: string) => {
    const b = open!;
    if (b.broken) return;
    if (over) { b.broken = 'too_long'; return; }
    let indent = 0;
    while (indent < raw.length && raw[indent] === ' ') indent++;
    if (b.kind === 'rich') {
      // Two levels under the head, two spaces each; the lines are read whole when the block ends.
      const lexed = lineTokens(raw.slice(indent));
      if ((indent !== 2 && indent !== 4) || lexed === null || lexed.length === 0) { b.broken = 'shape'; return; }
      if (b.lines.length >= linesCap(b.head[0].value)) { b.broken = 'too_many'; return; }
      b.lines.push({ depth: indent / 2, tokens: lexed });
      return;
    }
    if (b.kind !== 'faq' && b.kind !== 'feature') { b.broken = 'shape'; return; }
    const tokens = lineTokens(raw.slice(indent));
    const one = tokens !== null && tokens.length === 2 && tokens[0].kind === 'bare' && tokens[1].kind === 'string';
    // The one-line form (§19.14): `item "title" "text"`, the text in the same line.
    const both = tokens !== null && tokens.length === 3 && tokens[0].kind === 'bare' && tokens[1].kind === 'string' && tokens[2].kind === 'string';
    if (indent === 2 && (one || both) && tokens![0].value === 'item') {
      if (b.items.length >= ANSWER_LIMITS.items) { b.broken = 'too_many'; return; }
      b.items.push({ title: tokens![1].value, text: both ? tokens![2].value : null });
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
      // Too long to be a component; too long to show as the line it is. Its first word was a keyword, or it was never held.
      const first = raw.slice(0, raw.indexOf(' '));
      open = { kind: 'dropped', word: KEYWORDS.includes(first) ? first : 'component', head: [], items: [], lines: [], broken: 'too_long' };
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
        // The note names the quoted word only when it is one an answer may hold; the route is the model's and never noted.
        // `show <word> <route>`, or with a list's item: `show faq /help #2` (§19.14).
        if ((rest.length === 2 || (rest.length === 3 && rest[2].value.startsWith('#'))) && rest.every((r) => r.kind === 'bare')) {
          open = { kind: 'show', word: (ANSWER_WORDS as readonly string[]).includes(rest[0].value) ? rest[0].value : 'show', head: t, items: [], lines: [], broken: null };
        } else asProse();
        return;
      case 'cta':
        if (rest.length === 2 && str(0) && bare(1)) open = { kind: 'cta', word: 'cta', head: t, items: [], lines: [], broken: null };
        else asProse();
        return;
      case 'ask':
        if (rest.length === 1 && str(0)) open = { kind: 'ask', word: 'ask', head: t, items: [], lines: [], broken: null };
        else asProse();
        return;
      case 'use':
        // Only a chat with presets reads `use <name>`; on any other, the line is the sentence it is.
        if ((rules.presets ?? []).length > 0 && rest.length === 1 && bare(0)) open = { kind: 'use', word: 'use', head: t, items: [], lines: [], broken: null };
        else asProse();
        return;
      case 'faq':
      case 'feature':
      case 'pricing': {
        const words = OPENER_WORDS[first.value];
        if (rest.every((r) => r.kind === 'bare' && words.includes(r.value)) && rest.length <= 2) {
          open = { kind: first.value, word: first.value, head: t, items: [], lines: [], broken: null };
        } else asProse();
        return;
      }
      case 'chart':
      case 'table':
      case 'stats':
      case 'cards':
      case 'dashboard':
      case 'explore':
      case 'map': {
        // A line with a rich component's first-line shape is held as one; any other is a sentence that starts with the word.
        const shaped: Record<RichWord, boolean> = {
          chart: bare(0) && CHART_KINDS.includes(rest[0].value) && str(1),
          table: str(0),
          stats: rest.length === 0,
          cards: rest.length === 0 || (bare(0) && rest[0].value === 'from'),
          dashboard: rest.length === 1 && str(0),
          explore: rest.length === 1 && str(0),
          map: str(0) && (rest.length === 1 || (bare(1) && rest[1].value === 'from')),
        };
        if (shaped[first.value as RichWord]) open = { kind: 'rich', word: first.value, head: t, items: [], lines: [], broken: null };
        else asProse();
        return;
      }
      default:
        asProse();
    }
  };

  /** The current line ends (at a newline, or at the end of the answer). */
  const endLine = (newline: boolean) => {
    // A fence line at the margin opens or closes a code block (§21.1.2).
    if (state === 'prose' && margin && prefix === FENCE) fenced = fenced ? extra : true;
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
    margin = false;
    prefix = '';
    extra = false;
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
        margin = ch !== ' ';
        // Inside a code block every line is the code's: prose, whatever it starts with.
        if (fenced) state = 'prose';
        else {
          // The first character decides whether an open component goes on.
          if (open && ch !== ' ') close();
          if (ended) break;
          if (ch === ' ') state = open ? 'hold' : 'prose';
          else state = 'word';
        }
      }
      if (state === 'prose') {
        // Everything up to the next newline at once.
        let j = i;
        while (j < text.length && text[j] !== '\n') j++;
        note(text.slice(i, j));
        streamProse(text.slice(i, j));
        i = j;
        continue;
      }
      if (state === 'word') {
        hold(ch);
        note(ch);
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
    get spent() { return { points, queries, calls, places }; },
    get record() { return record; },
    history(lost = new Map()) {
      // What the notes may take: the cap less the prose and the stand-ins that stand (each with its line break).
      let room = ANSWER_LIMITS.record - base;
      for (const p of parts) if (p.kind === 'shown' && lost.has(p.block)) room += p.line.length + 1;
      let s = '';
      /** A line of its own; a note only while it fits the room, in the answer's order. */
      const add = (line: string, note: boolean) => {
        if (note) {
          if (line.length + 1 > room) return;
          room -= line.length + 1;
        }
        s += s !== '' && !s.endsWith('\n') ? `\n${line}` : line;
      };
      for (const p of parts) {
        if (p.kind === 'text') s += p.s;
        else if (p.kind === 'note') add(p.line, true);
        else {
          const why = lost.get(p.block);
          add(why === undefined ? p.line : droppedNote(p.word, why), why !== undefined);
        }
      }
      return s;
    },
  };
}
