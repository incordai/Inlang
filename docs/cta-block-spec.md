# `cta` — block specification

**Status** draft for M2 · Companion to the `hero`, `nav` and buttons/sections specs

`cta` is the closing ask. It is the smallest block in Phase 1 — a heading, a
line of support, one button — which makes it the easiest to add and the easiest
to add for no reason. **Most of this spec is about the button; the most
valuable part is §7, which is about not placing one.**

---

## 1. Syntax

```
az 1

cta band
  title "Forty pairs a month. One of them could be yours."
  sub   "Reserve now for the autumn run."
  cta   "Reserve a pair" /reserve
  alt   "Call the studio" tel:+50412345678
```

`cta split glass` adds `media ./assets/bench.jpg`, and a `video:` destination
opens the shared player (§5).

**Variants are mutually exclusive:** `band` `card` `split`. Two is a compile
error — `cta band card` must fail loudly. Default is `band`.

**Modifiers combine freely:** `glass` `reveal`.

The block word and its primary slot are both `cta`, deliberately: it is the slot
name `hero` and `nav` already use (buttons §1.1), and inventing `action` here
would give one concept two names depending on which block you were inside.

## 2. Choosing a variant

| Variant | Use when | Watch out for |
|---|---|---|
| `band` | default. The ask is the whole point and you want a hard stop before the footer. Full-bleed, its own background | it inverts the palette, so **the button must invert too** (§3) — an accent button on an accent band disappears |
| `card` | the page is already busy, or the ask is modest ("questions? talk to us"). Contained, inset, on the page background | reads as an aside — do not use it for the page's main conversion, it does not carry the weight |
| `split` | you have one genuinely good supporting image, or a short film to open | the media is decorative 90% of the time; if it is, it costs LCP and buys nothing — use `band` |

**Default to `band`.** It is the only one of the three that reliably feels like a
decision point rather than another section. `split` here means what it means in
`hero` — text one side, media the other — and it is a variant of both blocks
independently; there is no global modifier list.

## 3. Layout, measure and spacing

Theme scale only — no off-scale px, no hex (CONVENTIONS §4).

| Element | Rule |
|---|---|
| `band` | full-bleed background, content constrained to the page container (1200–1440px) |
| `card` | container width minus one step, inset; `radius.lg` — which is 0 in the `signal` theme, so never describe the block as rounded |
| `split` text column | 45–55%. Below 40% the title breaks badly — the same floor as `hero` §3 |
| Title measure | **20–30ch.** A closing ask is one sentence; if it needs 60ch it is not an ask |
| Sub measure | 45–65ch, standard readable measure |

```
title → sub              space.12
sub   → buttons          space.24   largest internal gap
band vertical padding    space.96 desktop / space.64 mobile
```

Same principle as `hero` §7: the gap before the buttons is the biggest, because
it separates the reason from the action. **The band's vertical padding is the
block's whole visual argument** — with section-standard padding it reads as
another section, with generous padding it reads as a stop. This is the one place
a block should feel *emptier* than its neighbours.

### The inverted-palette rule

`band` paints its own surface — usually the accent — so the buttons inside it
cannot use the page's button colours:

- Primary inverts to the pair the theme already ships for this: the band is
  `color.accent`, so its primary is filled `color.accent-contrast` with an
  accent label. An accent-filled button on an accent band is a rectangle you can
  only find by hovering it.
- Secondary is an outline in `color.accent-contrast`, never the page's border.
- Contrast is checked **against the band**, not the page background, in both
  themes. This is the check a hand-built inverted section always skips and axe
  always finds (gate item 4).

`band` paints `color.accent` **over** the page background — it does not own
`color.bg`, and no block does (hero §12 Q1, theme-spec §12 Q2). This is the line
to copy when the next block is tempted to take that token: if every section
could set its own background, theme-spec §6's contrast table would need a row
per legal section background and roughly double in size.

## 4. Type rules

One delta from theme defaults:

- **The title is display type, one step below `hero`'s.** It is the second
  loudest thing on the page and must not compete with the first. Where `hero`
  takes `clamp(2.5rem, 6vw, 5.5rem)`, `cta` takes roughly `clamp(1.75rem, 4vw,
  3rem)`, with leading 1.05–1.15 — looser than hero's 0.95 because the type is
  smaller — and light negative tracking that scales with the size step (hero §4).

Otherwise: `sub` is body at body leading and is never a heading.

## 5. Buttons

`cta` is nearly all button, so **buttons-and-sections-spec §1** is load-bearing
here rather than incidental. Hierarchy × intent × state, `<a>` vs `<button>`,
all six states, 44×44px targets and intent auto-detection all apply unchanged
and are not restated. What `cta` adds or tightens:

- **At least one button, or the block is invalid.** A `cta` with no action is a
  `text` block with delusions. Error, not warning.
