/**
 * @az module runtime
 * Purpose: the chat for an app — one call per question, answered by its own model (checked, budgeted, kept) or by a chat server, switching to the user's own when the operator's limit is reached.
 * Spec: docs/chat-block-spec.md §4, §6.5, §19.16, §22.4
 * Exports: createChatRuntime, ChatRuntime, ChatRuntimeOptions, RuntimeEvent, AskOptions, AppTool, Moderate, RUNTIME_ERRORS
 * Edit guide: nothing reaches a page but the checker's events (direct) or a server's, read by the page's own reader (transport);
 *   the model is stopped the moment an answer ends; a switch to the operator's server is never made without the app asking for it.
 * Tests: packages/chat-runtime/test/runtime.test.ts
 */

/**
 * `chat.ask(conversation, question)` streams one answer's events — `text`,
 * `hold`, `block`, then `done`, or `error` — which `<AzAnswer>` or the
 * renderer core draws (chat-block-spec §22.4).
 *
 * **Direct** (`model`): this runtime runs the chat itself, as the built-in
 * server's route does — the conversation's length, the moderation hook,
 * the day's budget at the answer's largest cost, the instructions
 * (buildInstructions), the model through the streaming contract
 * (first-token and idle timeouts, stopped at a cap or on `signal`), the
 * answer checker, then the history kept and the tokens counted. It runs
 * where the provider's key is — a sidecar, a server, a Node host — never in
 * a page: a key is never in browser code. `tools` are the app's own
 * functions behind `from tool …`, their rows checked and aggregated by the
 * server's own code (tool-rows.ts).
 *
 * **Transport** (`transport`): a chat server answers — the user's own
 * sidecar (`local`) or the operator's (`hosted`) — over the same chat API.
 * When the operator's server answers `limit_reached` and a local one is
 * set, the question is asked there instead and a `note` says the answer
 * came from the user's own provider. When the local one fails and a hosted
 * one is set, an `offer` says so; the runtime never spends the user's
 * hosted calls by itself — the app asks again with `mode: 'hosted'`.
 *
 * Each server is sent only the exchanges it answered, with its own tags
 * and conversation id, so every tag it checks is one it made; the whole
 * conversation — every answer's stand-ins and notes — stays in the app's
 * history and on screen.
 */

import { createAnswerChecker, type CheckerData, type CheckerOptions } from '#chat-answer/checker.ts';
import { estimateTokens, MODEL_TIMING, timedChunks, type ModelBridge, type ModelTiming, type ModelUsage } from '#chat-answer/model-stream.ts';
import { aggregateTool, toolMinute, toolRows } from '#chat-answer/tool-rows.ts';
import type { ToolsRun } from '#chat-answer/chat-rich.ts';
import type { ChatToolShape } from '#chat-answer/tool-shape.ts';
import type { HistoryTags } from '#chat-answer/history-tag.ts';
import { instructionParts, type InstructionsInput } from '#chat-instructions/instructions.ts';
import { trimHistory, VISITOR_MAX } from '#chat-instructions/turns.ts';
import { createBudget, type BudgetOptions, type BudgetStore } from './budget.ts';
import { memoryHistory, type ConversationTurn, type HistoryStore, type StoredAnswer, type StoredConversation } from './history.ts';
import type { ChatTransport, TransportEvent, TransportSource } from './transport.ts';

/** One event of an answer, as a page draws it — and, for an app's own window, what happened around it. */
export type RuntimeEvent =
  | { readonly type: 'text'; readonly s: string }
  | { readonly type: 'hold'; readonly word: string }
  | { readonly type: 'block'; readonly block: Record<string, unknown> }
  | {
    readonly type: 'done';
    /** The answer as the model is sent it back next time (stand-ins and notes). */
    readonly text: string;
    /** Questions this conversation may still hold. */
    readonly left: number;
    readonly source: StoredAnswer['source'];
    readonly by: 'suggested' | 'match' | null;
  }
  | { readonly type: 'error'; readonly code: string }
  /** The operator's limit was reached: this answer is from the user's own provider. */
  | { readonly type: 'note'; readonly code: 'answered_locally' }
  /** The user's own provider failed and the operator's has calls left: ask again with `mode: 'hosted'` to use them. */
  | { readonly type: 'offer'; readonly mode: 'hosted' };

