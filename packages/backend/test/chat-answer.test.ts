/**
 * The answer parser (server chat-answer.ts, chat-block-spec §5.3): every
 * legal form, every cap at its edge and one past it, the same events
 * however the stream is split — at every offset, inside a UTF-8 sequence,
 * inside a string escape — and a cost linear in what it reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER_FORMS, ANSWER_LIMITS, createAnswerParser, lineTokens, type AnswerEvent, type AnswerRules,
} from '../src/server/chat-answer.ts';
import { createSseReader } from '../src/server/chat-sse.ts';

const RULES: AnswerRules = {
  show: ['pricing', 'faq', 'cta', 'feature'],
  quotes: [{ word: 'pricing', route: '/pricing', n: 0 }, { word: 'pricing', route: '/plans', n: 0 }, { word: 'pricing', route: '/plans', n: 1 }],
  destinations: ['/', '/contact', '/pricing', '/pricing#plans', 'https://docs.example.org/start', 'mailto:help@example.org', 'tel:+15550100'],
};

/** What a whole answer becomes: its prose (text events joined), its blocks in order, the drops and the record. */
interface Outcome { text: string; blocks: unknown[]; order: string[]; dropped: string[]; record: string; ended: boolean }

function run(pieces: readonly string[], rules: AnswerRules = RULES): Outcome {
  const p = createAnswerParser(rules);
  const events: AnswerEvent[] = [];
  for (const piece of pieces) {
    if (p.ended) break;
    events.push(...p.push(piece));
  }
  events.push(...p.end());
  return summarise(events, p);
}

function summarise(events: readonly AnswerEvent[], p: { dropped: readonly string[]; record: string; ended: boolean }): Outcome {
  let text = '';
  const blocks: unknown[] = [];
  const order: string[] = [];
  for (const e of events) {
    if (e.type === 'text') {
      text += e.s;
      if (order.at(-1) !== 'text') order.push('text');
    } else {
      blocks.push(e.block);
      order.push('block');
    }
  }
  return { text, blocks, order, dropped: [...p.dropped], record: p.record, ended: p.ended };
}

const whole = (answer: string, rules?: AnswerRules) => run([answer], rules);

/* ---- every legal form ----------------------------------------------------- */

const LEGAL = [
  'For five people, Team fits.',
  'show pricing /pricing',
  'faq',
  '  item "Can I switch plans later?"',
  '    text "Yes, from Settings, at any time."',
  'cta "Talk to us" /contact',
  'feature',
  '  item "Fast"',
  '    text "Pages are pre-rendered."',
  '  item "Small"',
  '',
  'text "Anything \\"else\\"? Ask."',
  'Thanks!',
].join('\n');

test('every legal form becomes its event, in order, prose around them', () => {
  const r = whole(LEGAL);
  assert.deepEqual(r.blocks, [
    { quote: 'pricing', route: '/pricing', n: 0 },
    { faq: [{ q: 'Can I switch plans later?', a: 'Yes, from Settings, at any time.' }] },
    { cta: { label: 'Talk to us', to: '/contact' } },
    { feature: [{ title: 'Fast', text: 'Pages are pre-rendered.' }, { title: 'Small', text: '' }] },
  ]);
  assert.equal(r.text, 'For five people, Team fits.\nAnything "else"? Ask.\nThanks!');
  assert.deepEqual(r.order, ['text', 'block', 'block', 'block', 'block', 'text']);
  assert.deepEqual(r.dropped, []);
  // The record is what the page sends back: prose, and each component in its canonical lines.
  assert.equal(r.record, [
    'For five people, Team fits.', 'show pricing /pricing', 'faq', '  item "Can I switch plans later?"', '    text "Yes, from Settings, at any time."',
    'cta "Talk to us" /contact', 'feature', '  item "Fast"', '    text "Pages are pre-rendered."', '  item "Small"',
    'Anything "else"? Ask.', 'Thanks!',
  ].join('\n'));
  // …and the record parses back to the same components (a model that sees it as history learns the same forms).
  assert.deepEqual(whole(r.record).blocks, r.blocks);
});

test('a quote names a page and, with #n, its n-th pricing block; every destination of the allow-list works exactly as written', () => {
  assert.deepEqual(whole('show pricing /plans#2').blocks, [{ quote: 'pricing', route: '/plans', n: 1 }]);
  assert.deepEqual(whole('show pricing /plans#1').blocks, [{ quote: 'pricing', route: '/plans', n: 0 }]);
  for (const to of RULES.destinations) assert.deepEqual(whole(`cta "Go" ${to}`).blocks, [{ cta: { label: 'Go', to } }], to);
  // A variant word after faq/feature is accepted and ignored: the page draws its own template.
  assert.equal(whole('faq list\n  item "Q"\n    text "A"').blocks.length, 1);
  assert.equal(whole('feature grid\n  item "T"').blocks.length, 1);
});

