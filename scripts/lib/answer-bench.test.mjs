/**
 * The answer-format benchmark (answer-bench.mjs, docs/token-benchmark.md §7):
 * every `.az` answer is one the real parser accepts, holding exactly the
 * blocks its JSON form carries; every form is counted with the benchmark's
 * own tokenizers; the chat input is the chat e2e site's build. The numbers
 * are not pinned — only what makes the comparison fair.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_FORMS, answerCases, measureAnswers, measureChatInput, parsedBlocks } from './answer-bench.mjs';
import { ENCODINGS, loadCounters } from './token-bench.mjs';

test('each .az answer parses to exactly the blocks its JSON form carries; the refused one is refused', () => {
  const cases = answerCases();
  assert.ok(cases.length >= 6);
  for (const c of cases.filter((x) => x.blocks !== null)) {
    assert.deepEqual(parsedBlocks(c.az), c.blocks, c.name);
    const events = JSON.parse(c.json).answer;
    assert.deepEqual(events.filter((e) => !('text' in e)), c.blocks, `${c.name}: the JSON form holds the same blocks`);
  }
  // CONTROL: the composed pricing form is the one the parser drops (pricing is quote-only).
  const composed = cases.find((x) => x.blocks === null);
  assert.deepEqual(parsedBlocks(composed.az), []);
});

test('every answer is counted in every form and encoding; the chat input is the e2e site\'s prompt and context', async () => {
  const { counters } = await loadCounters();
  const answers = measureAnswers(counters);
  for (const a of answers) {
    for (const f of ANSWER_FORMS) {
      assert.ok(a.forms[f].chars > 0, `${a.name} ${f}`);
      for (const e of ENCODINGS) assert.ok(a.forms[f].tokens[e] > 0, `${a.name} ${f} ${e}`);
    }
  }
  // The quote is the point of the subset: the site's own table in one line, which markdown must spell out.
  const quote = answers.find((a) => a.name === 'pricing (quoted)');
  assert.ok(quote.forms.az.tokens[ENCODINGS[0]] < quote.forms.markdown.tokens[ENCODINGS[0]]);
  const input = measureChatInput(counters);
  assert.ok(input.prompt.chars > 1000 && input.context.chars > 500, JSON.stringify(input));
});
