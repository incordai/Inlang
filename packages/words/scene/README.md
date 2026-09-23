# `scene`

A 3D viewport anywhere in the page flow: an object next to the copy that describes it, a full-bleed section, or a site-wide backdrop. Every scene has a poster and a text alternative.

Full specification: [`docs/scene-block-spec.md`](../../../docs/scene-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora

page /
  hero split
    title "Built in the dark"
    sub   "Handmade. Forty pairs a month."
  scene inline 3d
    poster  ./preview-assets/assets/shoe.webp
    alt     "A black running shoe seen from the side"
    ratio   4:3
    caption "Cut from a single hide."
```

## Variants

Pick one. The first is the default.

| Variant | Use when |
|---|---|
| `inline` | the object sits next to the copy describing it |
| `full` | the object is the whole section |
| `backdrop` | motion behind the whole site (site-level) |
| `none` | suppresses an inherited backdrop on one page |

## Modifiers

Combine freely.

| Modifier | Effect |
|---|---|
| `3d` | renders the scene (requires `poster` and `alt`) |
| `scroll` | scroll-linked camera |
| `parallax` | depth motion |

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `model` | path |  |  | .glb | an optional `.glb` model |
| `poster` | path |  |  | .webp, .jpg, required | the static image, always required |
| `alt` | string |  |  | ≤ 20 words, required | the text alternative for the scene and poster |
| `ratio` | enum | `1:1` / `4:3` / `3:2` / `16:9` | `4:3` |  | viewport aspect ratio |
| `caption` | string |  |  | ≤ 16 words | a caption under the scene |
| `camera` | enum | `fixed` / `orbit` / `scroll` | `fixed` |  | `fixed`, `orbit` or `scroll` |

Rules: `3d` requires `poster`, `alt`.

## Accessibility

- The canvas is `role="img"` with the `alt` as its label
- No `<h1>`; a caption is a `<figcaption>`
- `prefers-reduced-motion` gives the poster, no motion
- Interactive scenes are keyboard-operable; auto-rotation has a pause control

The full floor is in the spec.

## Status

Every variant renders distinctly. Properties not yet implemented (`pnpm coverage`):

- `model`, `camera`

Known gaps:

- `model` and `camera`: the emitter outputs a `<figure>` placeholder with the poster in a `data-poster` attribute and never creates a canvas; the 3D runtime is not ported yet
- Because the poster is not resolved through the asset pipeline, the poster file is not copied into the build
- Phone and tablet layouts from the spec's responsive table are not implemented for any word yet: the web target emits inline styles only, with no media queries.

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Not part of the GRAMMAR §8 fixture, so `scripts/verify-build.mjs` does not render it

**Browser-tested** by `pnpm test:visual` (in CI) on this word's `preview.az`, in all three themes, light and dark: Chromium 153 runs every browser check — overflow at 390/768/1440px, axe, keyboard reachability and focus indicator, reduced motion, and that the schemes differ; Firefox 155 and WebKit 26.6 run overflow and page errors at one width each. Not tested: real Safari or iOS devices, and nav + footer combined in a browser (that combination is only server-rendered, by `verify-build`). The manifest's `tested` field records exactly this.
