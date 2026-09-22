# `pricing` — block specification

**Status** draft for M2 · Companion to the `hero`, `nav` and buttons/sections specs

Pricing is the page where a visitor decides. It is also the only Phase-1 block
carrying **persistent state** (the billing period) and **tabular data** — both
places where hand-built sites quietly fail an audit.

---

## 1. Syntax

```
az 1

pricing cards reveal
  title    "Simple pricing"
  currency usd
  period   "per seat, per month"
  plan "Studio"
    monthly 29
    annual  290
    feature "Projects"      "10"
    cta     "Start with Studio" /signup/studio
  plan "Practice"
    highlight on
    badge   "Most popular"
    monthly 79
    annual  790
    cta     "Start with Practice" /signup/practice
```

**Variants are mutually exclusive:** `cards` `table`. Two is a compile error —
`pricing cards table` must fail loudly. Default is `cards`.

**Modifiers combine freely:** `reveal`.

## 2. Choosing a variant

| Variant | Use when | Watch out for |
|---|---|---|
| `cards` | 2–4 plans differing by **degree** — more seats, more projects. The visitor picks by size | ragged cards: unequal feature counts make the row look broken |
| `table` | plans differ by **kind** — different capabilities, not bigger numbers — and the visitor genuinely has to compare | it is a data table, and a data table at 390px is the hard problem of this spec (§6) |

**Default to `cards`.** `table` looks thorough and converts worse: a matrix asks
the visitor to do the comparison you should have done for them — reach for it
only when a row is a real capability boundary. **Two to four plans:** one needs a
`cta`, not this block; five means you have not decided who you are for.

## 3. Layout, measure and spacing

Theme scale only, no off-scale px, no hex (CONVENTIONS §4); outer container as
`hero` §3.

| Element | Rule |
|---|---|
| `cards` columns | one per plan; 4 plans fall to a 2×2 grid at ≤1100px before the mobile stack |
| Card measure | 28–36ch. Wider and the feature list reads as prose, not a list |
| `table` first column | 22–30% — feature names anchor the row and must not wrap to three lines |
| Gap between cards | one step larger than the card's internal padding, or the cards fuse into a single bar |
| Surfaces | card on `color.surface` over the page's `color.bg`; the highlighted plan on `color.surface-alt`; card edge `color.border` |

```
plan name → price  space.12    period → features  space.24
price → period     space.4     feature → feature  space.8
features → cta     space.32    ← largest internal gap
```

The gap above the CTA is the biggest for the same reason as `hero` §7: it
separates *what this is* from *what to do*. **Every card is the same height and
the CTAs sit on a shared baseline** — grid `align-items: stretch`, CTA pushed by
`margin-top: auto`. Buttons at four different heights is the clearest tell of a
generated pricing section.

## 4. Type rules

Theme defaults apply, with three deltas:

- **`font-variant-numeric: tabular-nums` on prices.** Not cosmetic: the toggle
  swaps `29` for `24`, and proportional digits change the card's width
  mid-interaction.
- **The price is not display type.** Large — about two steps above body — but on
  body tracking, not `hero`'s negative tracking, which closes up digit pairs.
- **Currency symbol and period note sit one step down and muted**, on the
  price's baseline. A `$` at full price size makes the number look smaller.

## 5. Buttons

Buttons follow **buttons-and-sections-spec §1** without exception — hierarchy ×
intent × state, `<a>` vs `<button>`, all six states, 44×44px targets. Not
restated. `pricing` adds:

- **One `cta` per plan, required** — a plan you cannot buy is a feature list.
- **Only the highlighted plan's CTA is `primary`, the rest `secondary`.**
  Max-one-primary (buttons §1.2) is per section, and four filled buttons is four
  plans shouting at once. With no highlight, the middle plan takes it.
- **The label names the plan** — "Start with Practice", not "Choose plan" four
  times. Identical labels are identical links in a screen reader's link list.

## 6. Responsive behaviour

| Variant | <768px |
|---|---|
| `cards` | one column, full width, in declared order — **except the highlighted plan, which moves first** (§7.3). Cards keep their padding; do not compress to a dense list |
| `table` | **transposes to stacked per-plan panels.** One panel per plan, each row a `label / value` pair. No horizontal scroll, no sticky first column |

### The comparison table on a phone

buttons-and-sections §2 flags horizontal scroll as the hard part of `compare`.
It is the hard part here too, and the answer is **not to scroll**.

At 390px a sticky 140px first column leaves 250px for the plans — 83px each
across three, narrower than the word "unlimited". The visitor sees one and a
half columns and a scrollbar, which is the one layout where comparison is
*impossible*: you cannot compare two things you cannot see at once. A sticky
column makes that failure look deliberate; it does not fix it.

So `table` transposes: each plan becomes a panel with its name as an `<h3>`, its
price, and every row as a label/value pair. Reading order becomes plan-major —
which is how people read pricing on a phone anyway.

Consequences, stated rather than hidden:
- **Cross-plan comparison is lost below 768px** — cheaper than a 1.5-column
  scroller. If phone-width comparison is genuinely required the content is
  wrong: cut to the three rows that differ and use `cards`.
