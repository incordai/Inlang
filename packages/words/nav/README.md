# `nav`

The site navigation: logo, links, dropdown groups and one call to action, with a mobile menu. Usually declared once at site level; `nav none` removes it from a page.

Full specification: [`docs/nav-block-spec.md`](../../../docs/nav-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora
  nav split sticky solid
    logo    ./preview-assets/assets/logo.svg
    inverse ./preview-assets/assets/logo-w.svg
    link   "Work"   /work
    link   "Studio" /studio
    group  "Products"
      link "Shoes"  /shoes
      link "Bags"   /bags
    cta    "Reserve" /reserve

page /
  hero full
    title "Built in the dark"

page /work

page /studio

page /shoes

page /bags

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

- Built and checked in a browser by `pnpm test:visual`: the mobile menu is a drawer (§6 — focus trapped, Escape and outside-click close, focus returns to the toggle, page scroll locked), links collapse into it below sm; every bar `group` is a dropdown (arrow keys, roving tabindex, Escape, Tab leaves it); `solid` turns solid past 80px and back above 40px with the logo swap (§4); the skip link shows on focus (§7)
- Not built: the `hide` and `shrink` scroll modifiers, and §5's `scroll-padding-top` from the nav height

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Word-specific: `nav-footer.test.ts`, `nav-inverse.test.ts`
- `scripts/verify-build.mjs` compiles the GRAMMAR §8 fixture, which includes this word, builds it with the real toolchain and checks the server-rendered HTML

**Browser-tested** by `pnpm test:visual` (in CI) on this word's `preview.az`, in all three themes, light and dark: Chromium 153 runs every browser check — overflow at 390/768/1440px, axe, keyboard reachability and focus indicator, reduced motion, and that the schemes differ; Firefox 155 and WebKit 26.6 run overflow and page errors at one width each. Not tested: real Safari or iOS devices, and nav + footer combined in a browser (that combination is only server-rendered, by `verify-build`). The manifest's `tested` field records exactly this.
