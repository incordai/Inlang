// Run: node scripts/chat-lib-e2e.mjs --serve, then open http://127.0.0.1:4800/example/chat-react/chat
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AzChat } from '@az/chat-react/az-chat.ts';
import { createChatRuntime } from '@az/chat-runtime/runtime.ts';
import { httpTransport } from '@az/chat-runtime/transport.ts';

// In a page the runtime asks a chat server — the user's own sidecar, or the operator's — never a model with a key.
// Here the example's own server answers, at this page's origin.
const runtime = createChatRuntime({ transport: { local: httpTransport({ source: 'local', base: location.origin }) } });

// The window fills the element the app gives it; the app's own stylesheet sizes that element.
createRoot(document.getElementById('app')!).render(createElement(AzChat, {
  runtime, conversation: 'example-conversation', theme: 'midnight',
  components: ['faq', 'cta', 'chart', 'table'], destinations: ['/contact'],
  title: 'Ask Acme', greeting: 'Hi! Ask me about orders and shipping.',
  suggestions: ['How fast do you ship?'],
}));
document.documentElement.dataset.azExample = 'drawn';
