# `footer`

The site footer: logo, tagline, link groups, social and legal links, and the copyright line. Usually declared once at site level and inherited by every page.

Full specification: [`docs/footer-block-spec.md`](../../../docs/footer-block-spec.md). This page summarises it; the spec is authoritative.

## Example

[`preview.az`](preview.az), the default variant:

```
az 1

site aurora
  footer minimal
    tagline   "Handmade in the dark."
    link      "About"   /about
    link      "Contact" /contact
    legal     "Privacy" /privacy
    copyright "Aurora Studio"

page /

page /about

page /contact

page /privacy
```

## Variants

Pick one. The first is the default.

| Variant | Use when |
|---|---|
| `minimal` | one-page sites, portfolios, campaigns, checkout |
| `columns` | 2–5 link groups; the honest default for a marketing site |
| `mega` | multi-product sites with locale, status and legal surfaces |

## Modifiers

Combine freely.

| Modifier | Effect |
|---|---|
| `glass` | decorative frosted surface; contrast never depends on it |

## Properties

| Property | Type | Values | Default | Constraints | Meaning |
|---|---|---|---|---|---|
| `logo` | path |  |  | .svg, .png | the site logo, linking to `/` |
| `tagline` | string |  |  | ≤ 14 words | one short line |
| `copyright` | string |  |  | ≤ 8 words | the copyright holder |
| `since` | int |  |  | 1990–2100 | first year of the copyright range |
| `year` | enum | `none` / `since` / `dynamic` | `none` |  | `none`, `since` or `dynamic`: how the year is shown |

Rules: `columns` requires `group`; `mega` requires `group`; `dynamic` requires `since`.

## Children

- `group`: a titled link column (max 5)
- `link`: a plain link (max 24)
- `social`: a social or contact link (max 6)
- `legal`: a legal link (max 4)

## Accessibility

- A `<footer>` landmark; links in one `<nav aria-label="Footer">`
- Never an `<h1>` in the footer
- The logo link carries the site name as accessible text
- 44×44px targets and a visible focus ring on every link

The full floor is in the spec.

## Status

Every variant renders distinctly. Properties not yet implemented (`pnpm coverage`):

- none — every declared property changes the output

Known gaps:

- Phone and tablet layouts from the spec's responsive table are not implemented for any word yet: the web target emits inline styles only, with no media queries.

## Tested

What is automated today:

- `packages/words/test/props.test.ts`, `variants.test.ts`, `structure.test.ts` and `conformance.test.ts` run every word: each property changes the output, each variant renders differently, lists are valid HTML, and the emitter reads only declared properties
- `words.test.ts` runs the theme lint over the emitter (also `az lint`)
- Word-specific: `nav-footer.test.ts`
- `scripts/verify-build.mjs` compiles the GRAMMAR §8 fixture, which includes this word, builds it with the real toolchain and checks the server-rendered HTML

**Not yet tested:** no browser, visual, keyboard or axe run has been made for this word (quality-gate items 3–7). The manifest's `tested` field lists browsers, but those runs have not happened; treat it as a target, not a result.
