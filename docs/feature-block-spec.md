# `feature` — block specification

**Status** draft for M2 · Companion to the `hero`, `nav` and buttons/sections specs

`feature` is the block that carries the argument. The hero says what this is;
`feature` says why it's worth anything. It is Tier B (buttons-and-sections §2)
because it looks like pure layout and isn't — the bento tiling, the icon
pipeline and the reveal timing are each a day on their own.

---

## 1. Syntax

```
az 1

feature grid reveal
  title   "Made properly, or not at all"
  sub     "Four things we refuse to compromise on."
  columns 3
  item "Hand-cut leather"
    text "Every panel is cut by hand from a single hide."
    icon ./icons/knife.svg
  item "Sewn, not glued"
    text "A Goodyear welt, so the sole is replaceable."
    icon ./icons/stitch.svg
    link "How we do it" /process
  item "Forty a month"
    text "The workshop holds two people. That is the ceiling."
    icon ./icons/clock.svg
  cta "See the collection" /shop
```

**Variants are mutually exclusive:** `grid` `rows` `bento`. Two = compile
error. Default is `grid`.

**Modifiers combine freely:** `reveal`.

`columns` is a property, not a positional argument. The PRD sketch
(`feature grid 3`, PRD §6.1) has no grammar rule behind it — a bare number
after a variant is not a token this language defines, and adding one would mean
every block invents its own positional meaning. It compiles as `feature grid`
plus an indented `columns 3`.

## 2. Choosing a variant

| Variant | Use when | Watch out for |
|---|---|---|
| `grid` | 3–6 peer features of equal weight; short labels | reads as a template if the items are vague nouns instead of claims |
| `rows` | each feature needs a real screenshot or photo to land | it's tall — five rows is a scroll marathon; three is usually the honest number |
| `bento` | one feature genuinely outranks the others | the tiles must hold *different amounts* of content, or it's a grid with a bug |

**Default to `grid`.** `bento` photographs beautifully and fails quietly: it
promises a hierarchy, so if your items are equally important the layout is lying
and the page feels arbitrary — use it only when you can name the lead item
without hesitating. `rows` earns its height only when the media is doing work.

## 3. Layout, measure and spacing

Every value is a theme token (theme-spec §1). The `space` scale is global and
keyed by its own px value — `space.24` *is* 24px — so there is no separate
number to quote, and a px literal that is not a key of `space` is a lint error.

| | Value |
|---|---|
| Outer container | shares the page container with `hero` — same gutters |
| Section header measure | `title` `size.measure-display` · `sub` `size.measure-body` |
| Item text measure | 32–45ch — narrower than `size.measure-body`, because grid columns are narrow |
| Column gap | `space.32` · `space.24` below `breakpoint.sm` |
| Row gap | `space.48` — always larger than the column gap |
| Header → items | `space.64` |
| Section padding block | `space.96`, `space.64` below `breakpoint.sm` |

**Row gap > column gap, always.** Equal gaps make a grid read as a lattice of
unrelated cells; a taller row gap groups each row as a row. This is the single
cheapest thing that separates a considered grid from a default one.

`grid-template-columns: repeat(var(--cols), minmax(0, 1fr))` — the `minmax(0,…)`
matters: without it one long unbroken word (a URL, a product code) blows the
track out and the whole grid overflows on mobile. Most common bug in this shape.

## 4. Type

Only what differs from the default scale:

```
section title   type.display  type.size.2xl  type.tracking.2xl  weight.display   h2
item title      type.body     type.size.lg   type.leading.tight  weight.bold     h3
item text       type.body     type.size.base type.leading.body
```

- **The item title is not a display face.** Setting item titles in the display
  font at 1.05 leading is the tell that a grid was styled by copying the hero.
  Items are body type with more weight.
- Section `title` gets `text-wrap: balance`. Item titles get it too (they are
  short). Item `text` gets `text-wrap: pretty`, never `balance` — balancing a
  paragraph is wasted work and can produce a stubby last line.
- No all-caps item titles. Caps at body size cost ~10% reading speed and buy a
  look you can get from weight instead.

## 5. CTA and links

Two levels, and they are not interchangeable:

- **Section level:** `cta` (max 1) and `alt` (max 1). Same slots, same intent
  auto-detection, same six states as buttons-and-sections §1 — not restated
  here.
