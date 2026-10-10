# `faq` — block specification

**Status** draft for M2 · Companion to the `hero`, `nav` and overlays specs

An FAQ looks like a styled list. It is a **disclosure widget with routable
state** — the one Phase-1 block whose content is hidden by default, which makes
it the block most likely to be wrong in ways nobody sees until an audit or a
crawl.

---

## 1. Syntax

```
az 1

faq list reveal
  title "Questions"
  sub   "Everything people ask before they order."
  item "How long does a pair take?"
    text "Four to six weeks from order to shipping, cut and finished by one maker."
  item "Can I return them?"
    text ./content/returns.md
    more "Read the returns policy" /returns
```

**Variants are mutually exclusive:** `list` `columns`. Two is a compile error.
Default is `list`.

**Modifiers combine freely:** `single` `reveal`.

## 2. Choosing a variant

| Variant | Use when | Watch out for |
|---|---|---|
| `list` | default. 4–10 questions, answers of any length, one column at full measure | past 12 items it stops being an FAQ and becomes an un-navigable wall — that is a `help` system (buttons-and-sections §2 Tier C), not a block |
| `columns` | 6–12 **short** questions with one-line answers, and vertical space is genuinely scarce | expanding an item reflows everything below it in its column; with long answers the two columns pull apart and the section looks unfinished |

**Default to `list`.** An FAQ is read one question at a time; a second column
buys density and costs the reader a scan path. **`columns` is never CSS
multi-column:** `column-count` reflows content across the break when an item
expands, so an answer can start in column one and finish in column two
mid-interaction. Emit two grid columns and split the list at build time,
**filling column one top-to-bottom then column two**, so DOM order matches
reading order — and therefore tab and screen-reader order. Round-robin (1,3,5 /
2,4,6) looks identical and reads wrong. Below 768px `columns` is one column.

## 3. Layout, measure and spacing

Theme scale only — no off-scale px, no hex (CONVENTIONS §4).

| Element | Rule |
|---|---|
| Outer container | narrower than the page container: 720–840px for `list`. An FAQ at 1440px is unreadable |
| Answer measure | **60–70ch** — the block's real constraint |
| Row divider | a `color.border` hairline, full container width — not a box per item. If you give the open row's header an edge it is `color.border-strong`: that edge belongs to a control, and theme-spec §1 holds it to ≥3:1 |

```
item → item  0 (dividers separate, not gaps)  ·  question padding  space.16
question → answer  space.12                   ·  answer → divider    space.24
```

**Dividers, not cards.** A stack of bordered, rounded cards makes ten questions
read as ten separate objects; one hairline between rows reads as one list, which
is what it is. A subtle surface tint on the open row is the only background that
belongs here. **The chevron rotates; the row does not jump** — reserve its box at
a fixed size and rotate with `transform`, because swapping `+` for `−` changes
glyph width and nudges the whole line.

## 4. Type rules

Two deltas from theme defaults:

- **The question is not display type.** Body size, one weight up, normal
  tracking. Tracked-tight question text turns the list into ten competing
  headlines and destroys the scan.
- **The answer is body at body measure and body leading (1.5–1.7).** Do not size
  answers down to signal secondary — small answer text is the most common reason
  people give up on an FAQ. Use the muted colour token instead.

Question and answer differ by **weight and colour only, not size**.

## 5. Buttons

Buttons follow **buttons-and-sections-spec §1** in full — hierarchy, intent
auto-detection, `<a>` vs `<button>`, all six states, 44×44px targets. Not
restated. `faq` adds:

- **The question row is a `<button>`**, never a `<div>` with an onclick and never
  `<a href="#">`: it performs an action (reveal) rather than navigating, which
  buttons §1.4 puts squarely on `<button>`. **The whole row is the target**, not
  just the chevron — a 16px hit area on a phone is a broken FAQ.
- `more` is a `link`-hierarchy button — tertiary, inline. An answer never
  contains a filled primary; if it needs one, the answer is a landing page.
- **`faq` has no section-level CTA** — the closing ask belongs to `cta`.
- **An answer never opens in an overlay.** overlays-spec §2 is reusable and this
  is not a case for it: a modal removes the answer from Ctrl+F, from the
  crawler's reading order, and from the URL.

## 6. Responsive behaviour

| Variant | <768px |
|---|---|
| `list` | unchanged. Container drops to the mobile gutter; the answer measure is naturally satisfied |
| `columns` | **collapses to one column, in declared order** — not in the two-column split order, which would read 1,2,3 then 7,8,9 |

Both variants below 768px: row padding grows rather than shrinks (the tap target
is the row), and the chevron stays right, centred against the **first line** of
the question, not the block — a two-line question with a block-centred chevron
looks misaligned at every width.

## 7. The hard parts

### 7.1 It is a disclosure pattern

Each item is an **independent disclosure**, per the WAI-ARIA APG accordion
pattern:

