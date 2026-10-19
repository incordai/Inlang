/**
 * @az module budget
 * Purpose: an app's local spending limits — tokens a UTC day, messages a conversation, output tokens an answer — counted on the device.
 * Spec: docs/chat-block-spec.md §6.5, §22.4
 * Exports: BudgetOptions, Budget, BudgetStore, memoryBudgetStore, webStorageBudgetStore, createBudget, BUDGET_DEFAULTS, utcDay
 * Edit guide: the ceiling is checked before a question is sent, at its largest cost; what it spent is counted whatever happened.
 * Tests: packages/chat-runtime/test/runtime.test.ts
 */

/**
 * The built-in server's budget is a database row per UTC day (§6.5); an app's
 * is the same rule on the device: before a question is sent, its largest
 * cost — the input's estimate plus the answer's output cap — must fit what
 * is left of the day, or it is refused (`budget_exhausted`); afterwards the
 * provider's own counts, or the estimate when it gave none, are added. A
 * conversation holds at most `messagesPerConversation` questions
 * (`conversation_full`). Imports nothing.
 */

export interface BudgetOptions {
  /** Tokens one UTC day may spend, input and output together. */
  readonly tokensPerDay?: number;
  /** Questions one conversation may hold. */
  readonly messagesPerConversation?: number;
  /** The most output tokens one answer may take: the model is asked for no more, and the ceiling counts this much. */
  readonly maxOutputTokens?: number;
}

/** The built-in server's defaults — AZ_CHAT_DAILY_TOKENS, AZ_CHAT_MAX_OUTPUT_TOKENS and a chat's `limit` — held equal to them by a test. */
export const BUDGET_DEFAULTS = { tokensPerDay: 300_000, messagesPerConversation: 20, maxOutputTokens: 600 } as const;

/** Where the day's count is kept. */
export interface BudgetStore {
  spent(day: string): Promise<number>;
  add(day: string, tokens: number): Promise<void>;
}

/** `YYYY-MM-DD` in UTC. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function memoryBudgetStore(): BudgetStore {
  const days = new Map<string, number>();
  return {
    async spent(day) { return days.get(day) ?? 0; },
    async add(day, tokens) { days.set(day, (days.get(day) ?? 0) + tokens); },
  };
}

/** The day's count in Web Storage; only the current day is kept. A storage that refuses counts in memory. */
export function webStorageBudgetStore(storage: { getItem(k: string): string | null; setItem(k: string, v: string): void }, key = 'az-chat-runtime:budget'): BudgetStore {
  const fallback = memoryBudgetStore();
  const read = (): { day: string; tokens: number } | null => {
    try {
      const v = JSON.parse(storage.getItem(key) ?? 'null') as { day?: unknown; tokens?: unknown } | null;
      return v && typeof v.day === 'string' && typeof v.tokens === 'number' && Number.isFinite(v.tokens) && v.tokens >= 0 ? { day: v.day, tokens: v.tokens } : null;
    } catch {
      return null;
    }
  };
  return {
    async spent(day) {
      const v = read();
      return v?.day === day ? v.tokens : fallback.spent(day);
    },
    async add(day, tokens) {
      const v = read();
      const next = { day, tokens: (v?.day === day ? v.tokens : 0) + tokens };
      try { storage.setItem(key, JSON.stringify(next)); } catch { await fallback.add(day, tokens); }
    },
  };
}

export interface Budget {
  readonly maxOutputTokens: number;
  readonly messagesPerConversation: number;
  /** Whether a question whose input is about `inputTokens` may be sent today. */
  allows(inputTokens: number, now: number): Promise<boolean>;
  /** What an answer spent. */
  spend(tokens: number, now: number): Promise<void>;
}

export function createBudget(o: BudgetOptions = {}, store: BudgetStore = memoryBudgetStore()): Budget {
  const tokensPerDay = o.tokensPerDay ?? BUDGET_DEFAULTS.tokensPerDay;
  const maxOutputTokens = o.maxOutputTokens ?? BUDGET_DEFAULTS.maxOutputTokens;
  for (const [name, v] of [['tokensPerDay', tokensPerDay], ['maxOutputTokens', maxOutputTokens], ['messagesPerConversation', o.messagesPerConversation ?? 1]] as const) {
    if (!Number.isSafeInteger(v) || v < 1) throw new TypeError(`createBudget: ${name} must be a whole number of at least 1`);
  }
  return {
    maxOutputTokens,
    messagesPerConversation: o.messagesPerConversation ?? BUDGET_DEFAULTS.messagesPerConversation,
    async allows(inputTokens, now) {
      return (await store.spent(utcDay(now))) + inputTokens + maxOutputTokens <= tokensPerDay;
    },
    async spend(tokens, now) {
      if (tokens > 0) await store.add(utcDay(now), tokens);
    },
  };
}