test('a line that does not have a component\'s shape is prose — shown as the text it is', () => {
  for (const line of ['show me the plans', 'text me later', 'faq: see below', 'cta now', 'features are great', 'feature list soon please',
    'cta "Unterminated /contact', 'show pricing', 'text "a" "b"', 'textual', 'pricing starts at nine', 'item "Q"', 'auth login', 'hero center']) {
    const r = whole(line);
    assert.equal(r.text, line, line);
    assert.deepEqual(r.blocks, [], line);
    assert.deepEqual(r.dropped, [], line);
  }
});

test('a component that breaks a rule is dropped whole and leaves no text', () => {
  const cases: [string, string][] = [
    ['show auth /login', 'not_shown'],
    // An faq is quotable since §19.15: one the site does not have is no quote.
    ['show faq /help', 'no_quote'],
    ['show pricing /nope', 'no_quote'],
    ['show pricing /pricing#2', 'no_quote'],
    ['show pricing /pricing#plans', 'no_quote'],
    ['cta "Claim" https://evil.example/?d=1', 'destination'],
    ['cta "Claim" javascript:alert(1)', 'destination'],
    ['cta "Claim" /contact/', 'destination'],
    ['cta "" /contact', 'empty'],
    ['pricing cards\n  plan "Team"\n    monthly 0', 'composed_pricing'],
    ['pricing', 'composed_pricing'],
    ['faq', 'empty'],
    ['faq\n  item "Q"', 'empty'],
    ['faq\n  item "Q"\n    text "A"\n    text "B"', 'shape'],
    ['faq\n  item "Q"\n      text "A"', 'shape'],
    ['faq\n   item "Q"', 'shape'],
    ['faq\n  item "Q"\n    text "A"\n  img "https://evil.example/x.png"', 'shape'],
    ['cta "Go" /\n  item "x"', 'shape'],
    ['show pricing /pricing\n  plan "Free"', 'shape'],
    // The one-line form takes one text (§19.15): a third string, or a text line under it too, is no item.
    ['faq\n  item "Q" "R" "S"', 'shape'],
    ['faq\n  item "Q" "R"\n    text "S"', 'shape'],
    ['faq\n  item "Q" bare', 'shape'],
    ['faq\n  item "Q\n    text "A"', 'shape'],
  ];
  for (const [answer, reason] of cases) {
    const r = whole(`Before.\n${answer}\nAfter.`);
    assert.deepEqual(r.blocks, [], answer);
    assert.equal(r.text, 'Before.\nAfter.', answer);
    assert.deepEqual(r.dropped, [reason], answer);
  }
});

test('a component the page does not show is dropped, even in a legal form', () => {
  const faqOnly: AnswerRules = { ...RULES, show: ['faq'] };
  const r = whole(LEGAL, faqOnly);
  assert.deepEqual(r.blocks, [{ faq: [{ q: 'Can I switch plans later?', a: 'Yes, from Settings, at any time.' }] }]);
  assert.deepEqual(r.dropped, ['not_shown', 'not_shown', 'not_shown']);
  // CONTROL: a prose-only page shows none of them.
  assert.deepEqual(whole(LEGAL, { show: [], quotes: [], destinations: [] }).blocks, []);
});

/* ---- every cap, at the edge and one past it ------------------------------- */

const faqOf = (n: number, q = 'Q', a = 'A') => `faq\n${Array.from({ length: n }, () => `  item "${q}"\n    text "${a}"`).join('\n')}`;
const featureOf = (n: number, title = 'T', text = 'x') => `feature\n${Array.from({ length: n }, () => `  item "${title}"\n    text "${text}"`).join('\n')}`;

test('caps: items, question, answer, title, text, label — each at its limit shown, one past dropped', () => {
  const L = ANSWER_LIMITS;
  const edge: [string, string][] = [
    [faqOf(L.items), faqOf(L.items + 1)],
    [faqOf(1, 'q'.repeat(L.question)), faqOf(1, 'q'.repeat(L.question + 1))],
    [faqOf(1, 'Q', 'a'.repeat(L.answer)), faqOf(1, 'Q', 'a'.repeat(L.answer + 1))],
    [featureOf(L.items), featureOf(L.items + 1)],
    [featureOf(1, 't'.repeat(L.title)), featureOf(1, 't'.repeat(L.title + 1))],
    [featureOf(1, 'T', 'x'.repeat(L.text)), featureOf(1, 'T', 'x'.repeat(L.text + 1))],
    [`cta "${'l'.repeat(L.label)}" /contact`, `cta "${'l'.repeat(L.label + 1)}" /contact`],
  ];
  for (const [at, past] of edge) {
    assert.equal(whole(at).blocks.length, 1, at.slice(0, 40));
    assert.equal(whole(past).blocks.length, 0, past.slice(0, 40));
    assert.equal(whole(past).dropped.length, 1);
  }
});

test(`caps: ${ANSWER_LIMITS.components} components; the next one ends the answer`, () => {
  const four = Array.from({ length: ANSWER_LIMITS.components }, () => 'cta "Go" /contact').join('\n');
  const atCap = whole(`${four}\nMore prose.`);
  assert.equal(atCap.blocks.length, 4);
  assert.equal(atCap.ended, false);
  assert.equal(atCap.text, 'More prose.');
  const past = whole(`${four}\ncta "Fifth" /contact\nMore prose.`);
  assert.equal(past.blocks.length, 4);
  assert.equal(past.ended, true, 'past the cap the parser stops reading');
  assert.equal(past.text, '', 'nothing after it is read');
  assert.deepEqual(past.dropped, ['components']);
});

