# `hero` — block specification

**Status** draft for M2 · Companion to AZ Web PRD v0.2

The hero decides whether the site reads as expensive. It gets more design
budget than any other block. This spec is the reference implementation for
every target.

---

## 1. Syntax

```
az 1

hero split 3d scroll
  eyebrow "Limited run"
  title   "Built in the dark"
  sub     "Handmade. Forty pairs a month."
  cta     "Reserve a pair" /reserve
  alt     "See the process" /process
  model   ./assets/shoe.glb
  height  peek
```

**Variant modifiers are mutually exclusive:** `center` `split` `full` `stack`
`minimal`. Passing two is a compile error — `hero center split` must fail
loudly, not silently pick one. Default is `center`.

**Orthogonal modifiers** stack freely: `3d` `scroll` `parallax` `glass`.

---

## 2. Choosing a variant

The variant is decided by **what the visual is doing**, not by taste:

| Variant | Use when | Media | Risk |
|---|---|---|---|
| `center` | the *statement* is the product (agency, SaaS, brand) | behind / below, ambient | safe, can read generic |
| `split` | the visual **is** the product (shoe, watch, device) | 40–50% width, one side | weakest on mobile — must restack |
| `full` | you have one genuinely great asset | full-bleed behind type | text contrast; heaviest LCP |
| `stack` | visual is tall, or a screenshot/UI shot | below the fold line, full width | least dramatic |
| `minimal` | editorial, type-led brands, text-forward | none | nowhere to hide — type must be perfect |

**Default to `center`.** `full` looks the most impressive in a portfolio shot
and causes the most real-world problems (contrast, LCP, mobile crop).

---

## 3. Width and measure

Two containers, not one. This is the single most common mistake — setting one
max-width for the whole hero and letting the headline run 90 characters wide.

| Element | Max measure | Notes |
|---|---|---|
| Outer container | 1200–1440px | gutters: 24px mobile, 48–80px desktop |
| Display headline | **20–28ch** | *not* 60ch. Long display lines look cheap |
| Sub / deck | 45–65ch | standard readable measure |
| `split` text column | 45–50% | below 40% the headline breaks badly |

`ch` units, not px — the measure should follow the font, not fight it.

**Never let a headline exceed 3 lines** at any breakpoint. If it does, the copy
is too long. That's a content problem, and the compiler should warn:
`hero: title exceeds 3 lines at 390px — shorten or use 'stack'`.

---

## 4. Type

```
display   clamp(2.5rem, 6vw, 5.5rem)     center / split / stack
display   clamp(3rem, 8vw, 7rem)         full / minimal
line-height   0.95 – 1.05                display only
letter-spacing  -0.02em to -0.04em       display only, scales with size
weight        500 – 700
```

The rules that separate good from templated:

- **Tight leading on display type.** 1.5 line-height on a 5rem headline is the
  clearest tell of an amateur site. Display wants 0.95–1.05; body wants 1.5–1.7.
- **Negative tracking scales with size.** Big type needs tighter letter-spacing;
  at 14px it needs none. Tie tracking to the size step, not a fixed value.
- **Fluid, not breakpoint-stepped.** `clamp()` avoids the awkward jump at 768px.
- **Eyebrow is not a heading.** Style it small/caps/tracked, but mark it up as a
  `<p>` or `<span>` — never `<h2>`, or you break the heading outline.

**Exactly one `<h1>` per page, and it lives in the hero.** The compiler should
enforce this: two `hero` blocks on one page = error.

---

## 5. Buttons

| Count | Verdict |
|---|---|
| 0 | valid — editorial and brand pages where scroll *is* the action |
| 1 | best. Clearest intent, highest conversion |
| 2 | maximum. One primary + one secondary |
| 3+ | never. It signals you don't know what you want the visitor to do |

Rules:

- **Never two filled buttons.** Secondary is outline or text-link. Two primaries
  cancel each other out — the visitor picks neither.
- **Label = the action.** "Start free trial" if it starts a trial. Never "Learn
  more" on the primary — it's the weakest verb in the language.
- **The label survives the journey.** A button that says "Reserve" leads to a
  page that says "Reserve," which confirms "Reserved."
- **44×44px minimum touch target**, including padding. Non-negotiable.
- On <480px, primary goes full-width; secondary stays a text link.

---

## 6. Height and the scroll trap

```
min-height: 85svh     ← not 100vh
```

Two reasons, both routinely gotten wrong:

1. **`vh` is broken on mobile.** Browser chrome makes `100vh` taller than the
   visible area, so content clips. Use `svh` / `dvh`.
2. **100vh hides the page.** A hero that exactly fills the screen gives no cue
   that anything is below it. **85svh leaves a "peek" of the next section, and
   that peek does more for scroll-through than any bouncing arrow.**

Ship the peek. Skip the scroll-hint chevron — it's decoration compensating for
a layout problem you can just fix.

**The height is a word, because it is a decision, not a measurement:**