```html
<h3><button id="q1-btn" aria-expanded="false" aria-controls="q1">…</button></h3>
<div id="q1" role="region" aria-labelledby="q1-btn" hidden="until-found">…</div>
```

What it is **not** — the three mistakes that ship most often:

- **Not `role="menu"`.** That role is for application command menus and changes
  keyboard expectations to arrow-only — overlays-spec §6 makes the same point
  about nav dropdowns. A screen reader announces "menu, 8 items".
- **Not a tabs widget.** Tabs imply one visible panel, `role="tab"`,
  `aria-selected` and roving `tabindex`. An FAQ has no selected state.
- **Not `<details>`/`<summary>` styled up.** Semantics come free, but the
  animation, the heading wrapper and `hidden="until-found"` all fight the native
  element. Emit the button pattern.

`role="region"` on the panel is emitted **only when the block has ≤6 items** —
beyond that every answer becomes a landmark and the rotor's landmark list, the
thing a screen reader user navigates with, fills up with FAQ answers. That is
the APG's own caveat, and it is worth honouring.

### 7.2 One-open-at-a-time is a modifier, not the default

**Default: items open and close independently.** `single` opts in.

The reason is behavioural, not stylistic. With `single`, opening question seven
closes question two — which is above it — so the page **shortens under the
reader's scroll position** and the thing they were about to read jumps up the
screen. It also makes comparing two answers impossible, which is the main thing
people do with shipping and returns questions.

`single` earns its place with short answers and a long list, where independent
expansion leaves a field of open panels. When set, a panel above the viewport top
collapses instantly — animating a shrink nobody can see only delays the scroll
correction. Nothing is open on load either; the chevrons carry the affordance.

### 7.3 Answers are always in the HTML

The panel is hidden, never absent. No lazy rendering, no fetch-on-open, no
client-only mounting. Three things depend on it:

1. **Ctrl+F.** An answer browser-find cannot reach does not exist for a large
   group of users.
2. **The crawler.** ASSUMPTIONS A6 rests on the rendered HTML containing real
   content with JS disabled, and an FAQ breaks that claim if it renders on the
   client.
3. **The structured data in §7.5** is only honest if the answer is on the page.

Emit `hidden="until-found"` rather than `hidden`: browsers that support it find
the text with Ctrl+F, auto-open the item and fire `beforematch` so the chevron
and `aria-expanded` can be corrected, and browsers that do not treat it as plain
`hidden` and lose nothing. Animate with `grid-template-rows: 0fr → 1fr` or
`clip-path`, never `height`/`max-height` — overlays-spec §3 bans those for the
same reason (layout on every frame). Under `prefers-reduced-motion` the panel
simply appears.

### 7.4 Deep-linking, and the sticky-nav collision

Every question gets a stable id slugged from its text: `#faq-can-i-return-them`.
Slugs derive deterministically (lowercase, non-alphanumerics to hyphens,
collisions suffixed `-2`) so `az build` twice is byte-identical (CONVENTIONS §6).
Rewording a question breaks its inbound link — the cost of readable anchors.

On load with a matching fragment: **open the item first, then scroll.** The
reverse scrolls to a collapsed row and then expands it, leaving the answer below
the fold. Do it before first paint — an inline script, not a `useEffect`.

The anchor target is the `<h3>`, so `scroll-padding-top` from **nav-block-spec
§5** does its job and the question does not land under a `sticky` nav. This block
is the main reason that rule exists: a deep link that puts the question behind
the nav *and* the answer below the fold shows nothing at all. The URL is **not**
rewritten on every toggle — that fills the Back button with FAQ state; each
question exposes an anchor affordance (a link icon on hover and focus) instead.

### 7.5 FAQPage structured data — emit it, with conditions

**Recommendation: emit `schema.org/FAQPage` JSON-LD by default, with `schema
off` to suppress.**

Be honest about what it buys. Since August 2023 FAQ rich results are shown only
for well-known government and health sites, so for the sites AZ builds this is
**not** a rich-result win and must not be sold as one. It is emitted because it
is cheap, correct and machine-readable, and consumed by things that are not one
search engine. Conditions, because bad markup is worse than none:

- **One `FAQPage` per page.** Two `faq` blocks both emitting it is invalid:
  error, and tell the author to set `schema off` on the second.
- **Only questions whose answers are in the rendered HTML** (§7.3). Markup
  describing content a visitor cannot find is what earns a manual action.
- The text is the answer's plain text, escaped at emit and never
  string-concatenated (CONVENTIONS §6; word-quality-gate §2A rates template
  injection high severity). `</script>` in a question must not break out.
- Suppressed automatically below 3 items — a two-question `FAQPage` is noise.

This puts a load-bearing check on A6: JSON-LD present while the answers are
missing from the no-JS HTML means the assumption has already failed.

## 8. Accessibility floor

