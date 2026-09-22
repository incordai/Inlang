# Motion tiers — runtime selection specification

**Status** draft for M0/M2 · Replaces the static tier-trigger table in PRD §6.4

The generated site picks its motion tier by **measuring itself on the visitor's
device**, not by a build-time guess about that device.

A1 (ASSUMPTIONS.md) gates the roadmap on one manual measurement on one phone,
which tells you about that phone. A site that watches its own frame interval and
steps down cannot ship a 12fps hero on *any* device, measured or not — that
removes the failure mode instead of guarding it. §7 states what it does not
remove.

---

## 1. The three tiers, as outcomes

Names match PRD §6.4. Defined by what the visitor gets, never by device class —
device class is an input to a guess, and guessing is what we removed.

| Tier | The visitor sees | Guaranteed |
|---|---|---|
| `full` | scroll-linked camera, post-fx, shadows, full DPR | nothing about the frame rate is *promised* — it is measured, and the site leaves this tier the moment it cannot hold it |
| `lite` | the scene, static camera, no post-fx, clamped DPR, CSS reveals | the scene renders — or the site leaves this tier too |
| `static` | poster image, CSS-only reveals, no canvas, no WebGL | **always renders.** No GPU, no measurement, no failure mode. The floor |

`static` is a **complete hero**, not an error state — hero-spec §8 already
requires a poster for three jobs, and this is the fourth. A tier belongs to
*this page view*, not to the device, session, or user. The author wrote
`hero 3d scroll`, which is intent (PRD principle 6): `full` is the best case of
that intent, not its definition.

---

## 2. Static capability gate — decided before first paint

Runs synchronously before the canvas mounts, so it costs no frames and can
afford to be strict. Output: an **entry tier** and a **ceiling** (the highest
tier this page view may ever occupy).

| # | Signal | Exact call | Trip | Result | Why this threshold |
|---|---|---|---|---|---|
| 1 | reduced motion | `matchMedia('(prefers-reduced-motion: reduce)').matches` | `true` | `static`, ceiling `static` | hero-spec §9: *no* motion, not slower motion. Not overridable by anything here |
| 2 | WebGL2 | `canvas.getContext('webgl2')` → `null`/throws | yes | `static`, ceiling `static` | no context, no scene — there is nothing to degrade *to* |
| 3 | software raster | `getContext('webgl2', { failIfMajorPerformanceCaveat: true })` → `null` while #2 succeeded | yes | entry+ceiling `lite` | the browser is telling us it will render unaccelerated, and `full` there is a slideshow |
| 4 | cores | `navigator.hardwareConcurrency` | `<= 4` | ceiling `lite` | main thread + compositor + GPU process + one worker already exceed 4; matches PRD §6.4's existing `>4 cores` line |
| 5 | cores floor | same | `<= 1` | `static` | one core cannot run a rAF loop, a scroll handler and the compositor |
| 6 | memory | `navigator.deviceMemory` | `<= 2` | ceiling `lite` | a Draco hero decompresses to hundreds of MB of buffers and textures; under 2GB the tab is an eviction candidate, and an evicted tab is worse than a poster |
| 7 | memory floor | same | `<= 1` | `static` | past the point where degrading helps |
| 8 | data saver | `navigator.connection.saveData === true` | `true` | `static` | the visitor asked for less data; downloading a multi-MB `.glb` and rendering it beautifully does not honour that |
| 9 | context loss | `webglcontextlost` on the canvas, at any time | fires | `static` immediately | the GPU took the context away — nothing above `static` exists any more |

### 2.1 Missing signals — never read as "capable"

| Signal | Absent where | Rule |
|---|---|---|
| `deviceMemory` | non-Chromium | contributes nothing; does **not** raise the ceiling. Chromium also quantises it, so it is a floor test, not a measurement — do not compute with it |
| `connection.saveData` | non-Chromium | contributes nothing. The `Save-Data` **header** is unavailable to us entirely: the web target is a static site (PRD §7.2), so there is no server to read a request header |
| `hardwareConcurrency` | rare; also spoofed by anti-fingerprinting modes | treat `undefined` as *missing*, never as `0` — `0 <= 4` would wrongly cap and `0 <= 1` would wrongly force `static` |

