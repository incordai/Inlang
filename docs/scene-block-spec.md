# `scene` — block specification

**Status** draft for M3 · Companion to `hero`, which owns the 3D rules this word inherits

`scene` is a 3D viewport **in the flow of the page**: the rotating product
between two paragraphs, the configurator on a spec page, the object that
separates two sections. Anything 3D that is not the opening statement.

**It inherits every 3D rule in hero-block-spec §8 by reference.** Those rules are
not restated here, they are binding here, and if the two documents disagree the
hero spec wins. This file covers only what a *standalone, repeatable, mid-page*
scene adds — mostly a resource-management problem, and a real one.

---

## 1. Syntax

```
az 1

page /shoes
  hero split
    title "Built in the dark"
  scene inline 3d scroll
    model   ./assets/shoe.glb
    poster  ./assets/shoe.webp
    alt     "A black running shoe rotating slowly"
    ratio   4:3
    camera  orbit
  scene full 3d parallax
    model   ./assets/sole.glb
    poster  ./assets/sole.webp
    alt     "Cross-section of the midsole"
    caption "Two densities, one pour."
```

**Variants are mutually exclusive:** `inline` `full`. Two is a compile error;
default is `inline`. **Modifiers stack freely:** `3d` `scroll` `parallax` — the
same three names `hero` uses, meaning the same three things.

`3d` is technically redundant on a word whose whole purpose is 3D, and is kept
anyway: it carries the dependency set (§11), keeps `scene`'s vocabulary identical
to `hero`'s, and leaves room for a `scene video` later without a grammar change.
A `scene` without it is an error that names the fix.

## 2. What `scene` is for that `hero 3d` is not

| | `hero 3d` | `scene` |
|---|---|---|
| Position | opens the page | anywhere in the flow |
| Count per page | **exactly one** — it owns the `<h1>` | many |
| Owns | headline, CTA slots, the `<h1>` | a viewport, a caption, nothing else |
| Job | make the page read as expensive in the first 400ms | show a specific object where the copy talks about it |
| LCP | must **not** be the LCP element; the headline is | usually below the fold, not a candidate at all |

Without `scene`, a page can have **one** 3D object, ever — `hero` is one-per-page
by construction (hero §11). A product page wanting the shoe at the top and the
sole cross-section beside the materials copy cannot be written. No existing word
closes that gap: `gallery orbit` is a collection in one viewport, not one object
at one point in the narrative, and `raw` is the escape hatch, not a feature.

**Verdict: `scene` earns its place, narrowly** — as the *repeatable* 3D block and
nothing else. The failure to guard against is `scene` growing a `title`, a CTA
slot and a `height` until it is a second hero under another name. Several §12
validations exist to stop that drift.

## 3. Choosing a variant

| Variant | Use when | Watch out for |
|---|---|---|
| `inline` | the object belongs next to the copy describing it | fights the text column if oversized — cap it at the content measure |
| `full` | the object *is* the section: full-bleed, its own breathing room | heaviest by far; two on a page is a bandwidth problem before it is a taste problem |

**Default to `inline`.** `full` looks best in a portfolio shot and costs most on
a real connection — the trade-off `hero` calls out for its own `full`. `inline`
sits inside the content container and respects the text measure; `full` breaks
out to the viewport edge with `space.128` above and below, so it reads as a
section, not an image that escaped its column.

## 4. Inherited 3D rules — binding, not restated

From hero-block-spec §8, applying unchanged to every `scene`:

- **Text is the LCP element, never the canvas.** Usually free here, but see §12:
  a scene as the first block on a page makes the canvas an LCP candidate.
- **Reserve the layout box** with `aspect-ratio` before the model loads. `ratio`
  is required on `scene` for exactly this reason — an unreserved mid-page canvas
  spikes CLS *and* shoves the copy the reader is looking at.
- **Never live text over a moving scene without a scrim.** `inline` renders its
  caption outside the canvas so this cannot happen; `full` may overlay one and
  must then emit the gradient scrim.
- **Ship a poster** — the `static` tier, the loading state and §7's offscreen
  placeholder all use it.
