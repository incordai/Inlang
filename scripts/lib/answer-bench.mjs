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
 * C2b's rich components (chat-block-spec §20.3) are measured the same way:
 * a dashboard with server and model charts, a two-series model chart, a
 * server table and a model table, model and server cards. A `from …` is one
 * line however many figures it yields; markdown has to write the figures
 * out (the table a server chart would draw), so it is counted that way.
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
  show: ['pricing', 'faq', 'cta', 'feature', 'chart', 'table', 'stats', 'cards', 'dashboard'],
  quotes: [{ word: 'pricing', route: '/pricing', n: 0 }],
  destinations: ['/', '/contact', '/pricing', '/signup', '/shop'],
  images: ['i1'],
};

/** What the server's figures would be for the rich samples' `from` lines — what markdown has to write out. */
const ORDERS_BY_STATUS = [['paid', 3], ['open', 1], ['cancelled', 1]];
const ORDERS_BY_MONTH = [['2026-08', 2], ['2026-09', 1], ['2026-10', 4]];

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
    ...richCases(),
    {
      name: 'composed pricing (refused)', blocks: null,
      az: ['pricing cards', ...PLANS.flatMap((p) => [`  plan ${q(p.name)}`, `    monthly ${p.monthly.slice(1, -3)}`, `    annual ${p.annual.slice(1, -3)}`, `    cta ${q(p.action)} ${p.to}`])].join('\n'),
      json: JSON.stringify({ answer: [{ type: 'pricing', variant: 'cards', plans: PLANS.map((p) => ({ name: p.name, monthly: p.monthly, annual: p.annual, cta: { label: p.action, to: p.to } })) }] }),
      markdown: mdPricing(),
    },
  ];
}

/** C2b (§20.3): the rich components in the three forms; `blocks` are what the parser reads, `from` requests still unfilled. */
function richCases() {
  const mdTable = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
  const expected = { name: 'Expected next quarter', points: [['Nov', 140], ['Dec', 180], ['Jan', 120]] };
  const dashboard = {
    dashboard: {
      title: 'Orders this month',
      tiles: [
        { stat: { label: 'Orders', from: ['orders', 'count', 'by', 'placed', 'month'] } },
        { chart: { kind: 'bar', title: 'Orders by status', from: ['orders', 'count', 'by', 'status'] } },
        { chart: { kind: 'line', title: 'Orders per month', from: ['orders', 'count', 'by', 'placed', 'month'] } },
        { chart: { kind: 'line', title: 'Expected next quarter', unit: null, src: 'model', series: [expected] } },
      ],
    },
  };
  const signups = {
    chart: {
      kind: 'bar', title: 'Signups by plan', unit: null, src: 'model',
      series: [
        { name: '2025', points: [['Free', 120], ['Team', 45], ['Business', 12]] },
        { name: '2026', points: [['Free', 160], ['Team', 70], ['Business', 20]] },
      ],
    },
  };
  const tables = [
    { table: { title: 'Our newest products', sortable: false, from: ['products', 'columns', 'name', 'price', 'stock', 'sort', 'created', 'desc'] } },
    { table: { title: 'Plan comparison', sortable: true, src: 'model', columns: [{ label: 'Plan', type: 'text' }, { label: 'Seats', type: 'number' }], rows: [['Team', 10], ['Business', 50]] } },
  ];
  const cards = [
    { cards: [{ title: 'Linen shirt', text: 'Breathable, for hot days.', image: { asset: 'i1' }, link: { label: 'See the shirts', to: '/shop' } }] },
    { cards: { from: ['products', 'title', 'name', 'text', 'summary', 'image', 'photo'] } },
  ];
  return [
    {
      name: 'dashboard (2 server charts, a model chart)', blocks: [dashboard],
      az: [
        'dashboard "Orders this month"',
        '  stat "Orders" from orders count by placed month',
        '  chart bar "Orders by status" from orders count by status',
        '  chart line "Orders per month" from orders count by placed month',
        '  chart line "Expected next quarter"',
        '    point "Nov" 140',
        '    point "Dec" 180',
        '    point "Jan" 120',
      ].join('\n'),
      json: json([dashboard]),
      markdown: [
        '**Orders this month**', '', 'Orders: 4 (up 3 on September)', '',
        '**Orders by status**', '', mdTable(['Status', 'Orders'], ORDERS_BY_STATUS), '',
        '**Orders per month**', '', mdTable(['Month', 'Orders'], ORDERS_BY_MONTH), '',
        '**Expected next quarter** (my estimate)', '', mdTable(['Month', 'Orders'], expected.points),
      ].join('\n'),
    },
    {
      name: 'model chart (2 series of 3)', blocks: [signups],
      az: ['chart bar "Signups by plan"', '  series "2025"', '    point "Free" 120', '    point "Team" 45', '    point "Business" 12',
        '  series "2026"', '    point "Free" 160', '    point "Team" 70', '    point "Business" 20'].join('\n'),
      json: json([signups]),
      markdown: ['**Signups by plan**', '', mdTable(['Plan', '2025', '2026'], [['Free', 120, 160], ['Team', 45, 70], ['Business', 12, 20]])].join('\n'),
    },
    {
      name: 'tables (server + model)', blocks: tables,
      az: ['table "Our newest products" from products columns name price stock sort created desc',
        'table "Plan comparison" sortable', '  columns "Plan" "Seats"', '  row "Team" 10', '  row "Business" 50'].join('\n'),
      json: json(tables),
      markdown: ['**Our newest products**', '', mdTable(['Name', 'Price', 'Stock'], [['Linen shirt', '$49.00', 12], ['Wool scarf', '$35.00', 4], ['Canvas bag', '$29.00', 30]]),
        '', '**Plan comparison**', '', mdTable(['Plan', 'Seats'], [['Team', 10], ['Business', 50]])].join('\n'),
    },
    {
      name: 'cards (model + server)', blocks: cards,
      az: ['cards', '  card "Linen shirt"', '    image i1', '    text "Breathable, for hot days."', '    link "See the shirts" /shop',
        'cards from products title name text summary image photo'].join('\n'),
      json: json(cards),
      markdown: ['![A linen shirt](/assets/linen.webp)', '**Linen shirt** — Breathable, for hot days. [See the shirts](/shop)', '',
        '![](/data/products/1/photo) **Wool scarf** — Soft and warm.', '![](/data/products/2/photo) **Canvas bag** — Carries a laptop.'].join('\n'),
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