**The rule:** if **any** of 4/6/8 could not be read, entry tier is `lite` with
ceiling `full`, promotable exactly once by §3.6. Without capability signals the
only honest position is "unknown", and **unknown must cost frames, not risk
them** — starting low and measuring up costs a second of a less impressive hero,
starting high and measuring down is a visible stutter on a real phone.

**Deliberately not signals:** user-agent or brand parsing (build-time guessing
relocated to runtime); GPU renderer strings via `WEBGL_debug_renderer_info` (a
device blocklist is a guess with a maintenance burden, and the extension is
restricted in several browsers); `navigator.getBattery()` (non-standard, absent
in several browsers, and battery level does not predict frame rate).

---

## 3. The runtime probe

### 3.1 What is measured

**The frame interval distribution — not the mean.** A mean of 58fps hides a
scene that stutters twice a second, and the stutter is what is perceived.
Sample `t - tPrev` in ms inside the render loop that already exists (R3F
`useFrame`, itself a `requestAnimationFrame` callback), from the timestamp the
callback is handed; no second loop, no `setInterval`. Per window: **p50** and
**p95**.

**p95 interval *is* p5 FPS.** VERIFICATION §2 records p50 and p5 FPS, and the
slowest 5% of frames is the 95th-percentile interval — same number, same units,
so the thresholds below are directly comparable to the real-device protocol.

### 3.2 Settle — do not measure the load

Shader compilation, texture upload, first layout and the JS-parse tail all land
in the first second and none of them recur. Discarded, and not counted toward
any sample minimum:

| Discard | Condition | Why |
|---|---|---|
| Post-mount settle | first **1500 ms** after the canvas's first rendered frame | covers shader compile and texture upload on slow hardware without waiting until the visitor has scrolled past the problem |
| Warm-up frames | the first **60 frames** after that, whichever ends later | a 30Hz device reaches 1500ms in 45 frames, so the frame count is the backstop |
| Hidden tab | `document.visibilityState !== 'visible'` | background rAF throttles to ~1Hz and would trip every threshold |
| Outliers | any single interval **> 500 ms** | a tab suspend, debugger pause or alert — not rendering cost. Logged (§9), excluded from percentiles |
| Post-transition settle | one full window after any rung is applied | the previous window measured the *previous* configuration, and judging a change on stale samples is how cascades happen |

### 3.3 Window and minimum sample

Rolling buffer of **120 frames** (~2 s at 60Hz, ~4 s at 30Hz). **No decision
below 90 samples** — a percentile over fewer points is dominated by single
events. Percentiles are computed once per window boundary, never per frame.

### 3.4 Downgrade thresholds

| From | To | Trip when | Confirm | Why this number |
|---|---|---|---|---|
| `full` | next rung (§5) | p95 > **20.0 ms** (p5 < 50 fps) | **3 consecutive** windows (~6 s) | 50fps p5 is exactly A1's `full` threshold; three windows so a GC pause, route change or scroll-momentum spike cannot trip it alone |
| `lite` | `static` | p95 > **33.3 ms** (p5 < 30 fps) | **3 consecutive** windows | 30fps p5 is exactly A1's `lite` threshold; below it the scene reads as broken, and a poster beats a broken scene |
| any | `static` | **5 consecutive** intervals > 250 ms | none | a 250ms frame is a visible freeze; five in a row is already a failed page view and waiting 6 more seconds helps nobody |
| any | `static` | `webglcontextlost` | none | §2 #9 |

**Refresh rate is deliberately ignored.** Thresholds are absolute intervals: a
120Hz device rendering at 55fps is *failing*, and normalising to its 8.3 ms
nominal budget would hide that. The nominal interval is logged (§9) only.

### 3.5 Hysteresis and the one-way ratchet

1. **Hysteresis** — the confirm counts above, the post-transition settle, and
   the counter **resetting to zero on any passing window**. A scene must fail
   persistently, not momentarily. nav-spec §4 applies the same rule to its
   scroll threshold for the same reason, and it matters more here: a flickering
   nav is ugly, a flickering tier re-uploads textures and rebuilds a post-fx
   chain mid-scroll, *causing* the jank it is reacting to.
2. **One-way ratchet** — tier index (`full`=0, `lite`=1, `static`=2) and rung
   index are monotonically non-decreasing for the page view's lifetime, enforced
   in the state setter, not by convention.

### 3.6 Is an upgrade ever allowed? Once, before the ratchet arms

