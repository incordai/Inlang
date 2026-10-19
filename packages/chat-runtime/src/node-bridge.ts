/**
 * @az module node-bridge
 * Purpose: a model bridge for a Node host — the built-in server's own completions adapter, behind the streaming contract, its key read where the host keeps it.
 * Spec: docs/chat-block-spec.md §6.2, §22.4
 * Exports: nodeModelBridge, NodeBridgeOptions
 * Edit guide: Node only (a server, a CLI, a sidecar) — never imported by a page, so a key is never in browser code; the URL is the host's, never the model's.
 * Tests: packages/chat-runtime/test/node-bridge.test.ts
 */

/**
 * `createChatRuntime({ model: nodeModelBridge({...}), … })` answers with any
 * provider that speaks the completions shape — the shape the built-in
 * server's AZ_CHAT_API=completions speaks (backend chat-adapters.ts), read
 * by that same adapter: its stream framing, size caps and usage counts, and
 * its errors, which carry a kind and at most a status, never a provider's
 * body. The key comes from the host — an environment variable, a keychain —
 * and is sent only in the request's header.
 */

import { createCompletionsAdapter, type ModelChoice } from '#backend/chat-adapters.ts';
import type { ModelBridge } from '#chat-answer/model-stream.ts';

export interface NodeBridgeOptions {
  /** The provider's base URL, https (or http on this machine); the completions path is added to it. */
  readonly url: string;
  /** The provider's key; empty for one that needs none. */
  readonly key: string;
  readonly model: string;
  readonly fetch?: typeof fetch;
}

const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost)(?::\d{1,5})?(?:\/|$)/;

export function nodeModelBridge(o: NodeBridgeOptions): ModelBridge {
  const url = o.url.replace(/\/+$/, '');
  if (!url.startsWith('https://') && !LOOPBACK.test(url)) throw new TypeError('nodeModelBridge: the url is https, or http on this machine only');
  if (o.model.trim() === '') throw new TypeError('nodeModelBridge: a model is named');
  const choice: ModelChoice = { url, key: o.key, model: o.model };
  return o.fetch ? createCompletionsAdapter(choice, o.fetch) : createCompletionsAdapter(choice);
}
