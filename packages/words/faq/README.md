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
- "Two FAQPage blocks on one page" is not validated yet
- Phone and tablet layouts from the spec's responsive table are not implemented for any word yet: the web target emits inline styles only, with no media queries.

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Word-specific: `faq-schema.test.ts`
- Not part of the GRAMMAR §8 fixture, so `scripts/verify-build.mjs` does not render it

**Not yet tested:** no browser, visual, keyboard or axe run has been made for this word (quality-gate items 3–7). The manifest's `tested` field lists browsers, but those runs have not happened; treat it as a target, not a result.