test(`caps: ${ANSWER_LIMITS.prose} characters of prose, then the answer ends`, () => {
  const at = whole('x'.repeat(ANSWER_LIMITS.prose - 1));
  assert.equal(at.text.length, ANSWER_LIMITS.prose - 1);
  assert.equal(at.ended, false);
  const past = whole(`${'x'.repeat(ANSWER_LIMITS.prose)}y\ncta "Go" /contact`);
  assert.equal(past.text.length, ANSWER_LIMITS.prose);
  assert.equal(past.ended, true);
  assert.deepEqual(past.blocks, []);
});

test(`caps: a held line is read to ${ANSWER_LIMITS.line} characters; a longer one is dropped, never shown`, () => {
  const label = 'l'.repeat(ANSWER_LIMITS.line);
  const r = whole(`Before.\ncta "${label}" /contact\nAfter.`);
  assert.equal(r.text, 'Before.\nAfter.');
  assert.deepEqual(r.dropped, ['too_long']);
  // A line that starts like a component and never ends: one megabyte, held only to the cap.
  const huge = whole(`faq "${'z'.repeat(1024 * 1024)}`);
  assert.equal(huge.text, '');
  assert.deepEqual(huge.dropped, ['too_long']);
  // CONTROL: prose of any line length streams (the prose cap is what bounds it).
  assert.equal(whole('w'.repeat(ANSWER_LIMITS.line + 10)).text.length, ANSWER_LIMITS.line + 10);
});

test('the record is capped: a component that would pass it is dropped, so a tagged answer always fits a history turn', () => {
  const longFaq = faqOf(ANSWER_LIMITS.items, 'q'.repeat(ANSWER_LIMITS.question), 'a'.repeat(ANSWER_LIMITS.answer));
  const r = whole(`${'p'.repeat(3_000)}\n${longFaq}\n${longFaq}\n${longFaq}\n${longFaq}`);
  assert.ok(r.record.length <= ANSWER_LIMITS.record, `${r.record.length}`);
  assert.equal(r.blocks.length, 1);
  assert.deepEqual(r.dropped, ['record', 'record', 'record']);
});

/* ---- strings: what is stripped, normalised, and never decoded ------------- */

test('strings: three escapes only; controls, bidi and zero-width characters go; NFC; entities stay as written', () => {
  assert.deepEqual(lineTokens('cta "a \\"b\\" \\\\ c\\nd" /x'), [{ kind: 'bare', value: 'cta' }, { kind: 'string', value: 'a "b" \\ c\nd' }, { kind: 'bare', value: '/x' }]);
  assert.equal(lineTokens('cta "\\t" /x'), null, 'another escape does not lex');
  assert.equal(lineTokens('cta "a"b /x'), null);
  assert.equal(lineTokens('cta a"b /x'), null);
  const r = whole('cta "Pa‮y​ me\u0000" /cont‮act\nfaq\n  item "Café &lt;b&gt;"\n    text "<img src=x onerror=alert(1)>"');
  assert.deepEqual(r.blocks, [
    { cta: { label: 'Pay me', to: '/contact' } },
    { faq: [{ q: 'Café &lt;b&gt;', a: '<img src=x onerror=alert(1)>' }] },
  ]);
  assert.equal(whole('a‮b\u0007c\r\nd').text, 'abc\nd', 'prose too; a CRLF is a line end');
});

/* ---- streaming ------------------------------------------------------------ */

test('prose streams before its line ends, once its first word cannot start a component', () => {
  const p = createAnswerParser(RULES);
  const first = p.push('Hello wor');
  assert.equal(first.length, 1);
  assert.equal(first[0].type, 'text');
  // All but the last character, which waits in case a combining mark follows it.
  assert.equal((first[0] as { s: string }).s, 'Hello wo');
  // A line that starts like a component waits for its end.
  assert.deepEqual(p.push('ld.\nfa'), [{ type: 'text', s: 'rld.\n' }]);
  assert.deepEqual(p.push('q\n  item "Q"\n    text "A"\n'), []);
  assert.deepEqual(p.push('Next'), [{ type: 'block', block: { faq: [{ q: 'Q', a: 'A' }] } }, { type: 'text', s: 'Nex' }]);
});

/** Adjacent text events joined: how the page reads a stream, whatever its pieces. */
const canonical = (o: Outcome) => ({ text: o.text, blocks: o.blocks, order: o.order, dropped: o.dropped, record: o.record });

const SPLIT = `${LEGAL}\nÉmoji 🌍 and Café.\ncta "Tal\\"k" /contact\n${'faq\n  item "Q \\\\ 🌍"\n    text "A\\nB"'}\nshow pricing /plans#2\nEnd`;

test('the same events however the answer is split: at every offset, inside a surrogate pair and inside an escape', () => {
  const expected = canonical(whole(SPLIT));
  assert.equal(expected.blocks.length, 4, 'the cap holds for the expected run too');
  for (let i = 0; i <= SPLIT.length; i++) {
    assert.deepEqual(canonical(run([SPLIT.slice(0, i), SPLIT.slice(i)])), expected, `split at ${i}`);
  }
  // One character (UTF-16 unit) at a time.
  assert.deepEqual(canonical(run(SPLIT.split(''))), expected);
});