- **`dispose()` on unmount** — geometries, materials, textures. §5 and §7 are
  about when "unmount" happens for a block that may exist twelve times on a page.

## 5. Multiple scenes on one page — one renderer, always

This is the block-specific hard part; the naive implementation fails at about
the fourth scene. Every `<canvas>` with a WebGL context consumes a real GPU
resource, and browsers cap the number of **simultaneous live contexts** per page
— low, and varying by device, driver and browser version. Exceeding it does not
throw: the browser **silently kills the oldest context**, firing
`webglcontextlost` and turning the first scene black while the reader is looking
at the fourth. The exact cap must be measured per target device, never assumed;
the design below is chosen so the number never matters.

> **Decision: one WebGL renderer per page, shared by every `scene` on it.**

A single renderer is created lazily by the first scene to mount and owned by a
page-level provider. Each `scene` contributes a DOM element that reserves its
box; the renderer draws each scene into that element's rectangle using scissor
and viewport rectangles derived from its bounding box, in one frame. That buys:

- **A live-context count of 1 regardless of scene count** — the browser cap stops
  being a design constraint at all. This is the whole reason for the decision.
- One animation loop, not N. Independent `requestAnimationFrame` loops compete
  and stutter visibly well before they saturate the GPU.
- One DPR clamp, one resize observer, one `webglcontextlost` handler that
  restores every scene at once instead of one of them.
- Shared geometry and texture caches keyed by asset path — two scenes showing
  the same model cost one upload.

Costs, stated honestly: the renderer is a **page-level** resource, so `scene`
depends on something above the block — it belongs in `target-web` as a provider
the word requests, never in `core`, since a word must not require a `core` edit
(CONVENTIONS §3). Per-scene post-processing is off the table, because an effect
pipeline on a shared renderer applies to every rectangle; `full` may opt into a
cheap effect implemented as a material, never a post pass. And scenes cannot
differ in renderer-level settings — one page, one look, which is what the theme
wants anyway.

**Scene budget: 4 per page.** Not a context limit — memory and bandwidth. Four
models at the 5MB cap `hero` sets is 20MB, worse than the front-page-of-Reddit
case distribution-and-hosting §5.2 warns about. Warn at 4, error at 8, and name
the total byte weight rather than the count, because the count is not what hurts.

**Implemented** (`packages/scene-runtime`, 2026-09-23): one fixed canvas at
the bottom of the stack, each view drawn into its element's rectangle by
scissor, one loop that stops when no view is in the warm margin, views paused
(not unmounted) offscreen, one `webglcontextlost` handler that returns every
view to its poster, and models cached by URL. Browser checks: `pnpm test:3d`.

## 6. `backdrop` — motion across the whole site, not one section

Every other block in AZ is a **section**: it occupies a rectangle in the
document flow, and its 3D is confined to that rectangle (§5). `backdrop` is the
one exception, and it exists because the most striking scroll-driven sites are
not built as a sequence of framed viewports — they are built as **one persistent
surface that the entire document travels over**.

```
site aurora
  theme midnight
  scene backdrop scroll        # every page inherits it
    model ./assets/terrain.glb

page /                         # content scrolls over the backdrop
  hero center
  feature grid
  footer

page /legal
  scene none                   # this page opts out
  text prose
```

### 6.1 What it is

| | `scene inline` / `full` | `scene backdrop` |
|---|---|---|
| Position | a rectangle in the flow | fixed to the viewport, behind all content |
| Extent | its own box | the whole scroll, every section |
| Count | up to 4 per page (§5) | **exactly one per page** |
| Declared at | inside a `page` | `site` or `page` — inherited like `nav` |
| Drives motion from | its own visibility | **document scroll progress, 0 → 1** |
| Content sits | beside or around it | **over it** |

The DOM contract is the one the `hero 3d` layering already assumes, promoted to
page scope: a fixed full-viewport canvas at the bottom of the stack, every block
rendered above it, and the content layer `pointer-events: none` so the canvas
receives the pointer — with interactive children re-enabling it.

