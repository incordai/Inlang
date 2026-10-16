# `chat`

A panel — on a page, or opened from a launcher in the corner of every page — where a visitor asks the site's AI a question and reads the answer as it streams. The answer comes from the site's own backend, which asks the model the operator chose in the server's `.env` — the `.az` file never names a provider or a model.

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
| `float` | a launcher fixed to the inline-end bottom corner that opens the same panel: a bottom sheet below `sm` (focus held there, the page locked), a side panel above it (the page stays usable). Declared under `site` it is on every page |
| `none` | on a page, leaves the site's float out of it |

```
site aurora
  chat float
    title "Ask Aurora"
    allow anyone

page /checkout
  chat none
```

A page shows one chat: a page's own `chat panel` replaces the site's float
there, and a page's own `chat float` under the site's is AZ2229. The
launcher ships hidden and the runtime shows it, so with JavaScript off there
is nothing to open. [`preview.float.az`](preview.float.az) shows a float.

## Modifiers

None in this release.

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `title` | string |  | `Ask a question` | 1–60 characters | the panel's heading, as an `<h2>` |
| `greeting` | string |  |  | 1–200 characters | the first message, shown before anyone asks; never sent to the model |
| `allow` | enum | `signedin` / `anyone` | `signedin` |  | who may send a message; a signed-out visitor sees **Sign in to ask** |
| `limit` | int | 1–50 | `20` |  | questions per conversation before the panel says to start a new chat |
| `show` | list | `pricing` `faq` `cta` `feature` `chart` `table` `stats` `cards` `dashboard` `explore` |  | at most 10 | what an answer may hold besides text (below); a word outside that list is AZ1254 with its reason; `pricing` with no pricing block a signed-out visitor can see is AZ1255; `dashboard` with nothing to hold is AZ1270; a public table named `tool` beside a component that takes `from` is AZ1272 (`from tool` is the server's data tools) |
| `knows` | list | table names |  | at most 3 | tables whose rows the answers draw on (below): each must be `allow anyone read` (AZ1252) and filled only by the site's admins (AZ1253); named twice or a fourth is AZ1258, not a table AZ1271 |

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

And the rich components (chat-block-spec §20), which exist only inside
answers — they are not page words:

| Word | In an answer |
|---|---|
| `chart` | a bar, line, area, pie or donut chart in SVG drawn by the page, in the theme's six series colours (3:1 on every ground) with a pattern, marker or dash per series, a one-sentence summary and the same figures as a table. **Figures `from` a public table** (`chart bar "Orders" from orders count by status`) are the server's exact count; numbers the model writes carry a visible **"AI-generated figures"** label |
| `table` | a table `from` a public table's columns, or the model's own (labelled); real headers, sortable when asked |
| `stats` | 1–4 key figures with their change, in a sign, a glyph and words — never colour alone |
| `cards` | 1–4 cards: a title, text, a link to a declared destination, and an image that is only a gallery image of this site (by key) or a public row's image — never an address the model writes |
| `dashboard` | 2–6 stats, charts, tables or cards under one title |
| `explore` | one data set the visitor explores in the page (chat-block-spec §21.3): the model's rows (labelled AI-generated), a public table's `from`, or a tool's; up to 4 controls — a slider, a date, a toggle, a form of fields that applies them or asks a question built from them, shown on its button before it is sent; and up to 4 views — a table, a stat or a chart, each with one `where` and one of `count`, `sum`, `avg`, `min`, `max`. The page recomputes the views as a control moves, with no request; nothing is a formula, nothing is evaluated |

A visitor can **share** one finished answer: only then is that answer
stored, under an unguessable link to `/chat/shared`, for 30 days
(`AZ_CHAT_SHARE_DAYS`), with a delete link shown once; the question is kept
only if they tick "Include my question". The shared page is read-only and
`noindex`.

The model writes these as a few lines of `.az` (`show pricing /pricing`,
`faq` with `item "…"` and `text "…"`, `cta "Talk to us" /contact`); the
server parses them and the page receives only checked events. A line that
does not have a component's shape is shown as text; a component that breaks
any rule — a word the panel does not show, a destination the file does not
declare, a value past its length, deeper nesting — is dropped and leaves no
trace. No image, no markup, no style and no link the file did not declare
can appear in an answer.

## Answers from the site's tables (`knows`)

```
site aurora
  data questions
    question text     required search
    answer   longtext required search
    allow anyone read

  chat float
    knows questions
```

With each question the server reads rows of the tables a chat `knows`
exactly as a signed-out visitor reads `GET /data/<table>`: only fields that
are not `private`, never an image, never who owns a row. When the table has
`search` fields the visitor's words are looked for in them; otherwise (or
when nothing matches) the newest rows. At most 20 rows, 2 000 characters a
row and 12 000 a table, cached for a minute, are sent after the site's pages,
marked as data the model must not take instructions from. A table that
strangers can add rows to or change (`allow anyone create`, `allow signedin
create`, any `edit` rule) is refused: a row a stranger wrote would be
instructions to the model dressed as data. The server checks the same again
when it starts.

## How an answer reaches the page

