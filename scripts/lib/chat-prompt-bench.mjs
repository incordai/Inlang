/**
 * The token benchmark's chat-prompt budget (docs/token-benchmark.md §8): what
 * a chat model is sent besides the conversation, for three fixture sites —
 * one chat that may show every component (`scripts/token-benchmark/chat-all.az`),
 * the same site whose chat shows `faq` only (`chat-faq.az`), and a site of
 * forty pages past the size where every page is sent in full (`chat-large.az`,
 * chat-block-spec §19.17) — counted with the benchmark's own tokenizers and
 * held to the budget recorded in `scripts/token-benchmark/chat-prompt-budget.json`.
 * For the large site, measureSelection also counts what its questions are
 * sent with the pages chosen and with the site whole.
 *
 * Three texts per fixture:
 *
 *   prompt   the chat's generated prompt file, as `az build` writes it
 *   context  server/chat/context.json, as `az build` writes it
 *   system   the whole system text the server sends for one question on the
 *            chat's page (server chat.ts systemText), with no `knows` rows
 *
 * The prompt is generated from the components' tables, so each new
 * component or rule makes every chat request dearer; the budget makes that
 * a deliberate change: a count over it fails `pnpm bench:tokens` and the
 * unit test (chat-prompt-bench.test.mjs, part of `pnpm verify`). The budget
 * is updated by hand, in the change that grows or shrinks the prompt.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from '../../packages/cli/src/az.ts';
import { parseChatContext, systemText } from '../../packages/backend/src/server/chat.ts';
import { corpusContext, judgeCorpus } from '../../packages/backend/test/chat-match-corpus.ts';
import { manifests } from '../../packages/backend/test/data-fixture.ts';
import { ROOT, WORDS } from './token-bench.mjs';

const CLI = join(ROOT, 'packages/cli/bin/az.js');
/** `az backend schema` writes one small lock file; past this it is killed. */
const SCHEMA_MS = 60_000;

/** The budget file: the most tokens each fixture's texts may take, per encoding. */
export const BUDGET_PATH = 'scripts/token-benchmark/chat-prompt-budget.json';
export const BUDGET_FILE = join(ROOT, BUDGET_PATH);

/** The fixtures, in table order: a name, the source, and the page whose chat is measured. */
export const CHAT_PROMPT_FIXTURES = [
  { name: 'all', file: 'scripts/token-benchmark/chat-all.az', page: '/' },
  { name: 'faq', file: 'scripts/token-benchmark/chat-faq.az', page: '/' },
  // Forty pages, past the size where every page is sent in full (chat-block-spec §19.17): its system text is
  // the summaries and the visitor's own page; the questions below measure what each question adds.
  { name: 'large', file: 'scripts/token-benchmark/chat-large.az', page: '/' },
];

/** The large fixture's questions, each with the page whose content answers it (chat-block-spec §19.17). */
export const CHAT_LARGE_QUESTIONS = [
  { ask: 'How do I clean the brass on my desk lamp?', page: '/guides/brass-care' },
  { ask: 'Which bulb should I buy for a reading lamp?', page: '/guides/choosing-bulbs' },
  { ask: 'Can I rewire my grandmother\'s old lamp?', page: '/guides/rewiring' },
  { ask: 'Can I leave the lantern outside in the garden?', page: '/guides/outdoor-use' },
  { ask: 'Do you ship abroad?', page: '/help/shipping' },
  { ask: 'How long do I have to return a lamp?', page: '/help/returns' },
  { ask: 'Does the warranty cover the bulb?', page: '/help/warranty' },
  { ask: 'Can I pay by bank transfer?', page: '/help/payments' },
  { ask: 'Is there a discount if I buy twenty lamps for my hotel?', page: '/help/trade' },
  { ask: 'Do gift cards expire?', page: '/help/gifts' },
  { ask: 'How do I reset my password?', page: '/help/account' },
  { ask: 'Will my lamp work with the voltage abroad?', page: '/help/electrics' },
  { ask: 'Tell me about the pendant lamp for my kitchen', page: '/lamps/pendant' },
  { ask: 'Is the night light safe for a child\'s room?', page: '/lamps/kids' },
  { ask: 'How much is the care plan?', page: '/pricing' },
  { ask: 'Where can I see your lamps in person?', page: '/stores' },
];

/** The texts measured per fixture, in table order. */
export const CHAT_PROMPT_TEXTS = ['prompt', 'context', 'system'];

/** The prompt file the chat on `page` reads, as context.json names it, among the build's files. */
export function promptFileOf(files, context, page) {
  const name = context.chats[page]?.prompt;
  const f = files.find((x) => x.path === `server/chat/${name}`);
  if (!f) throw new Error(`the build has no prompt file for the chat on ${page}`);
  return f.content;
}

