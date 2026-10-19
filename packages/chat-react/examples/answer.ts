// Run: node scripts/chat-lib-e2e.mjs --serve, then open http://127.0.0.1:4800/example/chat-react/answer
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { AzAnswer } from '@az/chat-react/az-answer.ts';
import { createAnswerChecker } from '@az/chat-answer/checker.ts';
import type { AnswerWireEvent } from '@az/chat-render/chat-answer-mount.ts';

// In an app the events come from the chat runtime or the chat API; here a model's text is checked in the page.
async function* model(): AsyncGenerator<string> {
  yield 'Here are **this week\'s** orders.\n\nchart bar "Orders by status"\n  points "paid" 12 "open" 3\n\n';
  yield 'cta "Talk to us" /contact\n\nask "How do refunds work?"\n';
}

const components = ['chart', 'cta'] as const;
const destinations = ['/contact'];
const events: AnswerWireEvent[] = [];
const root = createRoot(document.getElementById('app')!);
const render = () => root.render(createElement(AzAnswer, {
  events: [...events], theme: 'midnight', components, destinations,
  onAsk: (q: string) => { document.title = `Asked: ${q}`; },
}));

for await (const e of createAnswerChecker({ components: [...components], destinations }).read(model())) {
  events.push(e.type === 'done' ? { type: 'done' } : e);
  render();
}
document.documentElement.dataset.azExample = 'drawn';
