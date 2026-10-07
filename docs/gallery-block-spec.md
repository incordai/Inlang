# `gallery` — block specification

**Status** draft for M2 · Companion to the `hero`, `feature` and overlays specs

`gallery` is the block most likely to wreck a performance score, and the block
where a tested template is worth the most: lazy-loading, aspect-ratio
reservation, focus return and arrow-key navigation are four things nobody
writes correctly by hand at 11pm, and all four are invisible until an audit.
Tier B (buttons-and-sections §2), with the deepest hidden cost of the six.

---

## 1. Syntax

```
az 1

gallery masonry lightbox reveal
  title  "The workshop"
  sub    "Eighteen months, one room."
  ratio  3:2
  image ./photos/bench.webp
    caption "The bench, day one"
  image ./photos/welt.webp
    caption "Welting by hand"
  cta "See the whole archive" /archive
```

**Variants are mutually exclusive:** `grid` `masonry` `carousel` `orbit`.
Two = compile error. Default is `grid`.

**Modifiers combine freely:** `reveal` `lightbox`.

`orbit` appears in the PRD (§6.1, `gallery orbit`) and has never been declared
anywhere. **This is where it is declared:** a variant, not a global modifier —
it is what the images *are arranged as*, so it cannot coexist with `grid`.

## 2. Choosing a variant

| Variant | Use when | Watch out for |
|---|---|---|
| `grid` | a set of peers — product shots, a portfolio index | one uniform crop for everything; a portrait forced into 16:9 loses its subject |
| `masonry` | mixed aspect ratios you refuse to crop | order is column-major, so it is wrong for anything sequential |
| `carousel` | a sequence with a beginning, or you need one screen of vertical space | everything after slide 1 is effectively unvisited; never put anything load-bearing at slide 4 |
| `orbit` | a small, deliberately theatrical set on a brand page | the most expensive thing in this document. Caps at 16 images and pulls in the 3D runtime |

**Default to `grid`** — the only variant with no cost and no caveat.

`carousel` is chosen far more often than it should be: it exists because it
hides content, and hidden content is why it converts badly. Choose it when the
sequence matters, not when the page is long — that is an editing problem.
`orbit` is a real 3D scene with the cost that implies (§9).

## 3. Layout, measure and spacing

Theme tokens only (theme-spec §1). The `space` scale is global and keyed by its
own px value — `space.16` *is* 16px — and a px literal that is not a key of
`space` is a lint error.

| | Value |
|---|---|
| Section header measure | `title` `size.measure-display` · `sub` `size.measure-body` |
| Caption measure | 30–45ch, and never wider than its image |
| `grid` columns | 3 default, 2–4 allowed via `columns` |
| Gap | `space.16` — galleries want a **tighter** gap than `feature` |
| Header → images | `space.48` |
| Section padding block | `space.96`, `space.64` below `breakpoint.sm` |
| `carousel` peek | `space.48` of the next slide always visible |

**A gallery's gap is small on purpose:** `feature` items are separate ideas and
want air; gallery images are one set and read as a mass. `masonry` uses CSS
columns, so **DOM order runs down column 1, then column 2** — tab, lightbox and
visual order all agree, which is the right trade, but left-to-right reading
order does not hold. If order carries meaning, use `grid`.

## 4. Type

The only type here is the caption, and it is the part people set wrong:

```
caption   type.body  type.size.sm  type.weight.body  type.leading.body
          color.muted — never color.text. Over media it is color.on-scrim
```

- The caption sits **under** its image at `space.8`, left edge aligned to
  the image's. Overlaid captions fail on light photographs and need a scrim — a
  hero problem you don't have to inherit. Never centre one under a left-aligned
  image; that alignment is what makes a grid look typeset.
- Captions are optional per image but **all-or-nothing per gallery** — three
  captions among nine produces ragged heights and reads as missing data.

## 5. CTA

`gallery` takes `cta` (max 1) and `alt` (max 1). Slots, hierarchy, intent
detection and the six states are buttons-and-sections §1, not restated here.
One rule *is* specific: **an image is never a CTA.** With `lightbox` an image is
a `<button>` that opens the overlay; without it, a plain `<img>`, not focusable
at all. A gallery whose images link elsewhere is a card list — that pattern
belongs in `feature`.

## 6. Responsive behaviour