- **Exactly one primary. Never two filled buttons.** Two primaries cancel each
  other out and the visitor picks neither — `hero` §5's rule, and it matters
  more here because there is nothing else on screen to break the tie.
- **Maximum two buttons:** one `cta` (primary) and one `alt` (secondary —
  outline or text link). Three is an error here rather than a warning: a
  closing section offering three choices has not closed anything.
- **The label is the action, not the topic.** "Reserve a pair", "Book a call",
  "Start the trial". Never "Learn more" on the primary — the weakest verb
  available, and the most common closing-CTA label in the wild.
- **The label survives the journey** (buttons §1.6): "Reserve" leads to a page
  that says "Reserve" and confirms "Reserved".
- Below 480px the primary goes full-width and the secondary stays a text link
  beneath it. Two stacked full-width buttons are two primaries by geometry.
- **`cta` does not capture email.** `newsletter` is its own word
  (buttons-and-sections §2 Tier A) and owns the input, the validation and the
  success state. A `cta` that grows a text field has become a form block.
- Overlay destinations reuse the shared engine: `video:./film.mp4` opens the
  `popup` preset from **overlays-spec §2** with its focus trap, body scroll lock
  and Escape handling. No second overlay implementation, here or anywhere.

## 6. Responsive behaviour

| Variant | <768px |
|---|---|
| `band` | keeps full bleed; vertical padding drops a step, horizontal to the mobile gutter. Buttons stack, primary full-width, title clamp floor takes over |
| `card` | inset drops to the mobile gutter, radius unchanged. If the inset would fall below the gutter the card **becomes a band** rather than touching the screen edges |
| `split` | **restacks: text above, media below** — and decorative media is dropped entirely |

The `split` restack is the failure `hero` §10 calls out: half the split layouts
in the wild look broken on a phone because nobody defined the restack.

**Decorative media is dropped, not shrunk.** A `split` cta's image exists to give
the text something to sit against at desktop width; stacked on a phone it is a
200px spacer between the visitor and the button, and it delays LCP to be one. If
it is genuinely informative — a product shot, a still that explains the film —
the author says so with a `describe` line and it is kept below the text.

## 7. The honest part: when `cta` is redundant

A closing CTA is the most-added and least-considered block on a marketing page,
and this spec should say so plainly. **A `cta` block earns its place when the
visitor has learned something since the hero.** The hero asked before they knew
anything; the closing block asks again after they do — a real second bite, but
only if something happened in between. It is redundant when:

- **The page is short.** Fewer than three content blocks between `hero` and
  `cta` means the visitor scrolled past almost nothing. The two asks are the
  same ask half a screen apart, and repetition without new information reads as
  filler rather than confidence.
- **The label and destination match the hero's on a short page.** Identical asks
  are correct on a long page — one goal, twice. On a short one, one goal, padded.
- **`pricing` is directly above it** and every plan already carries a CTA. Four
  buttons, then a fifth version of the same thing.
- **The page has no hero and `cta` is the first block.** Then it is not a
  closing ask, it is the opening statement — which is what `hero` is for.

The compiler warns rather than errors: the author knows their page, and this is
taste (CONVENTIONS §5). And the inverse, which is the worse mistake and gets its
own warning: **never put a different primary action in the closing `cta` than
the hero's.** "Start free trial" at the top and "Book a demo" at the bottom is a
page with two goals, which is a page with none. If the closing ask should be
softer, make it the `alt`, not the `cta`.

### `glass` needs something behind it

`glass` blurs what is behind the block. On a flat background there is nothing to
blur, and the modifier buys a slightly lighter rectangle at the cost of a
`backdrop-filter` that is expensive on low-end Android — the caveat
nav-block-spec §3 records. `glass` on a `band`, which paints its own solid
background, is a contradiction: warn. It is worth it in exactly one arrangement —
`card`, over a page background with an image, gradient or 3D scene behind it.

## 8. Accessibility floor

- **`cta` emits `<h2>` for `title`, and `sub` as a `<p>`. It never emits
  `<h1>`** — `hero` owns the page's only one (hero §4). The block emits one
  heading at one level and no sub-headings, so it cannot skip a level; multiple
  `cta` blocks emit sibling `h2`s, which is valid.
- `band` and `card` are `<section>` elements with `aria-labelledby` pointing at
  the `h2` — a labelled section appears usefully in the rotor instead of as an
  anonymous region.
- **Contrast is checked against the band's own background**, in both themes
  (§3): ≥ 4.5:1 for `sub`, ≥ 3:1 for the display-size title, and the same for
  the inverted button pair.
- Visible `:focus-visible` ring on both buttons. `color.focus` is tuned for the
  page, so on an accent band it inverts with the buttons — check it there.
- `split` media: a `describe` line when informative, `alt=""` when decorative.
  There is no third option, and "cta-image.jpg" is not alt text.
- `glass`: a solid fallback where `backdrop-filter` is unsupported, with contrast
  passing **against the fallback too**.