**No upgrade after the ratchet arms. Exactly one promotion before it**, for
§2.1's *missing-signal* entry only — `lite` with ceiling `full` because signals
were unreadable, not because anything was measured. If the **first two complete
windows** after settle both show p95 ≤ **13.0 ms** (p5 ≥ 77 fps) *while
rendering `lite`*, promote once to `full`, arm the ratchet, never promote again.

- Why 13.0 and not 20.0: `lite` is materially cheaper than `full`, so a device
  merely *meeting* the `full` floor while rendering `lite` is not evidence it
  can meet it while rendering `full`. The headroom is the evidence, and the
  exact margin must be re-derived against a real scene at M0.
- Why before the scroll-link engages: promotion changes what is on screen, so
  doing it before the visitor scrolls makes it invisible.

**Why never again**, in order of weight:

1. **No evidence is available.** After a downgrade every measured frame is a
   frame of the *cheaper* scene; `lite` at 90fps says nothing about whether
   `full` would hold 50. The only way to find out is to try `full` — which is
   the oscillation itself, not a test for it.
2. **Every transition is visible and costs frames**, and an upgrade rebuilds
   exactly the pipeline the downgrade tore down, during a page view already
   shown to be frame-constrained.
3. **The failure modes are asymmetric.** One tier too conservative costs polish;
   oscillating means a hero that visibly changes while being read.

### 3.7 Persistence across route changes

Tier and rung go to **`sessionStorage`** and are re-read on mount, so an internal
navigation does not re-run settle-and-degrade and re-jank the visitor. Not
`localStorage`: a downgrade caused by one hot phone or one background download
would follow that visitor across every future visit with no way to clear it, and
a session is the correct blast radius. Reads are wrapped — `sessionStorage`
throws in some privacy modes — and a throw means "no stored tier", never
"capable".

---

## 4. Thermal reality

VERIFICATION §2 measures twice, five minutes apart, because thermal throttling
appears late. **A probe that samples only the first seconds has the identical
blind spot** and would certify `full` on a phone that is fine for ninety seconds
and then is not. So the probe never stops. Alongside the rolling window:

