# `cta`

The closing call to action: one ask, one primary button, an optional secondary, usually the last thing before the footer.

Full specification: [`docs/cta-block-spec.md`](../../../docs/cta-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora

page /
  hero center
    title "Built in the dark"
  cta band
    title "Forty pairs a month. One of them could be yours."
    sub   "Reserve now for the autumn run."
    cta   "Reserve a pair" /reserve
    alt   "Copy the studio address" copy:studio@aurora.example

page /reserve
```

## Variants

Pick one. The first is the default.

| Variant | Use when |
|---|---|
| `band` | default: full-bleed with its own background and inverted palette |
| `card` | contained and inset, for a modest ask on a busy page |
| `split` | text beside one genuinely good supporting image (`media` required) |

## Modifiers

Combine freely.

| Modifier | Effect |
|---|---|
| `glass` | frosted surface with a solid fallback |
| `reveal` | entrance motion, fully suppressed under reduced motion |

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `title` | string |  |  | ≤ 12 words, required | the ask, as an `<h2>` |
| `sub` | string |  |  | ≤ 24 words | one supporting line |
| `media` | path |  |  | .jpg, .png, .webp, .avif | the `split` image |
| `describe` | string |  |  | ≤ 20 words | the image's alt text; omit it when the image is decorative |

Rules: `split` requires `media`.

## Children

- `cta`: the primary button (max 1)
- `alt`: the secondary action (max 1)

## Accessibility

- `title` is an `<h2>`; the block never emits an `<h1>`
- Contrast checked against the band's own background, in both themes
- `split` media: `describe` when informative, `alt=""` when decorative
- `reveal` fully suppressed under `prefers-reduced-motion`

The full floor is in the spec.

## Status

Every variant renders distinctly. Properties not yet implemented (`pnpm coverage`):

- none — every declared property changes the output

Known gaps:

- Primary and secondary buttons render as plain links until the button primitive exists
- The spec's responsive table is implemented through the style contract (`below`), and each layout change is checked at 390px against 1440px by `pnpm test:visual`

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Word-specific: `cta-media.test.ts`
- `scripts/verify-build.mjs` compiles the GRAMMAR §8 fixture, which includes this word, builds it with the real toolchain and checks the server-rendered HTML

**Browser-tested** by `pnpm test:visual` (in CI) on this word's `preview.az`, in all three themes, light and dark: Chromium 153 runs every browser check — overflow at 390/768/1440px, axe, keyboard reachability and focus indicator, reduced motion, and that the schemes differ; Firefox 155 and WebKit 26.6 run overflow and page errors at one width each. Not tested: real Safari or iOS devices, and nav + footer combined in a browser (that combination is only server-rendered, by `verify-build`). The manifest's `tested` field records exactly this.