- **Item level:** `link` (max 1 per item). Always the `link` hierarchy — text
  plus underline on hover. Never a filled button.

**Never put a filled button in every item.** Six primaries in a grid is six
things competing for the one decision a section may ask for
(buttons-and-sections §1.2). If every item needs its own action, this is a card
list, not a `feature`.

If an item has a `link`, the **whole tile is clickable** — but the tile is not
the link. Emit the anchor around the item title and stretch it with a
pseudo-element. A `<div onclick>` wrapper breaks middle-click, keyboard focus
and "copy link address", and is how nested-interactive violations ship.

## 6. Responsive behaviour

| Variant | <768px |
|---|---|
| `grid` | **1 column.** 2 columns only when every item is icon + a label of ≤3 words and has no `text` — then the pair reads as a spec sheet, not a squeezed grid |
| `rows` | media above text in every row. **Alternation is dropped** — in one column, alternating changes nothing visible except which items start with a photo, so it reads as inconsistent rather than rhythmic |
| `bento` | tiling collapses to a **single column in DOM order**. The `lead` item keeps a taller aspect ratio so it still reads as the lead; every other tile becomes equal-height |

Between `breakpoint.sm` and `breakpoint.md` (1024px — proposed, §13.6), `grid`
caps at 2 columns regardless of `columns`: three 30ch tracks at 800px produce
22ch measures and four-word orphan lines. The restack is specified here for the
same reason `hero` §10 exists — an undefined restack is how half of these
layouts arrive broken on a phone.

## 7. Icons and media

**Icons are user assets, not a bundled set.** `icon ./path.svg` resolves
through `ctx.asset()` (ARCHITECTURE §4.3), sandboxed to the project root. No
icon-library dependency ships with this word — a thousand glyphs to use four of
is bundle weight and a lock-in for a decision the designer should be making.

At emit the SVG is **inlined and sanitised**, unconditionally:

- strip `<script>`, `<foreignObject>`, `<use href>` pointing outside the file,
  every `on*` attribute, and any `href`/`xlink:href` that isn't a local fragment
- strip `width`/`height`, set `aria-hidden="true"` and `focusable="false"`
- force `fill="currentColor"` / `stroke="currentColor"` so the icon inherits
  theme colour instead of shipping a hard-coded hex into the output

The icon is **always decorative**: the item title carries the meaning, so the
icon never gets an accessible name — an `aria-label` produces a duplicate
announcement of the heading directly beneath it. **Icons and photographs must
not mix in one section**, either: a grid where two items have line icons and two
have product shots looks like a build error (warned, not blocked — CONVENTIONS
§5, taste is a warning).

Item `media` (an image, for `rows` and `bento`) follows the same intrinsic-size
rule as `gallery` §7: the compiler reads the file header at build time and
writes `width`/`height` so the box is reserved before the byte arrives.
It follows gallery §7 rule 3 too (built 2026-10-06): the item's `<img>`
carries a `sizes` from this word's layout — `rows` `(width < 768px) 100vw`,
then half the row; `bento` `(width < 768px) 100vw`, then `(width < 1024px)`
at up to two tiles' share, then `columns`' share — capped by the site frame
(`min(50vw, 720px)` on the 1440px container), and the build writes a srcset
of the widths narrower than the file. Media from a `from <table>` row ships
the server's one file and no srcset (data-spec §8).

## 8. The `bento` tiling

Bento is where "just a grid" stops being true. The base is **6 columns** — six
divides by 2 and 3, so two-, three- and mixed-width rows land on the same grid;
twelve is too fine to constrain anything, four can't express thirds. Tiles come
in four widths only (`6` `4` `3` `2`), and the row-height minimum is **the width
of a 2-column tile**, so the smallest tile is a square and every other tile is a
whole multiple of it. Everything derives from the container; there is no magic
row height to go stale.

| Items | Tiling (col span × row span, in order) |
|---|---|
| 3 | `4×2` `2×1` `2×1` |
| 4 | `4×1` `2×1` · `2×1` `4×1` |
| 5 | `4×2` `2×1` `2×1` · `3×1` `3×1` |
| 6 | `4×1` `2×1` · `2×1` `4×1` · `3×1` `3×1` |
| 7 | `4×1` `2×1` · `2×1` `4×1` · `2×1` `2×1` `2×1` |