- **Long-horizon buffer** — one value per window (that window's p95), 300
  entries ≈ 10 minutes at 60Hz, fixed size, oldest overwritten.
- **Drift check** — every 30 windows once ≥ 60 entries exist, compare
  `median(last 30)` against `median(first 30 after settle)`. Step down one rung
  when the recent median is **> 25% worse** *and* the current window also
  breaches the §3.4 floor for the current tier. Both, because drift alone is not
  a problem — 120fps decaying to 90fps is still fine. 25% is roughly 60 → 45fps,
  the point where sustained throttling becomes visible in scroll-linked motion
  rather than merely measurable.
- A hidden tab marks a **discontinuity**: the baseline half of the comparison is
  re-taken on return, because a cooled device is a different device.

**Cost, honestly.** Per frame: one subtraction, one array write, one comparison.
Per window (~2 s): one copy-and-sort of 120 numbers and two lookups. Buffers are
fixed-size and allocated once, or the probe becomes a GC source and measures its
own overhead. That is far below one frame's budget on anything that can render
the scene at all — but it is an **argument, not a measurement**: M0 measures
probe-on versus probe-off (§8.1 check 7) and the result goes in ASSUMPTIONS, not
in a comment.

---

## 5. The degradation ladder — order matters

`full` → `lite` in one step, mid-scroll, is a cliff the visitor sees.
Degradation is a ladder of rungs, cheapest and least visible first; each rung is
its own confirmed trip with its own post-transition settle.

| Rung | Tier | Change | Visibility | Why here |
|---|---|---|---|---|
| 0 | `full` | full quality | — | entry |
| 1 | `full` | DPR clamp `2.0` → `1.5` | essentially invisible | biggest cost lever per unit of perceived change — pixel count drops ~44% |
| 2 | `full` | post-fx chain off (bloom / AA / any post pass) | subtle; scene loses glow | removes whole fullscreen passes at once, and is the second-cheapest thing to *lose* |
| 3 | `full` | shadow map off → contact-shadow plane or none | noticeable; object loses grounding | first genuinely visible rung, so it follows the invisible ones |
| 4 | `full` | DPR `1.5` → `1.0` | visible edge aliasing | second bite of the biggest lever, taken only once cheap options are gone |
| 5 | `full` | LOD swap to low-poly; textures to half-res mips | visible up close | costs a swap and possibly an upload, so it is not free the way 1–4 are |
| 6 | → `lite` | **scroll-linked camera → static camera** | the defining change | it is the thing the author actually asked for, so it goes last, not first |
| 7 | → `static` | canvas unmounts, poster shows, `dispose()` runs | complete change of hero | the floor |

Rungs 1–2 apply **immediately** — nothing perceptible happens. Rungs 3–7 are
**deferred to a quiet moment**: the next scroll-idle (no scroll event for
200 ms) or section boundary, whichever comes first, with a **hard 2 s deadline**
so a visitor who never stops scrolling still gets relief. Mid-gesture is the most
noticeable possible moment to change the scene.

### 5.1 Removing the scroll-linked camera mid-scroll (rung 6)

Never snap — the camera is mid-interpolation between two author-defined poses
and cutting to either is a visible jump.

1. **Freeze** — unsubscribe the camera from scroll progress at its current pose.
2. **Ease to rest** — tween to the nearest author-defined rest pose (the one
   keyed to the current section) over the theme's `motion.slow` duration and
   easing (PRD §7.3). Theme tokens, never a literal.
3. **Release** — at rest the render loop drops to on-demand: no frames drawn
   until something changes, so the scene's largest remaining cost becomes zero.
4. **The page must not feel dead.** Scroll keeps driving the DOM — text reveals,
   section transitions, the `nav` solid/transparent switch. Only the *camera*
   stopped following scroll. This is exactly §1's `lite` outcome, reached
   gradually instead of by cliff.

On rung 7 the canvas unmounts, `dispose()` runs on geometries, materials and
textures (hero-spec §8), and the poster cross-fades in over `motion.normal`. Its
`alt` text is already required by hero-spec §9, so the accessible outcome is
unchanged by the transition.

---

### 5.2 When the page has a `scene backdrop`

A backdrop (scene-spec §6) breaks two assumptions the ladder above is built on:
it is **on screen at all times**, so the offscreen pause that protects inline
scenes never applies to it, and it is **scroll-linked by definition**, so rung 6
is not a degradation of it — it is the removal of the thing itself.

Three amendments, and no new rungs:

- **The backdrop is evaluated first at every rung.** It is the largest fixed
  cost on the page precisely because it never stops drawing, so a DPR or
  post-fx cut applied to it buys more than the same cut applied to an inline
  scene. Rungs 1–5 hit the backdrop before they hit anything else.
- **Rung 6 becomes "backdrop stops tracking scroll."** The camera holds its
  current pose and the surface keeps its ambient motion. The page still has a
  living background; it has stopped being a scroll instrument. Inline scenes
  reach rung 6 independently and later.
- **Rung 7 replaces the backdrop with its poster, and does not unmount the
  page.** For a hero, `static` means the canvas goes away. For a backdrop it
  means the canvas is swapped for the poster image — or, if the theme defines
  one, the CSS gradient wash (`3d-technique-reference.md` §4), which costs
  nothing and still sets the tone. **A page must never become visually empty
  because its backdrop was dropped.**

**The lesson borrowed from the reference teardown applies hardest here.** That
scene's own `lite` switch cut DPR and instance counts and left a 4096² shadow
map untouched — the single most expensive term in its frame
(`3d-technique-reference.md` §6). A backdrop makes that failure mode worse,
because its cost is paid on every frame of every page. **Every expensive term a
backdrop introduces must appear on this ladder.** A cost that is not on a rung
is a cost no tier can control, and on an always-on layer that is the whole
budget.

## 6. Determinism is not violated

The obvious objection — *"a site that behaves differently on different devices
cannot be deterministic"* — conflates two things.

| | Deterministic? | Guaranteed by |
|---|---|---|
| **The emitted code**, the bytes `az build` writes to `dist/` | **Yes, absolutely** | `pnpm test:determinism`, CONVENTIONS §6 |
| **The rendered result**, what a given GPU makes of those bytes | No, and never was | the visitor's hardware |

PRD §3's claim is about the **compiler**, and it is untouched. **Nothing about
the probe is decided at build time**: no device detection, no user-agent branch,
no capability check, no timestamp and no random ID enters the emitted source. The
ladder is emitted as a static data structure and the probe as a module from the
pinned word package — identical bytes in every build of the same `.az` file, on
every machine. The adaptivity lives in **the code's behaviour at runtime**,
exactly where a `@media` query or a `srcset` also lives, and nobody calls a
responsive stylesheet non-deterministic. One line: **the same words still compile
to the same bytes; the bytes then adapt on the visitor's device.**

### 6.1 Forcing a fixed tier — how the probe stays testable

| Mechanism | Effect on emitted bytes | Use |
|---|---|---|
| `?az-tier=full\|lite\|static`, `?az-probe=off` | **none** — pure runtime | the default for tests, and for an author debugging a live site |
| `az build --tier-lock=<tier>` | changes bytes, **deterministically** — same flag, same bytes | builds that must not contain the probe (offline kiosk, size-constrained page) |

Determinism is defined **per invocation with the same flags**; a different flag
is a different build, exactly as a different `.az` file is.

Guard rails, so the parameter is not a hole in the accessibility floor: it can
never force **above** the §2 ceiling (`?az-tier=full` without WebGL2 still gets
`static`); `prefers-reduced-motion` is **not overridable** in either direction,
because hero-spec §9 is a floor and not a default; and `?az-probe=off` freezes
the ratchet at the forced tier — no settle, no windows, no transitions.

Effect on word-quality-gate §1:

| Check | How it stays deterministic |
|---|---|
| 3 — renders 390/768/1440 without overflow | run at `?az-tier=static&az-probe=off`. Layout is what is under test, and a poster in the canvas's reserved box is pixel-stable where a live scene is not |
| 6 — `prefers-reduced-motion` honoured | already `static` by §2 #1; the test also asserts `?az-tier=full` does **not** override it |
| 7 — both themes, light and dark | forced `static`, as check 3 |
| *new* — ladder correctness | force each rung; assert the renderer's actual pixel ratio, post-pass count and camera scroll-subscription count. Assert the *effect*, never that a function returned successfully |
| *new* — decision logic | pure unit test over synthetic interval arrays (§8.2). No browser, no pixels, no flake |

---

## 7. What this does **not** solve

A mechanism oversold is worse than no mechanism.

1. **It does not tell the author whether their 3D hero is good on a phone.** It
   guarantees the visitor is not served something broken — a different promise.
   An author can ship a hero that every phone renders as a poster and the tool
   will never say so; it will quietly serve posters.
2. **It cannot fix a 12MB model.** The download finishes *before* the first
   measurable frame. That is an LCP problem, and the only defence is the
   compile-time size check already in hero-spec §11 and assumption A8.
3. **It cannot make `full` reachable on hardware that cannot reach it.** If a
   design only reads as expensive at `full`, the probe protects the frame rate
   and does nothing for the design.
4. **It floors the failure; it does not raise the ceiling.** It measures the
   rate the visitor *is getting*, never the rate a better-authored scene could.
5. **Detection latency is real:** worst case before rung 1 lands is settle
   (1.5 s) + three windows (~6 s) ≈ **7.5 s of degraded frames**, not removable
   without making false trips likely.
6. **Real-device measurement is still the only thing that says where the tier
   boundary actually falls.** Which rung a given phone settles on, and whether it
   still looks good there, is unanswerable from a laptop.

### 7.1 What A1 becomes

A1 stops being a **safety gate** and becomes a **quality question**, answered
whenever a device is available. Exact replacement text for ASSUMPTIONS.md:

> ## A1 — Scroll-linked 3D is *good* on mid-range mobile browsers
>
> **Status:** `OPEN-QUALITY` · **Confidence:** medium · **Blocks:** nothing
>
> Safety is handled by design: `motion-tiers-spec.md` makes tier selection
> runtime-measured and one-way, so no device is served a hero it cannot render.
> What remains unknown is **which rung** a ~€150 Android settles on, and whether
> the hero still looks expensive there.
>
> **Verify:** whenever such a device is available; protocol VERIFICATION §2,
> unchanged. Record the settled rung, not only the FPS.
> **If the answer is "static on most phones":** the 3D hero is a desktop
> flourish, not the centrepiece — reposition the marketing around determinism
> and accessibility. **That is a positioning change, not a stop.**

This adds a fifth status value, `OPEN-QUALITY`, to ASSUMPTIONS.md's legend —
*"answering it improves the product; not answering it blocks nothing."* Add it
deliberately, or the status line lies.

### 7.2 The product claim must be worded accordingly

VERIFICATION §4's rule applies: no test, no claim.

- **Not:** "3D that runs at 60fps on any phone" — untested and untrue.
- **Not:** "automatically optimised for every device" — fluff, unfalsifiable.
- **Claim:** *"Every 3D hero ships three tiers and picks one by measuring the
  frame rate on the visitor's device. If it can't hold the rate it steps down,
  and if it can't render at all it shows the poster. Nobody gets a slideshow."*
- **Backed by** the §8.1 ladder assertions and §8.2 decision tests. Add the row
  to VERIFICATION §4.

---

## 8. M0, rewritten

M0 stops being blocked on hardware nobody has. It keeps every criterion that
never needed a phone and adds the ones this document creates.

### 8.1 Measurable on a development laptop

| # | Check | Pass |
|---|---|---|
| 1 | `full` sustained FPS, 10 s scroll, 2021+ laptop | **p5 ≥ 50 fps** (p95 ≤ 20.0 ms) — unchanged from VERIFICATION §2 |
| 2 | Heap growth over 5 mount/unmount cycles | **< 5 MB** — `dispose()` correctness |
| 3 | Headline paints before the canvas | LCP element is the `<h1>` (hero-spec §8) |
| 4 | Hand-written hero source | **≤ ~250 lines**, probe module counted separately (A2) |
| 5 | Draco model | **< 5 MB** (A8) |
| 6 | Each of the 8 rungs forceable **and its effect measured** | pixel ratio, post-pass count and camera-subscription count each match the rung |
| 7 | Probe overhead: same scene, `?az-probe=off` vs on | **p95 delta < 0.5 ms** — §4's cost claim, measured not asserted |
| 8 | Context loss → `static` | forced via `WEBGL_lose_context`; poster appears, no console error, `alt` present |
| 9 | Decision function, synthetic traces | §8.2 |

### 8.2 Decision-function unit tests — no browser, no flake

| Trace fed to the pure decision function | Required outcome |
|---|---|
| steady 16.7 ms | never leaves rung 0 |
| steady 40 ms from `lite` | reaches `static` within 4 windows, and not before 3 |
| 16.7 ms with one 300 ms spike per 10 s | **never downgrades** — outlier rule plus confirm count |
| alternating good/bad windows | **never downgrades, never oscillates** — the counter resets |
| 16.7 ms ramping to 30 ms over 6 minutes | the §4 drift check trips exactly once |
| any trace, after reaching `static` | tier never decreases — the ratchet holds |
| fewer than 90 samples | no decision is taken at all |

Row 4 is the one that matters: **reintroduce the ratchet bug and confirm this
test fails on that assertion.** A hysteresis test that passes with the hysteresis
removed is decoration.

### 8.3 Synthetic-throttle protocol — a weaker proxy, labelled as such

VERIFICATION §2 is right that CPU throttling **does not reproduce mobile GPU or
thermal behaviour**. This does not contradict it: the protocol tests **the
detector**, not the device. Serve the M0 hero, apply DevTools CPU throttling at
4× and 6×, run §8.1 checks 6–9 under each.

| Reproduces | Does **not** reproduce |
|---|---|
| main-thread starvation, JS-bound frame cost | mobile GPU fill rate and memory bandwidth |
| the probe firing under real `requestAnimationFrame` timing | tile-based deferred rendering behaviour |
| rung transitions landing during real scroll | driver and shader-compiler differences |
| §5's deferred-transition timing | thermal throttling curves; memory pressure and tab eviction |

For thermal: ramp a synthetic per-frame load over 6 minutes and assert the §4
drift check trips. **This tests the drift detector, not thermal throttling** —
say exactly that in the results, or the record reads later as device evidence.
Every number from this protocol is tagged `proxy` in ASSUMPTIONS.md per
VERIFICATION §2; proxy and real-device figures must never be averaged, ranged, or
quoted interchangeably.

### 8.4 M0 exit criteria

- [ ] §8.1 checks 1–9 pass on the laptop
- [ ] §8.2 traces all pass, **and row 4 fails when the ratchet is removed**
- [ ] §8.3 run at 4× and 6×, results recorded with the labelling above
- [ ] A2 and A8 updated to `HOLDS` or `FAILED` — both are device-independent
- [ ] A1 replaced with §7.1's text; `OPEN-QUALITY` added to the legend
- [ ] **A1b** added — *"the probe picks the right tier, including under throttle,
      and the ladder degrades before a visitor notices"* — verified by §8.1
      check 6, §8.2 and §8.3, plus recording rung transitions on video and
      checking whether the change is identifiable without the debug overlay.
      This is the assumption VERIFICATION §6 names as M0's exit condition

⛔ **The stop gate moves.** M0 no longer halts on a phone; it halts on §8.2. **If
the tier cannot be shown stable and one-way under synthetic traces, do not build
the compiler around it.** An oscillating tier is worse than the static table it
replaced.

---

## 9. Instrumentation — a silent downgrade is a bug

A tier that drops with no way to see why is untraceable for the author and
unreportable by the visitor. Development mode only, behind `import.meta.env.DEV`
so it tree-shakes out of production — verified by `pnpm size` and by grepping
`dist/` for the debug string *with a control string known to be present*:

1. **One console line per transition**, prefixed `[az:tier]`, naming the trigger
   **and its number**:
   `[az:tier] rung 1→2 (post-fx off) · trigger: 3 windows p95 over 20.0ms · p50 18.4 p95 24.1 · t+8.2s`.
   A log saying a downgrade happened without saying which threshold fired is
   itself a bug — fix it in the log, not by guessing later.
2. **`window.__AZ_TIER__`** — entry tier and the *reason* for it; every §2
   signal's raw value **and which were missing**; ceiling; current tier and rung;
   ratchet armed or not; last window's p50/p95 and sample count; the full
   transition list; nominal refresh interval; discarded-outlier count.
3. **A corner overlay** at `?az-tier-debug=1` — tier, rung, live p50/p95 in both
   ms and fps, ratchet state, and a sparkline of the long-horizon buffer, without
   which §4's drift check is invisible.
4. **The one pre-ship signal an author gets** is hero-spec §11's model-size
   warning; its message should point here.

Production: nothing logged, nothing stored beyond §3.7's `sessionStorage` value.
No telemetry, ever — PRD principle 1.

---

## 10. Browser APIs — verification status

Every API named above genuinely exists. These are flagged for **availability or
version**, not because their existence is doubtful:

| API | Flag | Note |
|---|---|---|
| `navigator.deviceMemory` | verify before implementing | Chromium-only; absent in Firefox and Safari. §2.1 covers the absence |
| `navigator.connection.saveData` | verify before implementing | Chromium-only. The `Save-Data` *header* is unavailable to a static site at all |
| `PerformanceObserver` `'long-animation-frame'` | verify before implementing | recent and Chromium-only. Would improve §9's attribution; nothing here depends on it |
| `EXT_disjoint_timer_query_webgl2` | verify before implementing | genuinely a WebGL2 extension, but frequently unavailable for fingerprinting reasons. GPU-time attribution is a nice-to-have, not a dependency |
| `WEBGL_debug_renderer_info` | verify — and prefer not to use | restricted in several browsers, and a GPU blocklist is the build-time guessing being removed |
| `matchMedia('(prefers-reduced-data: reduce)')` | verify before implementing | a real Media Queries Level 5 feature with limited support; a cleaner signal 8 than `saveData` if available |
| `requestIdleCallback` | verify before implementing | non-Chromium support is recent. Only used to schedule §5's deferred rungs, and `setTimeout` is an acceptable fallback |
| R3F `frameloop="demand"`, `performance.regress()`, `<Canvas performance>` | verify against the pinned version | `@react-three/fiber@8.17.10` per PRD §6.7 — do not assume an API from a newer release |
| Vite `import.meta.hot.send` (surfacing transitions in the `az dev` terminal) | verify before implementing | optional §9 nicety; needs a dev-server plugin |

Used unflagged, as unambiguously standard and widely available:
`matchMedia('(prefers-reduced-motion: reduce)')`, `navigator.hardwareConcurrency`,
`requestAnimationFrame`, `performance.now()`, `document.visibilityState` and
`visibilitychange`, `sessionStorage`,
`canvas.getContext('webgl2', { failIfMajorPerformanceCaveat })`, the
`webglcontextlost` event, `WEBGL_lose_context`, `URLSearchParams`,
`import.meta.env.DEV`, and three.js `WebGLRenderer.getPixelRatio()`.
