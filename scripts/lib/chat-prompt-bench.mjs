/**
 * The token benchmark's chat-prompt budget (docs/token-benchmark.md §8): what
 * a chat model is sent besides the conversation, for two fixture sites —
 * one chat that may show every component (`scripts/token-benchmark/chat-all.az`)
 * and the same site whose chat shows `faq` only (`chat-faq.az`) — counted
 * with the benchmark's own tokenizers and held to the budget recorded in
 * `scripts/token-benchmark/chat-prompt-budget.json`.
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
];

/** The texts measured per fixture, in table order. */
export const CHAT_PROMPT_TEXTS = ['prompt', 'context', 'system'];

/** The prompt file a chat page's model is told, among the build's files. */
export function promptFileOf(files) {
  const f = files.find((x) => x.path === 'server/chat/prompt.txt');
  if (!f) throw new Error('the build has no server/chat/prompt.txt');
  return f.content;
}

/** One fixture built in a fresh directory (its data lock recorded first): its chat's three texts. */
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
    const prompt = promptFileOf(outcome.files);
    const context = parseChatContext(contextFile.content);
    if (typeof context === 'string') throw new Error(`${fixture.file}: context.json ${context}`);
    return { prompt, context: contextFile.content, system: systemText(prompt, context, fixture.page) };
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