| Variant | <768px |
|---|---|
| `grid` | **2 columns, not 1.** Full-width photos turn a 20-image gallery into a two-minute scroll; two columns keeps it browsable. `ratio` is forced to a single crop so the rows stay even |
| `masonry` | 2 columns, column-major order preserved |
| `carousel` | keeps. Peek shrinks to `space.24`, scroll-snap per item, arrows are **hidden visually but stay in the DOM and focusable** — swipe is the touch affordance, arrows are the keyboard one |
| `orbit` | **falls back to `carousel`.** A 3D ring is unreadable at 390px, and shipping a WebGL context to a phone for a decorative layout is the exact trade this project exists to refuse |

`orbit`'s fallback is not bolted on at the end: the carousel emitter runs for
the mobile breakpoint and the scene is never mounted below 768px — mounting and
hiding it still costs the GPU. Between `breakpoint.sm` and `breakpoint.md`
(1024px — proposed, §13.6), `grid` and `masonry` cap at 3 columns.

## 7. Images: lazy-loading, CLS and 200 photographs

Four rules, in order of how much they save:

**1 — Reserve the box before the byte arrives.** The emitter reads each image's
header at compile time and writes `width`/`height`; the browser derives the
aspect ratio and reserves the space, so an image landing 4 seconds late shifts
nothing. That is the whole of Cumulative Layout Shift here, for one file read at
build. `ratio` overrides the intrinsic ratio and crops with `object-fit: cover`;
`auto` — the `masonry` default — keeps each image's own. Cropping without a
focal point beheads people, so `image ./x.webp focus top` moves
`object-position`.

**2 — Eager above the fold, lazy below, no priority hint at all.** The first
row (`columns` images) gets `loading="eager"`; the rest get `loading="lazy"
decoding="async"`. **No gallery image ever gets `fetchpriority="high"`** — that
hint belongs to the hero's LCP element, and spending it here is how a gallery
outranks the headline in the network queue.

**3 — `srcset` at fixed widths, generated at build.** Four widths (480, 768,
1200, 1800) plus a `sizes` string derived from the column count — which the
compiler knows and hand-written galleries always get wrong. 200 images × 4
widths = 800 encodes, so output is content-hashed and cached, or CONVENTIONS §6's
byte-identical rebuild stops being cheap.