test('the same events however the model\'s bytes arrive: an SSE stream split at every byte, inside UTF-8 sequences', () => {
  const answer = 'Café 🌍 ok.\nfaq\n  item "Ünïcødé 🌍?"\n    text "Yes."\nDone.';
  // Two deltas, as a completions stream sends them; the adapter path is SSE reader → JSON → parser.
  const deltas = [answer.slice(0, 9), answer.slice(9)];
  const bytes = new TextEncoder().encode(deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join('') + 'data: [DONE]\n\n');
  const viaSse = (cuts: number[]) => {
    const sse = createSseReader();
    const p = createAnswerParser(RULES);
    const events: AnswerEvent[] = [];
    const take = (data: string) => {
      if (data === '[DONE]') return;
      events.push(...p.push((JSON.parse(data) as { choices: { delta: { content: string } }[] }).choices[0].delta.content));
    };
    let at = 0;
    for (const cut of [...cuts, bytes.length]) {
      for (const e of sse.push(bytes.slice(at, cut))) take(e.data);
      at = cut;
    }
    for (const e of sse.end()) take(e.data);
    events.push(...p.end());
    return canonical(summarise(events, p));
  };
  const expected = canonical(whole(answer));
  assert.equal(expected.blocks.length, 1);
  for (let i = 0; i <= bytes.length; i++) assert.deepEqual(viaSse([i]), expected, `byte split at ${i}`);
});

/* ---- cost: linear on adversarial input ------------------------------------ */

/** CPU milliseconds `f` takes: the least of `runs`. */
function cpuMs(f: () => unknown, runs = 3): number {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const start = process.cpuUsage();
    f();
    const used = process.cpuUsage(start);
    best = Math.min(best, (used.user + used.system) / 1000);
  }
  return best;
}

/** Shapes a parser could restart on, none of which reaches a cap that ends the read early. */
const ADVERSARIAL: Readonly<Record<string, string>> = {
  'unterminated strings in a held line': 'faq "',
  'deep indents inside a component': 'faq\n' + `${' '.repeat(64)}x\n`,
  'escapes in a held line': 'cta "\\\\\\"',
  'keyword prefixes': 'fe',
  'items past the cap': 'feature\n  item "x"\n',
};

const MB = 1024 * 1024;
for (const [name, unit] of Object.entries(ADVERSARIAL)) {
  test(`LINEAR: ${name}, 4MB — about eight times the cost for eight times the input`, () => {
    const fill = (chars: number) => unit.repeat(Math.ceil(chars / unit.length));
    const big = fill(4 * MB);
    const small = fill((4 * MB) / 8);
    const parse = (s: string) => { const p = createAnswerParser(RULES); for (let i = 0; i < s.length; i += 4096) p.push(s.slice(i, i + 4096)); p.end(); };
    const tBig = cpuMs(() => parse(big), 1);
    const tSmall = cpuMs(() => parse(small));
    assert.ok(tBig <= (big.length * 1_000) / 1e6, `${tBig.toFixed(1)}ms CPU for ${big.length} characters`);
    assert.ok(tBig <= 24 * Math.max(tSmall, 1), `8× the input took ${(tBig / tSmall).toFixed(1)}× (${tSmall.toFixed(1)} → ${tBig.toFixed(1)}ms)`);
  });
}

/* ---- C5 (chat-block-spec §21.1.2): follow-up questions and code fences ---- */

test('a follow-up question is its own event, in the record, and not a component', () => {
  const r = whole(['Here is the answer.', 'ask "How do I cancel?"', 'ask "Is there a \\"team\\" plan?"'].join('\n'));
  assert.deepEqual(r.blocks, [{ ask: 'How do I cancel?' }, { ask: 'Is there a "team" plan?' }]);
  assert.equal(r.text, 'Here is the answer.\n');
  assert.equal(r.record, 'Here is the answer.\nask "How do I cancel?"\nask "Is there a \\"team\\" plan?"\n');
  assert.deepEqual(r.dropped, []);
  // On a prose-only page too: a follow-up needs no `show`.
  assert.deepEqual(whole('ask "And yearly?"', { ...RULES, show: [] }).blocks, [{ ask: 'And yearly?' }]);
  // Not counted as components: four components and three follow-ups all show.
  const many = whole([...Array.from({ length: 4 }, (_, i) => `cta "Go ${i}" /contact`), 'ask "a?"', 'ask "b?"', 'ask "c?"'].join('\n'));
  assert.equal(many.blocks.length, 7);
  assert.equal(many.ended, false);
});

