/**
 * The topic matcher's labelled corpus (fixtures/chat-match/, chat-block-spec
 * §19.17): the questions of corpus.json asked of site.az's chat, each judged
 * against what must answer it — a preset, one faq item, or the model.
 *
 * Read by packages/backend/test/chat-match-corpus.test.ts (the bar it is
 * held to) and scripts/token-benchmark.mjs (the share of the corpus answered
 * without the model), so both judge exactly the same cases.
 */

import { readFileSync } from 'node:fs';
import { compile, type Manifest } from '../../core/src/index.ts';
import { chatBackend, checkPreset } from '../src/chat-context.ts';
import { bestMatch, matchCandidates } from '../src/server/chat-match.ts';
import { parseChatContext, type ChatContext } from '../src/server/chat.ts';

const DIR = new URL('./fixtures/chat-match/', import.meta.url);

export interface MatchCase { readonly ask: string; readonly expect: string; readonly why?: string }

/** One case judged: what answered it, as the corpus writes it. */
export interface MatchOutcome extends MatchCase { readonly got: string }

/** The corpus judged: every case, how many the server answered, how many of those were right, how many it should have. */
export interface MatchReport {
  readonly cases: readonly MatchOutcome[];
  readonly answered: number;
  readonly right: number;
  readonly wrong: readonly MatchOutcome[];
  /** Cases whose answer is the site's, and how many of them the matcher gave. */
  readonly site: number;
  readonly found: number;
}

/** The corpus site's context as the server reads it, built with the chat server's own preset check. */
export function corpusContext(manifests: ReadonlyMap<string, Manifest>): { context: ChatContext; page: string } {
  const source = readFileSync(new URL('site.az', DIR), 'utf8');
  const r = compile(source, { manifests: new Map(manifests), checkAnswer: checkPreset });
  if (!r.ok || !r.spec) throw new Error(`chat-match/site.az does not compile: ${JSON.stringify(r.diagnostics.filter((d) => d.severity === 'error'))}`);
  const context = parseChatContext(chatBackend(r.spec)!.context);
  if (typeof context === 'string') throw new Error(`chat-match/site.az: context.json ${context}`);
  const { page } = JSON.parse(readFileSync(new URL('corpus.json', DIR), 'utf8')) as { page: string };
  return { context, page };
}

export function corpusCases(): MatchCase[] {
  return (JSON.parse(readFileSync(new URL('corpus.json', DIR), 'utf8')) as { cases: MatchCase[] }).cases;
}

/** Every case asked of the page's chat, and the bar's counts. */
export function judgeCorpus(context: ChatContext, page: string, cases: readonly MatchCase[] = corpusCases(), bars?: { readonly score: number; readonly lead: number }): MatchReport {
  const chat = context.chats[page];
  const candidates = matchCandidates(chat.presets, context.quotes, chat.show);
  // What a corpus label stands for, as the matcher answers: a preset's body, or the quote of one item.
  const label = (answer: string | null): string => {
    if (answer === null) return 'model';
    const preset = chat.presets.find((p) => p.text === answer);
    if (preset) return `preset:${preset.name}`;
    const m = /^show faq (\S+) (#\d+)\n$/.exec(answer);
    return m ? `faq:${m[1]} ${m[2]}` : `other:${answer}`;
  };
  const outcomes = cases.map((c) => ({ ...c, got: label(bestMatch(c.ask, candidates, bars)) }));
  const answered = outcomes.filter((o) => o.got !== 'model');
  return {
    cases: outcomes,
    answered: answered.length,
    right: answered.filter((o) => o.got === o.expect).length,
    wrong: outcomes.filter((o) => o.got !== o.expect && o.got !== 'model'),
    site: outcomes.filter((o) => o.expect !== 'model').length,
    found: outcomes.filter((o) => o.expect !== 'model' && o.got === o.expect).length,
  };
}