- Rows identical in every plan **collapse into a shared "in every plan" list**
  at all widths — four identical ticks is noise on desktop and four panels of
  wasted scroll on mobile.
- Where a scroller does survive (768–1024px) its container needs `tabindex="0"`,
  `role="region"` and an `aria-label` — a scrollable region a keyboard cannot
  scroll is a WCAG 2.1.1 failure, and hand-built tables miss it.

## 7. The hard parts

### 7.1 The billing toggle is state — and it lives in the URL

The only Phase-1 block state that survives a page load, so it gets one source of
truth: **the query string, `?billing=annual`**, defaulting to the `billing` prop.

- Toggling writes with `history.replaceState`, never `pushState` — Back should
  leave the page, not walk the visitor through four toggles.
- **Query param, not fragment.** The fragment is reserved for anchor targets and
  `scroll-padding-top` (nav §5); `#annual` would switch *and* scroll.
- **Both price sets ship in the server-rendered HTML**, one behind the `hidden`
  attribute — nothing computed, nothing fetched, and the crawler sees a real
  price either way. Exactly the property ASSUMPTIONS A6 has to verify.
- **No layout shift:** tabular figures (§4) plus a `min-width` sized to the
  longer string. A card that reflows when toggled feels broken.

**Screen readers.** The control is a `role="radiogroup"` of two radios
("Monthly", "Annual") under a visible "Billing period" legend — *not*
`role="switch"`, which is on/off with an unnamed off state, and "Annual: off"
says nothing about what you get instead. On change, one visually-hidden
`aria-live="polite"` status announces the *mode*, not the numbers: `"showing
annual pricing, billed yearly"` — four changed prices is four interruptions.

### 7.2 Prices are declared, never computed — and currency is formatting

PRD principle 7 forbids expressions in `.az`, so there is **no way to express
"annual is monthly × 10"** and the compiler must not grow one.

- `monthly 29` and `annual 290` are independent declarations. The annual figure
  is whatever the business decided, which is rarely a round multiple anyway.
- The saving is a **declared string**: `save "2 months free"`. The compiler never
  renders "save 17%" because it cannot calculate it and must not appear to. Want
  a percentage? Type it — it is your number. Showing annual as a per-month
  equivalent likewise means declaring that number: one more line, zero magic.
- A plan may carry a **string price** — `monthly "Custom"` — exempt from the
  toggle, rendering no currency symbol.
- **`annual` is all-or-nothing across plans.** Some with, some without, and the
  toggle blanks half the row. Error, not warning.

`currency USD` (ISO 4217) with `locale en-US`. Symbol, position, grouping and
decimals come from `Intl.NumberFormat` at **emit time**, so the output is a
static string and the byte-identical-build rule (CONVENTIONS §6) holds.
Formatting is not arithmetic — no value changes, only its presentation — so
principle 7 holds. The compiler never converts currencies and never shows two at
once; multi-currency belongs to i18n (buttons-and-sections §5).

**The payment or billing service is never named in the block.** The CTA points at
a route the author owns; whatever processes the payment lives behind it, out of
the compiled source (CONVENTIONS §2, neutral naming).

### 7.3 The highlighted plan

`highlight on` marks one plan, `badge "Most popular"` labels it. Two is an error.

- The badge is **real text in the flow** — a `<p>` before the plan name — not
  `::before` content, which is inconsistently announced and cannot be selected.
- It must survive without colour: border weight **and** the badge text, never
  colour alone — a colour-only "most popular" is invisible to roughly one
  visitor in twelve. That border is **`color.accent`, not `color.border`**,
  which is a decorative hairline capped at 1.90:1 with no floor by design (§8).
- **On mobile the highlighted plan moves to the top of the stack.** Use grid
  `order` so DOM order, tab order and screen-reader order all match.

### 7.4 Feature lists

One prop, two renderings, so intent is written once:

```
feature "Team seats" "15"    → cards "Team seats · 15"  ·  table cell "15"
feature "Custom domain" yes  → cards ticked line        ·  table tick cell
```

- `table` column order is the **union of labels in first-declared order**. No
  positional cells — "the third value fills the third column" breaks silently
  the moment someone inserts a row.
- A label one plan declares and another omits renders "not included" **and
  warns** — silence is the wrong default in a matrix.
- **A tick is not accessible text.** Every boolean cell carries visually-hidden
  "included" / "not included". A bare ✓ is announced as "check mark" at best.
  The tick is `color.accent` and an excluded row `color.muted` — the theme has
  no semantic green, deliberately (§11).
- Explaining a feature uses the `popover` preset from **overlays-spec §2**, never
  a second overlay. Not `tooltip`: hover-only content is invisible on touch.

## 8. Accessibility floor

- **`<h2>` for `title`, `<h3>` per plan name. Never `<h1>`** — `hero` §4 owns the
  page's only one. The outline stays valid because the block emits exactly two
  levels and skips none; badge, price and period note are `<p>`.
