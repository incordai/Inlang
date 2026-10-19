// Run: node scripts/chat-lib-e2e.mjs --serve, then open http://127.0.0.1:4800/example/chat-render/answer
import { mountAnswer } from '@az/chat-render/chat-answer-mount.ts';
import * as midnight from '@az/chat-render/themes/midnight.ts';

// The checker's events for one answer, as the chat runtime or the chat API hands them over.
const events = [
  { type: 'text', s: 'Here are **this week\'s** orders.\n\n' },
  { type: 'hold', word: 'chart' },
  { type: 'block', block: { chart: { kind: 'bar', title: 'Orders by status', unit: null, src: 'model', series: [{ name: 'Orders by status', points: [['paid', 12], ['open', 3]] }] } } },
  { type: 'block', block: { cta: { label: 'Talk to us', to: '/contact' } } },
  { type: 'block', block: { ask: 'How do refunds work?' } },
  { type: 'done' },
] as const;

// The page loads the theme's stylesheet itself (themes/midnight.css): no inline style, so a strict policy holds.
const answer = mountAnswer(document.getElementById('app')!, {
  theme: midnight,
  components: ['chart', 'cta'],
  destinations: ['/contact'],
  onAsk: (q) => { document.title = `Asked: ${q}`; },
  onAnnounce: (said) => { document.getElementById('status')!.textContent = said; },
});
for (const e of events) answer.push(e);
document.documentElement.dataset.azExample = 'drawn';
