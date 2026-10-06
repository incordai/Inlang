# Mobile motion vocabulary — spec

**Status:** design, written 2026-10-06 · closes ROADMAP M2 "mobile motion
vocabulary designed and written down" and the PRD §6.4 open task · **nothing
here is built.** The mobile target arrives in Phase 3 (ROADMAP), and every
number below is a design target until a mobile emitter exists and a test
measures it.

PRD §6.4 decided that the mobile-app target does **not** use 3D. It uses native
motion instead: shared-element transitions, spring physics, gesture sheets and
haptics. This spec says what each motion word and modifier *means* on that
target. It does not say how a particular platform toolkit implements it. The
normative sections (§1–§8) name no platform, toolkit or vendor. §9 is the
non-normative place for those details when Phase 3 picks a stack.

---

## 1. The rule that keeps `.az` target-agnostic

1. **No new words, no new modifiers, no target switch in the language.** A
   `.az` file that says `hero full 3d scroll` compiles for the web and the
   mobile target unchanged. The mobile meaning lives in the word's **mobile
   emitter** (ROADMAP Phase 3, "Mobile word emitters"). It never lives in the
   source.
2. **`.az` cannot name a duration, an easing, a spring, a haptic or a
   platform.** Motion values come only from the theme's `motion.*` tokens
   (theme-spec §1.7). Both targets read the same token values (§3).
3. **Every web motion modifier has a mobile meaning**, so nothing is silently
   dropped (§2). The one exception is a live 3D renderer, which by PRD §6.4
   never ships to mobile. Its replacement is defined, not omitted.
4. **Determinism is unchanged** (motion-tiers-spec §6). The same words and the
   same flags give the same emitted bytes per target. What adapts at runtime is
   the emitted code's behaviour: system reduced-motion, display refresh rate and
   gesture velocity.
5. **No tier ladder on mobile.** The ladder exists to protect a GPU-bound live
   scene (motion-tiers-spec §5). The mobile vocabulary uses only compositor
   transforms and opacity (§6), so there is nothing to degrade and no probe
   ships. The reduced-motion floor (§4) is the only switch.

---

## 2. The vocabulary — word by word

"Poster" means the `static`-tier poster image that the web target already
requires for every 3D hero and scene, with its `alt` (hero-block-spec §8–§9,
scene-block-spec §9). The mobile target reuses that asset and needs no new
one.

### 2.1 `3d` (on `hero` and `scene`)

| Web | Mobile |
|---|---|
| live scene, tiered by the probe | **the poster**, full-bleed in the block's reserved box, with an entrance (below) |

- **`hero 3d`.** On first display, the poster fades in (`opacity 0→1`) while
  the text column rises `motion.slide` → 0. Both run on `motion.spring.sheet`.
  The text starts one `motion.fast` step after the poster. This resolves
  hero-spec §12 Q3: the mobile hero lays out as `stack`, poster on top, with a
  spring entrance.
- **`scene 3d`.** The poster sits in the scene's box with **no entrance**: a
  scene is mid-page content, and an entrance there is a `reveal` the author did
  not ask for. This replaces scene-block-spec §13 Q5's leaning "emits nothing".
  The poster and its `alt` already exist, so a page built around scenes keeps
  its images on mobile. `az build` still prints a note that the scene is a
  still image on the mobile target.

### 2.2 `scroll` (scroll-linked camera → scroll-linked poster)

The poster is bound to the block's own scroll progress (scene-block-spec §8).
It is not bound to time. The block's progress **p** goes from 0, when the
block's top meets the viewport bottom, to 1, when its bottom meets the viewport
top.

- **`hero`** — the collapsing header. Pulling past the top (overscroll) scales
  the poster up from its top edge, at most `1.0 → 1.15` (§3.2,
  `motion.scroll.zoom`). On release it springs back on `motion.spring.sheet`.
  Scrolling the content up translates the poster at the content's rate until
  it leaves.
- **`scene`** — the poster scales `1.0 → 1.08` across p ∈ [0, 1] (§3.2,
  `motion.scroll.drift`). It is clipped to its box, so nothing overflows.
