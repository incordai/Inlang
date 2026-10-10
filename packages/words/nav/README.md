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
- `mobile sheet` is a bottom sheet with a drag handle — drag it down past a quarter of its height (or 96px) to close; `mobile full` is a full-screen menu that fades in. Both are modal like the drawer (focus trapped, Escape closes, focus returns, scroll locked) and checked in three engines on `preview.sheet.az` / `preview.full.az`
- `hide` retracts the bar on a run of scrolling down and returns it on a run up, never while something in it is open or focused, instantly under reduced motion; `shrink` drops to `size.nav-shrink` past 80px (back above 40px) inside a frame that holds the full height, so nothing below moves (§3). A pinned nav (`sticky`, `hide`, `shrink`) ships §5's `scroll-padding-top` from the `--az-size-nav` variable. Checked in a browser on `preview.bar.az`

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Also exercising this word (its emitter header's `Tests`): `nav-footer.test.ts`, `nav-inverse.test.ts`, `nav-scroll.test.ts`, `behaviour-markup.test.ts`
- `scripts/verify-build.mjs` compiles the GRAMMAR §8 fixture, which includes this word, builds it with the real toolchain and checks the server-rendered HTML

**Browser-tested** by `pnpm test:visual` (in CI) on this word's `preview.az`, in all three themes, light and dark: Chromium 153 runs every browser check — overflow at 390/768/1440px, axe, keyboard reachability and focus indicator, reduced motion, and that the schemes differ; Firefox 155 and WebKit 26.6 run overflow and page errors at one width each, and the behaviour checks (menus, dropdowns, disclosures, copy, play, scroll behaviours) run in all three engines. Not tested: real Safari or iOS devices, and nav + footer combined in a browser (that combination is only server-rendered, by `verify-build`). The manifest's `tested` field records exactly this.
