/**
 * The answer checker package's entry point (createAnswerChecker,
 * chat-block-spec §22.1): the injection corpus through it, at once and in
 * pieces; a rich component held, then filled from the data source; the caps
 * that end an answer and stop its stream; the events' byte cap; a stream
 * that fails; and the package's promise to run outside Node — no Node-only
 * global in its sources. The same corpus runs in three browsers in
 * scripts/chat-lib-e2e.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createAnswerChecker, EVENTS_BYTES, type CheckerEvent, type CheckerOptions } from '../src/checker.ts';
import { ANSWER_LIMITS, type AnswerRules } from '../src/chat-answer.ts';
import type { FiguresRun } from '../src/chat-rich.ts';
import { chunksOf, corpusCases, corpusRules } from './corpus.ts';

const CASES = corpusCases();
const RULES: AnswerRules = corpusRules();
const OPTIONS: CheckerOptions = { components: RULES.show, quotes: RULES.quotes, destinations: RULES.destinations, ...(RULES.presets ? { presets: RULES.presets } : {}) };

async function* stream(pieces: readonly string[]): AsyncGenerator<string> {
  for (const p of pieces) yield p;
}

/** Every event of one answer, read whole. */
async function readAll(options: CheckerOptions, pieces: readonly string[]): Promise<CheckerEvent[]> {
  const out: CheckerEvent[] = [];
  for await (const e of createAnswerChecker(options).read(stream(pieces))) out.push(e);
  return out;
}

/** Text events joined, blocks in order, and the end's drops and history: how a page and a server read one answer. */
function outcome(events: readonly CheckerEvent[]) {
  let text = '';
  const blocks: unknown[] = [];
  const done = events.at(-1);
  for (const e of events) {
    if (e.type === 'text') text += e.s;
    else if (e.type === 'block') blocks.push(e.block);
  }
  assert.equal(done?.type, 'done', 'an answer read whole ends with done');
  return { text, blocks, done: done as Extract<CheckerEvent, { type: 'done' }> };
}

test('CONTROL: the corpus is here and judges something', () => {
  assert.ok(CASES.length >= 15);
  assert.equal(CASES.find((c) => c.name === 'legal')!.expect.blocks.length, 4);
  assert.ok(CASES.some((c) => c.expect.dropped.length > 0));
});

for (const c of CASES) {
  test(`corpus ${c.name} through createAnswerChecker — ${c.threat}`, async () => {
    for (const pieces of [[c.answer], chunksOf(c.answer)]) {
      const { text, blocks, done } = outcome(await readAll(OPTIONS, pieces));
      assert.deepEqual({ text, blocks, dropped: [...done.dropped], ...(c.expect.history !== undefined ? { history: done.history } : {}) }, c.expect);
      // The events a share would hold are exactly the ones sent.
      assert.deepEqual(done.events.filter((e) => e.type === 'block').map((e) => e.block), blocks);
    }
  });
}

test('a rich component is held by its kind, then filled from the data source, marked as the site\'s figures on the given day', async () => {
  const asked: string[][] = [];
  const figures: FiguresRun = async (kind, words) => {
    asked.push([kind, ...words]);
    return { kind: 'figures', unit: null, value: null, groups: [['paid', 3], ['open', 1]], more: false, dated: false };
  };
  const events = await readAll({ components: ['chart'], data: { figures }, day: '2026-10-19' }, ['Here:\nchart bar "Orders" from orders count by status\n']);
  assert.deepEqual(asked, [['figures', 'orders', 'count', 'by', 'status']]);
  const i = events.findIndex((e) => e.type === 'hold');
  assert.deepEqual(events[i], { type: 'hold', word: 'chart' });
  assert.deepEqual(events[i + 1], {
    type: 'block',
    block: { chart: { kind: 'bar', title: 'Orders', unit: null, src: 'site', asOf: '2026-10-19', more: false, series: [{ name: 'Orders', points: [['paid', 3], ['open', 1]] }] } },
  });
});

test('a `from` with no data source to answer it is dropped whole, and the history says so by its word and reason only', async () => {
  const { blocks, done } = outcome(await readAll({ components: ['chart'] }, ['chart bar "Orders" from orders count by status\n']));
  assert.deepEqual(blocks, []);
  assert.deepEqual(done.dropped, ['figures']);
  assert.equal(done.history, '(dropped: chart, figures)\n');
});