**Fewer than 3 items has no hierarchy to express; more than 7 has too much.**
Both are compile errors, not warnings — there is no correct tiling to fall back
to, so silently picking one would produce a layout the author never chose.

`item "…" lead` moves the `4×2` tile to that item; exactly one per section.
Counts with no `4×2` tile (4, 6, 7) reject `lead` outright rather than
pretending — their emphasis comes from the first `4×1`, which is positional.
Authors do **not** write spans: a span is implementation, `lead` is intent (PRD
principle 6), and exposing `span 2` would make every bento a hand-built grid
with extra steps while the tiling table above stopped being testable.

## 9. The `reveal` modifier

| Rule | Why |
|---|---|
| The hidden state is applied **by script**, never in the stylesheet | if JS fails, IntersectionObserver never fires, or the element is off-observer, CSS-hidden content stays invisible forever. Content-invisible-without-JS is the failure mode this modifier is most likely to ship |
| Items already inside the first viewport render **visible, unanimated** | animating what the user is already looking at is a flash, not a reveal |
| `opacity 0→1` + `translateY(space.8 → 0)` at `motion.slow` on `motion.ease.emphasis` | transform and opacity only — see overlays-spec §3 |
| Stagger 60ms, **capped at 6 steps** | item 12 arriving 720ms after item 1 is not a stagger, it's a queue. Past step 6 the delay stops accumulating |
| Fires **once**; the observer disconnects | re-animating on scroll-up is the effect everyone disables within a week |
| `prefers-reduced-motion` → no observer at all, everything visible at first paint | `motion.reduced` is opacity-only; here it is nothing at all |

`reveal` on a `feature` whose items are above the fold does nothing but risk.
Warn when the section is the first block on the page.

## 10. Accessibility floor

- **`title` emits `<h2>`, item titles emit `<h3>`.** If the section has no
  `title`, item titles emit `<h2>` instead — so the outline never skips from
  the hero's `<h1>` to an `<h3>`.
- `feature` never emits an `<h1>`. The hero owns the only one (hero §4).
- The section is a `<section aria-labelledby>` pointing at its `title`; with no
  `title` it stays a plain container — an unlabelled landmark is noise.
- Items are a `<ul>`/`<li>` when they are a set of peers. A grid of `<div>`s
  gives a screen-reader user no count; a list announces "4 items".
- Icons `aria-hidden`, per §7.
- The `focus-visible` ring (`color.focus`, `size.ring`, `size.ring-offset`)
  follows the **tile** outline, not the text — a stretched-anchor tile with a
  ring around three words looks like a bug.
- Contrast ≥ 4.5:1 for item text. Grey-on-white at 60% opacity is the most
  common failure in this exact block.
- Tile hover effects must not be the only affordance — `link` text is underlined
  or carries an arrow, so touch and keyboard users get the same signal.

## 11. Compiler validations

| Check | Message |
|---|---|
| two variants | `feature: 'grid' and 'bento' are both layouts — pick one` |
| `columns` outside `grid` | `feature: 'columns' only applies to 'grid' — remove it or switch variant` |
| `columns` out of range | `feature: 'columns 5' is too many — use 2, 3 or 4, or switch to 'bento'` |
| fewer than 2 items | `feature: 1 item — a feature section needs at least 2, or use 'text'` |
| `bento` with <3 or >7 items | `feature: 'bento' needs 3–7 items, got 9 — use 'grid'` |
| `lead` on a count with no lead tile | `feature: 'lead' has no larger tile at 4 items — use 3, 5 or drop 'lead'` |
| two `lead` items | `feature: 2 items marked 'lead' — only one can lead` |
| orphan in the last row | `feature: 7 items in 3 columns leaves 1 alone — use 6, 9, or 'bento'` |
| >5 `rows` items | `feature: 6 rows is a long scroll — use 'grid', or cut to 3` |
| icons and photos mixed | `feature: item 'Sewn, not glued' uses an icon and item 'Forty a month' uses a photo — pick one` |
| item with a filled CTA | `feature: item CTAs must be links, not buttons — one primary per section` |
| >1 section `cta` | `feature: 2 CTAs — a section gets one primary and one alt` |
| item title over 6 words | `feature: 'Everything you need to run your workshop' is a sentence — item titles are 2–5 words` |
| item with no `text` in `rows` | `feature: 'rows' gives each item half a screen — add 'text' or use 'grid'` |
| `reveal` on the first block | `feature: 'reveal' on the first block animates what is already on screen — drop it` |
| `item` with neither `text` nor `media` | `feature: item 'Fast' has only a title — add 'text', or this is a 'stats' section` |

