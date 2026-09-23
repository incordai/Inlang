# `text`

A section of prose: an about section, a manifesto, or one line that should land on its own.

Full specification: [`docs/text-block-spec.md`](../../../docs/text-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora

page /
  hero center
    title "Built in the dark"
  text prose
    title "Why we stopped taking commissions"
    body  "Forty pairs a month is not a strategy. It is the size of the room, and the room decides what we can do well."
    cta   "Read the workshop notes" /journal

page /journal
```

## Variants

Pick one. The first is the default.

| Variant | Use when |
|---|---|
| `prose` | default: an about section or a long answer |
| `centered` | one short statement (3 lines or fewer) |
| `columns` | a short passage with a printed feel |

## Modifiers

Combine freely.

| Modifier | Effect |
|---|---|
| `reveal` | entrance motion, suppressed under reduced motion |

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `title` | string |  |  | ≤ 10 words | section heading, as an `<h2>` |
| `body` | markdown |  |  | .md, ≤ 800 words, required | the text, inline or a `.md` file |

## Children

- `cta`: one primary button
- `alt`: one secondary action

## Accessibility

- `title` is an `<h2>`; never an `<h1>`
- Markdown headings are shifted below the title and clamped at `<h4>`
- Prose links are underlined with a visible focus ring; every markdown image needs alt text

The full floor is in the spec.

## Status

Every variant renders distinctly. Properties not yet implemented (`pnpm coverage`):

- none — every declared property changes the output

Known gaps:

- Buttons render as plain links until the button primitive exists
- The spec's responsive table is implemented through the style contract (`below`), and each layout change is checked at 390px against 1440px by `pnpm test:visual`

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- `scripts/verify-build.mjs` compiles the GRAMMAR §8 fixture, which includes this word, builds it with the real toolchain and checks the server-rendered HTML

**Browser-tested** by `pnpm test:visual` (in CI) on this word's `preview.az`, in all three themes, light and dark: Chromium 153 runs every browser check — overflow at 390/768/1440px, axe, keyboard reachability and focus indicator, reduced motion, and that the schemes differ; Firefox 155 and WebKit 26.6 run overflow and page errors at one width each, and the behaviour checks (menus, dropdowns, disclosures, copy, play, scroll behaviours) run in all three engines. Not tested: real Safari or iOS devices, and nav + footer combined in a browser (that combination is only server-rendered, by `verify-build`). The manifest's `tested` field records exactly this.
