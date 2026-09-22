# `nav` — block specification

**Status** draft for M2 · Companion to the `hero` and buttons/sections specs

Nav looks like a row of links. It is actually a **dialog, a scroll listener and
a focus manager**. It has more hidden complexity than any other block, and more
of that complexity is invisible until an audit.

---

## 1. Syntax

```
az 1

nav split sticky solid
  logo   ./logo.svg
  link   "Work"   /work
  link   "Studio" /studio
  group  "Products"
    link "Shoes"  /shoes
    link "Bags"   /bags
  cta    "Reserve" /reserve
  mobile drawer
```

**Layout modifiers are mutually exclusive:** `bar` `center` `split` `minimal`
`side` `mega`. Two = compile error. Default is `bar`.

**Behaviour modifiers stack:** `sticky` `hide` `shrink` `glass` `solid`.

---

## 2. Choosing a layout

| Variant | Use when | Watch out for |
|---|---|---|
| `bar` | default; logo left, links right | reads generic — earn distinction elsewhere |
| `center` | editorial, fashion, symmetric brands | breaks with >4 links; odd numbers look wrong |
| `split` | you have a real CTA to protect | three zones need genuine content in each |
| `minimal` | portfolio, agency; menu button at all sizes | one extra click to *everything* — only for small sites |
| `side` | docs, apps, deep hierarchies | eats 240–280px of width; never on marketing pages |
| `mega` | multi-product companies | biggest a11y cost in this doc; needs ≥2 groups or it's a dropdown |

**Link count: 5–7 top-level, maximum.** Past that you don't need `mega`, you
need better information architecture. The compiler should warn, not silently
wrap.

---

## 3. Behaviour modifiers

| Modifier | Effect | Note |
|---|---|---|
| `sticky` | pinned to top | requires `scroll-padding-top` — see §5 |
| `hide` | hides scrolling down, reveals scrolling up | reclaims space; must be instant under reduced-motion |
| `shrink` | reduces height/logo past a threshold | **reserve final height up front or you cause CLS** |
| `glass` | backdrop blur once scrolled | needs a fallback — blur is expensive on low-end Android |
| `solid` | transparent at top, solid after scroll | for `full`/`3d` heroes. See §4 |

---

## 4. The transparent-over-hero problem

This is where nav most often looks broken on real sites.

A nav sitting over a full-bleed hero must be transparent at the top, then turn
solid on scroll. Three things go wrong:

1. **Contrast fails against the image.** A light logo over a bright sky is
   invisible. Fix: a top scrim gradient (`rgba(0,0,0,.35)` → transparent, ~120px),
   *not* a flat overlay — flat dims the whole image.
2. **The logo needs two versions.** Light-on-transparent and dark-on-solid. The
   compiler should accept `logo ./logo.svg` plus optional `inverse ./logo-w.svg`
   and warn when `solid` is used without one.
3. **The switch must be hysteretic.** Toggling at exactly one scroll position
   makes the nav flicker when a user hovers at the threshold. Use separate
   thresholds — solid at 80px down, transparent again at 40px up.

`solid` on a page without a `full` or `3d` hero does nothing. Warn about it.

---

## 5. Sticky nav and anchor links — the universal bug

```css
html { scroll-padding-top: calc(var(--nav-height) + 16px); }
```

Without this, every anchor link (`/#pricing`, and every docs TOC entry) scrolls
the target heading **underneath** the sticky nav. It's one line, it's missed on
most hand-built sites, and it's exactly the kind of thing a tested template
should get right for free.

Also: nav height must be a **CSS variable**, because `hero` height, scroll
padding, and the mobile drawer offset all depend on it. Hardcoding it in three
places is how they drift apart.

---

## 6. Mobile

| Pattern | Behaviour | Use when |
|---|---|---|
| `drawer` | slides from the side | default; most links |
| `sheet` | rises from the bottom | thumb-reachable, app-like |
| `full` | fullscreen overlay | few links, dramatic brands |

**The mobile menu is a dialog.** All of the following, or it's not done:

- **Focus trap** while open — Tab cycles inside the menu only
- **Return focus to the toggle button** on close, not to `<body>`
- **Escape closes.** Click/tap outside closes
- **Scroll lock on the body** while open — and iOS needs `position: fixed` with
  a restored offset, or the page silently scrolls behind the overlay
- `aria-expanded` on the toggle, `aria-controls` pointing at the panel
- Animate `transform`, never `left`/`width` — the latter cause layout thrash
- Toggle is a `<button>`, never a `<div>` with an onclick

**The CTA stays visible in the collapsed bar**, not buried in the drawer. If
it's worth a nav CTA, it's worth being reachable without a tap.

---

## 7. Accessibility floor

- **Skip link is the first focusable element** — "Skip to content", visually
  hidden until focused. Nav owns this; no other block does.