The page posts the question and the conversation so far to the backend's
`/chat` (the browser's cookie, the CSRF header, the backend origin the page
policy already allows), and reads the answer as server-sent events over the
`fetch` body. Each piece of prose is written with `textContent` into a copy
of a template this word rendered — never parsed as markup, never linkified.
Each component is a copy of a hidden template the build rendered with that
word's own emitter, filled with text; a call to action's destination is
checked against the shell's own allow-list before it is written.
Prose may use a small markdown subset — **bold**, *italic*, `inline code`,
bullet and numbered lists, and fenced code blocks with a **Copy code**
button — read in the page into a fixed set of elements whose text is set
with `textContent`; anything else (HTML, links, images, headings) stays the
text it is. An answer may end with up to three **follow-up questions**:
buttons that ask exactly their words as the visitor's next question.

The conversation is kept in the visitor's own browser (`localStorage`) for
7 days, so a reload — or the next page, under a float — carries on; the
panel says so and offers **Clear history**. What is kept is bound to who
reads it — a salted hash of the signed-in account, or the browser for a
visitor nobody signed in — so another account, a sign-out, or a sign-in
over a stranger's chat starts empty. The same chat in two tabs stays in
step; a tab whose answer the other overtook says it is not kept. A restored
answer can still be shared, and a long chat sends only its latest exchanges
(and says so). Nothing is stored on the server, and earlier answers carry a
server tag so an edited one is refused. Where storage is blocked the chat
works as before, keeping nothing.

## Accessibility

- the heading is an `<h2>`; the form has a visible label; Send, Stop, Try again, New chat are real buttons
- the transcript is a plain list, not a live region; a separate polite status region hears whole sentences, at most one update every 1.5 seconds
- an answer is `aria-busy` while it streams; focus stays in the input when a question is sent
- Enter sends, Shift+Enter is a new line, Escape stops an answer — and then closes a float
- a float's launcher is named by the title; opening moves focus to the input, closing returns it to the launcher; below `sm` focus stays in the sheet
- the transcript scrolls on its own, follows the newest words only while you are at its end, and offers **Jump to latest** once you scroll up; it is a keyboard stop, and an answer that holds components is one too
- follow-up questions are real buttons in a list named "Follow-up questions"; a code block is a focusable, named scroll region with a **Copy code** button whose result is announced; formatting marks are never read aloud
- with reduced motion the panel appears without sliding and the transcript jumps rather than glides
- colours are theme tokens only: visitor messages on `color.surface-alt`, answers on `color.surface`, errors in `color.danger`

The full floor is in the spec (§9).

## Status

C1 to C7 of the spec: a `panel` or a `float` (on every page from
`site`, left out with `chat none`) whose answers are prose and the
components `show` lists — the site's own blocks, and charts, tables, stats,
image cards and dashboards — with share links, grounded on the site's pages
(a `text` body kept in a file included, as plain text) and on the public
tables it `knows`; C4's operations — the moderation hook, the `az doctor` and
`az audit` chat checks, the usage view and `az backend usage`; C5 —
formatted prose, follow-up questions, and the conversation kept in the
visitor's browser (spec §21.1); and C6 — charts, tables and stats whose
figures come `from tool` one of the operator's own HTTP endpoints, declared
in the server's `.env` and shown with its label, their rows never sent to
the model (spec §21.2); and C7 — explores, whose sliders, dates, toggles
and forms recompute their tables, stats and charts in the page over a
closed set of computations (spec §21.3). Before going live, `az backend probe server` asks
the configured model the real prompt, one question per component, calls
each tool once with its sample, and reports what it streamed, what the
filter dropped and what each tool answered.

Known gaps:

- a quote is of `pricing` only; `faq`, `cta` and `feature` are composed, never quoted
- one wire shape (`completions`); a second is added only when a deployment needs it (spec §19.8)
- the model never reads a tool's rows, so it cannot comment on them (spec §21.2.8 O6); interactive controls (C7) and maps (C8) are not built

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word; `chat-shell.test.ts` holds the shell to §5.4, §7 and §9
- `packages/core/test/chat-decl.test.ts` and `chat-float-decl.test.ts` trigger every code the block raises; `packages/overlay/test/chat.test.ts` the runtime's event reader, copy and a source scan for markup sinks, `chat-float.test.ts` the float's preset and the transcript's end
- `packages/overlay/test/chat-markdown.test.ts` holds the prose subset (every hostile form literal, linear cost); `chat-history.test.ts` the kept conversation's caps, expiry, Clear and corrupt or refused storage
- `packages/backend/test/chat-knows.test.ts` reads `knows` rows through the anonymous list on SQLite and holds the exact bytes the model is given; `pnpm test:backend-db` does the same on PostgreSQL and MySQL
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- `pnpm test:chat` runs the real generated server with the `fake` adapter in Chromium, Firefox and WebKit, components and the injection corpus included — and the float on every page, its keyboard and focus, Jump to latest, reduced motion, answers grounded on a `knows` table, and pixel snapshots of answered states in every theme and scheme
- `packages/backend/test/chat-tools.test.ts` holds the tool declarations, every parameter type at its bounds, and the call against a local endpoint (redirects, timeouts, oversized, malformed and mis-shaped replies refused); `chat-tools-route.test.ts` the route with a tool, the per-answer cap, the cache, the per-address limit, and that no row ever reaches the model
- `packages/backend/test/chat-answer.test.ts` and `chat-attacks.test.ts` hold the answer parser to every form, cap and split, and to the injection corpus (`packages/backend/test/fixtures/chat-attacks/`)
