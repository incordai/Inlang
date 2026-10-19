# @az/chat-runtime — the chat, for an app

One call per question — `chat.ask(conversation, question)` — streams the
answer's events (`text`, `hold`, `block`, then `done`, or `error`), which
`<AzAnswer>` (`@az/chat-react`) or the renderer core (`@az/chat-render`
`mountAnswer`) draws. It is the built-in chat server's route, as a library:

- **Direct** (`model`): the runtime runs the chat itself, as the server
  does: the conversation's length, the moderation hook, the day's budget at
  the answer's largest cost, the instructions (`@az/chat-instructions`), the
  model under the streaming contract (first token in 15 s, each next in 20 s;
  stopped at a cap or on `signal`), the answer checker (`@az/chat-answer`),
  then the history kept and the tokens counted. It runs where the
  provider's key is — a Node host, a sidecar — **never in a page**.
- **Transport** (`transport`): a chat server answers over the chat API — the
  user's own sidecar on 127.0.0.1 (`local`), or the operator's (`hosted`).
  The operator's `limit_reached` is answered by the user's own provider,
  with a `note`; the user's own failing yields an `offer`, and the
  operator's calls are spent only when the app asks again with
  `mode: 'hosted'`. Each server is sent only the exchanges it answered, with
  its own tags and conversation id, so every tag it checks is one it made.

The pieces are interfaces: `ModelBridge` (any model — `nodeModelBridge` is
the server's own completions adapter), `ChatTransport` (`httpTransport`),
`HistoryStore` (`memoryHistory`, `webStorageHistory`, or the app's own),
`BudgetStore`, `AppTool` (the app's functions behind `from tool …`, their rows
checked and aggregated by the server's code), and `HistoryTags`
(`webCryptoTags`), which refuses a kept conversation that was edited
([chat-block-spec §22.4](../../docs/chat-block-spec.md)).

Not published to a registry (the package is `private`); a workspace package
depends on it with `"@az/chat-runtime": "workspace:*"`. The desktop bridge
and the sidecar are later work (issues #39, #41).

## Example

[`examples/ask-in-node.ts`](examples/ask-in-node.ts), run with
`node packages/chat-runtime/examples/ask-in-node.ts` — a stand-in provider on
this machine, so it runs offline:

```ts
// Run: node packages/chat-runtime/examples/ask-in-node.ts
import { createServer } from 'node:http';
import { createChatRuntime } from '@az/chat-runtime/runtime.ts';
import { nodeModelBridge } from '@az/chat-runtime/node-bridge.ts';

// A stand-in provider on this machine that speaks the completions shape, so the example runs offline.
// Point `url` at a real provider instead, and read its key from the environment.
const provider = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const say = (content: string) => res.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
  say('We ship within two working days.\n\n');
  say('cta "Contact us" /contact\n');
  say('cta "Wire money" https://elsewhere.example\n');
  res.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 800, completion_tokens: 30 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
const { port } = provider.address() as { port: number };

const chat = createChatRuntime({
  model: nodeModelBridge({ url: `http://127.0.0.1:${port}/v1`, key: process.env.MODEL_KEY ?? '', model: 'default' }),
  instructions: { appName: 'Acme Lamps', components: ['cta'], destinations: ['/contact'], content: { notes: ['Orders ship within two working days.'] } },
  checker: { components: ['cta'], destinations: ['/contact'] },
  budget: { tokensPerDay: 50_000 },
});

// The checker's events: prose, the link to a page the app allows, and nothing for the one it does not.
for await (const e of chat.ask('first-conversation', 'How fast do you ship?')) {
  if (e.type === 'text') console.log(`text  ${JSON.stringify(e.s)}`);
  if (e.type === 'block') console.log(`block ${JSON.stringify(e.block)}`);
  if (e.type === 'done') console.log(`done  ${e.left} questions left; kept as ${JSON.stringify(e.text)}`);
}
console.log((await chat.list()).map((c) => c.title));
provider.close();
```

It prints the prose, the link to a page the app allows — the other dropped,
and noted in the history the model is sent back — and the conversation kept:

```text
text  "We ship within two working days.\n\n"
block {"cta":{"label":"Contact us","to":"/contact"}}
done  19 questions left; kept as "We ship within two working days.\n\ncta \"Contact us\" /contact\n(dropped: cta, destination)\n"
[ 'How fast do you ship?' ]
```

## API

| Import | What |
|---|---|
| `@az/chat-runtime/runtime.ts` | `createChatRuntime(options)` → `{ ask, load, list, forget }`; `RuntimeEvent`, `AppTool`, `Moderate`, `RUNTIME_ERRORS` |
| `@az/chat-runtime/node-bridge.ts` | `nodeModelBridge({ url, key, model })`: a provider of the completions shape, through the server's adapter. Node only |
| `@az/chat-runtime/transport.ts` | `httpTransport({ source, base, token })`: `POST <base>/chat`, the token in the Authorization header only, no cookie; the base https, or http on this machine |
| `@az/chat-runtime/history.ts` | `HistoryStore`; `memoryHistory()`, `webStorageHistory(localStorage)` — capped, read back checked whole |
| `@az/chat-runtime/session.ts` | `createChatSession(runtime, conversation)`: a chat window's headless state — snapshots of its turns and each answer's events, `ask`, `stop`, `askHosted`, `load` (what `useAzChat` reads) |
| `@az/chat-runtime/budget.ts` | `createBudget`, `BUDGET_DEFAULTS` (the server's: 300 000 tokens a UTC day, 20 questions a conversation, 600 output tokens an answer), `memoryBudgetStore`, `webStorageBudgetStore` |

`createChatRuntime` takes:

| Field | Meaning |
|---|---|
| `model` | direct: a `ModelBridge` (`@az/chat-answer/model-stream.ts`) |
| `instructions` | direct: `buildInstructions`' input but the per-question fields; the app's tools are added from `tools` |
| `checker`, `data` | direct: the answer checker's rules (components, destinations, quotes, images, presets) and its data source |
| `tools` | direct: `{ shape, run(args, signal) }` per tool; `run` returns rows of exactly the declared fields, or the component says its figures could not be loaded |
| `budget`, `moderate`, `timing` | direct: the limits and their store; the moderation hook (a failure refuses); the model's timers |
| `transport` | `{ local?, hosted?, prefer? }`: the chat servers |
| `history`, `tags`, `page`, `now` | where conversations are kept; the tagger; the page the context names; the clock |

## Security

A key is never in browser code: `nodeModelBridge` is the one module that
holds one, and the dependency rules (`packages/core/test/deps.test.ts`) let
only it reach the server's adapters. Nothing reaches a page but the
checker's events (direct) or a server's, read by the page's own reader. The
model is stopped the moment an answer ends. The injection corpus runs
through `ask` (`test/runtime.test.ts`).

## Tests

`node --experimental-strip-types --test packages/chat-runtime/test/*.test.ts`
(part of `pnpm verify`): the direct path end to end, every refusal, the cap,
the timers, tampering, tools, the corpus, the fallback rules, the stores,
the transport and the bridge.
