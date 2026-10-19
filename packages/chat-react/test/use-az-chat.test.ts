/**
 * useAzChat (chat-block-spec §22.5) in React, with no browser: rendered on
 * the server it reads the session's snapshot — an empty conversation, then,
 * for a session that already answered, every turn. Its streaming states are
 * the session's (packages/chat-runtime/test/session.test.ts).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { useAzChat } from '../src/use-az-chat.ts';
import type { SessionAsker } from '#chat-runtime/session.ts';
import type { RuntimeEvent } from '#chat-runtime/runtime.ts';

const asker: SessionAsker = {
  async *ask(): AsyncGenerator<RuntimeEvent> { yield { type: 'text', s: 'Hi.\n' }; },
  load: async () => null,
};

function Window(props: { readonly runtime: SessionAsker }) {
  const chat = useAzChat(props.runtime, 'conversation-0001');
  return createElement('p', null, `${chat.turns.length} turns, ${chat.busy ? 'busy' : 'idle'}, ${typeof chat.ask}`);
}

test('the hook renders the session\'s snapshot, with its actions', () => {
  assert.equal(renderToString(createElement(Window, { runtime: asker })), '<p>0 turns, idle, function</p>');
});
