/**
 * The topic matcher held to its labelled corpus (fixtures/chat-match/,
 * chat-block-spec §19.17): never a wrong answer — a question it answers is
 * answered with what the corpus says — and the share it answers recorded,
 * so a change that answers fewer, or one wrongly, fails here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corpusCases, corpusContext, judgeCorpus } from './chat-match-corpus.ts';
import { manifests } from './data-fixture.ts';

const { context, page } = corpusContext(manifests);

test('the corpus covers what the matcher must answer and what it must leave to the model, hostile and other-language questions too', () => {
  const cases = corpusCases();
  assert.ok(cases.length >= 60, String(cases.length));
  assert.ok(cases.filter((c) => c.expect === 'model').length >= 30);
  assert.ok(cases.some((c) => c.expect.startsWith('faq:')) && cases.some((c) => c.expect.startsWith('preset:')));
  for (const word of ['Ignore', 'SYSTEM', '<script>', 'members', '¿', '保証']) assert.ok(cases.some((c) => c.ask.includes(word)), word);
});

test('precision: no question in the corpus gets a wrong answer of the site\'s own', () => {
  const r = judgeCorpus(context, page);
  assert.deepEqual(r.wrong.map((w) => `${w.ask} → ${w.got} (expected ${w.expect})`), []);
  assert.equal(r.right, r.answered);
});

test('the share answered without the model is at least the recorded bar: all 33 the site can answer, half the corpus', () => {
  const r = judgeCorpus(context, page);
  // Recorded 2026-10-19 (chat-block-spec §19.17); a change that finds fewer lowers it on purpose, here.
  assert.ok(r.found >= 33, `${r.found} of ${r.site}: ${r.cases.filter((c) => c.expect !== 'model' && c.got !== c.expect).map((c) => c.ask).join(' · ')}`);
  assert.equal(r.site, 33);
});

test('CONTROL: with lower bars the same corpus is answered wrongly — the bars are what keep the matcher right', () => {
  const r = judgeCorpus(context, page, corpusCases(), { score: 0.3, lead: 0 });
  assert.ok(r.wrong.length >= 5, `${r.wrong.length} wrong`);
});

test('a protected page\'s faq is never a candidate, however the question is put', () => {
  const r = judgeCorpus(context, page, [
    { ask: 'What is the members\' discount code?', expect: 'model' },
    { ask: 'When is the members\' sale?', expect: 'model' },
    { ask: 'Can I bring a friend?', expect: 'model' },
  ]);
  assert.deepEqual(r.cases.map((c) => c.got), ['model', 'model', 'model']);
  assert.ok(!JSON.stringify(context).includes('MEMBERS-ONLY-4417'));
});