| Word | Emits | Use when |
|---|---|---|
| `compact` | `70svh` | the hero is a header, not a statement — docs, app pages |
| `peek` | `85svh` | **default.** Leaves the next section visible, which is what earns the scroll |
| `tall` | `92svh` | a single great asset that needs the room, and a section below worth finding |
| `full` | `100svh` | almost never — see the warning below |

`full` exists because authors will want it, and the compiler warns rather than
refuses: `hero: 'full' fills the screen and hides the page below it — 'tall'
keeps the peek that earns the scroll`. Curated taste belongs in warnings
(§11), not in a value the author cannot express.

## 7. Internal spacing

One scale, no arbitrary values:

```
eyebrow → title      16–24px
title   → sub        24–32px
sub     → buttons    32–48px
buttons → section end  96–128px
```

The gap between `sub` and `buttons` should be the **largest** internal gap. It
separates "what this is" from "what to do" — the two jobs of a hero.

---

## 8. The `3d` modifier

**`hero` never creates a renderer.** The page owns exactly one WebGL renderer
(scene-spec §5) and `hero 3d` draws into it like any other participant. Which
rectangle it gets depends on what else the page declares:

| Page declares | `hero 3d` renders as |
|---|---|
| no `scene backdrop` | its own rectangle in the flow, sized by the hero's layout box |
| a `scene backdrop` (scene-spec §6) | **it does not take a rectangle at all** — the hero's 3D *is* the backdrop's first scroll segment, and the hero's text layers over it |

**Where the rectangle sits, per layout (implemented).** `split`: the media
column, 4:3. `full`: behind the type, filling the hero — the only layout with
a scrim, and while the canvas draws the flat scrim becomes a gradient over the
scene (never a flat layer). `center`, `stack`, `minimal`: a 16:9 rectangle
in the flow below the copy, because none of them has a scrim and text over
media without one is what this section forbids. The view is named by
`describe` (`role="img"`); without it the headline carries the meaning and the
view is `aria-hidden`.

The second row is the one to get right. A hero canvas stacked on top of a
full-viewport backdrop is two draws of the same idea, a doubled cost, and a
visible seam where the two scenes meet. When a backdrop exists the hero
contributes to it rather than competing with it, which is also what makes a
camera path able to continue past the fold instead of stopping at the hero's
bottom edge.

### 8.1 `model` is optional — procedural is the default

**`hero 3d` without a `model` is valid and is the common case.** It renders the
**theme's procedural scene**: geometry generated from a seed rather than loaded
from a file (scene-spec §11.1). `model` is how you say *"the subject is my
product"*; without it, the hero is dimensional without being about an object.

Why this is the default rather than the fallback:

- **It is deterministic by construction.** A seed produces the same mesh
  forever, which is the product's headline claim (PRD §3). A binary asset is
  deterministic too, but only as long as nobody re-exports it.
- **It has no asset pipeline.** No Draco step, no 5MB budget, no compression
  guidance the author has to follow correctly to avoid a slow hero.
- **It cannot touch the network at build time**, so it cannot violate
  principle 1 by accident.
- **The evidence says it is enough.** A current, well-regarded 3D marketing
  scene ships no model at all — every surface is generated and every texture is
  drawn at runtime (`3d-technique-reference.md` §2).

**The procedural scene belongs to the theme, not to `hero`.** Each theme ships
its own, and they must look genuinely different from one another — this is the
direct mitigation for the "generated 3D sites all look identical" risk in
PRD §10. A theme with no procedural scene makes `model` required again, and the
compiler says so by name rather than in the abstract.

Everything below applies to both paths. The model path additionally carries the
5MB budget and the Draco guidance in `ASSUMPTIONS.md` A8.

Where 3D heroes go wrong, in order of how often:

**Text must be the LCP element, never the canvas.** Render the headline first;
mount the 3D scene after. Otherwise Largest Contentful Paint waits on a 4MB
`.glb` and the perf score collapses. This is the highest-value rule here.

**Reserve the layout box.** Give the canvas a fixed `aspect-ratio` before the
model loads, or the page reflows on arrival and Cumulative Layout Shift spikes.

**Never put a 3D object directly behind live text** without a scrim. A moving
scene under a headline is unreadable at some frame of its animation — and you
won't catch it, because you won't be watching at that frame. Either offset the
object (`split`), or lay a gradient scrim over it.

**Ship a poster.** Every 3D hero compiles a static poster image used for: the
`static` tier, the loading state, and OpenGraph. One asset, three jobs.

**`dispose()` on unmount.** Geometries, materials, textures. Without it, a
route change leaks memory until the tab dies. This is exactly the failure a
generated one-off never includes and a tested template always does.

---

## 9. Accessibility floor

Not optional, and cheap to bake in once:

- exactly one `<h1>`; eyebrow is not a heading
- contrast ≥ 4.5:1 body, ≥ 3:1 for large text (24px+, or 18.66px bold)
- `full` variant: text sits on a **gradient scrim**, not a flat opacity layer —
  opacity dims the image too and still fails on bright regions
