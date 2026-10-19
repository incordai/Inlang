// Run: node packages/chat-answer/examples/check-an-answer.ts
import { createAnswerChecker } from '@az/chat-answer/checker.ts';
import type { FiguresRun } from '@az/chat-answer/chat-rich.ts';

// What the model streamed — prose, a chart from the app's own data, and a link it is not allowed.
async function* model(): AsyncGenerator<string> {
  yield 'Orders this week:\n\nchart bar "Orders by status" from or';
  yield 'ders count by status\n\ncta "Click me" https://elsewhere.example\n';
}

// The app's data source answers `from …` requests; the model never sees what it returns.
const figures: FiguresRun = async (kind, words) =>
  kind === 'figures' && words.join(' ') === 'orders count by status'
    ? { kind: 'figures', unit: null, value: null, groups: [['paid', 12], ['open', 3]], more: false, dated: false }
    : null;

const checker = createAnswerChecker({
  components: ['chart', 'cta'],
  destinations: ['/contact'],
  data: { figures },
  day: '2026-10-19',
});

for await (const event of checker.read(model())) {
  if (event.type === 'done') console.log('done', JSON.stringify({ dropped: event.dropped, history: event.history }));
  else console.log(event.type, JSON.stringify(event.type === 'text' ? event.s : event.type === 'hold' ? event.word : event.block));
}
