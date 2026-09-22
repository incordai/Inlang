# `footer` — block specification

**Status** draft for M2 · Companion to the `nav`, `hero` and buttons/sections specs

The footer is the block nobody reviews and everybody ships broken. Its failure
is never visual — a link that died two quarters ago, a legal page that moved, a
copyright year that is wrong every January. All three are structural and all
three have one fix: **declare it once**. `nav` reached that conclusion in its
§8; `footer` has the identical failure and resolves it identically.

---

## 1. Syntax

```
az 1

site aurora
  footer columns
    logo      ./logo.svg
    tagline   "Handmade in the dark."
    group "Shop"
      link "Shoes"  /shoes
      link "Bags"   /bags
    group "Studio"
      link "About"    /about
      link "Call us"  tel:+50412345678
    social "Field notes"  https://journal.aurora.test
    legal  "Privacy"  /privacy
    copyright "Aurora Studio"
    since     2019

page /checkout
  footer minimal          # override: no IA to escape into mid-purchase

page /privacy           # the legal link's page — an internal link must name one (§11)
```

**Variants are mutually exclusive:** `minimal` `columns` `mega`. Two is a
compile error — `footer minimal columns` must fail loudly, not silently pick
one. Default is `minimal`. **Modifiers stack freely:** `glass`. `group`,
`link`, `social` and `legal` are slots, not properties — they repeat.

---

## 2. Choosing a variant

Decided by **how much navigation the site has**, not by how impressive the
footer real estate looks:

| Variant | Use when | Watch out for |
|---|---|---|
| `minimal` | one-page sites, portfolios, campaigns, checkout | invisible by design — hides real IA if the site has any |
| `columns` | 2–5 link groups; the honest default for a marketing site | empty-column syndrome: three groups of two links reads as padding |
| `mega` | multi-product companies with locale, status, legal surfaces | the largest link-rot surface in the product; it needs an owner |

**Default to `minimal`.** A footer earns width by having content and most sites
do not have it. `mega` looks like a serious company and behaves like a
maintenance liability — every link in it is one somebody must re-check.
**Link budget: 24 total, 8 per group**; past that the footer is a sitemap, and a
sitemap is a page. `mega` needs ≥4 groups or it is `columns` wearing a bigger
word — the argument nav makes for its own `mega`.

---

## 3. Where `footer` is declared — the stale-link problem

> **Recommendation: `footer` is declared once at site level and inherited by
> every page. A page may override it. This mirrors `nav` §8 exactly.**

```
site aurora
  footer columns      # declared once
page /                # inherits
page /embed
  footer none         # opts out entirely
```

Repeating the footer per page is how the link list drifts: `/pricing` is
renamed, four of nine page files are updated, the other five point at a 404
until a customer reports it. Site-level declaration makes that bug
**unrepresentable** — worth more than any runtime link checker.

Three rules make inheritance safe:

1. **Override replaces, never merges.** Merge semantics ("this page adds one
   link") produce a footer no single file describes — the bug we just removed.
2. **`footer none` is explicit.** Embeds legitimately have none, and silent
   absence must not look like a forgotten declaration.
3. **Internal `link` destinations resolve against the page graph at compile
   time.** A `/pricing` no `page` declares is a build error, not a runtime 404 —
   the stale-link bug caught at the only moment it is cheap.

---

## 4. The copyright line and the year

The year is a determinism trap. CONVENTIONS §6 requires `az build` twice to
produce **byte-identical** files, and it is a test. A footer stamping
`getFullYear()` at emit time breaks it the first time a build crosses midnight
on 31 December — *silently*, because every build inside one year agrees.
**The build clock is never read. No exception.**

| `year` | Emits | Determinism | Use when |
|---|---|---|---|
| `none` *(default)* | `© Aurora Studio` | trivial | almost always |
| `since` | `© 2019 Aurora Studio` | the literal from `since` | a founding date belongs on the page |
| `dynamic` | `© <span data-year>2019</span> Aurora Studio` | the emitted *fallback* is the `since` literal; the rolling year is written by the client at runtime | a legal team asked for it |

**Default to `none`.** A year in a copyright notice grants nothing — copyright
subsists from creation and the notice is a courtesy. The rolling year is a
convention, and the only reason this trap exists. `dynamic` requires `since`, so
the pre-script markup is never empty and the line does not reflow when the
script runs; that script is inline, three statements, no dependency, and the
only runtime clock read in the block.

**Copyright is not the legal nav.** `copyright` is one string, the entity name.
`legal` links are a separate slot rendered as a list — they are destinations,
and the copyright is a sentence.

---

## 5. The `<footer>` landmark and the second `<nav>`

**`<footer>` maps to the `contentinfo` landmark only as a direct child of
`<body>`.** Nested in `<article>`, `<section>`, `<main>` or `<aside>` it is a
generic footer with no landmark role at all, so the emitter places the block as
a body-level sibling of `<main>`. This is the commonest way the landmark is
lost and it is invisible until an audit. **One `contentinfo` per page** — two
`footer` blocks is an error, the same shape as `hero` owning `<h1>`.

**The second `<nav>` must be labelled.** `nav` §7 already labels the main
navigation; once the footer emits links the page has two `<nav>` landmarks and
role alone no longer distinguishes them.

- Footer links live in **one** `<nav aria-label="Footer">`, not one per column.
  Six columns must not become six landmarks — the landmark list is a navigation
  surface and padding it is a real regression.
- Column headings are `<h2>` inside that nav; each column's `<ul>` points at its
  heading with `aria-labelledby`. Structure without extra landmarks.
- `minimal` with ≤3 links emits **no** `<nav>` — a bare `<ul>`.
- `legal` links sit outside the footer nav, in the copyright row: they are not
  site navigation.
- `aria-current="page"` applies here too: the current page is still current.

---

## 6. Social and contact links

The footer is where `tel:`, `mailto:` and off-site links collect, so it leans
hardest on the intent auto-detection in buttons-and-sections §1.3. **`footer`
declares no intent** — it hands each destination to the primitive:

| Written | Detected | Emitted |
|---|---|---|
| `link "Call us" tel:+504…` | `call` | `<a href="tel:">`, phone icon, tap-to-call |
| `link "Contact" mailto:…` | `mail` | `<a href="mailto:">`, mail icon |
| `social "Field notes" https://…` | `external` | `target="_blank" rel="noopener noreferrer"`, arrow icon |
| `link "Press kit" ./press.zip` | `download` | `download` attr, size label |

**No third-party marks ship with the word.** The compiler carries no library of
platform logos — a trademark and vendor-name surface (CONVENTIONS §5) for a
decorative glyph. `social` renders its label as text; an author wanting a mark
supplies it (`icon ./marks/notes.svg`). The `<a>` takes its accessible name from
the label either way, so an icon-only rendering is still a labelled link.

**Social links are not a hierarchy.** All `link` level — never `primary`, never
filled. A filled button in a footer competes with the page's real CTA and wins.

---

## 7. Layout and spacing

Tokens only, no literals (CONVENTIONS §4):

```
footer padding          space.128 top, space.64 bottom
column gap              space.32         columns / mega
group heading → list    space.12
link → link             space.8          tap targets do the rest
link rows → legal row   space.32  + a hairline rule in color.border
```

- **The gap above the footer is the biggest gap on the page.** It says the
  content has ended; undersizing it is why footers read as amputated.
- The footer sits on `color.surface` — a tonal step, not a slab of pure black
  or white. `mega` may take a second, deeper step for its legal row.
- Footer type is one step below body in `color.muted`, contrast still ≥4.5:1.
  "Small and grey" is a style; "small, grey and failing contrast" is the block's
  most common accessibility bug.
- `glass` over a flat final section is a no-op with a paint cost — the compiler
  says so, as `nav` does for `solid`.

---

## 8. Responsive behaviour

| Variant | <768px |
|---|---|
| `minimal` | unchanged; logo, tagline and legal row stack centred |
| `columns` | **collapses to one column**, groups in source order, headings kept |
| `mega` | **collapses to one column**; groups become `<details>` accordions, all closed except the first |

The `mega` accordion is the only interactivity a footer earns, and it brings the
whole disclosure contract: a real `<summary>` (focusable and keyboard-operable
for free), no height animation, and the open state **not** persisted — a footer
that remembers which column you opened is surprising. Never collapse `columns`
to two-across at phone width: two columns of short links at 390px produce a
ragged block with more whitespace than content.

---

## 9. Accessibility floor

- `<footer>` is a **direct child of `<body>`** — otherwise there is no landmark,
  and exactly one `contentinfo` per page
- links in one `<nav aria-label="Footer">`; column headings `<h2>`, each list
  tied to its heading with `aria-labelledby`
- **no `<h1>` in the footer, ever** — the hero owns it (hero §4)
- `aria-current="page"` on a link pointing at the current page
- contrast ≥4.5:1 for the muted type, checked on `color.surface`, both themes
- 44×44px touch targets — footer link lists are the most commonly under-spaced
  targets on the web, because they look like text
- visible focus ring on every link, `mega` accordions included
- the logo links to `/` and carries the site name as accessible text (`nav` §7)
- `glass` is decorative; nothing may depend on the blur for contrast

---

## 10. Manifest sketch — `words/footer/word.json`

```jsonc
{
  "name": "footer",
  "version": "1.0.0",
  "kind": "block",
  "variants": ["minimal", "columns", "mega"],
  "modifiers": ["glass"],
  "props": {
    "logo":      { "type": "path", "ext": [".svg", ".png"], "maxBytes": 262144 },
    "tagline":   { "type": "string", "maxWords": 14 },
    "copyright": { "type": "string", "maxWords": 8 },
    "since":     { "type": "int", "min": 1990, "max": 2100 },
    "year":      { "type": "enum", "values": ["none", "since", "dynamic"], "default": "none" }
  },
  "slots": { "group": { "max": 5 }, "link": { "max": 24 }, "social": { "max": 6 }, "legal": { "max": 4 } },
  "requires": { "columns": ["group"], "mega": ["group"], "dynamic": ["since"] },
  "themeReads": ["color.surface", "color.muted", "color.border", "color.text",
                 "space.*", "type.body", "type.size.sm", "radius.sm"],
  "deps": {},
  "targets": ["web"],
  "tested": {
    "browsers": ["chrome-latest", "safari-latest", "firefox-latest", "ios-17"],
    "with": ["nav", "hero"]
  }
}
```

`deps` is empty and stays empty — a footer needing a runtime dependency has
stopped being a footer. `requires` is keyed by variant **and** by value (§12.2).

---

## 11. Compiler validations

| Check | Severity | Message |
|---|---|---|
| two variants | error | `footer: 'minimal' and 'columns' are both layouts — pick one` |
| second footer on a page | error | `footer: only one per page (it owns the contentinfo landmark)` |
| internal link with no matching page | error | `footer: '/pricing' is not a page in this site — add it or fix the link` |
| `year dynamic` without `since` | error | `footer: 'dynamic' needs a fallback year — add: since 2019` |
| `<h1>` inside the footer | error | `footer: an '<h1>' in the footer conflicts with the hero — use a group heading` |
| `mega` with <4 groups | warning | `footer: 'mega' has 2 groups — use 'columns'` |
| >24 links total | warning | `footer: 31 links, max is 24 — this is a sitemap, move it to a page` |
| group with 1 link | warning | `footer: group 'Legal' has 1 link — fold it into the legal row` |
| `glass` over a flat section | warning | `footer: 'glass' has nothing to blur — the section above it is flat` |
| social styled as primary | warning | `footer: 'Field notes' is a filled button in a footer — social links are text links` |
| link label > 3 words | warning | `footer: 'Read our privacy policy' — footer labels should be 1–3 words` |
| identical footer declared on ≥3 pages | warning | `footer: the same footer is declared on 4 pages — move it to 'site' and inherit` |

That last one is this document in one diagnostic: the compiler can *see* the
duplication that causes stale links, and saying so costs less than any checker.

---

## 12. Open questions

1. **Is `mega` a real variant or a `/sitemap` in disguise?** *(Recommend: keep
   for M2 behind the ≥4-group check; if the dogfood site skips it, cut it.)*
2. **`requires` is currently keyed by modifier** (ARCHITECTURE §4.1,
   `{"3d": ["model"]}`); footer needs it keyed by variant and by enum value.
   *(Recommend: widen the key space to "any declared token" in §4.1 rather than
   inventing a second field.)*
3. **Does `footer none` belong to `footer` or to `page`?** *(Recommend:
   `footer`, as a bare opt-out token — `page` growing negation syntax per
   inheritable block is how the grammar starts leaking.)*
4. **Should the page-graph link check extend to external URLs?** *(Recommend:
   no — that is a network call and principle 1 forbids it. It is `az audit`'s.)*
5. **Mobile-app target:** a footer has no native analogue — the tab bar took the
   navigation, Settings took the legal links. *(Leaning: emit only the legal
   links, under Settings. Decide in the M2 mobile-vocabulary work alongside
   nav's tab-bar mapping.)*