- `table` emits a real `<table>` with `<caption>`, `<th scope="col">` per plan
  and `<th scope="row">` per feature — a grid of `<div>`s reads "15" with no
  indication of which plan. Each `cards` plan is an `<article>` labelled by its
  `<h3>`, so the rotor lists three plans, not one wall of text.
- Toggle: keyboard reachable, arrow keys within the radio group, a visible
  `:focus-visible` ring in `color.focus`, 44×44px including padding.
- Contrast ≥ 4.5:1 for prices and feature text in both themes (gate item 7). The
  `color.accent` highlight border (§7.3) clears the 3:1 non-text floor (WCAG
  1.4.11) with room to spare: across all three themes × both schemes the worst
  case is **5.16:1** — accent on `color.surface-alt`, paper dark — and the best
  11.57:1 (theme-spec §6). That ~1.7× headroom survives an accent retune.
- **The price is text**, read as a number inside the plan's labelled region —
  that is what makes the `<article>` labelling above testable rather than
  decorative. Never an image, never `aria-hidden` decoration: a price baked
  into an SVG is unreadable, unselectable and untranslatable.
- `reveal` suppressed entirely under `prefers-reduced-motion`; every price
  readable with JS disabled.

## 9. Compiler validations

Format per CONVENTIONS §5. Errors block the build; taste warnings never do.

| Check | Message |
|---|---|
| two variants | `pricing: 'cards' and 'table' are both layouts — pick one` |
| no plans | `pricing: no plans declared — add: plan "Studio"` |
| plan with no cta | `pricing: plan 'Atelier' has no cta — add: cta "Talk to us" /contact` |
| two highlights | `pricing: 'Studio' and 'Practice' are both highlighted — highlight one` |
| `annual` on some plans only | `pricing: 'Studio' has an annual price and 'Atelier' does not — declare annual on every plan or none` |
| numeric prices, no currency | `pricing: numeric prices need a currency — add: currency USD` |
| arithmetic in a price | `pricing: 'monthly 29*10' is an expression — declare the number: annual 290` |
| `billing annual`, no annual prices | `pricing: 'billing annual' but no plan declares one — add: annual 290` |
| a feature repeated in every plan (warning) | `pricing: every plan includes 'Custom domain' — move it to the shared list` |
| ≥5 plans (warning) | `pricing: 5 plans, 4 is the practical maximum — merge two or move the detail into 'table'` |
| >7 features on a card (warning) | `pricing: 'Practice' lists 11 features, 7 is the readable maximum — trim or switch to 'table'` |
| weak or repeated CTA labels (warning) | `pricing: 3 plans all say "Choose plan" — name the plan in the label, as in "Start with Practice"` |

## 10. `word.json`

```jsonc
{
  "name": "pricing", "version": "1.0.0", "kind": "block",
  "variants": ["cards", "table"], "modifiers": ["reveal"],
  "props": {
    "title":    { "type": "string", "required": true, "maxWords": 8 },
    "sub":      { "type": "string", "maxWords": 24 },
    "currency": { "type": "enum", "values": "iso4217" },
    "locale":   { "type": "string", "default": "en-US" },
    "billing":  { "type": "enum", "values": ["monthly","annual"], "default": "monthly" },
    "period":   { "type": "string", "maxWords": 6 }
  },
  "slots": { "plan": { "min": 1, "max": 4 } },
  "requires": {},
  "themeReads": ["color.accent","color.accent-contrast","color.surface",
                 "color.surface-alt","color.text","color.muted","color.border",
                 "color.focus","space.*","radius.md","radius.lg","type.body"],
  "deps": {},
  "targets": ["web"],
  "tested": { "browsers": ["chrome-latest","safari-latest","firefox-latest","ios-17"],
              "with": ["nav","hero","footer"] }
}
```

`deps` is empty and stays so: the toggle is a radio group and a `hidden`
attribute, the transpose a media query — which is how the block stays inside the
bundle budget (gate 9). The taste warnings above are the point: a compiler that
tells you your pricing table does nothing for the visitor does what no generator
does.

## 11. Open questions

1. **§4.1 cannot declare a repeatable child's props.** `plan` is a slot with its
   own `monthly`, `annual`, `feature` and `cta`, so graph, autocomplete and lint
   are blind inside it. *(Recommend: a `slotProps` map in the manifest schema;
   `faq` needs the same for `item` — a core change, not a word-level workaround.)*
2. **Does `table` deserve to be its own word (`compare`)?** buttons-and-sections
   §2 lists it separately already. *(Recommend: keep it a variant through M5.)*
3. Mobile-app target: `table` has no honest phone rendering, so `pricing` maps
   to `cards` only. Decide in M2 whether that errors or silently downgrades.
4. **"Included" has no colour of its own.** theme-spec §1.2 deliberately has no
   `color.success`, so ticks use `color.accent` and excluded rows `color.muted`
   (§7.4). *(Recommend: leave it — this block and `auth`'s confirmation are the
   two demands that would justify adding one, and two is the trigger.)*
