/**
 * @az server chat-match
 * Purpose: deterministic keyword scoring of a visitor's question: which pages a large site sends in full, and which author's answer a clear question gets without the model.
 * Spec: docs/chat-block-spec.md §19.17
 * Exports: terms, scoreCandidates, bestMatch, choosePages, matchCandidates, MATCH_LIMITS, MatchCandidate, Scored
 * Edit guide: no regular expression that can backtrack; a pure function of its inputs (no clock, no randomness); the visitor's words choose among the candidates and are never returned.
 * Tests: packages/backend/test/chat-match.test.ts, packages/backend/test/chat-match-corpus.test.ts, packages/backend/test/chat-site-answers.test.ts
 */

/**
 * Two choices are made from the visitor's words before the model is asked
 * (chat-block-spec §19.17), both by the same scoring:
 *
 *   - on a large site, which pages are sent in full (choosePages); every
 *     page's summary is always sent;
 *   - whether the question is a clear match for one of the author's answers
 *     — a preset, or one item of a quotable faq — so the server answers with
 *     it and the model is not called (bestMatch).
 *
 * A text's terms are its words lower-cased, NFC-normalised and split at
 * anything that is not a letter or a digit, without the common English
 * words that carry no topic, and with a plural's last letters taken off
 * (`orders` → `order`, `countries` → `country`). A term is weighted by how
 * rare it is among the candidates (a word every candidate has decides
 * nothing), and a term no candidate has weighs the most: a question is a
 * match only when most of its weight is the candidate's own words. A
 * candidate's title counts too, so a question that says only "orders"
 * picks the preset titled "Orders" over "Orders by month".
 *
 * Only a strong, unambiguous score answers: at least MATCH_LIMITS.score,
 * and MATCH_LIMITS.lead ahead of the second. The visitor's words only ever
 * choose among what the author or the build wrote; nothing here returns,
 * echoes or stores them.
 *
 * Copied into a generated server with chat; imports chat-answer.ts's types.
 */

import type { AnswerPreset, AnswerQuote, AnswerWord } from './chat-answer.ts';

/** The bars a match must clear, and the bounds of the work one question costs. */
export const MATCH_LIMITS = {
  /** The least score that answers without the model, from 0 to 1. */
  score: 0.7,
  /** How far ahead of the second candidate the first must be. */
  lead: 0.1,
  /** Characters of a question that are read; the visitor's message is at most 1 000 (chat-text.ts VISITOR_MAX). */
  chars: 1_000,
  /** The terms of a question that are kept, the first ones. */
  terms: 64,
  /** …and of a page, whose text is the site's: at most the context's cap (chat-context.ts CONTEXT_MAX). */
  pageChars: 24_000,
  pageTerms: 2_000,
} as const;

/** Words that carry no topic in a question: asked of any site, they decide nothing. */
const STOP: ReadonlySet<string> = new Set([
  'a', 'about', 'all', 'also', 'am', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can', 'could', 'did', 'do',
  'does', 'for', 'from', 'get', 'give', 'got', 'had', 'has', 'have', 'hello', 'hi', 'how', 'i', 'if', 'in', 'into', 'is', 'it',
  'its', 'just', 'know', 'let', 'like', 'list', 'me', 'my', 'need', 'of', 'on', 'or', 'our', 'please', 'see', 'should', 'show',
  'so', 'some', 'tell', 'thank', 'thanks', 'that', 'the', 'their', 'them', 'there', 'these', 'they', 'this', 'those', 'to', 'us',
  'want', 'was', 'we', 'were', 'what', 'whats', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your',
]);

/** A word's plural ending off, so `orders` and `order` are one term. */
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && (w.endsWith('ches') || w.endsWith('shes') || w.endsWith('sses') || w.endsWith('xes'))) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

/** Whether one code point is a letter or a digit, of any script. */
const WORDISH = /[\p{L}\p{N}]/u;

/**
 * A text's terms, each once, in the order first met: lower-cased, NFC,
 * split at every character that is not a letter, a digit or a mark, the
 * stop words and one-letter words left out, plurals stemmed. One pass.
 */
export function terms(text: string, chars: number = MATCH_LIMITS.chars, most: number = MATCH_LIMITS.terms): string[] {
  const s = text.slice(0, chars).normalize('NFC').toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  let word = '';
  const flush = () => {
    // An apostrophe joins nothing: "what's" is "whats", "visitor's" is "visitors".
    if (word.length > 1 && !STOP.has(word)) {
      const t = stem(word);
      if (!seen.has(t) && out.length < most) { seen.add(t); out.push(t); }
    }
    word = '';
  };
  for (const ch of s) {
    if (ch === '\'' || ch === '’') continue;
    if (WORDISH.test(ch) || /\p{M}/u.test(ch)) word += ch;
    else flush();
  }
  flush();
  return out;
}

/** What the question may be matched to: its terms, its title's terms, and what it stands for. */
export interface MatchCandidate<T> {
  readonly terms: readonly string[];
  /** The words of its title: matching them all is what tells "Orders" from "Orders by month". */
  readonly title: readonly string[];
  readonly value: T;
}

export interface Scored<T> { readonly value: T; readonly score: number }

/** How much of a score is the question saying the candidate's title: what tells "Orders" from "Orders by month". */
const TITLE_WEIGHT = 0.25;

/**
 * Every candidate's score for `question`, highest first (ties in the
 * candidates' order): the share of the question's weight that is the
 * candidate's own terms, raised by how much of its title the question says.
 */