- `<nav>` landmark with `aria-label` (needed when a page has two, e.g. `side`
  plus footer nav)
- `aria-current="page"` on the active link — visual highlight alone doesn't
  reach screen readers
- **Dropdowns and `mega`:** arrow-key navigation, Escape closes and returns
  focus, roving `tabindex`. Hover-only dropdowns are a keyboard dead end
- Logo links to `/` and carries the site name as accessible text — an `<img>`
  with empty alt inside a link is an unlabelled link
- 44×44px touch targets, including the menu toggle
- Contrast checked in **both** transparent and solid states

---

## 8. Where `nav` is declared

> **Recommendation: `nav` is declared once at site level and inherited by every
> page. A page may override it.**

```
site aurora
  nav split sticky
    link "Work" /work

page /            # inherits
page /docs
  nav side        # overrides — docs get a sidebar
```

Repeating nav in every page file is how the link list drifts out of sync — the
classic stale-footer bug, one level up.

---

## 9. Compiler validations

| Check | Message |
|---|---|
| two layout modifiers | `nav: 'bar' and 'side' are both layouts — pick one` |
| >7 top-level links | `nav: 9 links. Max 7 — group them or simplify the IA` |
| `mega` with <2 groups | `nav: 'mega' needs 2+ groups. Use a plain dropdown` |
| >1 CTA | `nav: 2 CTAs. Nav gets one` |
| `solid` without full/3d hero | `nav: 'solid' has no effect — the hero isn't full-bleed` |
| `solid` without light logo | `nav: 'solid' needs a light logo variant. Add: inverse ./logo-w.svg` |
| `side` on a page with a hero | `nav: 'side' with a hero is unusual — 'side' is for docs` |
| link label > 2 words | `nav: "Our latest work" — nav labels should be 1–2 words` |

---

## 10. Open questions

1. Does `nav` own the skip link, or does `page`? *(Recommend: `nav`, since it's
   the first element — but it must still emit when a page has no nav.)*
2. Is `side` really a nav variant, or a **page layout** that happens to contain
   a nav? Docs pages need the sidebar to affect content width, which is beyond
   what a block should control. *(Leaning: page layout. Decide before `docs`.)*
3. Does `mega` earn Phase 2 at all? It carries the highest a11y cost of anything
   here and serves the fewest users.
4. Mobile-app target: nav maps to a tab bar, not a drawer — different enough
   that it may need its own vocabulary in the M2 mobile work.

---

## 11. Manifest

Per ARCHITECTURE §4.1. Source of truth for the graph, autocomplete, lint and
validation.

```jsonc
{
  "name": "nav",
  "version": "1.0.0",
  "kind": "block",
  "variants": ["bar", "center", "split", "minimal", "side", "mega", "none"],
  "modifiers": ["sticky", "hide", "shrink", "glass", "solid"],
  "props": {
    "logo":       { "type": "path", "ext": [".svg", ".png", ".webp"] },
    "inverse": { "type": "path", "ext": [".svg", ".png", ".webp"] },
    "mobile":     { "type": "enum", "values": ["drawer", "sheet", "full"], "default": "drawer" }
  },
  "children": ["link", "group", "cta"],
  "limits": { "link": { "max": 7 }, "cta": { "max": 1 }, "depth": 2 },
  "requires": { "solid": ["inverse"] },
  "themeReads": [
    "color.bg", "color.surface", "color.text", "color.muted",
    "color.accent", "color.accent-contrast", "color.scrim", "color.on-scrim",
    "space.*", "type.body", "motion.*", "size.ring",
    "layer.sticky", "layer.dropdown", "layer.scrim", "layer.skip",
    "size.nav", "size.nav-shrink", "size.tap"
  ],
  "deps": { "@floating-ui/react": "0.26.28" },
  "targets": ["web"],
  "tested": {
    "browsers": ["chrome-latest", "safari-latest", "firefox-latest", "ios-17"],
    "with": ["hero", "footer"]
  }
}
```

**`children` and `limits` are why `nav` needs manifest fields no other Phase-1
block uses.** It is the only block with nested children (`group`, per GRAMMAR
§3.3), so `depth: 2` is what stops a submenu inside a submenu — §2's warning
about information architecture, enforced rather than advised.

**`size.nav` is read, not written.** §5 requires nav height to be a
single CSS variable because `hero` height, `scroll-padding-top` and the mobile
drawer offset all derive from it. It is a theme token so that all four read one
value; a nav that hardcodes its own height breaks anchor links site-wide.

`@floating-ui/react` is required only by `group` (dropdown positioning) and by
`mega`. A `nav bar` with no `group` must not pull it into the bundle — see
overlays-spec §1 for why hand-rolling the positioning maths is the wrong trade.
**Version pin is UNVERIFIED** — confirm the current stable release before M2
rather than trusting this number (CONVENTIONS §7, and see `stack-evaluation.md`).