- `prefers-reduced-motion` → `static` tier: poster image, no parallax, no
  scroll-linked camera. Not "slower motion" — *no* motion
- visible focus ring on both CTAs, never `outline: none`
- background video/3D: no autoplay audio, ever; provide a pause control
- alt text on the poster, written as `describe`, and on the model a text
  equivalent of what it shows. `describe`, not `alt`: `alt` is the secondary
  button (§1), and one word cannot be both. A `3d` hero without `poster` and
  `describe` gets a warning (`recommends`)

---

## 10. Responsive behaviour

| Variant | <768px |
|---|---|
| `center` | unchanged; display clamp floor kicks in |
| `split` | **restacks to `stack`** — text above, media below |
| `full` | keep, but crop from a defined focal point; strengthen scrim |
| `stack` | unchanged |
| `minimal` | unchanged |

`split` restacking is the reason it can't be the default. Half of `split`
heroes in the wild look broken on a phone because nobody defined the restack.

---

## 11. Compiler validations

The hero is where a compile-time check pays for itself. Fail loudly on:

| Check | Message |
|---|---|
| two variant modifiers | `hero: 'center' and 'split' are both layouts — pick one` |
| more than 2 CTAs | `hero: 3 CTAs. Maximum is 2 (one primary, one secondary)` |
| title > 3 lines at 390px | `hero: title too long at mobile width — shorten or use 'stack'` |
| second hero on a page | `hero: only one per page (it owns the <h1>)` |
| `height full` (warning) | `hero: 'full' fills the screen and hides the page below it — 'tall' keeps the peek that earns the scroll` |
| `3d`, no `model`, theme has no procedural scene | `hero: theme 'signal' has no procedural scene — add: model ./path.glb` |
| model > 5MB | `hero: shoe.glb is 12MB. Draco-compress or the LCP will suffer` |
| CTA label in a denylist | `hero: "Learn more" is a weak primary CTA — name the action` |

That last one is opinionated on purpose. **The curated taste baked into
warnings is a big part of what people are actually adopting.** A compiler that
tells you your CTA is weak is doing something no boilerplate generator does.

---

## 12. Open questions

1. Does `hero` own its background, or does `page` set it? (Recommend: `page`
   owns background, `hero` owns scrim — otherwise section seams don't match.)
2. Is `eyebrow` worth a slot, or is it `text` inside the hero?
3. Mobile-app target: which variant does `hero` map to? Probably `stack` with a
   spring entrance — needs deciding in the M2 mobile-vocabulary work.
   *(Resolved 2026-10-06: `stack`, poster on top, spring entrance —
   mobile-motion-spec §2.1.)*

---

## 13. Manifest

Per ARCHITECTURE §4.1. This is the source of truth — the graph, autocomplete,
lint, auto-install and validation are all generated from it.

```jsonc
{
  "name": "hero",
  "version": "1.0.0",
  "kind": "block",
  "variants": ["center", "split", "full", "stack", "minimal"],
  "modifiers": ["3d", "scroll", "parallax", "glass"],
  "props": {
    "eyebrow": { "type": "string", "maxWords": 6 },
    "title":   { "type": "string", "required": true, "maxWords": 12 },
    "sub":     { "type": "string", "maxWords": 30 },
    "model":   { "type": "path", "ext": [".glb"], "maxBytes": 5242880 },
    "poster":  { "type": "path", "ext": [".jpg", ".png", ".webp"] },
    "describe": { "type": "string", "maxWords": 20 },
    "height":  { "type": "enum", "values": ["compact", "peek", "tall", "full"], "default": "peek" }
  },
  "slots": { "cta": { "max": 2 }, "alt": { "max": 1 } },
  "requires": { "scroll": ["3d"] },
  "recommends": { "3d": ["poster", "describe"] },
  "themeReads": [
    "color.bg", "color.text", "color.muted", "color.accent",
    "color.accent-contrast", "color.scrim", "color.on-scrim",
    "space.*", "type.display", "type.body", "motion.*", "size.ring"
  ],
  "deps": { "three": "0.170.0", "@react-three/fiber": "8.17.10" },
  "targets": ["web"],
  "tested": {
    "browsers": ["chrome-latest", "safari-latest", "firefox-latest", "ios-17"],
    "with": ["nav", "footer"]
  }
}
```

**Notes on two fields.** `height` is a WORD, not a number. `85` encoded a
decision §6 spends a paragraph justifying, and a raw number both hides that
reasoning and violates principle 3 (no word hardcodes a spacing value). The
words carry the intent and the emitter supplies the `svh` unit §6 requires. `requires` encodes
§11's checks mechanically: `scroll` without `3d` has nothing to drive, so it
is rejected rather than silently ignored.

`deps` are loaded **only** when `3d` is present. A hero without `3d` must add
nothing to the bundle — PRD §9 budgets non-3D pages at under 150KB gz, and a
`center` hero is the most common block on the most common page.