Taste rows are warnings, structural rows errors. A compiler that tells you seven
items in three columns will strand one is doing the review a designer would
otherwise do at 11pm.

## 12. `word.json`

```jsonc
{
  "name": "feature", "version": "1.0.0", "kind": "block",
  "variants": ["grid", "rows", "bento"],
  "modifiers": ["reveal"],
  "props": {
    "title":   { "type": "string", "required": false, "maxWords": 10 },
    "sub":     { "type": "string", "required": false, "maxWords": 30 },
    "columns": { "type": "int", "min": 2, "max": 4, "default": 3 }
  },
  "slots": {
    "item": { "min": 2, "max": 12, "slots": { "link": { "max": 1 } }, "props": {
      "title": { "type": "string", "required": true, "maxWords": 6 },
      "text":  { "type": "string", "maxWords": 40 },
      "icon":  { "type": "path", "ext": [".svg"], "maxBytes": 16384 },
      "media": { "type": "path", "maxBytes": 512000,
                 "ext": [".webp",".jpg",".png",".avif"] },
      "lead":  { "type": "flag" }
    } },
    "cta":  { "max": 1 },
    "alt":  { "max": 1 }
  },
  "requires": {},
  // Exactly the tokens this word's own code reads; az lint (pnpm lint) fails on a missing or extra entry.
  "themeReads": [
    "breakpoint.md", "breakpoint.sm", "color.bg", "color.muted", "color.text",
    "radius.md", "size.gutter-sm", "size.measure-body", "size.measure-display",
    "space.8", "space.12", "space.16", "space.24", "space.32", "space.48",
    "space.96", "type.body", "type.display", "type.leading-body",
    "type.leading-tight", "type.size.2xl", "type.size.base", "type.size.lg",
    "type.weight-bold", "type.weight-display"
  ],
  "deps": {},
  "targets": ["web"],
  "tested": { "with": ["nav", "hero", "footer"],
              "browsers": ["chrome-latest","safari-latest","firefox-latest","ios-17"] }
}
```

Zero runtime dependencies, on purpose: grid, `content-visibility` and
IntersectionObserver are platform features, and a layout library here would be
a dependency for something CSS already does (word-quality-gate §1, item 9).

## 13. Open questions

1. **Nested slot props.** `item` carries its own props and its own `link` slot,
   but ARCHITECTURE §4.1 documents `slots` as `{ max }` only. *(Recommend:
   extend the schema with `min` and nested `props`/`slots` now — `gallery` and
   `text` need the same shape, so three words are blocked on it.)*
2. **Is `bento` a variant of `feature` or its own word?** buttons-and-sections
   §6 asks the same. *(Recommend: variant, as decided — but it carries ~60% of
   this spec's complexity, and if it slips M2 the word still ships with `grid`
   and `rows`.)*
3. **Where does `lead` live grammatically?** `item "…" lead` puts an adjective
   on a slot, which no other word does. *(Recommend: allow it — the
   alternative, an indented `lead yes`, introduces booleans to a language that
   has none.)*
4. **Diagnostic ID range.** CONVENTIONS §5 requires stable IDs (`AZ1042`) and no
   allocation scheme exists. One block of IDs per word, before M2.
5. **A shared section-header primitive?** `feature`, `gallery` and `text` all
   emit `title` + `sub` + labelled landmark identically. *(Recommend: yes — same
   argument as the button primitive. Three copies of the heading-level rule is
   three places to get it wrong.)*
6. **`breakpoint.md` does not exist.** theme-spec §1 ships `xs` 480, `sm` 768,
   `lg` 1440, and the token set is closed. All three of these blocks need a
   ~1024px band — the width where 3 columns stop having a measure. *(Recommend:
   add `breakpoint.md` 1024 to the theme rather than hard-coding 1024px in three
   words, which is exactly the drift CONVENTIONS §4 exists to stop.)*