test(`caps: ${ANSWER_LIMITS.asks} follow-ups of ${ANSWER_LIMITS.ask} characters; past them dropped, the answer goes on`, () => {
  const at = 'q'.repeat(ANSWER_LIMITS.ask);
  assert.deepEqual(whole(`ask "${at}"`).blocks, [{ ask: at }]);
  const over = whole(`ask "${at}q"`);
  assert.deepEqual(over.blocks, []);
  assert.deepEqual(over.dropped, ['too_long']);
  const four = whole(['ask "1?"', 'ask "2?"', 'ask "3?"', 'ask "4?"', 'Still prose after them.'].join('\n'));
  assert.deepEqual(four.blocks, [{ ask: '1?' }, { ask: '2?' }, { ask: '3?' }]);
  assert.deepEqual(four.dropped, ['too_many']);
  assert.equal(four.text, 'Still prose after them.');
  assert.equal(four.ended, false);
});

test('a follow-up with a line break, a child line, no string or two strings is not one', () => {
  assert.deepEqual(whole('ask "one\\ntwo"').dropped, ['shape']);
  const child = whole(['ask "Why?"', '  text "nested"'].join('\n'));
  assert.deepEqual(child.blocks, []);
  assert.deepEqual(child.dropped, ['shape']);
  // Not its shape: a sentence that starts with the word.
  assert.equal(whole('ask me anything').text, 'ask me anything');
  assert.equal(whole('ask "a" "b"').text, 'ask "a" "b"');
  assert.deepEqual(whole('ask ""').dropped, ['empty']);
});

test('inside a code fence every line is prose: a component written as code is the code\'s text', () => {
  const answer = ['Try this:', '```az', 'show pricing /pricing', 'cta "Go" /contact', 'ask "Hidden?"', '  item "indented"', '', 'faq', '```', 'After it, a real one:', 'cta "Go" /contact'].join('\n');
  const r = whole(answer);
  assert.equal(r.text, ['Try this:', '```az', 'show pricing /pricing', 'cta "Go" /contact', 'ask "Hidden?"', '  item "indented"', '', 'faq', '```', 'After it, a real one:', ''].join('\n'));
  assert.deepEqual(r.blocks, [{ cta: { label: 'Go', to: '/contact' } }]);
  assert.deepEqual(r.dropped, []);
  // The same however it is split.
  for (let i = 0; i <= answer.length; i++) assert.deepEqual(run([answer.slice(0, i), answer.slice(i)]), r, `split at ${i}`);
});

test('a fence opens only at the margin; an unclosed one runs to the end; it closes an open component first', () => {
  // Indented: not a fence, so the next component line is a component.
  assert.deepEqual(whole([' ```', 'cta "Go" /contact'].join('\n')).blocks, [{ cta: { label: 'Go', to: '/contact' } }]);
  // Unclosed: everything after it is the code's.
  const open = whole(['```', 'cta "Go" /contact', 'ask "x?"'].join('\n'));
  assert.deepEqual(open.blocks, []);
  assert.equal(open.text, '```\ncta "Go" /contact\nask "x?"');
  // A fence at the margin ends the faq above it, which is shown; what follows is code.
  const after = whole(['faq', '  item "Q?"', '    text "A."', '```', 'cta "Go" /contact', '```'].join('\n'));
  assert.deepEqual(after.blocks, [{ faq: [{ q: 'Q?', a: 'A.' }] }]);
  assert.equal(after.text, '```\ncta "Go" /contact\n```');
  // Only the backticks alone (trailing spaces allowed) close a block: a line naming a language inside one does not.
  const inner = whole(['```', '```js', 'cta "Go" /contact', '```  ', 'cta "Go" /contact'].join('\n'));
  assert.deepEqual(inner.blocks, [{ cta: { label: 'Go', to: '/contact' } }]);
  assert.equal(inner.text, '```\n```js\ncta "Go" /contact\n```  \n');
});

/* ---- the history the model is sent back (§19.15) -------------------------- */

const ALL: AnswerRules = {
  ...RULES, show: ['pricing', 'faq', 'cta', 'feature', 'chart', 'table', 'stats', 'cards', 'dashboard', 'explore', 'map'], images: ['i1'],
};

/** An answer read whole: its history, its record and what it dropped. */
function historyOf(answer: string, rules: AnswerRules = ALL): { history: string; record: string; dropped: string[]; blocks: unknown[] } {
  const p = createAnswerParser(rules);
  const events = [...p.push(answer), ...p.end()];
  return { history: p.history(), record: p.record, dropped: [...p.dropped], blocks: events.filter((e) => e.type === 'block').map((e) => (e as { block: unknown }).block) };
}

test('§19.15 history: each long component a one-line stand-in, prose and ask lines as they are; the record keeps the canonical lines', () => {
  const answer = [
    'Here is this month.',
    'dashboard "This month"',
    '  stat "Orders" from orders count',
    '  chart bar "By status" from orders count by status',
    'chart line "Expected"',
    '  point "Nov" 140',
    '  point "Dec" 180',
    'faq',
    '  item "Can I cancel?"',
    '    text "Yes, from your account page, at any time."',
    '  item "Do you ship abroad?"',
    '    text "Yes, to most countries."',
    'Anything else?',
    'ask "How do I cancel?"',
  ].join('\n');
  const r = historyOf(answer);
  assert.equal(r.blocks.length, 4);
  assert.equal(r.history, [
    'Here is this month.',
    '[shown: dashboard "This month"]',
    '[shown: chart line "Expected" (your own figures)]',
    '[shown: faq "Can I cancel?" "Do you ship abroad?"]',
    'Anything else?',
    'ask "How do I cancel?"',
    '',
  ].join('\n'));
  assert.match(r.record, /^ {2}point "Nov" 140$/m, 'the record is the canonical lines, as before');
  assert.ok(r.history.length * 3 < r.record.length * 2, `${r.history.length} against ${r.record.length}`);
});

