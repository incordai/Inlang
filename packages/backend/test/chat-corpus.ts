/**
 * The injection corpus (chat-block-spec §6.1, §12): model answers that try
 * every threat — forbidden components, scripts, every scheme, off-list
 * hosts, look-alike routes, markdown images and links, entities, bidi and
 * zero-width characters, deep nesting, a long line, a composed pricing
 * block, CSS, too many components, over-long values. Each case is a JSON
 * file in fixtures/chat-attacks/ with the events it must become; rules.json
 * is the chat page they are judged on.
 *
 * Read by packages/backend/test/chat-attacks.test.ts (the parser and the
 * route) and scripts/chat-e2e.mjs (the same answers, through the real page,
 * in three browsers), so both judge exactly the same cases.
 */

import { readdirSync, readFileSync } from 'node:fs';
import type { AnswerRules } from '../src/server/chat-answer.ts';

const DIR = new URL('./fixtures/chat-attacks/', import.meta.url);

/**
 * What a case must become: its prose (text events joined), its components in
 * order, and why the others were dropped; and, where a case says, the history
 * the model is sent back (chat-block-spec §19.16) — what the answer is tagged as.
 */
export interface CorpusExpect {
  readonly text: string; readonly blocks: readonly Record<string, unknown>[]; readonly dropped: readonly string[];
  readonly history?: string;
}

export interface CorpusCase {
  readonly name: string;
  readonly threat: string;
  /** The question that makes the fake model give this answer. */
  readonly ask: string;
  readonly answer: string;
  readonly expect: CorpusExpect;
}

interface CorpusFile extends Omit<CorpusCase, 'answer'> {
  readonly answer: string;
  /** A marker in the answer standing for a long run, so the fixture stays small. */
  readonly expand?: Readonly<Record<string, { readonly repeat: string; readonly count: number }>>;
}

/** A case's answer with its expansions applied. */
function answerOf(c: CorpusFile): string {
  let answer = c.answer;
  for (const [marker, { repeat, count }] of Object.entries(c.expand ?? {})) answer = answer.split(marker).join(repeat.repeat(count));
  return answer;
}

/** The rules every case is judged under. */
export function corpusRules(): AnswerRules {
  const { show, quotes, destinations, presets } = JSON.parse(readFileSync(new URL('rules.json', DIR), 'utf8')) as AnswerRules;
  return { show, quotes, destinations, ...(presets ? { presets } : {}) };
}

/** Every case, in file-name order. */
export function corpusCases(): CorpusCase[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.json') && f !== 'rules.json')
    .sort()
    .map((f) => {
      const c = JSON.parse(readFileSync(new URL(f, DIR), 'utf8')) as CorpusFile;
      return { name: c.name, threat: c.threat, ask: c.ask, answer: answerOf(c), expect: c.expect };
    });
}

/** An answer in three pieces at fixed places, as a model streams it: the same cut every run. */
export function chunksOf(answer: string): string[] {
  const a = Math.floor(answer.length / 3);
  const b = Math.floor((2 * answer.length) / 3);
  return [answer.slice(0, a), answer.slice(a, b), answer.slice(b)].filter((p) => p !== '');
}
