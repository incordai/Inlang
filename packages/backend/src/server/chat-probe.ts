/**
 * @az server chat-probe
 * Purpose: az backend probe — the production prompt and context sent to the configured model, one fixed question per component; each answer measured and parsed.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §11.3)
 * Exports: probeChat, probeReport, PROBE_QUESTIONS, PROBE_MS, ProbeResult, ProbeAnswer
 * Edit guide: the only path that calls a model outside a visitor's request; bounded per answer and in total; reports codes, times and counts — never the key, never the model's words.
 * Tests: packages/backend/test/chat-probe.test.ts
 */

/**
 * `node src/chat-probe.ts [--json]` (run by `az backend probe <server-dir>`).
 *
 * Before a site goes live the operator pins a model (owner's rule: probe
 * each candidate with the production prompt first). This reads the
 * server's own `.env` exactly as main.ts does, builds the system text the
 * chat route would send — prompt.txt, context.json, the page — and asks
 * one fixed question for prose and one for each component some chat on the
 * site shows. Each answer goes through the real answer parser, and is
 * reported: whether it streamed, the time to its first text and in total,
 * the provider's token counts, the events parsed, the components dropped
 * and why. It fails (exit 1) when an answer is empty, fails, or drops a
 * component — the model wrote one the filter refused.
 *
 * Every answer is bounded by the server's own timeouts; the whole run by
 * PROBE_MS, past which the questions left are reported as not asked.
 *
 * Copied into a generated server with a chat; imports only its siblings and node built-ins.
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import type { ChatAdapter } from './chat-adapters.ts';
import { ANSWER_WORDS, createAnswerParser, type AnswerWord, type DropReason } from './chat-answer.ts';
import { CHAT_TIMING, rulesFor, systemText, type ChatContext, type ChatTiming } from './chat.ts';

/** The whole probe's bound; questions left after it are reported, not asked. */
export const PROBE_MS = 10 * 60 * 1000;

/** One fixed question per thing an answer can be; prose is always asked. */
export const PROBE_QUESTIONS: Readonly<Record<'prose' | AnswerWord, string>> = {
  prose: 'In two sentences, what is this site about?',
  pricing: 'Which plan should I choose? Show me the pricing.',
  faq: 'What do people usually ask? Answer as a few questions and answers.',
  cta: 'How do I get started? Give me a button to the right page.',
  feature: 'What are the main features? List a few.',
};

export interface ProbeAnswer {
  readonly question: 'prose' | AnswerWord;
  readonly page: string;
  /** `ok`, or why not: `empty`, `unavailable <kind>` (the adapter's class and status only), `timeout`, `not_asked`. */
  readonly outcome: string;
  /** More than one piece of text arrived. */
  readonly streamed: boolean;
  readonly firstMs: number | null;
  readonly totalMs: number;
  /** The provider's own counts, or null when it reported none. */
  readonly tokens: { readonly input: number; readonly output: number } | null;
  readonly events: { readonly text: number; readonly blocks: Readonly<Record<string, number>> };
  readonly dropped: readonly DropReason[];
}

export interface ProbeResult { readonly ok: boolean; readonly answers: readonly ProbeAnswer[] }

/** The block kind an event carries: quote, faq, cta, feature. */
const kindOf = (block: object) => Object.keys(block)[0];

/**
 * Ask every question once, in order. `now` and `timing` are the clock and
 * the first-token and between-chunk bounds (the route's own by default).
 */
export async function probeChat(o: {
  readonly adapter: ChatAdapter; readonly prompt: string; readonly context: ChatContext;
  readonly maxOutputTokens: number; readonly timeoutMs: number;
  readonly now?: () => number; readonly timing?: ChatTiming; readonly budgetMs?: number;
}): Promise<ProbeResult> {
  const now = o.now ?? Date.now;
  const timing = o.timing ?? CHAT_TIMING;
  const pages = Object.keys(o.context.chats).sort();
  if (pages.length === 0) return { ok: false, answers: [] };
  // Prose on the first chat page; each component on the first page that shows it.
  const asked: { question: 'prose' | AnswerWord; page: string }[] = [{ question: 'prose', page: pages[0] }];
  for (const word of ANSWER_WORDS) {
    const page = pages.find((p) => o.context.chats[p].show.includes(word));
    if (page) asked.push({ question: word, page });
  }
  const until = now() + (o.budgetMs ?? PROBE_MS);
  const answers: ProbeAnswer[] = [];
  for (const { question, page } of asked) {
    if (now() >= until) {
      answers.push({ question, page, outcome: 'not_asked', streamed: false, firstMs: null, totalMs: 0, tokens: null, events: { text: 0, blocks: {} }, dropped: [] });
      continue;
    }
    answers.push(await askOne(o, question, page, now, timing));
  }
  const ok = answers.every((a) => a.outcome === 'ok' && a.dropped.length === 0);
  return { ok, answers };
}

