/**
 * The token benchmark's answer-format part (docs/token-benchmark.md §7,
 * chat-block-spec §5.1–5.2): the same chat answers written three ways —
 * the restricted `.az` subset a model is taught (server chat-answer.ts),
 * a compact JSON document of the same events, and markdown — counted
 * with the benchmark's own tokenizers. `scripts/token-benchmark.mjs`
 * prints them after the site table.
 *
 * Every `.az` answer is checked against the real answer parser before it
 * is counted: it must parse into exactly the blocks its JSON form carries,
 * so the comparison is of one content in three spellings, not of three
 * different answers. Markdown cannot quote a block, so where the `.az`
 * form quotes the site's pricing, the markdown form must spell the table out.
 *
 * Also measured: what the model is sent besides the conversation — the
 * generated prompt.txt and context.json of the chat e2e site — and the
 * characters per token of prose, against the server's estimate of 3.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnswerParser } from '../../packages/backend/src/server/chat-answer.ts';
import { build } from '../../packages/cli/src/az.ts';
import { ROOT, WORDS, literal } from './token-bench.mjs';

/** The forms, in table order. */
export const ANSWER_FORMS = ['az', 'json', 'markdown'];

/** The rules the `.az` answers are parsed under: every component, the e2e site's quote and destinations. */
export const ANSWER_RULES = {
  show: ['pricing', 'faq', 'cta', 'feature'],
  quotes: [{ word: 'pricing', route: '/pricing', n: 0 }],
  destinations: ['/', '/contact', '/pricing', '/signup'],
};

const PROSE = 'For five people, Studio fits: every lamp in one account, billed monthly or yearly.';
const FAQ = [
  { q: 'Can I cancel any time?', a: 'Yes. Cancel from your account page; the plan runs to the end of the month you paid for.' },
  { q: 'Do you ship abroad?', a: 'Yes, to most countries. Delivery takes five to ten working days.' },
  { q: 'Is there a warranty?', a: 'Every lamp has a two-year warranty that covers the light and the dimmer.' },
];
const FEATURES = [
  { title: 'Bright', text: '800 lumens from a lamp the size of a mug.' },
  { title: 'Dimmable', text: 'Ten steps, from reading light to night light.' },
  { title: 'Quiet', text: 'No fan and no hum, ever.' },
];
/** The e2e site's pricing as its page renders it: what markdown has to write out to show the same table. */
const PLANS = [
  { name: 'Home', monthly: '$9.00', annual: '$90.00', action: 'Start', to: '/signup' },
  { name: 'Studio', monthly: '$29.00', annual: '$290.00', action: 'Start', to: '/signup' },
];

const q = (s) => JSON.stringify(s);
const azFaq = (items) => `faq\n${items.map((i) => `  item ${q(i.q)}\n    text ${q(i.a)}`).join('\n')}`;
const azFeature = (items) => `feature\n${items.map((i) => `  item ${q(i.title)}\n    text ${q(i.text)}`).join('\n')}`;
const mdFaq = (items) => items.map((i) => `**${i.q}**\n\n${i.a}`).join('\n\n');
const mdFeature = (items) => items.map((i) => `- **${i.title}**: ${i.text}`).join('\n');
const mdPricing = () => ['| Plan | Monthly | Yearly | |', '|---|---|---|---|', ...PLANS.map((p) => `| ${p.name} | ${p.monthly} | ${p.annual} | [${p.action}](${p.to}) |`)].join('\n');
/** A compact JSON answer: the events in order, as a JSON-schema answer format would carry them. */
const json = (events) => JSON.stringify({ answer: events });

/**
 * Each answer: its three forms and the blocks it holds. `composed-pricing`
 * is the one form an answer may NOT use (pricing is quote-only, L8); it is
 * measured to replace §5.2's byte comparison with tokens, and is not parsed.
 */
