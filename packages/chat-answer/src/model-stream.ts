/**
 * @az module model-stream
 * Purpose: the model's streaming contract — what a model is asked and streams back, and the timers its stream must keep: a first token in time, each next one too.
 * Spec: docs/chat-block-spec.md §6.5, §22.4
 * Exports: ModelBridge, ModelRequest, ModelChunk, ModelUsage, ModelTiming, MODEL_TIMING, timedChunks, TimedOptions, StoppedError, CHARS_PER_TOKEN, estimateTokens
 * Edit guide: a stream a timer or the caller stopped ends in StoppedError, never as a finished answer; no Node-only API.
 * Tests: packages/chat-answer/test/model-stream.test.ts, packages/backend/test/chat-main.test.ts
 */

/**
 * Every model the chat talks to — a server's provider adapter
 * (backend chat-adapters.ts ChatAdapter is this shape), an app's own bridge,
 * a test's scripted one — is a ModelBridge: the system text and the turns
 * in, text chunks out, the provider's token counts on any chunk that has
 * them. The built-in server and the app runtime read it through the same
 * timers (§6.5): the first chunk within `firstMs`, each next within
 * `betweenMs` of the one before; either passing aborts the model, and the
 * stream then ends in StoppedError, which the caller tells as a failed
 * answer. Imports nothing.
 */

/** The provider's counts; `cached` is the part of `input` read from its prompt cache, when it says (never more than `input`). */
export interface ModelUsage { readonly input: number; readonly output: number; readonly cached?: number }

export interface ModelChunk {
  readonly text?: string;
  readonly usage?: ModelUsage;
}

export interface ModelRequest {
  /** The instructions (chat-instructions buildInstructions). */
  readonly system: string;
  /** How many characters at the start of `system` are the same for every question; a provider that caches a prefix marks it there. */
  readonly fixed?: number;
  readonly turns: readonly { readonly role: 'user' | 'assistant'; readonly text: string }[];
  readonly maxOutputTokens: number;
  /** Aborted when the asker leaves, a timer passes, or a cap is reached. */
  readonly signal: AbortSignal;
}

export interface ModelBridge {
  /** Streams the answer's text. Throws on a failure; a stream that was aborted may end or throw. */
  stream(request: ModelRequest): AsyncIterable<ModelChunk>;
}

/** When the model must answer: its first token and each next one. */
export interface ModelTiming { readonly firstMs: number; readonly betweenMs: number }

/** The first token within 15 seconds, each next within 20 (§6.5). */
export const MODEL_TIMING: ModelTiming = { firstMs: 15_000, betweenMs: 20_000 };

/** Characters per token when a provider reports no usage — a conservative estimate (§6.5, INFERENCE). */
export const CHARS_PER_TOKEN = 3;

/** A whole-number token estimate for `chars` characters. */
export const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

/** The model's stream ended because a timer or the caller stopped it: a failed answer, never a finished one. */
export class StoppedError extends Error {
  constructor() {
    super('stopped');
    this.name = 'StoppedError';
  }
}

export interface TimedOptions {
  readonly timing: ModelTiming;
  /** Aborted by a timer that passes; the caller aborts it too, to stop the model (a cap, the asker leaving). */
  readonly controller: AbortController;
  /** Each count the provider reports, the last one standing. */
  readonly onUsage?: (usage: ModelUsage) => void;
}

/**
 * The model's text under the timers: `open` is called once with the
 * controller's signal and its chunks read, each restarting the idle timer.
 * A stream that ends with the signal aborted throws StoppedError.
 */
export async function* timedChunks(open: (signal: AbortSignal) => AsyncIterable<ModelChunk>, o: TimedOptions): AsyncGenerator<string, void, undefined> {
  const stop = () => o.controller.abort();
  let idle = setTimeout(stop, o.timing.firstMs);
  try {
    for await (const chunk of open(o.controller.signal)) {
      clearTimeout(idle);
      idle = setTimeout(stop, o.timing.betweenMs);
      if (chunk.usage) o.onUsage?.(chunk.usage);
      if (chunk.text) yield chunk.text;
    }
    if (o.controller.signal.aborted) throw new StoppedError();
  } finally {
    clearTimeout(idle);
  }
}
