# `pricing`

Plans and prices, as comparable cards or a real comparison table, with an optional monthly/annual toggle.

Full specification: [`docs/pricing-block-spec.md`](../../../docs/pricing-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora

page /
  hero center
    title "Built in the dark"
  pricing cards
    title    "Simple pricing"
    currency usd
    period   "per seat, per month"
    plan "Studio"
      monthly 29
      annual  290
      feature "Projects" "10"
      cta     "Start with Studio" /signup/studio
    plan "Practice"
      highlight on
      badge   "Most popular"
      monthly 79
      annual  790
      feature "Projects" "Unlimited"
      cta     "Start with Practice" /signup/practice

page /signup/studio

page /signup/practice
```

## Variants

Pick one. The first is the default.

| Variant | Use when |
|---|---|
| `cards` | 2–4 plans that differ by degree |
| `table` | plans that differ by kind and must be compared |

## Modifiers

Combine freely.

| Modifier | Effect |
|---|---|
| `reveal` | entrance motion, suppressed under reduced motion |

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `title` | string |  |  | ≤ 8 words, required | section heading, as an `<h2>` |
| `sub` | string |  |  | ≤ 24 words | one supporting line |
| `currency` | enum | ISO 4217 code |  |  | ISO 4217 currency code |
| `locale` | string |  | `en-US` |  | number formatting locale (default `en-US`) |
| `billing` | enum | `monthly` / `annual` | `monthly` |  | `monthly` or `annual`: which price shows first |
| `period` | string |  |  | ≤ 6 words | the price unit, e.g. "per seat, per month" |

## Children

- `plan`: a plan (1–4): `monthly`, `annual`, `highlight`, `badge`, `feature` rows and exactly one `cta`

## Accessibility

- `<h2>` for the title, `<h3>` per plan; never an `<h1>`
- `table` is a real `<table>` with a caption and scoped headers
- The price is text, read as a number within the plan's region

The full floor is in the spec.

## Status

Every variant renders distinctly. Properties not yet implemented (`pnpm coverage`):

- none — every declared property changes the output

Known gaps:

- Buttons render as plain links until the button primitive exists
- Phone and tablet layouts from the spec's responsive table are not implemented for any word yet: the web target emits inline styles only, with no media queries.

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Word-specific: `pricing.test.ts`
- Not part of the GRAMMAR §8 fixture, so `scripts/verify-build.mjs` does not render it

**Browser-tested** by `pnpm test:visual` (in CI) on this word's `preview.az`, in all three themes, light and dark: Chromium 153 runs every browser check — overflow at 390/768/1440px, axe, keyboard reachability and focus indicator, reduced motion, and that the schemes differ; Firefox 155 and WebKit 26.6 run overflow and page errors at one width each. Not tested: real Safari or iOS devices, and nav + footer combined in a browser (that combination is only server-rendered, by `verify-build`). The manifest's `tested` field records exactly this.