- Scroll-bound motion follows the finger 1:1 with **no easing and no spring**
  while the user is scrolling. Easing a value the user is directly driving reads
  as lag. Springs apply only on release.

### 2.3 `parallax`

The poster translates at `motion.parallax` × the scroll delta (0.5, §3.2). It
is clipped to the block's box. The box reserves the extra height up front, so
the clip never shows an edge and layout never shifts. If `scroll` and
`parallax` are both set, the translate is added on top of the scale, as on the
web.

### 2.4 `reveal` (`feature`)

Same rules as feature-block-spec §9, with the same tokens:

- `opacity 0→1` + `translateY(space.8 → 0)` at `motion.slow` on
  `motion.ease.emphasis`;
- stagger 60 ms, capped at 6 steps;
- runs once;
- items in the first screen are visible and do not animate.

The hidden state is applied only once the item has been laid out off-screen.
Content can never be stuck invisible.

### 2.5 Overlays (overlays-spec §2–§3)

The timings are the overlays-spec §3 tokens, unchanged. What changes is the
input: on touch, every dismissible surface can also be **dragged**.

| Preset | Mobile meaning |
|---|---|
| `dropdown` / `popover` | anchored menu. Enter `opacity` + `translateY(-motion.slide → 0)`, `motion.normal`, `ease.emphasis`. Exit `motion.fast`, `ease.in`. The slide inverts when the menu opens upward (overlays-spec §3) |
| `popup` | centred dialog, `scale .96→1` + opacity, `motion.emphasis`. The backdrop leads by `motion.backdrop` |
| `drawer` | edge panel, `translateX(-100%→0)`, `motion.slow`, `ease.out`. **Interactive:** an edge swipe opens it and a swipe back closes it. The panel tracks the finger 1:1 and on release settles with `motion.spring.sheet`, carrying the release velocity |
| `sheet` | **the gesture sheet.** Detents at content height and full height. A drag tracks 1:1. On release it snaps to the nearest detent in the velocity's direction with `motion.spring.sheet`. Dragging below the lowest detent past 25% of its height, or flinging down faster than `motion.fling` (§3.2), dismisses it |
| `tooltip` | **long-press**, since there is no hover on touch. The long-press duration replaces `motion.delay.tooltip-in`, then the tooltip shows with an opacity-only `motion.snap`. It hides on release after `motion.delay.tooltip-out` |
| `toast` | slides from the nearest safe edge, `motion.emphasis`. Swipe horizontally to dismiss. `motion.dwell.toast` (≥ 5 s) pauses **while touched**, the touch equivalent of overlays-spec's pause-on-hover |
| `interrupt` | as `popup`. overlays-spec §5's mobile ban on `trigger exit` already applies |

**Interruptions.** A gesture that starts mid-animation takes over from the
**current** position and velocity. The animation never restarts from an
endpoint, so there are no jumps when a sheet is grabbed while still opening.

### 2.6 `nav` behaviour modifiers (nav-block-spec §3–§4)

