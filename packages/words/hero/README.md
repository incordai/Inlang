# `hero`

The page opener: eyebrow, the page's only `<h1>`, a supporting line, and up to two actions, optionally with a 3D scene.

Full specification: [`docs/hero-block-spec.md`](../../../docs/hero-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora

page /
  hero center
    eyebrow "Limited run"
    title   "Built in the dark"
    sub     "Handmade. Forty pairs a month."
    cta     "Reserve a pair" /reserve
    alt     "Watch the film" video:./preview-assets/assets/film.webm
    height  peek

page /reserve

```

## Variants

Pick one. The first is the default.

| Variant | Use when |
|---|---|
| `center` | the statement is the product |
| `split` | the visual is the product; text and media side by side |
| `full` | one great asset full-bleed behind the type |
| `stack` | a tall visual or screenshot below the headline |
| `minimal` | type-led, no media |

## Modifiers

Combine freely.

| Modifier | Effect |
|---|---|
| `3d` | adds a 3D scene (procedural by default) |
| `scroll` | scroll-linked camera; requires `3d` |
| `parallax` | depth motion |
| `glass` | frosted panel behind the text |

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `eyebrow` | string |  |  | ≤ 6 words | a short label above the title; not a heading |
| `title` | string |  |  | ≤ 12 words, required | the page's `<h1>` |
| `sub` | string |  |  | ≤ 30 words | one supporting line |
| `model` | path |  |  | .glb | an optional `.glb` model for `3d` |
| `poster` | path |  |  | .jpg, .png, .webp | the static image a `3d` hero shows at the static tier and while loading |
| `describe` | string |  |  | ≤ 20 words | the poster's alt text |
| `focus` | enum | `center` / `top` / `bottom` / `left` / `right` | `center` |  | which part of the poster a crop keeps — on a phone, `full` crops it tall |
| `height` | enum | `compact` / `peek` / `tall` / `full` | `peek` |  | `compact`, `peek`, `tall` or `full` |

Rules: `scroll` requires `3d`; `3d` works better with `poster`, `describe` (warning).

## Children

- `cta`: primary actions (max 2)
- `alt`: the secondary action (max 1)

## Accessibility

- Exactly one `<h1>`; the eyebrow is not a heading
- A gradient scrim under text on `full`
- `prefers-reduced-motion` gives the static poster, no motion
- A visible focus ring on both actions

The full floor is in the spec.

## Status

Every variant renders distinctly. Properties not yet implemented (`pnpm coverage`):

- none — every declared property changes the output

Known gaps:

- `3d` draws through the page's single renderer (packages/scene-runtime); the poster shows until it draws and at the `static` tier
- Actions render through the button primitive (`ctx.actions`): hierarchy, intent, six states and a 44px target
- Responsive (§10): `split` restacks to one column below 768px and the actions stack full-width below 480px, checked in a browser by `test:visual` (preview.split.az)
- Responsive (§10): `full` crops its poster from `focus`, and its scrim over the visual strengthens below 768px (88% → 65% of `scrim`, the stop that holds 4.5:1 over a white pixel in every theme), checked at 375px over the darkest and lightest poster by `test:visual` (preview.full.az)
- Not measured: the desktop scrim (88% → 55%) over a light poster

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Word-specific: `hero-alt.test.ts`, `hero-scrim.test.ts`
- `scripts/verify-build.mjs` compiles the GRAMMAR §8 fixture, which includes this word, builds it with the real toolchain and checks the server-rendered HTML

**Browser-tested** by `pnpm test:visual` (in CI) on this word's `preview.az`, in all three themes, light and dark: Chromium 153 runs every browser check — overflow at 390/768/1440px, axe, keyboard reachability and focus indicator, reduced motion, and that the schemes differ; Firefox 155 and WebKit 26.6 run overflow and page errors at one width each, and the behaviour checks (menus, dropdowns, disclosures, copy, play, scroll behaviours) run in all three engines. Not tested: real Safari or iOS devices, and nav + footer combined in a browser (that combination is only server-rendered, by `verify-build`). The manifest's `tested` field records exactly this.
