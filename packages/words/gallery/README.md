# `gallery`

A set of photographs as a grid, masonry, a snapping carousel, or a 3D `orbit`.

Full specification: [`docs/gallery-block-spec.md`](../../../docs/gallery-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora

page /
  hero center
    title "Built in the dark"
  gallery grid
    title   "The workshop"
    sub     "Eighteen months, one room."
    columns 3
    ratio   3:2
    image ./preview-assets/assets/bench.webp
      alt "An empty workbench under a single lamp"
    image ./preview-assets/assets/welt.webp
      alt "A welt being stitched by hand"
    image ./preview-assets/assets/lasts.webp
      alt "Wooden lasts lined up on a shelf"
```

## Variants

Pick one. The first is the default.

| Variant | Use when |
|---|---|
| `grid` | a set of peers, one uniform crop |
| `masonry` | mixed aspect ratios you refuse to crop |
| `carousel` | a sequence with a beginning, in one screen of height |
| `orbit` | a small theatrical set in 3D (max 16 images, `poster` required) |

## Modifiers

Combine freely.

| Modifier | Effect |
|---|---|
| `reveal` | entrance motion, suppressed under reduced motion |
| `lightbox` | images open in a full-screen viewer |

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `title` | string |  |  | ≤ 10 words | section heading, as an `<h2>` |
| `sub` | string |  |  | ≤ 30 words | one supporting line |
| `columns` | int |  | `3` | 2–4 | grid columns, 2–4; also the eagerly loaded first row |
| `ratio` | enum | `square` / `4:3` / `3:2` / `16:9` / `portrait` / `auto` | `3:2` |  | crop ratio for every image; `auto` keeps each image's own shape |
| `poster` | path |  |  | .webp, .jpg | the static image `orbit` shows before or instead of 3D |

Rules: `orbit` requires `poster`.

## Children

- `image`: a photo (2–200): path first, then `alt`, `caption`, `focus`
- `cta`: one primary button
- `alt`: one secondary action

## Accessibility

- `alt` on every image, and `alt` is not the caption (`alt ""` when the caption says it)
- `<figure>` + `<figcaption>` when captions exist
- Never an `<h1>`; the focus ring sits outside the image box

The full floor is in the spec.

## Status

Every variant renders distinctly. Properties not yet implemented (`pnpm coverage`):

- none — every declared property changes the output

Known gaps:

- `orbit` shows its poster and image list only; the 3D ring needs the runtime port
- `lightbox` (§8) is built: each image is a named `<button>`, and the gallery holds one `popup` dialog. ←/→ step through the images and Home/End jump to the ends, with no wrap. A polite "N of M" counter, neighbour-only preloading, swipe, and focus returning to the thumbnail on show. `carousel` has previous/next buttons that are unavailable at the ends, clipped on phones until focused (§6/§10). Both are checked in three browser engines on `preview.carousel.az`.
- Image `width`/`height` and `srcset` are not generated (needs build-time image reading)
- The validation table's missing-alt, alt-equals-caption and partial-caption warnings are implemented (AZ2106–AZ2108)
- The spec's responsive table is implemented through the style contract (`below`), and each layout change is checked at 390px against 1440px by `pnpm test:visual`

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Word-specific: `gallery-images.test.ts`, `gallery-poster.test.ts`
- `scripts/verify-build.mjs` compiles the GRAMMAR §8 fixture, which includes this word, builds it with the real toolchain and checks the server-rendered HTML

**Browser-tested** by `pnpm test:visual` (in CI) on this word's `preview.az`, in all three themes, light and dark: Chromium 153 runs every browser check — overflow at 390/768/1440px, axe, keyboard reachability and focus indicator, reduced motion, and that the schemes differ; Firefox 155 and WebKit 26.6 run overflow and page errors at one width each, and the behaviour checks (menus, dropdowns, disclosures, copy, play, scroll behaviours) run in all three engines. Not tested: real Safari or iOS devices, and nav + footer combined in a browser (that combination is only server-rendered, by `verify-build`). The manifest's `tested` field records exactly this.