### 6.2 Why this is a variant and not a new word

The block cap is 11 and holds (PRD §6.2). `backdrop` reuses machinery that is
already specified rather than adding any:

- **Site-level declaration and page override** — exactly the `nav` and `footer`
  rule (nav-spec §8, GRAMMAR §5.2). `scene none` opts a page out; a page-level
  `scene backdrop` replaces the inherited one rather than merging.
- **The shared renderer** — §5 already decided one renderer per page. `backdrop`
  is simply the rectangle that happens to be the whole viewport, drawn first.
- **The motion tiers** — §8 applies unchanged.

### 6.3 Scroll progress is page-level

This is the capability the block exists for. An `inline` scene knows only its
own intersection ratio; a `backdrop` is handed **document scroll progress
normalised 0 → 1**, so a camera path, a growth parameter or a colour ramp can
run continuously from the first section to the last.

Two rules make that survivable:

- **Progress is normalised, never absolute pixels.** A page whose content grows
  by one section must not break the animation's end state. `0` is the top, `1`
  is the last scrollable pixel, whatever the height.
- **Progress is monotonic and damped, never a raw scroll listener.** The value
  is lerped toward its target each frame (the same damping the tiers already
  use), which absorbs trackpad inertia, momentum scroll and jump-to-anchor
  without the camera snapping.

### 6.4 The cost this introduces, stated plainly

A backdrop renders on **every frame of every page**, not only while a section is
on screen — §7's offscreen pause cannot apply to something that is always on
screen. That inverts the cost profile of the whole page:

- it is the single largest fixed cost the tier ladder must control, and
  `motion-tiers-spec.md` §5 must be able to drop it to `static` (a poster, or
  the theme's CSS wash) independently of any inline scene
- a `backdrop` plus four `inline` scenes is **five** simultaneous draws. The §5
  budget of 4 counts inline scenes; a backdrop is additional and warns at 3
- with a backdrop present, no page is ever "3D-free", so the non-3D bundle
  budget in PRD §9 does not apply to any page that inherits one. **Declaring a
  backdrop at `site` level is therefore a whole-site performance decision**, and
  the compiler says so once rather than silently

### 6.5 Accessibility

Everything in §9 applies, plus two that only a full-viewport layer raises:

- **Contrast is not checkable against a moving surface.** Every block sitting
  over a backdrop must resolve its own background — either the theme's surface
  colour or a scrim (`color.scrim` / `color.on-scrim`). Text directly over a
  live backdrop is the same failure hero-spec §8 forbids, one level up, and the
  gate cannot catch it in a snapshot because the offending frame may be any
  frame.

  **Resolved:** blocks that paint their own background already comply. The
  two that paint none — `hero` (every variant but `full`, which is on its
  scrim) and `text` — take **`color.veil`** on a page with a backdrop: the
  page background at `VEIL_PERCENT` (92%) opacity, under the `overBackdrop`
  style state. Because the backdrop may show any colour on any frame, the
  percentage is set against the worst cases, pure white and pure black
  behind it: 90% is the smallest whole percent at which every theme and
  scheme keeps text, muted text and links at 4.5:1 and outlines at 3:1, and
  92% leaves margin for the browser's compositing (theme/test/contrast.test.ts
  proves the pass and the edge). A translucent surface rather than a scrim
  keeps every text colour the block already uses, so nothing inside it needs
  a second palette. The backdrop still shows — dimmed — through those blocks.
  The §6.6 "text over a backdrop with no surface" warning is therefore
  unreachable: the surface is applied, not requested.
- **`prefers-reduced-motion` removes the motion, not the layer.** The backdrop
  becomes its poster — still there, still setting the tone, no movement.

### 6.6 Validations specific to `backdrop`

| Check | Message |
|---|---|
| two backdrops on one page | `scene: two backdrops on '/products' — a page has one, or none` |
| `backdrop` inside a block | `scene: 'backdrop' is a page layer — declare it under 'site' or 'page', not inside a block` |
| `backdrop` + 3 inline scenes (warning) | `scene: a backdrop plus 3 scenes is 4 live draws — the backdrop already renders on every frame` |
| site-level backdrop, first use (advisory) | `scene: a site backdrop makes every page a 3D page — no page will meet the non-3D bundle budget` |
| text block over backdrop with no surface (warning) | `text: this sits over a live backdrop with no surface — add a scrim, or contrast is unprovable` |

