# `faq`

Frequently asked questions as disclosures, with schema.org FAQPage structured data by default.

Full specification: [`docs/faq-block-spec.md`](../../../docs/faq-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora

page /
  hero center
    title "Built in the dark"
  faq list
    title "Questions"
    sub   "Everything people ask before they order."
    item "How long does a pair take?"
      text "Four to six weeks from order to shipping, cut and finished by one maker."
    item "Can I return them?"
      text "Unworn pairs can be returned within thirty days for a full refund."
    item "Do you resole?"
      text "Yes. Every pair has a stitched welt, so the sole can be replaced in the studio."
```

## Variants

Pick one. The first is the default.

| Variant | Use when |
|---|---|
| `list` | default: one column at full measure, 4–10 questions |
| `columns` | 6–12 short questions with one-line answers, when vertical space is scarce |

## Modifiers

Combine freely.

| Modifier | Effect |
|---|---|
| `single` | opening one item closes the others |
| `reveal` | entrance motion, suppressed under reduced motion |

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `title` | string |  |  | ≤ 8 words, required | section heading, as an `<h2>` |
| `sub` | string |  |  | ≤ 24 words | one supporting line |
| `schema` | enum | `on` / `off` | `on` |  | `on` (default) emits FAQPage JSON-LD for three or more answered questions; `off` suppresses it |

## Children

- `item`: a question (1–12), whose `text` is the answer and optional `more` link

## Data from a table

Questions can come from a data table instead of being written (data-spec §10):

```
faq
  title "Questions"
  from questions
    question question
    text     answer
    sort     created asc
    limit    6
```

| Line | Takes | Meaning |
|---|---|---|
| `question` | a `text` field (required) | each question |
| `text` | a `longtext` field (required) | each answer, its paragraphs kept |
| `sort`, `limit` (1–12, default 6), `filter`, `mine`, `empty` | as for `feature` | |

No FAQPage structured data is emitted for a `from` faq — it is only useful in
the pre-rendered page, which has no rows; `schema on` is warning AZ1265. Each
row is a real disclosure: collapsed by the behaviour runtime, answers still
found by find-in-page. Each answer is a `region` when `limit` is 6 or fewer.

States, for every `from` block: the pre-rendered page holds a skeleton sized
from `limit` (static, so reduced motion has nothing to stop), the block is
`aria-busy` while it loads, and a polite status line says the `empty` copy
or one fixed error line with **Try again**. A `mine` block, or a table only
signed-in visitors read, shows **Sign in** to a signed-out visitor. Rows are
text only — a value is never parsed as HTML. Rows are not in the
pre-rendered HTML, so they are not indexed. Without JavaScript the skeleton
stays and a `<noscript>` line says so. The block's own count rules (no questions; 1–2 is a paragraph; 13+ is a help centre)
do not apply: the number of rows is known only after the page loads.
Diagnostics: AZ1260–AZ1267, AZ1269 (`az explain faq from` for the terms).

## Accessibility

- `<h2>` for the title, `<h3>` per question with the toggle `<button>` inside it
- `aria-expanded` kept in sync on every state change
- Every disclosure is keyboard-operable (§8)

The full floor is in the spec.

## Status

Every variant renders distinctly. Properties not yet implemented (`pnpm coverage`):

- none — every declared property changes the output

Known gaps:

- An answer given as a file path (`text ./content/x.md`) is shown as the path; markdown answers are not read yet
- Each question is a disclosure (§7.1): the answers ship open, so they read with JS off, and the behaviour runtime collapses them to `hidden="until-found"` so find-in-page still opens them (§7.3); arrow keys move between questions and `single` keeps one open. Checked in a browser by `pnpm test:visual`
- The spec's responsive table is implemented through the style contract (`below`), and each layout change is checked at 390px against 1440px by `pnpm test:visual`

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Also exercising this word (its emitter header's `Tests`): `faq-schema.test.ts`, `faq-rows.test.ts`, `behaviour-markup.test.ts`, `from-blocks.test.ts`
- Not part of the GRAMMAR §8 fixture, so `scripts/verify-build.mjs` does not render it

**Browser-tested** by `pnpm test:visual` (in CI) on this word's `preview.az`, in all three themes, light and dark: Chromium 153 runs every browser check — overflow at 390/768/1440px, axe, keyboard reachability and focus indicator, reduced motion, and that the schemes differ; Firefox 155 and WebKit 26.6 run overflow and page errors at one width each, and the behaviour checks (menus, dropdowns, disclosures, copy, play, scroll behaviours) run in all three engines. Not tested: real Safari or iOS devices, and nav + footer combined in a browser (that combination is only server-rendered, by `verify-build`). The manifest's `tested` field records exactly this.
