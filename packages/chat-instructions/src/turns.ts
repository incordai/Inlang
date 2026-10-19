/**
 * @az module turns
 * Purpose: the turns a model is sent — the visitor's longest message, and the history cut to its last turns and characters.
 * Spec: docs/chat-block-spec.md §4.2, §6.5, §22.4
 * Exports: ModelTurn, VISITOR_MAX, HISTORY_TURNS, HISTORY_CHARS, trimHistory
 * Edit guide: the latest question is never dropped; the turns sent start with the visitor's. Imports nothing.
 * Tests: packages/backend/test/chat-text.test.ts, packages/chat-runtime/test/runtime.test.ts
 */

/** One turn as the model is sent it: the visitor's (`user`) or an answer's history text (`assistant`). */
export interface ModelTurn { readonly role: 'user' | 'assistant'; readonly text: string }

/** A visitor message, after trimming (chat-block-spec §6.5). */
export const VISITOR_MAX = 1_000;
/** The history sent on to the model: the last turns, at most this many characters (§4.2). */
export const HISTORY_TURNS = 8;
export const HISTORY_CHARS = 12_000;

/**
 * The turns the model is sent: the last HISTORY_TURNS, then oldest first
 * dropped until they fit HISTORY_CHARS — never the latest visitor message,
 * which is at most VISITOR_MAX and always fits. Starts with a user turn.
 */
export function trimHistory(turns: readonly ModelTurn[]): ModelTurn[] {
  let kept = turns.slice(-HISTORY_TURNS);
  const size = (t: readonly ModelTurn[]) => t.reduce((n, x) => n + x.text.length, 0);
  while (kept.length > 1 && size(kept) > HISTORY_CHARS) kept = kept.slice(1);
  while (kept.length > 1 && kept[0].role !== 'user') kept = kept.slice(1);
  return kept;
}