> **Status (rules 1 and 3 built, 2026-10-06).** Rule 1 ships: the
> CLI reads the first 1MB of each image the build copies, through the asset
> sandbox, and `target-web/src/image-size.ts` reads its size from the
> header — PNG, GIF, JPEG (EXIF orientation applied), WebP (VP8, VP8L,
> VP8X), AVIF/HEIF (the primary item's `ispe`, turned by `irot`) and SVG
> (`width`/`height` in px, else the `viewBox`). It applies to every `<img>`
> any word emits through the sandbox — gallery images and poster, feature
> media, hero and cta media, nav and footer logos, markdown images — not
> only this word's. A header the parser cannot read gives no attributes
> (never wrong ones) and a warning:
> `image: can't read the size of './x.bmp' — the page will shift as it loads; export it as WebP, AVIF, JPEG, PNG or GIF`.
>
> Rule 3 ships as **option A** (the owner's decision, 2026-10-06): images
> are resized at build by the CLI, with the image library the generated
> server already uses — same pin, same limits (stack-evaluation §16). The
> compiler core stays pure: the target decides the widths and writes the
> attributes (`target-web/src/image-srcset.ts`); the CLI makes the files
> (`cli/src/images.ts`, encoding in a bounded child process,
> `cli/src/image-encode.ts`). As built:
>
> - **Which images.** An `<img>` whose word gives a `sizes` — the gallery's
>   `grid`, `masonry` and `carousel` images and its lightbox image, a
>   `feature`'s `rows` and `bento` media, a `cta`'s `split` media and a
>   `3d` hero's poster, in every variant — of a
>   JPEG, PNG, WebP or AVIF file (by its first bytes). SVG and GIF are never
>   resized. `orbit` gives no `sizes`: its ring's textures are the original
>   files, so a resized copy for the hidden list would be a second download
>   of every image.
> - **Logos give no `sizes`, by decision.** The nav logo is drawn
>   `space.32` tall (`space.24` shrunk) and the footer's `space.24`, with
>   `width: auto` — so its drawn width is that height times the file's own
>   aspect, which the word cannot see (only the target reads the file). Any
>   `sizes` the word could state is a guess, and a safe upper bound (the
>   bar's width) would make the browser pick a far larger file than the
>   100–200px a logo is drawn at — the opposite of this rule. A fixed-height
>   image wants density descriptors (`1x`/`2x` at widths derived from its
>   height), a different rule from these fixed widths; and most logos are
>   SVG, which is never resized. So a logo ships its one file.
> - **Widths.** 480, 768, 1200 and 1800 — only those narrower than the
>   original: **never upscaled**. The original is the widest candidate while
>   it is at most 1800px; past that the 1800 variant tops the set. An
>   original of 480px or less gets no srcset. The original always stays the
>   `src` (the fallback), and `width`/`height` stay rule 1's.
> - **`sizes` from the layout** (an upper bound — gaps and gutters only
>   shrink the box): `grid` is `(width < 768px) 50vw`, then
>   `(width < 1024px)` at up to three columns' share, then `columns`' share
>   (`100/columns`, rounded up); `masonry` the same below md, then two
>   minimum columns and a gap; `carousel` `(width < 768px) 100vw`, then one
>   minimum column; the lightbox `min(90vw, size.container)`, the dialog's
>   own width. `feature` `rows` media is `(width < 768px) 100vw` (above the
>   text), then half the row (two equal columns); `bento` media is
>   `(width < 768px) 100vw`, then `(width < 1024px)` at up to two tiles'
>   share, then `columns`' share; `cta` `split` media is
>   `(width < 768px) 100vw`, then half the section (its two columns). The
>   hero poster follows its visual's box (hero-spec §8): `full` is `100vw`
>   — the visual fills the full-bleed header behind the type, so the frame
>   does not cap it; `split` is `(width < 768px) 100vw`, then one of its two
>   columns; `center`, `stack` and `minimal` are the content's width,
>   `min(100vw, <frame>px)`. The poster keeps its loading (eager, no
>   priority hint; the text is the LCP element, hero-spec §8). No word
>   writes a `<link rel=preload>`; the server renderer preloads every eager
>   image from the page's head, and its preload carries the image's own
>   `srcset` and `sizes` as `imagesrcset`/`imagesizes`, so it asks for the
>   file the `<img>` picks (verify:build checks the poster's on both pages).
>   Not measured by `sizes`: an `object-fit: cover` crop draws the image
>   wider than its box when the file's aspect is wider than the box's — a
>   `full` poster on a portrait phone most of all — and the word cannot
>   see the file's aspect (as for logos, below), so the browser may pick a
>   narrower file than the crop draws. The gallery's cropped `ratio` tiles
>   share this.
> - **The site frame caps `sizes`.** `sizes` cannot read `--az-frame` (a
>   CSS variable), but the frame is a compile-time value: the target writes
>   it from `site width` and theme tokens (`default` = `size.container`,
>   `wide` = container + both `size.gutter-lg`, `narrow` =
>   `breakpoint.md`), and hands the same px to every word as
>   `ctx.site.frame` (`framePx`, `core/src/emit-contract.ts`). A share of
>   the viewport is then `min(<n>vw, <frame / n>px)` — for a three-column
>   grid on the 1440px container, `min(34vw, 480px)` — because the content
>   is never wider than the frame. A clause that only holds below a width
>   the frame is at least as wide as (`(width < 768px)`, and `(width <
>   1024px)` on a frame of 1024px or more) is never capped, so it stays
>   plain `vw`. `full` has no frame and `reading` is a measure in `ch` (a
>   length of the page's font, which no px states), so those two sites keep
>   the uncapped viewport share — still an upper bound.
> - **Output.** WebP, quality 80, every encoder option pinned; EXIF
>   orientation applied to the pixels; no metadata written. Each file is
>   `/az-img/<hash>-<width>.webp`, the hash over the input bytes and every
>   option (with the library and codec versions), so the same file always
>   gives the same names and bytes (CONVENTIONS §6).
> - **Cache.** Outside the build output — `AZ_IMAGE_CACHE`, default
>   `$XDG_CACHE_HOME/az/images` (else `~/.cache/az/images`) — keyed by that
>   hash; an entry is trusted only when every file matches its recorded
>   SHA-256, so a rebuild (each `az dev` save) encodes nothing.
> - **Limits.** The upload pipeline's (data-spec §8): the decoder
>   allow-list, ≤ 8000px a side and ≤ 40 MP checked from the header before
>   any decode, a bounded decode that fails on any error. A file that does
>   not decode, or is over the limits, is a warning and ships its original
>   only: `image: can't resize './x.jpg' — it does not decode; it ships at
>   its own size only, with no srcset` /
>   `image: './x.png' is 9000×6000 — over the resize limit (8000px a side,
>   40 megapixels); it ships at its own size only, with no srcset`. A child
>   that misses its deadline (10s + 20s per image, 8 images per child) or a
>   platform without the library's binary is one warning, and those images
>   ship without a srcset; the build never fails for it.
> - **Without a resizer** — the playground, unit tests, `az check` — the
>   `sizes` is removed and the output is exactly what it was before rule 3.
> - **Lightbox.** The enlarged image takes each thumbnail's `src` (the
>   original, never its `currentSrc`, which with a srcset is the small copy
>   the grid chose), its srcset and its `width`/`height`; the neighbour
>   preload (§8) asks for the same file the dialog's `sizes` picks.
> - **`from <table>` rows ship one size.** A row's image URL arrives from
>   the backend after the page, not from a build file, and the backend's
>   upload pipeline stores **one** re-encoded file per upload (WebP, at
>   most 2048px a side — data-spec §8, `IMAGE_LIMITS.storedMax`); it makes
>   no width variants. So a row's `<img>` (gallery `grid`/`masonry`,
>   feature media) gets no `sizes` and no srcset. Variants at upload are a
>   server change of their own (data-spec §8).

**4 — `content-visibility: auto` with `contain-intrinsic-size` per row.**
Offscreen rows skip layout and paint entirely, and the intrinsic size comes free
from rule 1 — so the scrollbar stays honest.

And what 200 images actually does:

| Count | Verdict |
|---|---|
| ≤ 24 | fine everywhere |
| 25–60 | fine with lazy + `content-visibility`; DOM weight is not the problem |
| 60–200 | **warned.** With `lightbox`, every image is a focusable button, so a keyboard user hits 200 tab stops before reaching the footer. That is the real failure, not bytes |
| > 200 | **error.** This is an archive, not a section — it needs paging, which is the `content` system (buttons-and-sections §3), not a block |
| `orbit`, > 16 | **error.** 16 textures at 1024² RGBA is 4MB each, ~5.3MB with mipmaps, ~85MB of GPU memory before geometry. That is a tab crash on a mid-range phone, and a ring of 40 photographs is illegible anyway |

The >200 error blocks a build, which is strong, and right: no layout makes 200
images good, and the fix — paginate — is a feature this project already plans.

## 8. The lightbox

**The lightbox is the `popup` preset from overlays-spec §2, not a new overlay.**
Portal to root, focus trap, body scroll lock (with the iOS `position: fixed` +
restored offset, overlays §6), Escape, click-outside, close button,
`role="dialog" aria-modal="true"`, `inert` on the background, `opacity 0→1` +
`scale .96→1` at `motion.emphasis` with the backdrop at `motion.backdrop`,
ahead of it — none of it reimplemented here. What `gallery` adds on top:

| Concern | Rule |
|---|---|
| Keyboard | `←`/`→` previous/next · `Home`/`End` first/last · `Escape` close. Arrows must not scroll the locked page behind |
| Wrap | **Does not wrap.** At the last image, `→` does nothing and the next button is `disabled`. Silent wrap-around leaves a viewer unable to tell they have seen everything |
| Focus return | returns to the thumbnail of the image **currently shown**, not the one that opened the lightbox. Arrow to image 7, press Escape, and focus lands on thumbnail 7 — and that thumbnail is scrolled into view. Returning to thumbnail 1 is technically "return focus" and practically a teleport |
| Preload | neighbours ±1 only, at full size, `fetchpriority="low"`. Preloading the set defeats every rule in §7 |
| Counter | always visible — the only thing telling a viewer the set is finite — and announced as `aria-live="polite"` text ("3 of 18"), or a screen-reader user gets nothing |
| Touch | swipe left/right maps to prev/next; swipe down closes, matching the `sheet` gesture in overlays §3 |
| Reduced motion | `motion.reduced` — opacity at 100ms, or instant. No slide between images |

The trigger is a real `<button>` wrapping the `<img>`, named by the caption (or
the `alt` when there is none). An `<img>` with an `onclick` is not focusable,
not announced and not operable — and it is what almost every hand-built
lightbox ships. **Deep-linking is out of scope for Phase 1:** `#photo-3` means
the gallery owns a route, and routes are the `content` system's job.

## 9. `orbit` — the 3D variant

Every rule in hero §8 applies unchanged — same failure set: text is the LCP
element and the canvas mounts after it; the canvas box is reserved by
`aspect-ratio` before the scene loads; `dispose()` runs on unmount for every
geometry, material **and texture** (with 16 textures this leak is larger than
the hero's); DPR is clamped (`min(devicePixelRatio, 2)`); and
`prefers-reduced-motion` gets the static poster, not a slower rotation.

What is specific to `orbit`:

- **A ring of planes facing the camera**, rotated by scroll or drag — not a
  perspective carousel faked in CSS, which is `carousel` with a transform and
  the cheaper answer whenever it is good enough.
- **Textures are the budget.** 1024² maximum, compressible; the 16-image cap in
  §7 is that arithmetic.
- **Every image must still exist in the DOM** — a real `<ul>`, visually hidden
  while the canvas is live. Without it, `orbit` is a block whose entire content
  is invisible to search engines and screen readers.
- Horizontal drag rotates, vertical drag scrolls the page. Backwards, and a
  phone user is trapped inside the block.
- A poster compiles for the static tier, the loading state and OpenGraph.
- **The scene cannot read `ctx.theme.*` directly.** Those return `var(--az-…)`
  strings; WebGL needs a literal, so the scene background and any scrim colour
  come through `theme.value(path)` (theme-spec §1).

## 10. Accessibility floor

- **`title` emits `<h2>`**, and `gallery` never emits an `<h1>` (hero §4 owns
  it). With no `title` the section emits no heading rather than promoting a
  caption — a caption is not a heading, and there are no item headings to nest.
- **`alt` on every image, and `alt` is not the caption.** The caption says
  "Welting by hand"; the alt says what is visible to someone who cannot see it.
  When the caption already says it, the image takes `alt=""`.
- `<figure>` + `<figcaption>` when captions exist; a plain `<ul>` when not.
- The thumbnail focus ring (`color.focus`, `size.ring`) is **offset outside**
  the image box by `size.ring-offset` — a ring inside the box disappears on a
  busy photograph.
- `carousel`: the track is a labelled `role="group"`, arrows are `<button>`s
  with real names ("Previous image"), and **no autoplay** — autoplay would need
  a pause control and a stop-on-focus rule, enough machinery that the honest
  answer is not to add it.
- All motion here — reveal, carousel scroll, lightbox transition, orbit
  rotation — is off under `prefers-reduced-motion`.

## 11. Compiler validations

| Check | Message |
|---|---|
| two variants | `gallery: 'grid' and 'carousel' are both layouts — pick one` |
| no images | `gallery: no images — add: image ./photo.webp` |
| one image | `gallery: 1 image is not a gallery — use 'feature' or a hero` |
| >60 images | `gallery: 84 images means 84 tab stops before the footer — split it or use 'carousel'` |
| >200 images | `gallery: 240 images is an archive, not a section — paginate it with 'content'` |
| `orbit` >16 images | `gallery: 'orbit' caps at 16 images, got 30 — use 'grid', or cut the set` |
| `orbit` <4 images | `gallery: 'orbit' needs at least 4 images to read as a ring — use 'grid'` |
| image size unreadable (§7 rule 1) | `image: can't read the size of './x.bmp' — the page will shift as it loads; export it as WebP, AVIF, JPEG, PNG or GIF` (an SVG: `give its <svg> a viewBox, or width and height in px`) |
| image over budget | `gallery: 'bench.webp' is 4.2MB — export it under 500KB or the gallery blocks the page` (built: a warning from the CLI, which has the file's size; over 500KB = 512 000 bytes, the manifest's `maxBytes`; shown in MB from 1MB, else KB) |
| missing `alt` | `gallery: 'lasts.webp' has no alt text — add: alt "lasts on a shelf", or alt "" if the caption says it` |
| `alt` equals `caption` | `gallery: alt and caption are identical on 'welt.webp' — set alt "" so it isn't read twice` |
| partial captions | `gallery: 3 of 9 images have captions — caption all of them or none` |
| `columns` outside `grid` | `gallery: 'columns' only applies to 'grid' — remove it or switch variant` |
| `ratio auto` with `grid` | `gallery: 'ratio auto' leaves ragged rows in 'grid' — set a ratio, or use 'masonry'` |
| `lightbox` on `orbit` | `gallery: 'orbit' opens its own viewer — 'lightbox' has no effect` |
| `carousel` with ≤3 images | `gallery: 3 images fit on one screen — 'carousel' hides two of them for nothing` |
| two galleries with `orbit` | `gallery: 2 orbit scenes on one page — one WebGL context per page` |

Structural rows are errors, the rest warnings — and the warnings are the point.
"Your alt text and your caption are the same sentence" is a review note no
boilerplate generator gives anyone.

## 12. `word.json`

```jsonc
{
  "name": "gallery", "version": "1.0.0", "kind": "block",
  "variants": ["grid", "masonry", "carousel", "orbit"],
  "modifiers": ["reveal", "lightbox"],
  "props": {
    "title":   { "type": "string", "maxWords": 10 },
    "sub":     { "type": "string", "maxWords": 30 },
    "columns": { "type": "int", "min": 2, "max": 4, "default": 3 },
    "ratio":   { "type": "enum", "default": "3:2",
                 "values": ["square","4:3","3:2","16:9","portrait","auto"] },
    "poster":  { "type": "path", "ext": [".webp",".jpg"], "maxBytes": 262144 }
  },
  "slots": {
    "image": { "min": 2, "max": 200, "props": {
      "src":     { "type": "path", "required": true, "maxBytes": 512000,
                   "ext": [".webp",".jpg",".png",".avif"] },
      "alt":     { "type": "string", "required": true },
      "caption": { "type": "string", "maxWords": 12 },
      "focus":   { "type": "enum", "default": "center",
                   "values": ["center","top","bottom","left","right"] }
    } },
    "cta": { "max": 1 },
    "alt": { "max": 1 }
  },
  "requires": { "orbit": ["poster"] },
  "themeReads": ["color.text","color.muted","color.surface","color.focus","color.scrim",
                 "color.on-scrim","color.overlay","space.*","type.*","radius.md",
                 "motion.emphasis","motion.backdrop","motion.fast","motion.reduced",
                 "motion.ease.emphasis","layer.modal","layer.backdrop","size.measure-display",
                 "size.measure-body","size.tap","size.ring","size.ring-offset","breakpoint.sm","breakpoint.md"],
  "deps": { "three": "0.170.0", "@react-three/fiber": "8.17.10" },
  "targets": ["web"],
  "tested": { "with": ["nav", "hero", "footer"],
              "browsers": ["chrome-latest","safari-latest","firefox-latest","ios-17"] }
}
```

`lightbox` adds no dependency — the overlay engine is a workspace package
(`words/* → core, theme, overlay`, ARCHITECTURE §2), not an npm pin; `carousel`
adds none either, being scroll-snap plus `scrollIntoView`. The two 3D pins exist
**only** for `orbit` and match the versions `hero` pins (ARCHITECTURE §4.1) — a
second copy of the 3D runtime in one bundle is a doubling nobody notices until
the build is megabytes.

## 13. Open questions

1. **Variant-scoped dependencies.** A `gallery grid` should not install the 3D
   runtime, but `deps` is flat, so today it does. *(Recommend: `deps` becomes
   `{ "<dep>": { "version": "…", "when": ["orbit"] } }` before M2 — and `hero`
   needs it the moment a non-`3d` hero ships.)*
2. **`orbit` vs `scene`.** PRD §6.2 lists `scene` as its own Phase-1 block; a
   ring of textured planes is arguably a `scene` preset. *(Recommend: keep it
   here — the PRD's own sketch, and the content model is a gallery's — but
   settle it before both words exist, or the 3D setup does.)*
3. **Does `masonry` survive?** `grid-template-rows: masonry` is not baseline, so
   §3 ships CSS columns with column-major order. *(Recommend: ship it and
   document the order; the later migration changes layout, not vocabulary.)*
4. **Image processing at build.** §7 rule 3 assumes the compiler resizes and
   re-encodes — a native codec, the first dependency here that cannot be pure
   TypeScript. *(Recommend: decide in M2 — making authors pre-size moves the work
   to the person least equipped to do it.)* **Resolved 2026-10-06:** option A,
   resize at build in the CLI with the server's vetted image library — §7
   status, stack-evaluation §16.
5. **Deep-linking a lightbox image.** Out of scope per §8, but "share this
   photo" is real. *(Recommend: revisit with `content`, which has routing.)*
6. **`breakpoint.md` does not exist.** theme-spec §1 ships `xs` 480, `sm` 768,
   `lg` 1440, closed. §6 needs the ~1024px band where 3 columns stop having a
   measure. *(Recommend: add `breakpoint.md` 1024 to the theme — `feature` and
   `text` need the same band, so three words would otherwise hard-code it.)*
