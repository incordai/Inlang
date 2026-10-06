# `feature`

A set of product features or claims: a grid of peers, rows with media, or a bento tiling where one item leads.

Full specification: [`docs/feature-block-spec.md`](../../../docs/feature-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora

page /
  hero center
    title "Built in the dark"
  feature grid reveal
    title   "Made properly, or not at all"
    sub     "Three things we refuse to compromise on."
    columns 3
    item "Hand-cut leather"
      icon ./preview-assets/icons/knife.svg
      text "Every panel is cut by hand from a single hide."
    item "Sewn, not glued"
      icon ./preview-assets/icons/stitch.svg
      text "A stitched welt, so the sole is replaceable."
      link "How we do it" /process
    item "Forty a month"
      icon ./preview-assets/icons/clock.svg
      text "The workshop holds two people. That is the ceiling."
    cta "See the collection" /shop

page /process

page /shop
```

## Variants

Pick one. The first is the default.

| Variant | Use when |
|---|---|
| `grid` | 3–6 peer features of equal weight |
| `rows` | each feature needs a real screenshot or photo |
| `bento` | one feature genuinely outranks the others |

## Modifiers

Combine freely.

| Modifier | Effect |
|---|---|
| `reveal` | entrance motion, suppressed under reduced motion |

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `title` | string |  |  | ≤ 10 words | section heading, as an `<h2>` |
| `sub` | string |  |  | ≤ 30 words | one supporting line |
| `columns` | int |  | `3` | 2–4 | grid columns, 2–4 |

## Children

- `item`: a feature (2–12): `title`, `text`, `icon`, `media`, `lead`, and an optional `link`
- `cta`: one primary button
- `alt`: one secondary action

## Data from a table

Items can come from a data table instead of being written (data-spec §10):

```
feature grid
  title "In the shop"
  from products
    title  name
    text   blurb
    sort   created desc
    limit  6
    filter status live
    empty  "Nothing here yet — check back soon"
```

| Line | Takes | Meaning |
|---|---|---|
| `title` | a `text` field (required) | each item's heading |
| `text` | a `text` or `longtext` field | each item's paragraph; a longtext keeps its paragraphs |
| `media` | an `image` field | not available until image uploads ship (D3): AZ1214 |
| `sort` | `created`, `updated` or a required field, then `asc`/`desc` | row order |
| `limit` | 1–12, default 6 | rows shown; the skeleton shows this many |
| `filter` | a `choice` or `flag` field and a value, at most two | only matching rows |
| `mine` | — | only the signed-in visitor's own rows |
| `empty` | a quoted sentence | what the block says with no rows |

A block with `from` declares no `item` (AZ1263). Each row is rendered by the
same code as a written item, so it looks exactly like one.

States, for every `from` block: the pre-rendered page holds a skeleton sized
from `limit` (static, so reduced motion has nothing to stop), the block is
`aria-busy` while it loads, and a polite status line says the `empty` copy
or one fixed error line with **Try again**. A `mine` block, or a table only
signed-in visitors read, shows **Sign in** to a signed-out visitor. Rows are
text only — a value is never parsed as HTML. Rows are not in the
pre-rendered HTML, so they are not indexed. Without JavaScript the skeleton
stays and a `<noscript>` line says so. The block's own count rules (at least 2 items; bento 3–7; rows ≤ 5)
do not apply: the number of rows is known only after the page loads.
Diagnostics: AZ1260–AZ1267, AZ1269 (`az explain feature from` for the terms).

## Accessibility

- `title` is an `<h2>`, item titles are `<h3>`; never an `<h1>`
- Items are a `<ul>` of peers
- Icons are `aria-hidden`
- A visible focus ring; hover is never the only affordance

The full floor is in the spec.

## Status

Every variant renders distinctly. Properties not yet implemented (`pnpm coverage`):

- none — every declared property changes the output

Known gaps:

- Icons are inlined and sanitised at build (§7): the CLI reads the file through the asset sandbox, and a strict parser keeps only shape elements and geometry/paint attributes. Script, style, `foreignObject`, event handlers and outside references are dropped. Paint becomes `currentColor`, and the icon is `aria-hidden`. A DOCTYPE, entity, CDATA or malformed file fails the build. Without file access (unit tests) the icon renders as an `<img>`
- `media` has no `width`/`height` from the file header yet (§7), which needs build-time image reading
- The spec's responsive table is implemented through the style contract (`below`), and each layout change is checked at 390px against 1440px by `pnpm test:visual`

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- `scripts/verify-build.mjs` compiles the GRAMMAR §8 fixture, which includes this word, builds it with the real toolchain and checks the server-rendered HTML

**Browser-tested** by `pnpm test:visual` (in CI) on this word's `preview.az`, in all three themes, light and dark: Chromium 153 runs every browser check — overflow at 390/768/1440px, axe, keyboard reachability and focus indicator, reduced motion, and that the schemes differ; Firefox 155 and WebKit 26.6 run overflow and page errors at one width each, and the behaviour checks (menus, dropdowns, disclosures, copy, play, scroll behaviours) run in all three engines. Not tested: real Safari or iOS devices, and nav + footer combined in a browser (that combination is only server-rendered, by `verify-build`). The manifest's `tested` field records exactly this.