test('§19.15 history: every component\'s stand-in names its word, kind, title and where its figures came from — never a row, point or cell', () => {
  const cases: [string, string][] = [
    ['show pricing /plans#2', 'show pricing /plans#2\n'],
    ['cta "Talk to us" /contact', 'cta "Talk to us" /contact\n'],
    ['feature\n  item "Bright"\n    text "800 lumens."\n  item "Quiet"', '[shown: feature "Bright" "Quiet"]\n'],
    ['chart bar "By status" from orders count by status', '[shown: chart bar "By status" (site data)]\n'],
    ['table "Plans" sortable\n  columns "Plan" "Seats"\n  row "Team" 10\n  row "Studio" 50', '[shown: table "Plans" (your own figures)]\n'],
    ['table "Newest" from orders columns item total', '[shown: table "Newest" (site data)]\n'],
    ['stats\n  stat "Orders" from orders count\n  stat "Conversion" 3.2 unit percent', '[shown: stats "Orders" "Conversion"]\n'],
    ['cards\n  card "Linen shirt"\n    text "Breathable."\n  card "Wool scarf"', '[shown: cards "Linen shirt" "Wool scarf"]\n'],
    ['cards from orders title item', '[shown: cards (site data)]\n'],
    ['explore "Plan cost"\n  columns "Plan" "Seats"\n  row "Team" 10\n  row "Studio" 50\n  view table', '[shown: explore "Plan cost"]\n'],
    ['map "Where"\n  pin "Shop" 52.52 13.40', '[shown: map "Where"]\n'],
    ['map "Stores" from orders label item lat total lon total', '[shown: map "Stores" (site data)]\n'],
    ['faq\n  item "A \\"quoted\\" question\\nsplit"\n    text "Yes."', '[shown: faq "A \\"quoted\\" question\\nsplit"]\n'],
  ];
  for (const [answer, want] of cases) {
    const r = historyOf(answer);
    assert.equal(r.blocks.length, 1, `${answer}: ${r.dropped.join(',')}`);
    assert.equal(r.history, want, answer);
  }
});

test('§19.15 history: a component dropped whole is one note of its word and reason code — no text the model or a visitor wrote', () => {
  const answer = [
    'Two goes.',
    'chart bar "Orders"',
    '  point "W1" NaN',
    '  point "W2" 3',
    'faq',
    ...Array.from({ length: 7 }, (_, i) => `  item "Question ${i + 1}?"\n    text "Answer."`),
    'show pricing /secret-visitor-route',
    'cta "Go" https://evil.example/',
    'feature',
    '  item "T"',
    '    text "x"',
    '      text "too deep"',
    'stats',
    '  stat "Orders" from tool nothing count',
    'ask "One?"',
    'ask "Two?"',
    'ask "Three?"',
    'ask "Four?"',
    'pricing cards',
    '  plan "Free"',
  ].join('\n');
  const r = historyOf(answer);
  assert.deepEqual(r.dropped, ['number', 'too_many', 'no_quote', 'destination', 'shape', 'tool', 'too_many', 'composed_pricing']);
  assert.equal(r.history, [
    'Two goes.',
    '(dropped: chart, number)',
    '(dropped: faq, too_many)',
    '(dropped: pricing, no_quote)',
    '(dropped: cta, destination)',
    '(dropped: feature, shape)',
    '(dropped: stats, tool)',
    'ask "One?"',
    'ask "Two?"',
    'ask "Three?"',
    '(dropped: ask, too_many)',
    '(dropped: pricing, composed_pricing)',
    '',
  ].join('\n'));
  for (const word of ['secret-visitor-route', 'evil.example', 'NaN', 'Question', 'nothing', 'Free', 'Four']) assert.ok(!r.history.includes(word), word);
  // A `show` of a word no answer may hold is noted as a show, never by the word the model wrote.
  assert.equal(historyOf('show gallery-of-secrets /pricing').history, '(dropped: show, not_shown)\n');
  // A line too long to be a component is noted by its keyword.
  assert.equal(historyOf(`faq ${'x'.repeat(ANSWER_LIMITS.line + 10)}`).history, '(dropped: faq, too_long)\n');
});