test('the model\'s own figures need no data source and are marked as the model\'s', async () => {
  const { blocks } = outcome(await readAll({ components: ['stats'] }, ['stats\n  stat "Uptime" 99.9 unit percent\n']));
  assert.deepEqual(blocks, [{ stats: [{ label: 'Uptime', value: 99.9, unit: 'percent', src: 'model' }] }]);
});

test('a cap ends the answer: onCapped is called once, at the cap, and the stream is not read past it', async () => {
  let pulled = 0;
  let calls = 0;
  async function* long(): AsyncGenerator<string> {
    for (let i = 0; i < 100; i++) { pulled++; yield 'x'.repeat(100); }
  }
  const out: CheckerEvent[] = [];
  for await (const e of createAnswerChecker({ components: [] }).read(long(), { onCapped: () => { calls++; } })) out.push(e);
  const { text, done } = outcome(out);
  assert.equal(calls, 1);
  assert.equal(done.capped, true);
  assert.equal(text.length, ANSWER_LIMITS.prose);
  // A streamed line's last character waits for the next piece (a combining mark may follow it), so the piece that
  // passes the cap is the 41st — and the last one read of the hundred on offer.
  assert.equal(pulled, ANSWER_LIMITS.prose / 100 + 1, 'not one piece is read past the one that reached the cap');
});

test('CONTROL: an answer under every cap is not capped and never calls onCapped', async () => {
  let calls = 0;
  const out: CheckerEvent[] = [];
  for await (const e of createAnswerChecker({ components: [] }).read(stream(['Short.']), { onCapped: () => { calls++; } })) out.push(e);
  assert.equal(outcome(out).done.capped, false);
  assert.equal(calls, 0);
});

test('the events stay within their byte cap: a component past it is dropped whole and noted, the prose before it stands', async () => {
  const faq = `faq\n${Array.from({ length: 6 }, (_, i) => `  item "Question ${i}?" "${'a'.repeat(500)}"`).join('\n')}\n`;
  const { text, blocks, done } = outcome(await readAll({ components: ['faq'], eventsBytes: 1_000 }, [`Intro.\n\n${faq}`]));
  assert.equal(text, 'Intro.\n\n');
  assert.deepEqual(blocks, []);
  assert.deepEqual(done.dropped, ['too_long']);
  assert.match(done.history, /\(dropped: faq, too_long\)/);
  // The cap can only be lowered: a larger one is EVENTS_BYTES.
  const big = outcome(await readAll({ components: ['faq'], eventsBytes: EVENTS_BYTES * 4 }, [faq]));
  assert.equal(big.blocks.length, 1);
});

test('a stream that fails ends the answer with no done, the error rethrown; what was read so far is still told', async () => {
  async function* failing(): AsyncGenerator<string> {
    yield 'Half an answer';
    throw new Error('provider gone');
  }
  const read = createAnswerChecker({ components: [] }).read(failing());
  const seen: CheckerEvent[] = [];
  await assert.rejects(async () => { for await (const e of read) seen.push(e); }, /provider gone/);
  assert.ok(!seen.some((e) => e.type === 'done'));
  assert.equal(read.record, 'Half an answe', 'the record so far — the last character held until the next arrives');
  assert.deepEqual(read.dropped, []);
});

test('an unknown component in the app\'s own options is a mistake it is told of', () => {
  assert.throws(() => createAnswerChecker({ components: ['chart', 'widget' as 'chart'] }), /'widget' is not a component/);
});

test('a place is only read where a map is shown and a geocoder is given', async () => {
  const answer = ['map "Visit"\n  pin "Shop" 52.52 13.405\n  place "Hall" "Main street 1"\n'];
  const without = outcome(await readAll({ components: ['map'] }, answer));
  assert.deepEqual(without.done.dropped, ['not_shown'], 'no geocoder: the place drops, the pin stands');
  const geocode = async () => ({ lat: 52.5, lon: 13.4 });
  const withIt = outcome(await readAll({ components: ['map'], data: { geocode } }, answer));
  assert.deepEqual(withIt.done.dropped, []);
  const map = (withIt.blocks[0] as { map: { pins: { src: string }[] } }).map;
  assert.deepEqual(map.pins.map((p) => p.src), ['model', 'geocoded']);
});

test('the package runs outside Node: no Node-only global or module in its sources', () => {
  const dir = new URL('../src/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 7, 'CONTROL: the sources are found');
  for (const f of files) {
    const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const banned of [/\bBuffer\b/, /\bprocess\./, /\brequire\(/, /\bnode:/, /\bsetImmediate\b/, /\b__dirname\b/]) {
      assert.doesNotMatch(code, banned, `${f} uses ${banned}`);
    }
  }
});