| Modifier | Mobile meaning |
|---|---|
| `sticky` | the top bar is pinned. Content gets a top inset equal to the bar's full height (the native form of `scroll-padding-top`) |
| `solid` | the bar's background opacity and the logo swap (normal ↔ `inverse`) are **interpolated continuously** over the 40–80 px scroll band from nav-block-spec §4. A continuous mapping cannot flicker at a threshold, so the hysteresis there is met by construction. The top scrim stays |
| `hide` | the bar translates out with the downward scroll delta, 1:1, clamped to its height. An upward scroll brings it back 1:1. When scrolling stops, it settles to fully shown or fully hidden, whichever is nearer, in `motion.fast`. It always shows at the top of the page |
| `shrink` | height is interpolated from `size.nav` to `size.nav-shrink` over the first 80 px of scroll, with the logo scaled in proportion. The content inset is fixed at `size.nav`, so **nothing below the bar ever moves** (nav-block-spec §3's no-CLS rule) |
| `glass` | a translucent material, not motion. Nothing changes here. Its cost goes in §6's budget |

### 2.7 Route changes — the shared element

Web route changes are page loads. On the mobile target they are transitions.

- **Default:** the new screen slides in from the trailing edge,
  `translateX(100%→0)`, `motion.slow`, `ease.emphasis`. The old screen moves
  −30% beneath a darkening scrim. The **back gesture** (edge swipe) drives this
  transition in reverse 1:1. On release it completes or cancels with
  `motion.spring.sheet`, carrying the release velocity.
- **Shared element:** if the element that started the route change shows an
  image that is also the next screen's `hero` image, that image animates its
  frame from source to destination over the same transition. The compiler
  finds the pairing from the **same asset path** on both ends. It is never
  declared in `.az`, so authors write nothing.

---

## 3. Shared tokens

### 3.1 Reused, unchanged (theme-spec §1.7)

`motion.snap` `fast` `backdrop` `normal` `emphasis` `slow` `sheet` · `slide` ·
`ease.emphasis` `ease.in` `ease.out` · `spring.sheet` · `delay.tooltip-in`
`delay.tooltip-out` · `dwell.toast` · `reduced`.

**Springs are physics, not durations.** `motion.spring.sheet` is
`{ stiffness 300, damping 30, mass 1 }`. Its damping ratio is ζ = 0.866, it
settles to 2% in about 267 ms, and it overshoots 0.43% (theme-spec §9.2). The
three numbers are passed to the platform spring as they are, so both targets
produce the same curve. The mobile emitter must not convert them to a
"duration + bounce" pair, because that conversion differs per toolkit.
Duration tokens are the **budgets** that a spring's settling time must fit
inside.

### 3.2 New tokens this vocabulary needs

These are proposed for theme-spec §1.7 and are **not yet in
`packages/theme`**. They land with the mobile emitter, each with a test.

| Path | Type | Value | Why |
|---|---|---|---|
| `motion.parallax` | `Ratio` | 0.5 | §2.3 — the poster moves at half the scroll rate. The web emitter should adopt the same token when it is built, so the two targets agree |
| `motion.scroll.zoom` | `Ratio` | 1.15 | §2.2 — the overscroll zoom ceiling for a `hero` |
| `motion.scroll.drift` | `Ratio` | 1.08 | §2.2 — a `scene` poster's scale across its progress |
| `motion.fling` | `Velocity` | 1000 px/s | §2.5 — the downward release speed that dismisses a `sheet` without the 25% drag |

The `Ratio` and `Velocity` types are new to theme-spec, so they come with the
validators that theme-spec's other types already have.

---

## 4. Reduced motion

The system "reduce motion" setting is read at launch **and on every change**.
It is not cached. The rule is the one theme-spec §9.3 states for the web:
**opacity-only or instant — never slower.** Like the web, it cannot be
overridden (motion-tiers-spec §6.1).

| Normally | Under reduced motion |
|---|---|
| hero entrance (§2.1) | the poster and text are present at first display. No entrance |
| `scroll` / `parallax` (§2.2–§2.3) | **inert.** The poster is static, with no zoom, drift or translate (scene-block-spec §8: inert, not damped) |
| `reveal` | everything is visible at first display (feature-block-spec §9) |
| overlay enter/exit, all presets | opacity only, `motion.reduced` (100 ms) |
| `drawer` / `sheet` drag | **still follows the finger.** Motion the user drives directly is input, not animation. Only the release settle changes: it becomes a `motion.reduced` opacity fade at the destination, with no spring |
| `nav solid` | the background swaps **instantly** at the band's midpoint (60 px), with no interpolation |
| `nav hide` / `shrink` | **instant** (nav-block-spec §3): hidden/shown and full/shrunk on the direction change, with no 1:1 tracking |
| route transition | crossfade, `motion.reduced`. The shared element does not travel |
| back gesture | still drives the transition, as a crossfade whose opacity follows the finger |
| toast dwell | unchanged. It is a timeout, not motion |

The system "reduce transparency" setting turns `glass` and the darkening scrim
into solid fills. This is separate from reduced motion and independent of it.

---

## 5. Haptics policy

Haptics are part of the vocabulary, not something an author places. `.az` has
no haptic word (§1 rule 2). A haptic fires **only** for these events:

| Event | Class |
|---|---|
| a `sheet` or `drawer` crosses a detent or the dismiss threshold during a drag | `selection` |
| a `sheet` is dismissed by drag or fling | `impact-light` |
| a form submit succeeds / fails (the form and auth words' result state) | `success` / `error` |
| a toggle, segmented control or picker changes value | `selection` |

**Never** for: scroll, `reveal`, any entrance, route changes, `nav`
hide/shrink/solid, toasts the user did not cause, or timers.

Rules:

1. **Only in response to the user's own input, in the same frame as the
   input.** A haptic that arrives late reads as a separate, unexplained event.
2. **At most one haptic per gesture**, except for detent crossings, which are
   limited to one per detent. The overall limit is one per 100 ms.
3. **The system haptics setting wins.** When the system has haptics off, or the
   hardware has none, nothing fires and nothing else changes. Haptics only ever
   repeat what the screen already shows, so nothing is lost without them.
4. Reduced motion does **not** turn haptics off. They are independent system
   settings, and a reduced-motion user may depend on haptic confirmation more,
   not less.
5. The five classes above are the whole set. They map to the platform's
   semantic feedback types (§9) and never to raw vibration patterns or
   durations.

---

## 6. Performance budgets

These are design targets, to be measured once the mobile emitter exists (§8).

| Budget | Target | Why |
|---|---|---|
| frame time during any motion | ≤ the display interval, which is 16.7 ms at 60 Hz and 8.3 ms at 120 Hz. **p95** over the transition, with **0** frames over 2× the interval | the same p95 framing as motion-tiers-spec §3, at native refresh |
| animated properties | **transform and opacity only.** No property that triggers layout changes per frame | overlays-spec §3's rule, unchanged. It is also why no tier ladder is needed (§1 rule 5) |
| gesture tracking | the surface is ≤ 1 frame behind the finger | anything more reads as lag on a dragged sheet |
| tap → motion start | ≤ 100 ms (`motion.snap`) | the reduced-motion ceiling, and the threshold at which a response stops feeling instant |
| idle | **zero frames** when nothing moves | battery. This is the mobile form of the `lite` rung's on-demand frames (motion-tiers-spec §5.1) |
| concurrent springs | ≤ 1 full-screen transition at a time. A new one retargets the running one from its current position and velocity (§2.5) | stacked full-screen transitions make the motion incoherent |
| poster | decoded off the main thread before the entrance starts. The entrance waits for decode, up to `motion.slow`, then runs without it | a half-decoded image animating in is the visible failure |
| translucency (`glass`, scrims) | ≤ 2 blurred layers on screen at once | blur is the expensive mobile surface (nav-block-spec §3) |

---

## 7. Determinism and snapshots

Emitted bytes are deterministic per target and flags (§1 rule 4). For visual
tests, the mobile target pins the same things the web pins (motion-tiers-spec
§6.1, ROADMAP M0's lite snapshot):

- a fixed viewport and scale factor;
- reduced motion **on**, so every surface is at rest and entrances are absent;
- the scroll at 0.

A second snapshot set with reduced motion **off** captures each surface after
its spring has settled. It is taken after the token-derived settle time plus
one frame, never by sleeping for an arbitrary duration.

---

## 8. How this will be verified (Phase 3)

Nothing in this file is verified yet. When the mobile emitter is built, each row
of §2 and §4 becomes a word-gate check (word-quality-gate §1 check 6 extended to
the mobile target), and each row of §6 becomes a measured number in
ASSUMPTIONS.md, tagged with the device it ran on. Before then, no figure here
may be quoted as device evidence (VERIFICATION §2).

---

## 9. Platform notes (non-normative)

Phase 3 chooses the mobile stack (ROADMAP: "spike WebGL/WebView in week 1
before committing"). Once the stack is chosen, this section records how each
§2 meaning maps onto that stack's native primitives:

- spring APIs that take stiffness/damping/mass;
- the semantic haptic feedback types for §5's five classes;
- the system reduced-motion and reduced-transparency settings.

It also records any value that cannot be matched exactly, with the measured
difference. Until then this section is deliberately empty of names.