test('§19.15 history: the route\'s own drops become notes in place; notes never take the history past the record cap', () => {
  const p = createAnswerParser(ALL);
  const events = [...p.push('Look.\nchart bar "A" from orders count by status\ncta "Talk" /contact\n'), ...p.end()];
  const chart = events.find((e) => e.type === 'block' && 'chart' in e.block)!;
  assert.ok(chart.type === 'block');
  assert.equal(p.history(new Map([[chart.block, 'figures']])), 'Look.\n(dropped: chart, figures)\ncta "Talk" /contact\n');
  assert.equal(p.history(), 'Look.\n[shown: chart bar "A" (site data)]\ncta "Talk" /contact\n', 'CONTROL: without the route\'s drop, the stand-in');
  // Prose to the cap, then drops: the notes that do not fit are left out, the text never cut.
  const prose = `${'p'.repeat(3_000)}\n`;
  const full = createAnswerParser(ALL);
  full.push(`${prose.repeat(4).slice(0, ANSWER_LIMITS.prose - 50)}\n`);
  for (let i = 0; i < 400; i++) full.push(`cta "Go" /nowhere-${i}\n`);
  full.end();
  const h = full.history();
  assert.equal(full.dropped.length, 400, 'every drop still counted');
  assert.ok(h.length <= ANSWER_LIMITS.record && h.length > ANSWER_LIMITS.record - 1_000, String(h.length));
  assert.ok(h.startsWith(prose.slice(0, 3_000)), 'the prose whole');
  assert.ok((h.match(/\(dropped: cta, destination\)/g) ?? []).length < 400, 'the notes past the cap are left out');
});

/* ---- quoting the site's own lists (§19.15) -------------------------------- */

const LISTS: AnswerRules = {
  ...RULES,
  quotes: [
    ...RULES.quotes,
    { word: 'faq', route: '/help', n: 0, label: 'Questions', items: [{ title: 'Do you ship abroad?', text: 'Yes, to most countries.' }, { title: 'Is there a warranty?', text: 'Two years.' }] },
    { word: 'faq', route: '/help', n: 1, items: [{ title: 'Long?', text: 'x'.repeat(ANSWER_LIMITS.answer + 1) }, { title: 'Short?', text: 'Yes.' }] },
    { word: 'feature', route: '/', n: 0, label: 'Why us', items: [{ title: 'Bright', text: '800 lumens.' }, { title: 'Quiet', text: '' }] },
  ],
};

test('§19.15 quotes: show faq or feature quotes the site\'s own list, whole or the one item #n names; its history is the quote\'s line', () => {
  const p = createAnswerParser(LISTS);
  const events = [...p.push('From the site.\nshow faq /help\nshow faq /help #2\nshow feature /\n'), ...p.end()];
  assert.deepEqual(events.filter((e) => e.type === 'block').map((e) => (e as { block: unknown }).block), [
    { faq: [{ q: 'Do you ship abroad?', a: 'Yes, to most countries.' }, { q: 'Is there a warranty?', a: 'Two years.' }] },
    { faq: [{ q: 'Is there a warranty?', a: 'Two years.' }] },
    { feature: [{ title: 'Bright', text: '800 lumens.' }, { title: 'Quiet', text: '' }] },
  ]);
  assert.deepEqual([...p.dropped], []);
  assert.equal(p.record, 'From the site.\nshow faq /help\nshow faq /help #2\nshow feature /\n');
  assert.equal(p.history(), p.record, 'a quote is its own one line, in the record and the history');
});

test('§19.15 quotes: no such list or item, an item of a pricing block, an author\'s item past the caps, a word not shown — each dropped by its code', () => {
  const cases: [string, string[]][] = [
    ['show faq /help #3', ['no_quote']],
    ['show faq /help #0', ['no_quote']],
    ['show faq /help #x', ['no_quote']],
    ['show faq /help#3', ['no_quote']],
    ['show faq /nowhere', ['no_quote']],
    ['show faq /help#2', ['too_long']],
    ['show pricing /pricing #1', ['shape']],
    ['show feature /help', ['no_quote']],
    ['show gallery /help', ['not_shown']],
  ];
  for (const [answer, dropped] of cases) {
    const r = whole(answer, LISTS);
    assert.deepEqual([r.blocks, r.dropped], [[], dropped], answer);
  }
  // One item of a list whose other item is past the caps is fine: only what is quoted is judged.
  assert.deepEqual(whole('show faq /help#2 #2', LISTS).blocks, [{ faq: [{ q: 'Short?', a: 'Yes.' }] }]);
  // A chat that does not show faq cannot quote one.
  assert.deepEqual(whole('show faq /help', { ...LISTS, show: ['pricing'] }).dropped, ['not_shown']);
  // CONTROL: the composed form still stands beside the quote.
  assert.equal(whole('faq\n  item "Q?"\n    text "A."', LISTS).blocks.length, 1);
});

/* ---- the one-line forms (§19.15) ------------------------------------------ */

