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
| `show` | list | `pricing` `faq` `cta` `feature` |  | at most 4 | what an answer may hold besides text (below); a word outside that list is AZ1254 with its reason; `pricing` with no pricing block a signed-out visitor can see is AZ1255 |

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

## Components in an answer (`show`)

```
  chat panel
    show pricing faq cta feature
```

| Word | In an answer |
|---|---|
| `pricing` | **quoted**: the site's own pricing block, exactly as its page renders it, billing switch and all — never prices the model wrote |
| `faq` | **composed**: 1–6 questions and answers the model writes, drawn by the faq word's own item markup; they open and close as on any page |
| `cta` | one button the model labels, to a destination this `.az` file already declares (a page, a written `route#anchor`, an exact `https:`, `mailto:` or `tel:` value) |
| `feature` | **composed**: 1–6 short items, drawn by the feature word's own item markup |

The model writes these as a few lines of `.az` (`show pricing /pricing`,
`faq` with `item "…"` and `text "…"`, `cta "Talk to us" /contact`); the
server parses them and the page receives only checked events. A line that
does not have a component's shape is shown as text; a component that breaks
any rule — a word the panel does not show, a destination the file does not
declare, a value past its length, deeper nesting — is dropped and leaves no
trace. No image, no markup, no style and no link the file did not declare
can appear in an answer.

## How an answer reaches the page

The page posts the question and the conversation so far to the backend's
`/chat` (the browser's cookie, the CSRF header, the backend origin the page
policy already allows), and reads the answer as server-sent events over the
`fetch` body. Each piece of prose is written with `textContent` into a copy
of a template this word rendered — never parsed as markup, never linkified.
Each component is a copy of a hidden template the build rendered with that
word's own emitter, filled with text; a call to action's destination is
checked against the shell's own allow-list before it is written.
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

C1 and C2 of the spec: a `panel` whose answers are prose and the components
`show` lists. Before going live, `az backend probe server` asks the configured
model the real prompt, one question per component, and reports what it streamed
and what the filter dropped.

Known gaps:

- `float`, a site-level `chat` and `chat none` (C3); `knows` tables (C3)
- a quote is of `pricing` only; `faq`, `cta` and `feature` are composed, never quoted
- "Jump to latest" and the rest of §9's scroll polish (C3)

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word; `chat-shell.test.ts` holds the shell to §5.4, §7 and §9
- `packages/core/test/chat-decl.test.ts` triggers every code the block raises; `packages/overlay/test/chat.test.ts` the runtime's event reader, copy and a source scan for markup sinks
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- `pnpm test:chat` runs the real generated server with the `fake` adapter in Chromium, Firefox and WebKit, components and the injection corpus included
- `packages/backend/test/chat-answer.test.ts` and `chat-attacks.test.ts` hold the answer parser to every form, cap and split, and to the injection corpus (`packages/backend/test/fixtures/chat-attacks/`)
