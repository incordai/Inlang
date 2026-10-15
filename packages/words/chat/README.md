# `chat`

A panel where a visitor asks the site's AI a question and reads the answer as it streams. The answer comes from the site's own backend, which asks the model the operator chose in the server's `.env` — the `.az` file never names a provider or a model.

Full specification: [`docs/chat-block-spec.md`](../../../docs/chat-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora
  auth
    adapter azbackend
  backend
    database sqlite
    email    smtp
    model    default

page /
  hero center
    title "Built in the dark"
  chat panel
    title    "Ask Aurora"
    greeting "Hi! Ask me about sizes, shipping or repairs."
    ask      "How long does a pair take?"
    ask      "Do you resole?"
```

A chat needs the built-in backend with `model default` (AZ1250), and the
backend needs `auth adapter azbackend` (AZ1507). Only signed-in visitors may
ask by default; `allow anyone` opens it to everyone and is warning AZ1256 —
every stranger spends the operator's model budget.

## Variants

| Variant | Use when |
|---|---|
| `panel` | default: a section on one page — heading, transcript, suggested questions, input |

`float` (a launcher fixed to the corner that opens the panel over any page,
declared under `site` and inherited) comes with phase C3 of the spec.

## Modifiers

None in this release.

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `title` | string |  | `Ask a question` | 1–60 characters | the panel's heading, as an `<h2>` |
| `greeting` | string |  |  | 1–200 characters | the first message, shown before anyone asks; never sent to the model |
| `allow` | enum | `signedin` / `anyone` | `signedin` |  | who may send a message; a signed-out visitor sees **Sign in to ask** |
| `limit` | int | 1–50 | `20` |  | questions per conversation before the panel says to start a new chat |
| `show` | list |  |  |  | the components an answer may hold (`pricing faq cta feature`) — **not available yet** (AZ1214); a word outside that list is AZ1254 with its reason |

## Children

- `ask "question"`: a suggested question (0–4, each 1–80 characters), shown as a button that asks it

## What the operator sets

The model is chosen in `server/.env`, never in the file: `AZ_CHAT_API`
(`completions`, the common chat-completions streaming shape, or `fake` for
local work), `AZ_CHAT_URL`, `AZ_CHAT_KEY`, `AZ_CHAT_MODEL`, and the cost
limits (`AZ_CHAT_DAILY_TOKENS`, `AZ_CHAT_MAX_OUTPUT_TOKENS`,
`AZ_CHAT_PER_ADDRESS`, `AZ_CHAT_PER_ACCOUNT`, `AZ_CHAT_CONCURRENCY`,
`AZ_CHAT_TIMEOUT_SECONDS`, `AZ_CHAT_ENABLED=off` as the kill switch). The
server's README, written by `az build`, lists them all. `az dev` runs the
`fake` adapter with a scripted demo answer, so local work costs nothing.

## How an answer reaches the page

The page posts the question and the conversation so far to the backend's
`/chat` (the browser's cookie, the CSRF header, the backend origin the page
policy already allows), and reads the answer as server-sent events over the
`fetch` body. Each piece of prose is written with `textContent` into a copy
of a template this word rendered — never parsed as markup, never linkified.
The conversation lives in the page's memory only; nothing is stored, and
earlier answers carry a server tag so they cannot be forged.

## Accessibility

- the heading is an `<h2>`; the form has a visible label; Send, Stop, Try again, New chat are real buttons
- the transcript is a plain list, not a live region; a separate polite status region hears whole sentences, at most one update every 1.5 seconds
- an answer is `aria-busy` while it streams; focus stays in the input when a question is sent
- Enter sends, Shift+Enter is a new line, Escape stops an answer
- colours are theme tokens only: visitor messages on `color.surface-alt`, answers on `color.surface`, errors in `color.danger`

The full floor is in the spec (§9).

## Status

C1 of the spec: prose answers on a `panel`. Properties not yet implemented (`pnpm coverage`):

- `show` — refused until components ship (C2)

Known gaps:

- `float`, a site-level `chat` and `chat none` (C3); `knows` tables (C3)
- quoted and composed components in answers (C2)
- "Jump to latest" and the rest of §9's scroll polish (C3)

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word; `chat-shell.test.ts` holds the shell to §5.4, §7 and §9
- `packages/core/test/chat-decl.test.ts` triggers every code the block raises; `packages/overlay/test/chat.test.ts` the runtime's event reader, copy and a source scan for markup sinks
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- `pnpm test:chat` runs the real generated server with the `fake` adapter in Chromium, Firefox and WebKit
