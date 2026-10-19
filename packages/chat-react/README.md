# @az/chat-react — az's chat for React apps

React components over the chat renderer (`@az/chat-render`): what an app
uses to draw az chat answers — charts, tables, stats, cards, dashboards,
explores, maps, follow-ups — with the same code and the same safety an az
site's panel has ([chat-block-spec §22.3](../../docs/chat-block-spec.md)).

| Export | What |
|---|---|
| `<AzAnswer events theme components destinations … />` (`@az/chat-react/az-answer.ts`) | one answer, drawn as its events arrive |
| `loadTheme(name)`, `THEME_NAMES` | a theme module by name, each its own chunk |
| `<AzChat runtime conversation theme components … />` (`@az/chat-react/az-chat.ts`) | a whole chat window — the site panel's own — over a chat session |
| `useAzChat(runtime, conversation)` (`@az/chat-react/use-az-chat.ts`) | a chat window's state: `{ turns, busy, answeredLocally, hostedOffered, left, ask, stop, askHosted }` — each site turn's `events` for `<AzAnswer>` |

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

## `<AzChat>`

The whole window an az site's chat panel is — its form, transcript,
suggested questions, Stop, Try again and status region, with the panel's
keyboard (Enter sends, Shift+Enter a new line, Escape stops), its status
lines for screen readers and its stillness under reduced motion — run by
the same code (`@az/chat-render` `chat-panel.ts`) over a chat session
(`@az/chat-runtime` `session.ts`). The app gives it its strings and its
box; it fills the box, and the transcript scrolls in what the rest leaves.

[`examples/chat.ts`](examples/chat.ts) — run `node scripts/chat-lib-e2e.mjs --serve`
and open `http://127.0.0.1:4800/example/chat-react/chat`:

```ts
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
```

| Prop | Meaning |
|---|---|
| `runtime`, `conversation` | what answers (`createChatRuntime`'s — in a page, over a transport), and the conversation's id: a kept one is drawn again on mount |
| `theme`, `components`, `destinations`, `images`, `scheme`, `backend`, `tiles` | as for `<AzAnswer>` |
| `title`, `greeting` | the window's heading and its first message, as text; the theme's own by default |
| `suggestions` | suggested questions, each a button that asks it; none by default |
| `limit` | the questions a conversation may hold (1–50, 20 by default) |
| `className` | the element the window fills: the app's stylesheet gives it its size (a height, for the transcript to scroll in) |

Every string is written as text; nothing is inline, so a policy of
`script-src 'self'; style-src 'self'` holds. Two windows on a page never
share an id. Unmounting stops the answer coming and leaves nothing in the
page. Not in the window: a kept conversation's Clear history and New chat
(the app's, through its runtime's history), and the operator's server
offered after the user's own fails (`useAzChat`'s `hostedOffered` and
`askHosted()` for a window of the app's own).

## `useAzChat`

The headless half of a chat window: `@az/chat-runtime`'s session
(`session.ts`) read through `useSyncExternalStore`. The kept conversation
loads on mount, and an answer still coming stops on unmount. `runtime` is
`createChatRuntime`'s; in a page, one over a transport — the sidecar or
the operator's server — since a key is never in browser code:

```js
const chat = useAzChat(runtime, conversationId);
chat.turns.map((t) => (t.role === 'site' ? createElement(AzAnswer, { events: t.events, theme, components }) : t.text));
```

`ask(question)` is refused while an answer is coming; `askHosted()` asks
the last question of the operator's server only after the runtime offered
it (`hostedOffered`). `<AzChat>` is this, with the window drawn
(chat-block-spec §22.5).

## Tests

`pnpm test:chat-lib`: in Chromium, Firefox and WebKit, an answer streamed
in three renders (the placeholder while a chart is read, then whole), an
injection that stays text, the theme applied, the map's module asked for
only when a map arrives, nothing left after unmount — under a policy of
`script-src 'self'; style-src 'self'`; and `<AzChat>` in a box the page's
stylesheet sizes: the app's title, greeting and suggestions, a suggested
question answered, Stop, Try again after a refused question, the status
lines, the window filling its box, no inline style. `packages/chat-react/test/`
checks the theme names, the session's events as the window is told them
(`az-chat.test.ts`), and that this README's examples are the example files.