/** The codes a direct answer is refused or ends with — the built-in server's own (chat-block-spec §4.2). */
export const RUNTIME_ERRORS = ['conversation_full', 'too_long', 'bad_request', 'blocked', 'unavailable', 'budget_exhausted', 'tampered', 'stopped'] as const;

/** One of the app's own functions behind `from tool <name> …`: its shape as the model is told it, and what answers it. */
export interface AppTool {
  readonly shape: ChatToolShape;
  /** The checked parameter values in; rows of exactly the declared fields out — checked again, as a server checks an endpoint's. */
  run(args: Readonly<Record<string, string | number | boolean>>, signal: AbortSignal): Promise<unknown>;
}

/** The moderation hook (chat-block-spec §6.8): the visitor's words in, allow or block; a failure is a refusal too. */
export type Moderate = (text: string, signal: AbortSignal) => Promise<'allow' | 'block'>;

export interface ChatRuntimeOptions {
  /** The chat's page, as a server's context names it; `/` by default. */
  readonly page?: string;
  /** Direct: the model, behind the streaming contract. */
  readonly model?: ModelBridge;
  /** Direct: what the model is told, but what each question changes. */
  readonly instructions?: Omit<InstructionsInput, 'page' | 'asked' | 'tools'>;
  /** Direct: what answers may show, quote and link to; its data and tools come from `data` and `tools`. */
  readonly checker?: Omit<CheckerOptions, 'data' | 'day' | 'tools'>;
  readonly data?: Omit<CheckerData, 'tools'>;
  readonly tools?: readonly AppTool[];
  readonly budget?: BudgetOptions & { readonly store?: BudgetStore };
  readonly moderate?: Moderate;
  readonly timing?: ModelTiming;
  /** Transport: the chat servers, and which answers first. */
  readonly transport?: { readonly local?: ChatTransport; readonly hosted?: ChatTransport; readonly prefer?: TransportSource };
  /** Where conversations are kept; in memory by default. */
  readonly history?: HistoryStore;
  /** Tags the runtime's own answers, so a kept conversation that was edited is refused; optional on a device the user owns. */
  readonly tags?: HistoryTags;
  readonly now?: () => number;
}

export interface AskOptions {
  readonly signal?: AbortSignal;
  readonly via?: 'suggested' | 'model' | null;
  /** Transport: which server to ask this time (the app offers hosted after a local failure); `prefer` by default. */
  readonly mode?: TransportSource;
}

export interface ChatRuntime {
  ask(conversation: string, question: string, options?: AskOptions): AsyncIterable<RuntimeEvent>;
  load(conversation: string): Promise<StoredConversation | null>;
  list(): ReturnType<HistoryStore['list']>;
  forget(conversation: string): Promise<void>;
}

const CONVERSATION = /^[A-Za-z0-9_-]{8,64}$/;
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

/** Each exchange in order: a question, and its answer when it has one. */
function exchanges(turns: readonly ConversationTurn[]): { readonly q: string; readonly a: StoredAnswer | null }[] {
  const out: { q: string; a: StoredAnswer | null }[] = [];
  for (const t of turns) {
    if (t.role === 'visitor') out.push({ q: t.text, a: null });
    else if (out.length > 0 && out[out.length - 1].a === null) out[out.length - 1].a = t;
  }
  return out;
}

/** The app's tools as the checker calls them: each request's rows from the app's function, checked and aggregated as a server's are. */
function toolsRun(tools: readonly AppTool[], signal: AbortSignal, now: () => number): ToolsRun {
  return async (req, cap) => {
    const tool = tools.find((t) => t.shape.name === req.tool);
    if (!tool) return 'unavailable';
    let value: unknown;
    try { value = await tool.run(req.args, signal); } catch { return 'unavailable'; }
    const rows = toolRows(tool.shape.fields, value);
    const result = rows && aggregateTool(rows, req.shape, tool.shape.fields, cap);
    return result ? { result, source: tool.shape.label, at: toolMinute(now()) } : 'unavailable';
  };
}

