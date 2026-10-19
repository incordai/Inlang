# @az/chat-react — az's chat for React apps

React components over the chat renderer (`@az/chat-render`): what an app
uses to draw az chat answers — charts, tables, stats, cards, dashboards,
explores, maps, follow-ups — with the same code and the same safety an az
site's panel has ([chat-block-spec §22.3](../../docs/chat-block-spec.md)).

| Export | What |
|---|---|
| `<AzAnswer events theme components destinations … />` (`@az/chat-react/az-answer.ts`) | one answer, drawn as its events arrive |
| `loadTheme(name)`, `THEME_NAMES` | a theme module by name, each its own chunk |

Written with `createElement`, not JSX, so it runs as TypeScript with no
build step like the rest of the repository; an app's bundler takes it as it
is. React 19.2 is a peer dependency. Not published to a registry (the
package is `private`).

## Example

[`examples/answer.ts`](examples/answer.ts) — a browser module; run
`node scripts/chat-lib-e2e.mjs --serve` and open
`http://127.0.0.1:4800/example/chat-react/answer`:

```ts
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
```

## `<AzAnswer>`

| Prop | Meaning |
|---|---|
| `events` | the answer's events so far, in order; it grows as the answer streams — only new events are drawn; a shorter list, or a different first event, starts again |
| `theme` | a theme module, or `'midnight' \| 'paper' \| 'signal' \| 'clay' \| 'petal' \| 'volt'`; load its stylesheet (`@az/chat-render/themes/<name>.css`) in the app |
| `components`, `destinations` | what the answer may show, and the only links it may hold — the checker's own options |
| `images` | `{ key: { src, alt } }`: the app's images a card may name |
| `scheme` | `'light'` or `'dark'`; by default the theme's or the visitor's preference |
| `backend`, `tiles` | where row images and map tiles come from |
| `onAsk`, `onAnnounce`, `onCopy` | a follow-up's or an explore's question; the status line (sentences, one line a component); Copy's text — with it, the answer has its bar |
| `className` | for the app's layout |

Unmounting stops the answer's charts and maps and leaves nothing in the
page. A map's library loads only when an answer holds a map.

## Tests

`pnpm test:chat-lib`: in Chromium, Firefox and WebKit, an answer streamed
in three renders (the placeholder while a chart is read, then whole), an
injection that stays text, the theme applied, the map's module asked for
only when a map arrives, nothing left after unmount — under a policy of
`script-src 'self'; style-src 'self'`. `packages/chat-react/test/` checks
the theme names and that this README's example is the example file.