## 7. Offscreen behaviour — pause, do not unmount

The obvious optimisation is to unmount a scene when it scrolls away. It is wrong:
unmounting disposes GPU resources, scrolling back re-uploads them, and a reader
moving up and down a page produces a dispose/upload cycle per pass — hitching and
churn far worse than a paused scene's idle cost.

| State | Trigger | Behaviour |
|---|---|---|
| Active | intersecting the viewport | drawn every frame by the shared loop |
| Paused | fully offscreen | **removed from the draw loop, GPU resources kept** — zero frame cost, no reallocation on return |
| Released | route change, or budget eviction | full `dispose()`, plus the cache entries no live scene still references |

Pausing is driven by one `IntersectionObserver` with a `rootMargin` of roughly a
viewport, so a scene is warm before it arrives. When **no** scene is intersecting
the shared loop stops completely — the page costs nothing while the reader is in
a text section, and restarting is a single frame.

**Eviction.** If live scene memory exceeds the budget, release the
least-recently-visible **paused** scene and show its poster in its place; an
active scene is never evicted.

**Resolved — the budget:** 64MB of estimated GPU memory (geometry buffers
plus RGBA textures with their mip chain, each counted once however many
views share it; the page's environment map excluded). gallery-spec §9
measures sixteen 1024² textures at ~85MB and calls it a tab crash on a
mid-range phone; 64MB sits below that with room for the page's own
compositing. The backdrop is never evicted (§6.4: it is on screen on every
frame). A released view is rebuilt when it re-enters the warm margin, and a
shared model's cache entry is freed only when no live view still holds it.
`?az-scene-budget=<MB>` sets a smaller budget for tests and diagnosis. This is why §4's poster requirement is not
optional — it is the fallback frame for three separate states. Also pause on
`visibilitychange` to hidden: a backgrounded tab rendering WebGL is pure battery
cost, and it is what a generated one-off never handles and a template always does.

## 8. Motion tiers

PRD §6.4's three web tiers apply per page. `scene` adds one rule `hero` does not
need, because `hero` is singular:

| Tier | Trigger | `scene` behaviour |
|---|---|---|
| `full` | desktop, WebGL2, >4 cores | all scenes live; `scroll` and `parallax` active |
| `lite` | mobile browser, or ≤4 cores | reduced poly and DPR, no post-fx, **and only the scene nearest the viewport centre animates** — the rest hold a static frame |
| `static` | `prefers-reduced-motion`, no WebGL, Save-Data | **posters only. No renderer is ever created** |

The `lite` rule is the `scene`-specific one: two simultaneously animating scenes
on a mid-range phone is the exact case that turns 60fps into 30fps, and "the one
you are looking at moves" is indistinguishable from "all of them move".
`static` is not slower motion — hero §9's wording, same meaning: no renderer, no
context, no 3D chunk loaded at all, which on a four-scene page saves the whole
bundle plus four models.

`scroll` and `parallax` drive the object from **the block's own progress through
the viewport**, not the page's — four scenes sharing page scroll would move
together, which reads as a bug. Under `prefers-reduced-motion` both are inert,
not damped.

## 9. Accessibility floor

- **The canvas is not content.** Emit `<canvas role="img" aria-label="…">` from
  the required `alt`, or the scene is an unlabelled graphic. `alt` describes
  **what the object is**, not that it is a 3D model.
- `alt` is required — unlike `hero`, where the headline carries the meaning, a
  mid-page scene may be the only thing in its section.
- **No `<h1>`.** A caption is a `<figcaption>` inside a `<figure>`, or an `<h2>`
  if the scene opens a section. The hero owns the `<h1>` (hero §4).
- `prefers-reduced-motion` → `static` per §8. Not slower — none.
- **Interactive scenes are keyboard-operable or they are not interactive.**
  `camera orbit` with drag-only control is mouse-only: emit arrow-key rotation
  and a visible focus ring on the canvas, or fall back to slow auto-rotate.
- An auto-rotating scene needs a pause control, as background video does (hero
  §9) — perpetual motion in peripheral vision is an accessibility problem.
- No audio from a scene, ever, at any tier. The poster carries the same `alt`,
  so the `static` tier loses nothing.

## 10. Layout and spacing

Tokens only (CONVENTIONS §4): `inline` never exceeds the content measure and
takes `space.64` above and below; `full` takes `space.128`; caption to canvas is
`space.12`; `ratio` defaults to `4:3` for `inline` and `16:9` for `full`.

`ratio` is a required property, not a `height`. Heights invite `100vh`, and a
mid-page scene at viewport height makes the reader think the page has ended —
the inverse of hero §6's "ship the peek". At `lite`, which most phones hit, the
canvas also drops to a capped DPR: rendering a decorative object at DPR 3 on a
phone is a quarter of a desktop monitor's pixels for something nobody inspects.

| Variant | <768px |
|---|---|
| `inline` | full content width; `ratio` clamped to at most `1:1` — 4:3 at 390px is taller than it is useful |
| `full` | stays full-bleed; `ratio` clamped to at most `4:3`, caption moves below the canvas instead of overlaying it |

## 11. Manifest sketch — `words/scene/word.json`

```jsonc
{
  "name": "scene",
  "version": "1.0.0",
  "kind": "block",
  "variants": ["inline", "full", "backdrop", "none"],
  "modifiers": ["3d", "scroll", "parallax"],
  "props": {
    "model":   { "type": "path", "ext": [".glb"], "maxBytes": 5242880 },
    "poster":  { "type": "path", "ext": [".webp", ".jpg"], "maxBytes": 262144, "required": true },
    "alt":     { "type": "string", "required": true, "maxWords": 20 },
    "ratio":   { "type": "enum", "values": ["1:1", "4:3", "3:2", "16:9"], "default": "4:3" },
    "caption": { "type": "string", "maxWords": 16 },
    "camera":  { "type": "enum", "values": ["fixed", "orbit", "scroll"], "default": "fixed" }
  },
  "slots": {},
  "requires": { "3d": ["poster", "alt"] },
  "themeReads": ["color.surface", "color.border", "space.*", "type.caption", "radius.md"],
  "deps": { "three": "0.170.0", "@react-three/fiber": "8.17.10" },
  "targets": ["web"],
  "tested": {
    "browsers": ["chrome-latest", "safari-latest", "firefox-latest", "ios-17"],
    "with": ["nav", "footer", "hero"]
  }
}
```

**The pins are byte-identical to `hero`'s** (ARCHITECTURE §4.1) and must stay
that way: two words resolving two versions of the renderer library ships both,
and §5's shared renderer requires every scene and the hero to talk to one. A pin
bumped in one word alone is a CI failure, not a review comment. `slots` is empty
and stays empty — a slot on `scene` is the first step to §2's second hero.

---

### 11.1 The procedural path — the default source of geometry

`model` is **optional** on `scene` and on `hero 3d`. Absent one, the block
renders the **theme's procedural scene**, and that is the expected case rather
than a degraded one.

**What "procedural" means here, precisely.** Geometry is generated at runtime
from a seed — swept curves, instanced primitives, shell layers — and its
surfaces are drawn into canvas textures rather than loaded as image files. The
techniques and the parameters that make this read as expensive rather than as a
tech demo are catalogued in `3d-technique-reference.md` §§1–3.

**The seed is the determinism contract.** The same `.az` file must produce the
same scene on every machine, forever, so:

- the seed derives from the site name and the block's position, never from
  `Math.random()` and never from a timestamp
- the noise functions are the compiler's own, pinned with the word — not the
  platform's, which may differ between engines
- **there is a test for this**: two builds, then two runs, asserting an
  identical vertex buffer hash. It belongs beside `test:determinism`
  (VERIFICATION §4), because a procedural default makes determinism a *runtime*
  property, not only a build-time one

**Themes own the scenes, and must differ.** A procedural default with one
generator would make every AZ site recognisable at a glance — the exact risk in
PRD §10 ("generated 3D sites all look identical"). Each theme therefore ships
its own generator, and the three must be different in kind, not in hue. A theme
that ships none makes `model` required for that theme, reported by name:
`scene: theme 'signal' has no procedural scene — add: model ./path.glb`.

**What the model path is still for.** Product pages. When the subject is a
specific physical object the visitor is being asked to buy, no generator
substitutes for it. That path keeps the 5MB budget, the Draco requirement and
the author-side pipeline in `stack-evaluation.md` §9 — it is simply no longer
the only way to get a 3D block onto a page.

## 12. Compiler validations

| Check | Severity | Message |
|---|---|---|
| two variants | error | `scene: 'inline' and 'full' are both layouts — pick one` |
| `scene` without `3d` | error | `scene: no renderer named — add: scene inline 3d` |
| `3d`, no model, theme has no procedural scene | error | `scene: theme 'signal' has no procedural scene — add: model ./path.glb` |
| no poster | error | `scene: no poster — add: poster ./shoe.webp (used for reduced-motion, loading and eviction)` |
| no `alt` | error | `scene: the canvas has no text equivalent — add: alt "what the object is"` |
| first block on a page | error | `scene: a scene cannot open a page — the LCP element must be text, use 'hero 3d'` |
| >8 scenes on a page | error | `scene: 11 scenes on one page, maximum is 8 — split the page` |
| pins differ from `hero` | error | `scene: the 3D dependency pins differ from 'hero' — align them, one page loads one renderer` |
| >4 scenes on a page | warning | `scene: 5 scenes totalling 18MB of models, budget is 4 — compress them or reuse one model` |
| model > 5MB | warning | `scene: 'sole.glb' is 12MB — Draco-compress it or the page will stall on mobile` |
| two `full` scenes on a page | warning | `scene: 2 full-bleed scenes compete for the same attention — make one 'inline'` |
| `camera orbit` | warning | `scene: 'orbit' is drag-only for keyboard users — the emitter adds arrow-key control, check it reads sensibly` |
| poster used as share image | warning | `scene: this page has no hero, so nothing sets the share image — the first scene poster will be used` |
| caption > 16 words | warning | `scene: the caption is a paragraph — captions are one line, move it to a 'text' block` |

The pin-drift check pays for itself: invisible in review, fatal at runtime, and
mechanically detectable from two manifests.

## 13. Open questions

1. **Where does the shared renderer live?** §5 puts it in `target-web` as a
   provider. *(Recommend: confirm before the first emitter is written — it is the
   only cross-block resource in Phase 1, and retrofitting it is a rewrite.)*
2. **Should `hero 3d` use the same shared renderer?** *(Recommend: yes, and it is
   why the pins must match. A hero with its own renderer plus four scenes on the
   shared one is two contexts and two loops for no gain.)*
3. **Is `camera` a property or three modifiers?** An enum, because `fixed`,
   `orbit` and `scroll` are mutually exclusive and modifiers combine freely.
   *(Recommend: keep it a property — but `gallery orbit` already spends `orbit`
   as a modifier, so check the two readings do not confuse.)*
4. **Does the 4-scene budget belong to `scene` or to `page`?** *(Leaning: `page`,
   as an asset-weight budget `scene` reports into. Decide with `gallery`.)*
5. **Mobile-app target: `scene` emits nothing** — PRD §6.4 decided mobile uses no
   3D. *(Recommend: `targets: ["web"]`, reported as unavailable rather than an
   error per ARCHITECTURE §4.3 — but a page built around four scenes has no
   mobile story, so warn at `az build` rather than surprise anyone in Phase 3.)*
6. **Does `scene` survive M5?** *(The honest test is whether the dogfood site
   uses it for something `hero 3d` could not do. If no page has both a 3D hero
   and a scene, cut it — a block never repeated is a hero with extra steps.)*