/** One fixture built in a fresh directory (its data lock recorded first): its chat's three texts, and the context the server reads. */
export function chatPromptTexts(fixture) {
  const dir = mkdtempSync(join(tmpdir(), 'az-chat-prompt-bench-'));
  try {
    const source = join(dir, 'site.az');
    writeFileSync(source, readFileSync(join(ROOT, fixture.file), 'utf8'));
    execFileSync(process.execPath, [CLI, 'backend', 'schema', source], {
      env: { ...process.env, AZ_WORDS: WORDS }, encoding: 'utf8', timeout: SCHEMA_MS, killSignal: 'SIGKILL', stdio: 'pipe',
    });
    const outcome = build({ source, wordsDir: WORDS, projectWordsDir: null, outDir: join(dir, 'out') });
    if (!outcome.ok) throw new Error(`${fixture.file} does not build\n${outcome.report}`);
    const contextFile = outcome.files.find((x) => x.path === 'server/chat/context.json');
    if (!contextFile) throw new Error(`${fixture.file}: the build has no server/chat/context.json`);
    const context = parseChatContext(contextFile.content);
    if (typeof context === 'string') throw new Error(`${fixture.file}: context.json ${context}`);
    const prompt = promptFileOf(outcome.files, context, fixture.page);
    return { prompt, context: contextFile.content, system: systemText(prompt, context, fixture.page), parsed: context };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every fixture's texts counted: `{ [fixture]: { [text]: { chars, tokens: { [encoding]: n } } } }`. */
export function measureChatPrompts(counters) {
  const out = {};
  for (const fixture of CHAT_PROMPT_FIXTURES) {
    const texts = chatPromptTexts(fixture);
    out[fixture.name] = {};
    for (const name of CHAT_PROMPT_TEXTS) {
      const tokens = {};
      for (const [enc, fn] of Object.entries(counters)) tokens[enc] = fn(texts[name]);
      out[fixture.name][name] = { chars: texts[name].length, tokens };
    }
  }
  return out;
}

/**
 * The large fixture's questions (CHAT_LARGE_QUESTIONS): each one's system
 * text with the pages it needs chosen, and with every page in full, counted
 * per encoding, their averages, and the questions whose page was not among
 * those chosen — an answer-quality check: the content that answers must be
 * sent (chat-block-spec §19.17).
 */
export function measureSelection(counters) {
  const fixture = CHAT_PROMPT_FIXTURES.find((f) => f.name === 'large');
  const { prompt, parsed } = chatPromptTexts(fixture);
  const average = { chosen: {}, whole: {} };
  const missed = [];
  for (const [enc, fn] of Object.entries(counters)) {
    let chosen = 0;
    let whole = 0;
    for (const q of CHAT_LARGE_QUESTIONS) {
      const text = systemText(prompt, parsed, fixture.page, '', [], false, [q.ask]);
      chosen += fn(text);
      whole += fn(systemText(prompt, parsed, fixture.page, '', [], false, [q.ask], false));
      if (enc === Object.keys(counters)[0] && !text.includes(`\n${parsed.outline.pages.find((p) => p.route === q.page).full}\n`)) missed.push(q.ask);
    }
    average.chosen[enc] = Math.round(chosen / CHAT_LARGE_QUESTIONS.length);
    average.whole[enc] = Math.round(whole / CHAT_LARGE_QUESTIONS.length);
  }
  return { questions: CHAT_LARGE_QUESTIONS.length, average, missed };
}

/**
 * The topic matcher's corpus (packages/backend/test/fixtures/chat-match/,
 * §19.17): how many of its questions the server answers without the model,
 * how many of those rightly, and how many of the ones the site can answer.
 */
export function measureMatch() {
  const { context, page } = corpusContext(manifests);
  const r = judgeCorpus(context, page);
  return { questions: r.cases.length, answered: r.answered, right: r.right, site: r.site, found: r.found, wrong: r.wrong.map((w) => w.ask) };
}

/** The budget file, read. */
export const readBudget = () => JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));

/**
 * Every count over its budget, as a line; and every count the budget does
 * not cover, so a new fixture, text or encoding is budgeted on purpose.
 */
export function overBudget(measured, budget) {
  const lines = [];
  for (const [fixture, texts] of Object.entries(measured)) {
    for (const [name, m] of Object.entries(texts)) {
      for (const [enc, n] of Object.entries(m.tokens)) {
        const most = budget.fixtures?.[fixture]?.[name]?.[enc];
        if (!Number.isInteger(most)) lines.push(`${fixture} ${name} ${enc}: ${n} tokens, and no budget for it`);
        else if (n > most) lines.push(`${fixture} ${name} ${enc}: ${n} tokens, over its budget of ${most}`);
      }
    }
  }
  return lines;
}

/** Every count under its budget, as a line: room the budget could give back. */
export function underBudget(measured, budget) {
  const lines = [];
  for (const [fixture, texts] of Object.entries(measured)) {
    for (const [name, m] of Object.entries(texts)) {
      for (const [enc, n] of Object.entries(m.tokens)) {
        const most = budget.fixtures?.[fixture]?.[name]?.[enc];
        if (Number.isInteger(most) && n < most) lines.push(`${fixture} ${name} ${enc}: ${n} tokens, ${most - n} under its budget of ${most}`);
      }
    }
  }
  return lines;
}
