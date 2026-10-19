# @az/chat-answer — the answer checker

The part of az's chat that stands between a model and a page. A model's
streamed text goes in; only typed, checked events come out: prose, and the
components a chat allows — an FAQ, a feature list, a call to action, a
quote of the site's own blocks, charts, tables, stats, cards, dashboards,
explores and maps — each checked whole against the chat's rules before it
is sent. A component that breaks a rule is dropped and leaves no trace on
the page; the history the model is sent back names it by its word and a
reason code only.

It is the same code the server `az build` generates runs on every answer
(`server/src/chat-answer/`, copied from here), and it runs unchanged in a
browser or an app webview: it imports nothing but its own files and uses no
Node-only API. The rules, caps and threats it answers for are
[chat-block-spec §5.3, §6.1, §20 and §21](../../docs/chat-block-spec.md);
the library use is §22.

Not published to a registry (the package is `private`); a workspace package
depends on it with `"@az/chat-answer": "workspace:*"`.

## Example

[`examples/check-an-answer.ts`](examples/check-an-answer.ts), run with
`node packages/chat-answer/examples/check-an-answer.ts`:

```ts
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
```

It prints the prose, a `hold` for the chart while its figures are read, the
chart filled from the data source (`src: site`, the day it was read), and a
`done` whose history notes the call to action it dropped — its link was not
a listed destination:

```text
text "Orders this week:\n\n"
hold "chart"
block {"chart":{"kind":"bar","title":"Orders by status","unit":null,"src":"site","asOf":"2026-10-19","more":false,"series":[{"name":"Orders by status","points":[["paid",12],["open",3]]}]}}
done {"dropped":["destination"],"history":"Orders this week:\n\n[shown: chart bar \"Orders by status\" (site data)]\n(dropped: cta, destination)\n"}
```

## API

| Import | What |
|---|---|
| `@az/chat-answer/checker.ts` | `createAnswerChecker(options)` → `{ read(chunks, { onCapped }) }`; `EVENTS_BYTES` |
| `@az/chat-answer/chat-answer.ts` | the line parser itself: `createAnswerParser(rules)`, `ANSWER_WORDS`, `ANSWER_LIMITS`, `ANSWER_FORMS`, `cleanText` |
| `@az/chat-answer/chat-rich.ts` | the rich components' reader and resolver; `FiguresRun`, `ToolsRun`, `GeocodeRun` — the data source's three calls |
| `@az/chat-answer/figures.ts` | the shapes a data source answers in: `Figures`, `RowsResult`, `CardsResult`, `PinsResult` |
| `@az/chat-answer/tool-shape.ts` | a declared tool's shape, and the one check of a parameter's value |
| `@az/chat-answer/history-tag.ts` | what a history tag covers (`tagMessage`, `HISTORY_KEY_LABEL`) and `webCryptoTags(secret)` |

`createAnswerChecker` takes:

| Option | Meaning |
|---|---|
| `components` | what an answer may show (`ANSWER_WORDS`); anything else is dropped. An unknown name throws. |
| `destinations` | the only links a cta or a card may use, exactly as written |
| `quotes` | the blocks `show …` may quote; none by default |
| `images` | the image keys a card may name — never an address; the renderer maps a key to its image |
| `presets` | the answers `use <name>` shows |
| `tools` | the tool shapes `from tool` may name: parameters and fields, never a URL or a key |
| `data` | `{ figures, tools, geocode }`: who answers a component's requests; each optional |
| `day` | the day figures are read on (`YYYY-MM-DD`); today in UTC by default |
| `eventsBytes` | the answer's events' byte cap, at most `EVENTS_BYTES` (48 KB, one share) |

`read(chunks)` takes the model's text as an async iterable of strings and
yields, in order:

| Event | When |
|---|---|
| `{ type: 'text', s }` | prose, cleaned (control, bidirectional and zero-width characters removed, NFC), never markup |
| `{ type: 'hold', word }` | a rich component passed the parser and its figures are being read: its kind only |
| `{ type: 'block', block }` | a component that passed every rule, as the page draws it |
| `{ type: 'done', capped, record, history, dropped, events }` | the end: what every cap was judged on, what the model is sent back next time, every drop's reason code, the events as sent |

A cap (4 000 characters of prose, four components) ends the answer:
`onCapped` is called at once — stop the model there — and nothing more is
read. A stream that throws ends the answer with no `done`; the error is
rethrown, and `read(…).record` and `.dropped` still say what was read.

History tags: whoever answers tags each answer's `history` so a page can
send it back and nobody can forge an earlier answer.
`webCryptoTags(secret)` gives exactly the tag the built-in server gives for
the same secret, so a conversation moves between them.

## Security

- The model is an untrusted author. Nothing it wrote reaches the page but
  these events; a component is checked whole, and a link, an image or a
  figure's source is never the model's choice.
- `from` requests reach your data source as the parser's closed words, never
  as text to run; tool parameters are checked against their declared types
  and bounds first (`tool-shape.ts`); your tool must still treat them as
  untrusted input.
- The injection corpus (`test/fixtures/chat-attacks/`) runs against this
  package in Node (`test/checker.test.ts`) and in Chromium, Firefox and
  WebKit (`scripts/chat-lib-e2e.mjs`, `pnpm test:chat-lib`).

## Tests

`node --experimental-strip-types --test packages/chat-answer/test/*.test.ts`
(part of `pnpm verify`), and `pnpm test:chat-lib` in three browsers. The
parser's own suites are in `packages/backend/test/chat-*.test.ts`, where
they were written; they import this package.