async function askOne(
  o: Parameters<typeof probeChat>[0], question: 'prose' | AnswerWord, page: string, now: () => number, timing: ChatTiming,
): Promise<ProbeAnswer> {
  const started = now();
  const ac = new AbortController();
  let timedOut = false;
  const stop = () => { timedOut = true; ac.abort(); };
  let idle = setTimeout(stop, timing.firstMs);
  const whole = setTimeout(stop, o.timeoutMs);
  const parser = createAnswerParser(rulesFor(o.context, page));
  let pieces = 0;
  let firstMs: number | null = null;
  let tokens: { input: number; output: number } | null = null;
  let text = 0;
  const blocks: Record<string, number> = {};
  let outcome = 'ok';
  const take = (events: ReturnType<typeof parser.push>) => {
    for (const e of events) {
      if (e.type === 'text') text++;
      else blocks[kindOf(e.block)] = (blocks[kindOf(e.block)] ?? 0) + 1;
    }
  };
  try {
    for await (const chunk of o.adapter.stream({
      system: systemText(o.prompt, o.context, page), turns: [{ role: 'user', text: PROBE_QUESTIONS[question] }],
      maxOutputTokens: o.maxOutputTokens, signal: ac.signal,
    })) {
      clearTimeout(idle);
      idle = setTimeout(stop, timing.betweenMs);
      if (chunk.usage) tokens = chunk.usage;
      if (!chunk.text) continue;
      pieces++;
      firstMs ??= now() - started;
      take(parser.push(chunk.text));
      if (parser.ended) { ac.abort(); break; }
    }
    take(parser.end());
    if (parser.record.trim() === '') outcome = 'empty';
  } catch (e) {
    const err = e as { name?: unknown; message?: unknown };
    // An adapter's message is fixed text: a kind and at most an HTTP status, never the provider's body or the key.
    outcome = timedOut ? 'timeout' : `unavailable ${err?.name === 'AdapterError' ? String(err.message) : typeof err?.name === 'string' ? err.name : 'Error'}`;
  } finally {
    clearTimeout(idle);
    clearTimeout(whole);
  }
  return { question, page, outcome, streamed: pieces > 1, firstMs, totalMs: now() - started, tokens, events: { text, blocks }, dropped: [...parser.dropped] };
}

/** The report a person reads: one line per question, then the verdict. */
export function probeReport(r: ProbeResult): string {
  const lines = r.answers.map((a) => {
    const blocks = Object.entries(a.events.blocks).map(([k, n]) => `${k}×${n}`).join(' ') || 'none';
    return [
      `${a.outcome === 'ok' && a.dropped.length === 0 ? 'PASS' : 'FAIL'} ${a.question.padEnd(8)} ${a.page}`,
      `outcome ${a.outcome}`,
      `streamed ${a.streamed ? 'yes' : 'no'}`,
      `first ${a.firstMs === null ? '—' : `${a.firstMs}ms`}`,
      `total ${a.totalMs}ms`,
      `tokens ${a.tokens ? `${a.tokens.input}/${a.tokens.output}` : 'not reported'}`,
      `text events ${a.events.text}`,
      `components ${blocks}`,
      `dropped ${a.dropped.length === 0 ? 'none' : a.dropped.join(', ')}`,
    ].join(' · ');
  });
  lines.push(r.ok
    ? 'probe: every answer arrived and parsed with nothing dropped'
    : 'probe: FAILED — an answer was empty, failed, or held a component the filter dropped (see above); try another model or a larger AZ_CHAT_MAX_OUTPUT_TOKENS');
  return `${lines.join('\n')}\n`;
}

/** Run from the server folder: its .env and its chat files, as main.ts reads them. */
async function main(argv: readonly string[]): Promise<number> {
  if (argv.some((a) => a !== '--json')) {
    process.stderr.write('backend: try: node src/chat-probe.ts [--json]\n');
    return 2;
  }
  const { loadConfig } = await import('./env.ts');
  const { createAdapter } = await import('./chat-adapters.ts');
  const { parseChatContext } = await import('./chat.ts');
  const site = JSON.parse(readFileSync(new URL('../az.config.json', import.meta.url), 'utf8')) as { siteName: string; database: 'sqlite' | 'postgres' | 'mysql'; email: 'smtp' | 'api'; images?: boolean; chat?: boolean };
  if (site.chat !== true) {
    process.stderr.write('backend: this site shows no chat — there is no model to probe\n');
    return 1;
  }
  if (existsSync('.env')) process.loadEnvFile('.env');
  const loaded = loadConfig(process.env, { database: site.database, email: site.email, ...(site.images ? { images: true } : {}), chat: true }, site.siteName);
  if (!loaded.ok) {
    process.stderr.write(`backend: cannot probe — fix these in .env (see .env.example):\n${loaded.problems.map((p) => `  - ${p}`).join('\n')}\n`);
    return 1;
  }
  const chat = loaded.config.chat!;
  const read = (name: string) => readFileSync(new URL(`../chat/${name}`, import.meta.url), 'utf8');
  const context = parseChatContext(read('context.json'));
  if (typeof context === 'string') {
    process.stderr.write(`backend: cannot probe — chat/context.json ${context}; rebuild the site to regenerate server/\n`);
    return 1;
  }
  let adapter: ChatAdapter;
  try {
    adapter = await createAdapter(chat);
  } catch (e) {
    process.stderr.write(`backend: cannot probe — ${(e as Error).message}\n`);
    return 1;
  }
  // Where it asks, never with what key.
  process.stderr.write(`probe: ${chat.api} model ${JSON.stringify(chat.model)}${chat.api === 'completions' ? ` at ${new URL(chat.url).origin}` : ''}\n`);
  const result = await probeChat({ adapter, prompt: read('prompt.txt'), context, maxOutputTokens: chat.maxOutputTokens, timeoutMs: chat.timeoutMs });
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(result, null, 2)}\n` : probeReport(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