export function answerCases() {
  const quote = { quote: 'pricing', route: '/pricing', n: 0 };
  const cta = { cta: { label: 'Talk to us', to: '/contact' } };
  return [
    {
      name: 'prose', blocks: [],
      az: PROSE, json: json([{ text: PROSE }]), markdown: PROSE,
    },
    {
      name: 'pricing (quoted)', blocks: [quote],
      az: `${PROSE}\nshow pricing /pricing`,
      json: json([{ text: PROSE }, quote]),
      markdown: `${PROSE}\n\n${mdPricing()}`,
    },
    {
      name: 'faq (3 items)', blocks: [{ faq: FAQ }],
      az: azFaq(FAQ), json: json([{ faq: FAQ }]), markdown: mdFaq(FAQ),
    },
    {
      name: 'cta', blocks: [cta],
      az: 'cta "Talk to us" /contact', json: json([cta]), markdown: '[Talk to us](/contact)',
    },
    {
      name: 'feature (3 items)', blocks: [{ feature: FEATURES }],
      az: azFeature(FEATURES), json: json([{ feature: FEATURES }]), markdown: mdFeature(FEATURES),
    },
    {
      name: 'mixed (prose, faq, cta)', blocks: [{ faq: FAQ.slice(0, 2) }, cta],
      az: `${PROSE}\n${azFaq(FAQ.slice(0, 2))}\ncta "Talk to us" /contact`,
      json: json([{ text: PROSE }, { faq: FAQ.slice(0, 2) }, cta]),
      markdown: `${PROSE}\n\n${mdFaq(FAQ.slice(0, 2))}\n\n[Talk to us](/contact)`,
    },
    {
      name: 'composed pricing (refused)', blocks: null,
      az: ['pricing cards', ...PLANS.flatMap((p) => [`  plan ${q(p.name)}`, `    monthly ${p.monthly.slice(1, -3)}`, `    annual ${p.annual.slice(1, -3)}`, `    cta ${q(p.action)} ${p.to}`])].join('\n'),
      json: JSON.stringify({ answer: [{ type: 'pricing', variant: 'cards', plans: PLANS.map((p) => ({ name: p.name, monthly: p.monthly, annual: p.annual, cta: { label: p.action, to: p.to } })) }] }),
      markdown: mdPricing(),
    },
  ];
}

/** The blocks the real answer parser reads from an `.az` answer, in order. */
export function parsedBlocks(az) {
  const p = createAnswerParser(ANSWER_RULES);
  const events = [...p.push(az), ...p.end()];
  return events.filter((e) => e.type === 'block').map((e) => e.block);
}

/** Every case counted in every form and encoding; throws when an `.az` answer does not parse to its blocks. */
export function measureAnswers(counters) {
  return answerCases().map((c) => {
    if (c.blocks !== null && JSON.stringify(parsedBlocks(c.az)) !== JSON.stringify(c.blocks)) {
      throw new Error(`answer ${c.name}: the .az form does not parse to its blocks`);
    }
    const forms = {};
    for (const f of ANSWER_FORMS) {
      const tokens = {};
      for (const [name, fn] of Object.entries(counters)) tokens[name] = fn(c[f]);
      forms[f] = { chars: c[f].length, tokens };
    }
    return { name: c.name, quotable: c.blocks !== null, forms };
  });
}

/**
 * What a chat model is sent besides the conversation, for the chat e2e
 * site (scripts/chat-e2e.mjs SITE): prompt.txt and context.json as `az
 * build` writes them, counted.
 */
export function measureChatInput(counters) {
  const dir = mkdtempSync(join(tmpdir(), 'az-answer-bench-'));
  try {
    const source = join(dir, 'site.az');
    writeFileSync(source, literal(join(ROOT, 'scripts/chat-e2e.mjs'), 'SITE'));
    const outcome = build({ source, wordsDir: WORDS, projectWordsDir: null, outDir: join(dir, 'out') });
    if (!outcome.ok) throw new Error(`the chat e2e site does not build\n${outcome.report}`);
    const file = (p) => {
      const f = outcome.files.find((x) => x.path === p);
      if (!f) throw new Error(`the chat e2e build has no ${p}`);
      return f.content;
    };
    const result = {};
    for (const [name, value] of Object.entries({ prompt: file('server/chat/prompt.txt'), context: file('server/chat/context.json') })) {
      const tokens = {};
      for (const [enc, fn] of Object.entries(counters)) tokens[enc] = fn(value);
      result[name] = { chars: value.length, tokens };
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
