/**
 * The chat-prompt budget (chat-prompt-bench.mjs, docs/token-benchmark.md §8):
 * both fixtures build, every text is counted in every encoding, and no
 * count is over the recorded budget — so a prompt that grows fails here,
 * in `pnpm verify`, until the budget is raised on purpose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT_LARGE_QUESTIONS, CHAT_PROMPT_FIXTURES, CHAT_PROMPT_TEXTS, measureChatPrompts, measureSelection, overBudget, readBudget, underBudget } from './chat-prompt-bench.mjs';
import { ENCODINGS, loadCounters } from './token-bench.mjs';

/** Both fixtures built and counted once, for every test below. */
let counted = null;
const measure = () => (counted ??= loadCounters().then(({ counters }) => measureChatPrompts(counters)));

test('the chat prompt of each fixture is within its recorded budget, in every encoding', async () => {
  const measured = await measure();
  assert.deepEqual(Object.keys(measured), CHAT_PROMPT_FIXTURES.map((f) => f.name));
  for (const texts of Object.values(measured)) {
    assert.deepEqual(Object.keys(texts), CHAT_PROMPT_TEXTS);
    for (const m of Object.values(texts)) for (const e of ENCODINGS) assert.ok(m.tokens[e] > 0, e);
  }
  assert.deepEqual(overBudget(measured, readBudget()), []);
});

test('a count past its budget, or one the budget does not name, is reported; one under it is room', () => {
  const measured = { all: { prompt: { chars: 10, tokens: { o200k_base: 101, cl100k_base: 99 } } } };
  const budget = { fixtures: { all: { prompt: { o200k_base: 100, cl100k_base: 100 } } } };
  assert.deepEqual(overBudget(measured, budget), ['all prompt o200k_base: 101 tokens, over its budget of 100']);
  assert.deepEqual(underBudget(measured, budget), ['all prompt cl100k_base: 99 tokens, 1 under its budget of 100']);
  assert.deepEqual(overBudget(measured, { fixtures: {} }), [
    'all prompt o200k_base: 101 tokens, and no budget for it', 'all prompt cl100k_base: 99 tokens, and no budget for it',
  ]);
});

test('the faq-only chat is told less than the chat that shows every component', async () => {
  const m = await measure();
  for (const e of ENCODINGS) assert.ok(m.faq.prompt.tokens[e] < m.all.prompt.tokens[e], e);
});

test('the large fixture (chat-block-spec §19.17): a question is sent the pages it needs, at well under the whole site\'s cost', async () => {
  const { counters } = await loadCounters();
  const s = measureSelection(counters);
  assert.equal(s.questions, CHAT_LARGE_QUESTIONS.length);
  for (const e of ENCODINGS) assert.ok(s.average.chosen[e] < s.average.whole[e] * 0.6, `${e}: ${s.average.chosen[e]} against ${s.average.whole[e]}`);
  // The recorded bar: the page that answers is sent in full for 14 of the 16 questions (the two misses are a word the
  // page spells otherwise, "voltage" for "volts", and a question of stop words and "person").
  assert.ok(s.missed.length <= 2, s.missed.join(' · '));
});