export function createChatRuntime(o: ChatRuntimeOptions): ChatRuntime {
  const direct = o.model !== undefined;
  const servers = o.transport;
  if (direct === (servers !== undefined)) throw new TypeError('createChatRuntime: give a model (direct) or a transport, one of them');
  if (servers && !servers.local && !servers.hosted) throw new TypeError('createChatRuntime: a transport needs a local or a hosted server');
  if (direct && (!o.instructions || !o.checker)) throw new TypeError('createChatRuntime: a direct runtime needs its instructions and its checker options');
  const page = o.page ?? '/';
  const now = o.now ?? Date.now;
  const store = o.history ?? memoryHistory();
  const budget = createBudget(o.budget, o.budget?.store);
  const timing = o.timing ?? MODEL_TIMING;
  const tools = o.tools ?? [];

  /** A kept conversation, or a new one; null when its runtime tags no longer hold (it was edited). */
  async function open(id: string): Promise<StoredConversation | null> {
    const kept = await store.load(id);
    if (!kept) return { id, server: {}, turns: [], at: now() };
    if (o.tags) {
      for (const [i, t] of kept.turns.entries()) {
        if (t.role === 'site' && t.source === 'direct' && !(await o.tags.check(id, i, t.text, t.tag))) return null;
      }
    }
    return kept;
  }

  /** The answer's own events, drawn from as they come; `done` saves it. */
  async function* directAnswer(conv: StoredConversation, question: string, signal: AbortSignal): AsyncGenerator<RuntimeEvent> {
    const asked = conv.turns.filter((t) => t.role === 'visitor').length + 1;
    if (o.moderate) {
      let verdict: 'allow' | 'block' | 'failed';
      try { verdict = await o.moderate(question, signal); } catch { verdict = 'failed'; }
      if (verdict !== 'allow') { yield { type: 'error', code: verdict === 'block' ? 'blocked' : 'unavailable' }; return; }
    }
    const turns = trimHistory([...conv.turns.map((t) => ({ role: t.role === 'visitor' ? 'user' as const : 'assistant' as const, text: t.text })), { role: 'user', text: question }]);
    const visitors = [...conv.turns.filter((t) => t.role === 'visitor').map((t) => t.text), question].reverse().slice(0, 2);
    const { text: system, fixed } = instructionParts({ ...o.instructions!, page, asked: visitors, tools: tools.map((t) => t.shape) });
    const input = estimateTokens(system.length + turns.reduce((n, t) => n + t.text.length, 0));
    if (!(await budget.allows(input, now()))) { yield { type: 'error', code: 'budget_exhausted' }; return; }
    const ac = new AbortController();
    const stop = () => ac.abort();
    signal.addEventListener('abort', stop, { once: true });
    // Set by the model's stream, read once it ends: typed as both, so the read is not narrowed to the null it starts as.
    let usage = null as ModelUsage | null;
    const checker = createAnswerChecker({
      ...o.checker!, tools: tools.map((t) => t.shape), day: new Date(now()).toISOString().slice(0, 10),
      data: { ...o.data, ...(tools.length > 0 ? { tools: toolsRun(tools, ac.signal, now) } : {}) },
    });
    const read = checker.read(timedChunks((s) => o.model!.stream({ system, fixed, turns, maxOutputTokens: budget.maxOutputTokens, signal: s }), {
      timing, controller: ac, onUsage: (u) => { usage = u; },
    }), { onCapped: stop });
    try {
      for await (const e of read) {
        if (e.type !== 'done') { yield e; continue; }
        // An answer with nothing in it failed, as the server's does.
        if (e.record.trim() === '') { yield { type: 'error', code: 'unavailable' }; return; }
        const index = conv.turns.length + 1;
        const tag = o.tags ? await o.tags.tag(conv.id, index, e.history) : null;
        const answer: StoredAnswer = { role: 'site', text: e.history, tag, source: 'direct', events: e.events };
        await store.save({ ...conv, turns: [...conv.turns, { role: 'visitor', text: question }, answer], at: now() });
        yield { type: 'done', text: e.history, left: budget.messagesPerConversation - asked, source: 'direct', by: null };
      }
    } catch {
      yield { type: 'error', code: signal.aborted ? 'stopped' : 'unavailable' };
    } finally {
      signal.removeEventListener('abort', stop);
      await budget.spend(usage ? usage.input + usage.output : input + estimateTokens(read.record.length), now());
    }
  }

  /** One server's answer, mapped to the runtime's events; `done` saves it with that server's tag and conversation. */
  async function* serverAnswer(conv: StoredConversation, question: string, via: AskOptions['via'], t: ChatTransport, signal: AbortSignal):
    AsyncGenerator<RuntimeEvent | { readonly type: 'failed'; readonly code: string; readonly early: boolean }> {
    // The exchanges this server answered, with its tags: every tag it checks is one it made (chat-block-spec §4.2).
    const mine = exchanges(conv.turns).filter((x) => x.a?.source === t.source);
    const history = mine.flatMap((x) => [{ role: 'visitor' as const, text: x.q }, { role: 'site' as const, text: x.a!.text, ...(x.a!.tag ? { tag: x.a!.tag } : {}) }]);
    let early = true;
    const events: Record<string, unknown>[] = [];
    for await (const e of t.send({ page, conversation: conv.server[t.source] ?? null, history, question, via: via ?? null, signal })) {
      if (e.type === 'error') { yield { type: 'failed', code: e.code, early }; return; }
      early = false;
      if (e.type === 'done') {
        const answer: StoredAnswer = { role: 'site', text: e.text, tag: e.tag, source: t.source, events };
        await store.save({ ...conv, server: { ...conv.server, [t.source]: e.conversation }, turns: [...conv.turns, { role: 'visitor', text: question }, answer], at: now() });
        yield { type: 'done', text: e.text, left: e.left, source: t.source, by: e.by };
        return;
      }
      events.push(e.type === 'text' ? { type: 'text', s: e.s } : e.type === 'block' ? { type: 'block', block: e.block } : { type: 'hold', word: e.word });
      yield e as Exclude<TransportEvent, { type: 'done' } | { type: 'error' }>;
    }
  }

  return {
    async *ask(id, raw, a = {}) {
      const signal = a.signal ?? new AbortController().signal;
      const question = raw.trim();
      if (!CONVERSATION.test(id) || question === '' || CONTROL.test(question)) { yield { type: 'error', code: 'bad_request' }; return; }
      if (question.length > VISITOR_MAX) { yield { type: 'error', code: 'too_long' }; return; }
      const conv = await open(id);
      if (!conv) { yield { type: 'error', code: 'tampered' }; return; }
      if (conv.turns.filter((t) => t.role === 'visitor').length >= budget.messagesPerConversation) { yield { type: 'error', code: 'conversation_full' }; return; }
      if (direct) { yield* directAnswer(conv, question, signal); return; }
      const first = a.mode ?? servers!.prefer ?? (servers!.hosted ? 'hosted' : 'local');
      const primary = servers![first];
      if (!primary) { yield { type: 'error', code: 'unavailable' }; return; }
      for await (const e of serverAnswer(conv, question, a.via, primary, signal)) {
        if (e.type !== 'failed') { yield e; continue; }
        // The operator's limit: the user's own provider answers instead, and the page says so (#37).
        if (first === 'hosted' && e.code === 'limit_reached' && servers!.local) {
          yield { type: 'note', code: 'answered_locally' };
          for await (const f of serverAnswer(conv, question, a.via, servers!.local, signal)) yield f.type === 'failed' ? { type: 'error', code: f.code } : f;
          return;
        }
        // The user's own provider failed before it answered anything: the operator's may be offered, never used unasked.
        if (first === 'local' && e.early && servers!.hosted && e.code !== 'stopped') yield { type: 'offer', mode: 'hosted' };
        yield { type: 'error', code: e.code };
        return;
      }
    },
    load: (id) => store.load(id),
    list: () => store.list(),
    forget: (id) => store.remove(id),
  };
}