- `reveal` fully suppressed under `prefers-reduced-motion`, and the block usable
  with JS disabled — a CTA that only appears on scroll is one some never see.

## 9. Compiler validations

Format per CONVENTIONS §5. Errors block the build; taste warnings never do.

| Check | Message |
|---|---|
| two variants | `cta: 'band' and 'card' are both layouts — pick one` |
| no buttons | `cta: no action declared — add: cta "Reserve a pair" /reserve` |
| no title | `cta: no title — add: title "Reserve for the autumn run"` |
| 3+ buttons | `cta: 3 buttons, maximum is 2 (one primary, one secondary)` |
| two primaries | `cta: 'alt' is filled as well — a secondary is an outline or a text link` |
| `split` without media | `cta: 'split' has nothing to split — add: media ./photo.jpg, or use 'band'` |
| an input field declared | `cta: email capture belongs in 'newsletter' — use that block` |
| first block on the page (warning) | `cta: this is the first block on the page — an opening statement is a 'hero'` |
| same ask as hero, <3 blocks between (warning) | `cta: same ask as the hero with 2 blocks between them — drop the block or change the ask` |
| different primary from hero (warning) | `cta: the hero asks for "Start free trial" and this asks for "Book a demo" — one page, one goal` |
| directly after `pricing` (warning) | `cta: every plan above already has a button — this is the fifth ask in a row` |
| weak primary label (warning) | `cta: "Learn more" is a weak primary — name the action` |
| `glass` on `band` (warning) | `cta: 'glass' on 'band' blurs nothing — the band paints its own background` |
| `glass` over a flat background (warning) | `cta: 'glass' needs an image or scene behind it — on a flat background it does nothing` |
| 3+ `cta` blocks on a page (warning) | `cta: 3 CTA blocks on one page — the ask stops being an ask` |

Five of these are pure taste, and that is the point. **A compiler that tells you
your closing CTA is redundant with your hero does something no generator does** —
and unlike the layout checks, it is advice no linter or screenshot gives.

## 10. `word.json`

```jsonc
{
  "name": "cta",
  "version": "1.0.0",
  "kind": "block",
  "variants": ["band", "card", "split"],
  "modifiers": ["glass", "reveal"],
  "props": {
    "title":    { "type": "string", "required": true, "maxWords": 12 },
    "sub":      { "type": "string", "maxWords": 24 },
    "media":    { "type": "path", "ext": [".jpg", ".png", ".webp", ".avif"], "maxBytes": 512000 },
    "describe": { "type": "string", "maxWords": 20 }
  },
  "slots": {
    "cta": { "max": 1 },
    "alt": { "max": 1 }
  },
  "requires": { "split": ["media"] },
  "themeReads": ["color.accent","color.accent-contrast","color.surface",
                 "color.surface-alt","color.text","color.muted","color.focus",
                 "space.*","radius.lg","type.display","type.body"],
  "deps": {},
  "targets": ["web"],
  "tested": {
    "browsers": ["chrome-latest", "safari-latest", "firefox-latest", "ios-17"],
    "with": ["nav", "hero", "pricing", "footer"]
  }
}
```

`requires` reproduces the `hero` manifest's `3d → model` pattern: `split` without
`media` is meaningless, so the manifest states the dependency and the §9
validation is generated from it rather than hand-written. `deps` is empty — `cta`
is a heading, a paragraph and two links, and the only runtime it reaches for is
the shared overlay engine, a workspace package rather than a dependency of the
word. The media's alt text is `describe`, **not** `alt` — see §11.

## 11. Open questions

1. **`alt` is overloaded.** It is the secondary-button slot in `hero` and `nav`,
   and image alt text is the obvious name for the other thing `cta` needs.
   Disambiguating by value shape (`alt "text"` vs `alt "label" /dest`) works
   until an author writes `alt "Call the studio"` and gets an alt-text warning
   about their button. *(Recommended above and used in §10: `alt` stays the
   button slot everywhere, and the media description is `describe`. Confirm
   before M2 code — the one thing not to do is ship both meanings.)*
2. **Should the hero-redundancy check live in `cta` or in `page`?** It needs
   both blocks and the count between them — a page-level view a block emitter
   does not have. *(Recommend: `page`-level validation reported against the
   `cta` node's source position; the diagnostic must point where the author can
   act.)*
3. Is `card` a `cta` variant or the general "section on a surface" treatment
   that `feature` and `testimonial` will also want? *(Lean: general, later. Keep
   it a variant through M5 and extract if two more blocks need it.)*
4. Does a sticky mobile CTA bar belong here? It converts well, and it is a
   persistent overlay that eats thumb space and fights the interrupt guardrails
   in overlays-spec §5. *(Recommend: not in Phase 1, and if ever, an overlay
   preset with a frequency-style guardrail — not a `cta` modifier.)*
5. Theme paths above are the conventional shape, unconfirmed against the theme
   schema — confirm before the manifest lands.
