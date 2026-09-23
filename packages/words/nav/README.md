# `nav`

The site navigation: logo, links, dropdown groups and one call to action, with a mobile menu. Usually declared once at site level; `nav none` removes it from a page.

Full specification: [`docs/nav-block-spec.md`](../../../docs/nav-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora
  nav bar
    link   "Work"   /work
    link   "Studio" /studio
    cta    "Reserve" /reserve

page /
  hero center
    title "Built in the dark"

page /work

page /studio

page /reserve
```

## Variants

Pick one. The first is the default.

| Variant | Use when |
|---|---|
| `bar` | default: logo left, links right |
| `center` | editorial, symmetric brands (4 links or fewer) |
| `split` | three zones, protecting a real CTA |
| `minimal` | a menu button at every size, for small sites |
| `side` | docs and apps with deep hierarchies |
| `mega` | multi-product sites with at least two groups |
| `none` | suppresses an inherited nav on one page |

## Modifiers

Combine freely.

| Modifier | Effect |
|---|---|
| `sticky` | pinned to the top |
| `hide` | hides on scroll down, returns on scroll up |
| `shrink` | reduces height past a threshold |
| `glass` | backdrop blur once scrolled |
| `solid` | transparent over the hero, solid after scrolling |

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `logo` | path |  |  | .svg, .png, .webp | the site logo, linking to `/` |
| `inverse` | path |  |  | .svg, .png, .webp | the light logo shown while a `solid` nav is transparent |
| `mobile` | enum | `drawer` / `sheet` / `full` | `drawer` |  | `drawer`, `sheet` or `full`: the mobile menu |

Rules: `solid` works better with `inverse` (warning).

## Children

- `link`: a link
- `group`: a dropdown group of links
- `cta`: the call to action

## Accessibility

- A skip link is the first focusable element
- A labelled `<nav>` landmark; `aria-current="page"` on the active link
- The logo link carries the site name as accessible text
- 44×44px targets including the menu toggle

The full floor is in the spec.

## Status

Every variant renders distinctly. Properties not yet implemented (`pnpm coverage`):

- none — every declared property changes the output

Known gaps:

- The scroll behaviours (`sticky` offset, `hide`, `shrink`, the `solid` logo swap) and dropdown/mobile menu interaction need the motion/overlay runtime, which is not built; the markup hooks are emitted
- Phone and tablet layouts from the spec's responsive table are not implemented for any word yet: the web target emits inline styles only, with no media queries.

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Word-specific: `nav-footer.test.ts`, `nav-inverse.test.ts`
- `scripts/verify-build.mjs` compiles the GRAMMAR §8 fixture, which includes this word, builds it with the real toolchain and checks the server-rendered HTML

**Browser-tested** by `pnpm test:visual` (in CI) on this word's `preview.az`, in all three themes, light and dark: Chromium 153 runs every browser check — overflow at 390/768/1440px, axe, keyboard reachability and focus indicator, reduced motion, and that the schemes differ; Firefox 155 and WebKit 26.6 run overflow and page errors at one width each. Not tested: real Safari or iOS devices, and nav + footer combined in a browser (that combination is only server-rendered, by `verify-build`). The manifest's `tested` field records exactly this.