export function scoreCandidates<T>(question: readonly string[], candidates: readonly MatchCandidate<T>[]): Scored<T>[] {
  const sets = candidates.map((c) => new Set([...c.terms, ...c.title]));
  const df = new Map<string, number>();
  for (const s of sets) for (const t of s) df.set(t, (df.get(t) ?? 0) + 1);
  const n = candidates.length;
  // A rare term weighs more; a term no candidate has weighs most, so unknown words keep a question from matching.
  const weight = (t: string) => Math.log(1 + (n + 1) / ((df.get(t) ?? 0) + 1));
  const total = question.reduce((sum, t) => sum + weight(t), 0);
  const scored = candidates.map((c, i) => {
    if (total === 0) return { value: c.value, score: 0, i };
    const own = question.filter((t) => sets[i].has(t)).reduce((sum, t) => sum + weight(t), 0);
    const title = c.title.length === 0 ? 0 : c.title.filter((t) => question.includes(t)).length / c.title.length;
    return { value: c.value, score: (own / total) * (1 - TITLE_WEIGHT + TITLE_WEIGHT * title), i };
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map(({ value, score }) => ({ value, score }));
}

/** The one candidate `question` clearly asks for, or null: a strong score, well ahead of the second. `bars` are MATCH_LIMITS'. */
export function bestMatch<T>(question: string, candidates: readonly MatchCandidate<T>[], bars: { readonly score: number; readonly lead: number } = MATCH_LIMITS): T | null {
  const q = terms(question);
  if (q.length === 0 || candidates.length === 0) return null;
  const [first, second] = scoreCandidates(q, candidates);
  if (first.score < bars.score) return null;
  if (second !== undefined && first.score - second.score < bars.lead) return null;
  return first.value;
}

/**
 * The pages a large site sends in full for this question (chat-block-spec
 * §19.17), best first: each page's score is the weight of the question's
 * terms it holds, a term in its route or a block's title counted twice;
 * of pages that score the same, the visitor's own comes first. When no page
 * holds any of them, the visitor's own page is sent (the question is then
 * likely about the page in view). At most
 * `most` pages and `chars` characters of them; a page that would pass the
 * cap is left out. `asked` is the visitor's latest turns, newest first: the
 * newest that shares a term with some page decides, so "and the second
 * one?" is read with the question before it.
 */
export function choosePages<P extends { readonly route: string; readonly full: string; readonly terms: readonly string[]; readonly title: readonly string[] }>(
  pages: readonly P[], here: string, asked: readonly string[], most: number, chars: number,
): P[] {
  const sets = pages.map((p) => ({ all: new Set(p.terms), title: new Set(p.title) }));
  const df = new Map<string, number>();
  for (const s of sets) for (const t of s.all) df.set(t, (df.get(t) ?? 0) + 1);
  const weight = (t: string) => Math.log(1 + pages.length / (df.get(t) ?? pages.length));
  let ranked: P[] = [];
  for (const question of asked) {
    const q = terms(question).filter((t) => df.has(t));
    if (q.length === 0) continue;
    const at = (p: P) => (p.route === here ? 0 : 1);
    ranked = pages.map((p, i) => ({ p, i, score: q.reduce((n, t) => n + (sets[i].all.has(t) ? weight(t) : 0) + (sets[i].title.has(t) ? weight(t) : 0), 0) }))
      .filter((x) => x.score > 0).sort((a, b) => b.score - a.score || at(a.p) - at(b.p) || a.i - b.i).map((x) => x.p);
    break;
  }
  const own = pages.find((p) => p.route === here);
  const order = ranked.length === 0 && own ? [own] : ranked;
  const out: P[] = [];
  let size = 0;
  for (const p of order) {
    if (out.length >= most || out.includes(p) || size + p.full.length > chars) continue;
    out.push(p);
    size += p.full.length;
  }
  return out;
}

/** The first quoted string on a component's first line — its title: `dashboard "This month"` → `This month`. */
function titleOf(text: string): string {
  const line = text.split('\n')[0];
  const at = line.indexOf('"');
  if (at < 0) return '';
  let out = '';
  for (let i = at + 1; i < line.length; i++) {
    const c = line[i];
    if (c === '"') return out;
    if (c === '\\') { out += line[i + 1] ?? ''; i++; continue; }
    out += c;
  }
  return '';
}

/**
 * What a question on one chat page may be matched to (chat-block-spec
 * §19.17), each with the answer the server then reads as if the model had
 * written it: every preset that has keywords — the author's `keywords`, or
 * the build's — answering with its own body; and, when the page shows faq,
 * every item of the site's quotable faq lists, matched by its question and
 * answering with the quote of that one item. Nothing else: a candidate is
 * always the author's or the build's.
 */
export function matchCandidates(presets: readonly AnswerPreset[], quotes: readonly AnswerQuote[], show: readonly AnswerWord[]): MatchCandidate<string>[] {
  const out: MatchCandidate<string>[] = [];
  for (const p of presets) {
    if (!p.keywords || p.keywords.length === 0) continue;
    // A quote's title is its block's; a component's is its first string.
    const [verb, word, at] = p.text.trim().split(' ');
    const quote = verb === 'show' ? quotes.find((q) => q.word === word && `${q.route}${q.n > 0 ? `#${q.n + 1}` : ''}` === at) : undefined;
    const title = quote ? quote.label ?? '' : titleOf(p.text);
    out.push({ terms: terms(p.keywords.join(' ')), title: terms(title), value: p.text });
  }
  if (show.includes('faq')) {
    for (const q of quotes) {
      if (q.word !== 'faq' || !q.items) continue;
      q.items.forEach((item, k) => {
        const question = terms(item.title);
        out.push({ terms: question, title: question, value: `show faq ${q.route}${q.n > 0 ? `#${q.n + 1}` : ''} #${k + 1}\n` });
      });
    }
  }
  return out;
}