test('§19.15 one-line forms: item "title" "text" reads as the long form, under the same caps; the prompt teaches it alone', () => {
  const long = whole('faq\n  item "Can I switch?"\n    text "Yes."\n  item "Refunds?"\n    text "Within 30 days."\nfeature\n  item "Fast"\n    text "Pre-rendered."\n  item "Small"');
  const short = whole('faq\n  item "Can I switch?" "Yes."\n  item "Refunds?" "Within 30 days."\nfeature\n  item "Fast" "Pre-rendered."\n  item "Small"');
  assert.deepEqual(short.blocks, long.blocks);
  assert.deepEqual([short.dropped, short.record], [[], long.record], 'one record whichever form was written');
  // Both forms mixed in one list read the same.
  assert.deepEqual(whole('faq\n  item "Can I switch?" "Yes."\n  item "Refunds?"\n    text "Within 30 days."').blocks, [long.blocks[0]]);
  // The caps: a seventh item, an over-long text, an empty answer — each as for the long form.
  const seven = `faq\n${Array.from({ length: 7 }, (_, i) => `  item "Q${i}?" "A."`).join('\n')}`;
  assert.deepEqual(whole(seven).dropped, ['too_many']);
  assert.deepEqual(whole(`faq\n  item "Q?" "${'a'.repeat(ANSWER_LIMITS.answer + 1)}"`).dropped, ['too_long']);
  assert.deepEqual(whole(`feature\n  item "T" "${'t'.repeat(ANSWER_LIMITS.text + 1)}"`).dropped, ['too_long']);
  assert.deepEqual(whole('faq\n  item "Q?" ""').dropped, ['empty']);
  assert.deepEqual(whole('faq\n  item "Q?" "<script>alert(1)</script>"').blocks, [{ faq: [{ q: 'Q?', a: '<script>alert(1)</script>' }] }], 'text, never markup');
  // The prompt's forms are the one-line ones.
  assert.deepEqual(ANSWER_FORMS.faq.lines, ['faq', '  item "A question, at most 160 characters" "Its answer, at most 600 characters"']);
  assert.deepEqual(ANSWER_FORMS.feature.lines, ['feature', '  item "A title, at most 80 characters" "One or two sentences, at most 300 characters"']);
  assert.ok(ANSWER_FORMS.chart.lines.some((l) => /^ {4}points "Nov" 140 "Dec" 180$/.test(l)) && !ANSWER_FORMS.chart.lines.some((l) => /^\s*point /.test(l)));
});

/* ---- the author's presets (§19.15) ----------------------------------------- */

const PRESETS: AnswerRules = {
  ...RULES,
  show: ['cta', 'chart', 'stats', 'dashboard', 'faq'],
  presets: [
    { name: 'monthly', text: 'dashboard "This month"\n  stat "Orders" from orders count\n  chart bar "By status" from orders count by status\n' },
    { name: 'talk', text: 'cta "Talk to us" /contact\n' },
    { name: 'estimate', text: 'chart line "Expected"\n  points "Nov" 140 "Dec" 180\n' },
    { name: 'chatty', text: 'Some prose.\ncta "Talk to us" /contact\n' },
    { name: 'heavy', text: `stats\n${Array.from({ length: 4 }, (_, i) => `  stat "S${i}" from orders count`).join('\n')}\n` },
  ],
};

test('§19.15 use: the model\'s one line shows the author\'s whole component, read under the page\'s rules; the record and history are that line', () => {
  const p = createAnswerParser(PRESETS);
  const events = [...p.push('This month:\nuse monthly\nuse talk\nuse estimate\n'), ...p.end()];
  const blocks = events.filter((e) => e.type === 'block').map((e) => (e as { block: unknown }).block);
  assert.deepEqual(blocks, [
    { dashboard: { title: 'This month', tiles: [{ stat: { label: 'Orders', from: ['orders', 'count'] } }, { chart: { kind: 'bar', title: 'By status', from: ['orders', 'count', 'by', 'status'] } }] } },
    { cta: { label: 'Talk to us', to: '/contact' } },
    { chart: { kind: 'line', title: 'Expected', unit: null, src: 'model', series: [{ name: 'Expected', points: [['Nov', 140], ['Dec', 180]] }] } },
  ]);
  assert.deepEqual([...p.dropped], []);
  assert.equal(p.record, 'This month:\nuse monthly\nuse talk\nuse estimate\n');
  assert.equal(p.history(), p.record);
});

test('§19.15 use: a name the chat has not, a preset that is not one clean component, the caps — each dropped by its code; without presets the line is prose', () => {
  assert.deepEqual(whole('use nothing', PRESETS).dropped, ['no_quote']);
  assert.deepEqual(whole('use chatty', PRESETS).dropped, ['shape'], 'a preset with prose is not one component');
  assert.equal(whole('use talk now', PRESETS).text, 'use talk now', 'three words are a sentence');
  // A use is one component toward the four.
  const five = whole('use talk\nuse talk\nuse talk\nuse talk\nuse talk', PRESETS);
  assert.deepEqual([five.blocks.length, five.dropped], [4, ['components']]);
  // Its `from` requests count in the answer's six: two heavy presets are eight.
  assert.deepEqual(whole('use heavy\nuse heavy', PRESETS).dropped, ['too_many']);
  // The page's rules apply: a preset of a word this page does not show is dropped.
  assert.deepEqual(whole('use talk', { ...PRESETS, show: ['faq'] }).dropped, ['not_shown']);
  // No presets: `use` is an ordinary word.
  assert.deepEqual([whole('use talk', RULES).text, whole('use talk', RULES).dropped], ['use talk', []]);
  // A preset never uses another.
  const nested = { ...PRESETS, presets: [{ name: 'outer', text: 'use talk\n' }, ...PRESETS.presets!] };
  assert.deepEqual(whole('use outer', nested).dropped, ['shape']);
});