- **`<h2>` for `title`, `<h3>` per question, with the toggle `<button>` inside
  the `<h3>`** — never the reverse; a heading inside a button is not a heading to
  heading navigation. It never emits `<h1>` (`hero` §4 owns the page's only one),
  and the outline runs `h2` → `h3` with no skipped level.
- `aria-expanded` flips on **every** state change, including the `beforematch`
  auto-open in §7.3. A chevron that rotates while `aria-expanded` stays `false`
  is worse than no chevron. `aria-controls` points at the panel id.

**Keyboard operation of every disclosure:**

| Key | Behaviour |
|---|---|
| `Tab` / `Shift+Tab` | move between question buttons and into an open answer's links. **Every question stays in the tab order** — no roving `tabindex`; this is not a composite widget |
| `Enter` / `Space` | toggle the focused question. Free from `<button>` — do not re-implement, and do not let Space fall through to a page scroll |
| `↓` / `↑` | next / previous question, wrapping at the ends. Optional in the APG; cheap and expected, so we ship it |
| `Home` / `End` | first / last question |
| `Escape` | **nothing.** Escape is the overlay dismiss key (overlays-spec §1) and an inline disclosure is not an overlay. Collapsing on Escape teaches the wrong model |

Focus never moves into the panel on open — the reader is already reading. Also:
a `color.focus` `:focus-visible` ring on the whole row, never `outline: none`;
minimum row height; contrast ≥ 4.5:1 in both themes; `reveal` suppressed under
`prefers-reduced-motion`; and with JS disabled every panel renders **open**.

## 9. Compiler validations

Format per CONVENTIONS §5. Errors block the build; taste warnings never do.

| Check | Message |
|---|---|
| two variants | `faq: 'list' and 'columns' are both layouts — pick one` |
| no items | `faq: no questions declared — add: item "How long does it take?"` |
| item with no answer | `faq: 'Can I return them?' has no answer — add: text "…"` |
| duplicate question text | `faq: 'Do you ship?' is declared twice — the two anchors would collide, rename one` |
| two blocks emitting schema | `faq: two FAQPage blocks on one page is invalid structured data — add 'schema off' to the second` |
| fewer than 3 items (warning) | `faq: 2 questions is a paragraph, not an FAQ — write it as 'text' or add more` |
| more than 12 items (warning) | `faq: 14 questions is a help centre — group them or move to a content system` |
| question is not a question (warning) | `faq: "Shipping" is not a question — phrase it the way a visitor would ask it` |
| answer over 80 words (warning) | `faq: the answer to 'Can I return them?' runs 140 words — link to a page instead` |

## 10. `word.json`

```jsonc
{
  "name": "faq", "version": "1.0.0", "kind": "block",
  "variants": ["list", "columns"], "modifiers": ["single", "reveal"],
  "props": {
    "title":  { "type": "string", "required": true, "maxWords": 8 },
    "sub":    { "type": "string", "maxWords": 24 },
    "schema": { "type": "enum", "values": ["on", "off"], "default": "on" }
  },
  "slots": { "item": { "min": 1, "max": 12 } }, "requires": {},
  // Exactly the tokens this word's own code reads; az lint (pnpm lint) fails on a missing or extra entry.
  "themeReads": [
    "color.bg", "color.border", "color.focus", "color.muted", "color.text",
    "motion.ease", "motion.fast", "size.gutter-sm", "size.measure-body",
    "size.measure-display", "size.ring", "size.ring-offset", "size.tap", "space.8",
    "space.16", "space.24", "space.48", "space.96", "type.display",
    "type.leading-body", "type.leading-tight", "type.size.2xl", "type.size.base",
    "type.size.lg", "type.weight-display"
  ],
  "deps": {},
  "targets": ["web"],
  "tested": { "browsers": ["chrome-latest","safari-latest","firefox-latest","ios-17"],
              "with": ["nav","hero","footer"] }
}
```

`deps` is empty deliberately: a disclosure is a button, an `aria-expanded` and a
`hidden` attribute, and an accordion package would add kilobytes plus, in most
libraries, the wrong ARIA (§7.1). There is no `color.accent` either — the FAQ is
the quietest block on the page.

## 11. Open questions

1. **§4.1 cannot describe a repeatable child's props.** `item` is a slot with its
   own `text` and `more`, and the manifest cannot say so — autocomplete, lint and
   the graph are blind inside it. *(Recommend: add `slotProps`; `pricing` needs
   the same for `plan`, so fix it once in `core`.)*
2. **Is `columns` worth shipping?** It is the weaker variant and its only real
   use is a short-answer list. *(Lean: keep — it is a grid-template change, not a
   second implementation — but expect its §9 warning to fire often.)*
3. Should the anchor affordance (§7.4) be a `faq` feature or a shared primitive?
   Every deep-linkable heading in the eventual `docs` system wants it.
   *(Recommend: build it here, extract when `docs` arrives.)*
4. Does `schema` belong on the block or on `page`? *(Recommend: block-level now;
   revisit when a second block emits JSON-LD.)*
5. Mobile-app target: `hidden="until-found"`, fragments and JSON-LD have no
   meaning in a native disclosure list. Decide in M2 what survives.
