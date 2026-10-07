# ASSUMPTIONS

Beliefs this project is built on that are **not yet proven**. Each has a
verification method and a stated consequence if false.

**Rule for the agent: do not treat any `UNVERIFIED` assumption as fact in code
comments, docs, or user-facing copy.** If work depends on one, say so.

Status values: `UNVERIFIED` · `TESTING` · `HOLDS` · `FAILED`

`HOLDS (proxy only)` is `HOLDS` on the laptop-plus-synthetic-throttle proxy
(`motion-tiers-spec.md` §8.3) and nothing else. Per VERIFICATION §2 it is never
device evidence and is never quoted as such.

---

## A1 — Scroll-linked 3D is viable on mid-range mobile browsers

**Status:** `UNVERIFIED` · **Confidence:** medium · **Blocks:** *nothing —
downgraded from project-gating on 2026-08-21*

The `full` motion tier assumed a scroll-linked R3F scene sustains an acceptable
frame rate on a ~€150 Android in Chrome, and the whole roadmap was gated on
proving it once, by hand, on a borrowed device.

**Why it no longer gates.** The risk was never "we might be wrong about
phones" — it was "we might *ship* a 12fps hero to a real visitor." Tier
selection is now measured at runtime by the site itself and ratchets downward
(`motion-tiers-spec.md`), so a device that cannot sustain the budget is served
`lite` or `static` instead. The failure this assumption guarded against can no
longer reach a visitor, whatever A1's answer turns out to be.

**What is still unknown, and is now a quality question:** *where* the boundary
falls. How many real phones land in `full` versus `lite` determines how
impressive the mobile web experience is, and no runtime probe tells us that
from here — only a real device does.

**Verify:** whenever a mid-range Android is available — before M5 for the
dogfood site, not before M1. Protocol in VERIFICATION §2 (now labelled as the
*full-confidence* protocol). The laptop-plus-throttle proxy in
`motion-tiers-spec.md` §8 is what M0 can run, and it is explicitly weaker.
**Threshold:** `lite` ≥ 30fps sustained (p5) over 10s of scroll on the target
device; `full` ≥ 50fps (p5) on a 2021+ laptop.

**If FAILED:**
- nothing breaks and nothing stops — the probe already handles it
- the marketing claim narrows: 3D is a desktop-and-capable-device experience,
  gracefully degraded elsewhere. Say that plainly rather than implying
  universal 3D
- consider making `static` the default tier for the `full` hero variant

⚠ **Do not treat A1 as settled because the gate was removed.** The gate was
removed because the *consequence* was mitigated, not because the *question*
was answered. Any user-facing copy claiming good 3D performance on mid-range
phones remains unsupported until this says `HOLDS`.

---

## A1b — A runtime frame-rate probe can pick the right tier

**Status:** `HOLDS (proxy only)` — on this laptop and the synthetic-throttle
proxy; no genuinely slow device has run it · **Verdict 2026-10-07** (M0 spike;
first measured 2026-08-21) · **Blocks:** the A1 mitigation, and therefore the
3D positioning

New assumption, created when A1 was downgraded. It is the load-bearing one now:
that a short in-page probe can distinguish a device that will sustain the frame
budget from one that will not, **early enough to matter and without false
positives that needlessly downgrade a capable device.**

Specific ways it could be false, each of which must be checked:
- initial-load jank makes a fast device look slow → the settle period is wrong
- thermal throttling arrives after the probe window → a device passes, then
  degrades anyway
- the frame budget is met while the *interaction* still feels bad, so fps was
  the wrong metric
- the downgrade itself is visible enough to be worse than never having offered
  `full`

**Verify:** M0 — build the probe alongside the three tiers and confirm it
selects correctly on every device available, including a deliberately
throttled one. **Threshold:** correct tier chosen within the settle window on
every test device; zero oscillation across a 60s scroll; no capable device
downgraded.
**If FAILED:** fall back to the static capability gate alone (WebGL2,
`deviceMemory`, `prefers-reduced-motion`) and set the default tier
conservatively to `lite`. That is a worse product but a safe one — and it puts
A1 back in the critical path, so re-read this file before re-planning.

### Verdict — 2026-10-07: `HOLDS (proxy only)`

The devices available are this laptop (the 2020 machine of the 2026-09-22
record below, headless `chromium` channel on its hardware GPU — the renderer
string `test:m0` prints first names the GPU, not a software rasteriser) and
the synthetic-throttle proxy of `motion-tiers-spec.md` §8.3,
which §8.4 names as A1b's evidence alongside §8.1 check 6 and §8.2. On both,
the probe picked the right tier, never oscillated, and did not downgrade the
capable case. Every figure below was re-run on 2026-10-07 (load average 5–16
from parallel work during the runs).

| Device / input | Command | Right tier | Result |
|---|---|---|---|
| — (pure function) | `pnpm test:decision` | §8.2 rows | **ALL PASS**, 15 assertions; row 4 "200 windows judged, none" with its control "0→1" |
| — (pure function) | `pnpm test:probe` | §2 gate, §6.1, ladder | **ALL PASS**, 31 assertions; closed loop "path 1→2→3→4" rests at rung 4 |
| laptop, probe on, 4× CPU throttle [proxy] | `pnpm test:m0` | `full` (frames still meet 20 ms) | rung 0 held 60 s, "applied path 0; decisions none", frame p95 18.4 ms |
| laptop, probe on, 6× CPU throttle [proxy] | `pnpm test:m0` | `full` | rung 0 held 60 s, "applied path 0; decisions none", frame p95 18.5 ms |
| laptop, `?az-load=22` [proxy] | `pnpm test:m0` | below `full` | "applied path 0→1→2→3→4→5" in 60 s, one way; decide→apply lag "1:293ms 2:90ms 3:2143ms 4:2135ms 5:2235ms" |
| laptop, `?az-load=22`, 100 s [proxy] | scratch run, below | `lite` (≈22.5 ms frames: over the 20 ms `full` floor, under 33.3 ms) | `"appliedPath":"0→1→2→3→4→5→6","oneWay":true`, rests at rung 6 `lite` from 63.7 s to 100 s, last window p95 23.3 ms |
| laptop, `?az-load=10`, 40 s [proxy] — control | scratch run, below | `full` | `"appliedPath":"0","finalTier":"full"`, 19 windows judged, no transitions |
| every rung forced | `pnpm test:m0` #6 | as forced | 8/8 PASS, effects read back (dpr 2/1.5/1.5/1.5/1/1/1/—, verts 5488→3430 at rung 5, camera subs 1→0 at rung 6) |

`pnpm test:m0` ended `ALL PASS` (exit 0, 5 m 10 s). The two scratch rows come
from a throwaway browser-automation script (not committed) that loads the built spike
on `vite preview` with the same GPU channel, DPR 2 and 1440×900 viewport as
`m0.test.ts`, drives the same 4 s triangle-wave scroll, polls
`window.__AZ_TIER__.rung` every 250 ms, and prints the engine's own transition
list — `5→6@63.7s[3 windows p95 over 20ms (last p50 22.5 p95 23.3)]` was the
last.

**How the threshold reads.** "Correct tier within the settle window" cannot
mean every step lands inside §3.2's 1.5 s settle: the settle period discards
samples by design, and §7 item 5 puts the worst case to rung 1 at ~7.5 s.
What the runs show is that the **entry** tier was right at once on the
capable laptop and never changed, and that under load the ladder reached the
right tier at the designed rate (one rung per ~10.8 s, `lite` at 63.7 s)
and stayed there.

**Why `proxy only`.** CPU throttling cannot starve this scene on this GPU
(4× and 6× leave frames at 18.4–18.5 ms), so the step-downs come from an
injected per-frame load, not from a slow device. Nothing here reproduces a
mobile GPU, thermal throttling or memory pressure (§8.3). §8.4's last A1b
item — **recording rung transitions on video and judging whether they are
visible without the debug overlay — was not done**. The verdict becomes plain
`HOLDS` only when a genuinely slow device has run the probe; A1 stays
`UNVERIFIED` because no mid-range device was measured.

### What has been verified — 2026-09-22 (supersedes the 2026-08-21 record)

The probe was rebuilt to `motion-tiers-spec.md` as written: the 8-rung ladder
(§5) as data, the §2 gate with ceilings and §2.1 missing-signal handling, and
the decision function (§3–§4) as a deterministic engine fed intervals, with
`simulate(trace)` as its pure form (`spike-m0/src/tiers.ts`).

**§8.2 — decision function, synthetic traces** (`pnpm test:decision`, 15
assertions, one control per row) — all pass:

- steady 16.7 ms: never leaves rung 0 over 10 minutes (298 windows)
- steady 40 ms from `lite`: `static` after exactly 3 windows
- 16.7 ms with one 300 ms spike per 10 s: never downgrades
- alternating good/bad windows: 200 windows, never downgrades
- 16.7→30 ms ramp over 6 minutes: the drift **detector** trips exactly once.
  In this open-loop trace every step-down (0→6, first at 94.3 s) comes from the
  3-window rule; the drift trip lands at `lite`, where the floor is not
  breached, so it steps nothing down. It tests the detector, not thermal
  throttling
- after `static`, 10 minutes of 8 ms frames never climb back; the one §3.6
  promotion happens once and never again
- 89 samples then a hidden tab: no decision; the control with 90 is judged

**The row-4 proof the spec demands was run.** With the strike counter no longer
reset by a passing window, row 4 fails on its assertion (cascade 0→6). With an
upgrade rule injected, row 6 fails — with the setter's ratchet intact (an
extra promotion slips in before arming) and with it removed (0→3→0
oscillation). Restoring the file restores ALL PASS.

`pnpm test:probe` — 31 assertions: every §2 gate row, §2.1 missing signals,
§6.1 forcing and its guard rails, ladder shape, settle, the hidden-tab gap,
context loss, post-transition settle, and a closed loop resting at rung 4.

**In a browser, on a real GPU** (`pnpm test:m0`, Playwright `chromium`
channel headless → ANGLE Metal, Apple M1, 2020 MacBook — one year older than
§8.1's "2021+ laptop"):

| §8.1 | Result |
|---|---|
| 1 `full` sustained, 10 s scroll, DPR 2 | **PASS** p50 16.7 ms, p95 18.3 ms (p5 55 fps) |
| 2 heap over 5 mount/unmount cycles | **PASS** +1.0 MB (JS heap only; GPU memory not measured) |
| 3 LCP element | **PASS** `<h1>` |
| 6 each rung forced, effect read back | **PASS** 8/8 — pixel ratio 2/1.5/1.5/1.5/1/1/1/—, shadow map on→off at rung 3, camera scroll subscriptions 1→0 at rung 6, vertices 5488→3430 at rung 5, canvas gone at 7. Post-pass count is 0 at every rung: **the spike has no post-fx chain**, so rung 2 has nothing to remove here |
| 7 probe overhead | **PASS** frame p95 delta on−off −0.10 / +0.10 ms across two runs; the probe's own per-frame cost p95 0.1 ms |
| 8 context loss | **PASS** `WEBGL_lose_context` → rung 7, poster with its text alternative, no console error |
| 4, 5 | see A2; Draco (A8) not built |

**§8.3 — proxy, never device evidence.** At 4× and 6× CPU throttle the scene
held rung 0 for 60 s of scroll (frame p95 18.3 / 18.4 ms). A control shows the
throttle is applied (a fixed JS loop: 24 → 87 → 135 ms) — **this scene's
per-frame main-thread work is too small for CPU throttling to starve it on
this GPU, even at 40×**, so the spec's throttle protocol does not exercise the
detector here. A synthetic 22 ms/frame load (`?az-load=22`, spike-only) does:
0→1→2→3→4→5 in 60 s of continuous scroll, one way, about one rung per 10.9 s;
rungs 1–2 applied within ~200 ms of the decision, deferred rungs 3–5 at 2.25 s —
the 2 s deadline under a scroll that never idles, plus polling. Rung
transitions have not been recorded on video.

**Two spec gaps found while implementing.** (1) §3.6 promotes by measuring
two windows *while rendering `lite`*, but §5.1 puts `lite` on on-demand frames,
which have no frame rate. The spike keeps the loop running until the ratchet
arms, then drops to on-demand; after that `lite → static` can only come from
freezes or context loss, not the 33.3 ms floor. (2) SwiftShader passes
`failIfMajorPerformanceCaveat`, so §2 #3 does not catch it; and in the default
headless shell a SwiftShader frame takes ~600 ms, so §3.2's 60 warm-up frames
take ~36 s.

**A snapshot pinned to `lite` is reproducible — 2026-10-06.** Headless
`chromium` (SwiftShader, CPU raster), viewport and DPR 1 fixed, light scheme,
`?az-probe=off`, fonts settled, CSS animations disabled, page at rest (rung 6
has no scroll-linked camera, so nothing moves):

- spike (`spike-m0`, `pnpm test:snapshot`, 1280×720, the timing readout
  masked): `?az-rung=6` PNG sha256 `cf1eec2f038c0a5d` in two fresh contexts
  and again after relaunching the browser; `?az-tier=lite` gives the same
  bytes; **control** `?az-rung=4` gives `64109f447f5ba166`. Same hashes on 3
  consecutive runs.
- generated site (`pnpm test:3d`, 1440×900, the procedural `hero full 3d`):
  `?az-tier=lite` lands on rung 6 with the hero live; the 71,094-byte PNG is
  byte-identical in two fresh contexts and after a browser restart;
  **control** — the same page under another site name (another seed,
  scene-spec §11.1) renders different bytes.

Exact bytes, so no perceptual threshold was needed. This holds for a CPU
rasteriser; a GPU driver is not claimed to be byte-stable.

### What is still open

No genuinely slow device has run the probe; every threshold is validated only
on one fast machine and synthetic traces. The ladder's post-fx and shadow rungs
have no real cost to remove in this scene, and rung 6's ease-to-rest (§5.1
step 2) and the poster cross-fade are not built. Rung transitions have not
been recorded on video. The status is qualified `proxy only` until the probe
has run on at least one genuinely slow device.

---

## A2 — R3F keeps word emitters short

**Status:** `HOLDS` for structure (256 code lines, at the edge of ~250) ·
`FAILED` for a distinctive word (506) — remedy already taken ·
**Recounted 2026-10-07** (M0 spike, `spike-m0/`; first measured 2026-08-21)

Declarative R3F should map near 1:1 from the DSL, keeping `emit.web.ts` files
readable.

**Verify:** M0 — count lines of the hand-built hero. **Threshold:** the `hero`
emitter fits in ~250 lines.
**If FAILED:** emitters become string-heavy and contributor-hostile. Consider
shipping runtime React components that words merely configure, rather than
emitting JSX.

### 2026-09-23 — the `If FAILED` remedy, taken

The compiler's 3D runtime took the remedy this assumption names: words emit
data and a tested runtime renders it. A 3D view in `hero`, `scene` or
`gallery` is one element with `data-az-*` attributes (about 30 lines of each
emitter, no JSX, no shader text); `packages/scene-runtime` owns the renderer,
the generator and the shaders. The runtime is DOM-driven rather than R3F —
one shared renderer drawing every view by scissor (scene-spec §5) needs no
React binding — so generated sites depend on `three` alone. The measurements
below stay the spike's record.

### Verdict — 2026-10-07, recounted on the spike as it stands

Code lines = lines with anything left after comments are removed (blank,
`//`, `/* */` and JSX `{/* */}` lines dropped; strings respected). Counted with
a throwaway scanner (not committed). On the 2026-09-22 commit `5b21a19` it
gives `Hero.tsx` 320 / `material.ts` 84 where the table further down says
314 / 78, and matches `geometry.ts` 78 and `tiers.ts` 336 exactly. The older
counting rule is not recorded (one candidate: this scanner keeps `//` lines
inside GLSL template strings as code), so the figures below differ from the
older tables by up to 6 lines per file for method alone.

| What was counted (`spike-m0/src/`) | Code lines | vs ~250 |
|---|---|---|
| `Hero.tsx` as it stands | 351 | — |
| minus spike-only instrumentation: debug readout `<section className="readout">` (35), `__AZ_TIER__` publishing and its `declare global` (16), measurement read-back — `Measured`, the publish in `RendererWatch`, the probe-cost timer, the `measured` ref (32), and the `?az-load` hook (12) | **256** | **holds, at the edge** — 2.4% over the round number |
| of those 256: the opt-in model path (`ModelBoundary`/`Model` wiring, its state and the lazy import, 23) and the page frame/pattern hookup (`layout.ts`/`patterns.ts` calls, 23) — both added after 2026-09-22 | 46 | 210 without them |
| + the distinctive look: `geometry.ts` 78, `material.ts` 84, `seed.ts` 43, `framing.ts` 45 | **506** | **fails** |
| counted separately, not in either row: probe `tiers.ts` 341; model loader `model.tsx` 107 + `model-url.tsx` 37; frame `layout.ts` 78, `patterns.ts` 122; theme `shades.ts` 68 (not imported by the hero) | — | — |

- **Structural half — `HOLDS`.** 256 against "~250" is inside the stated
  approximation, not under the round number; read as a hard ≤ 250 it would
  miss by 6. The hero's structure did not run away as features landed: the
  growth since 2026-09-22 is the opt-in model and the frame, each a few
  declarative lines.
- **With-look half — `FAILED`.** 506, double the budget; the generator and the
  surface code are what break it, as on every earlier count. The `If FAILED`
  path is the one already taken on 2026-09-23 (above): the look lives in
  `packages/scene-runtime` and words emit data. Nothing further to do.

### Measured result

| What was counted | Lines | vs ~250 threshold |
|---|---|---|
| Hero structure alone (JSX, hooks, layout) | **200** | passes |
| + the GLSL shader strings | **234** | passes |
| + the procedural generator (`geometry.ts`) | **347** | **fails** |

**The split predicted below is real, and the threshold lands between the second
and third rows.** Scene structure in R3F genuinely is short. What breaks the
budget is the geometry generator, not the JSX.

Two caveats that make 200 an *over*-estimate of a real emitter, both of which
strengthen the structural conclusion: the spike's hero carries ~35 lines of
debug readout UI no emitted hero would contain, and its comment density is far
above production. A real `emit.web.ts` for this hero would be well under 150.

**Consequence, and it is the useful one:** the remedy this assumption named as
a fallback should be adopted as the *design*. Ship the generator and the
shaders in a tested runtime package; let the emitter pass seeds and uniforms.
That keeps `emit.web.ts` declarative and short **and** keeps the distinctive
look, instead of trading one for the other.


### Re-measured 2026-09-22 — after the 8-rung ladder

Counted as code lines (no blank or comment lines), so the numbers do not move
with comment density. The probe module is counted separately, per §8.1 check 4.

| What was counted | Code lines | vs ~250 |
|---|---|---|
| `Hero.tsx` as it stands | 314 | fails |
| minus debug readout (35), `__AZ_TIER__` instrumentation (13), measurement publishing (18) and the `?az-load` test hook (11) | **237** | **passes** |
| + the distinctive look: `geometry.ts` 78, `material.ts` 78, `seed.ts` 43, `framing.ts` 45 | **481** | **fails** |
| probe module `tiers.ts` (counted separately) | 336 | — |

The split holds: the structural hero fits, and adding the ladder did not push it
over; the generator and surface code are what break the budget. The consequence
above stands.

### Evidence gathered 2026-08-21 — the assumption holds for *structure*, and the risk sits elsewhere

**Supporting.** The official R3F documentation states it "merely expresses
Threejs in JSX", that `<mesh />` "dynamically turns into `new THREE.Mesh()`",
and that "everything that works in Threejs will work here without exception"
([r3f.docs.pmnd.rs/getting-started/introduction](https://r3f.docs.pmnd.rs/getting-started/introduction)).
Scene *structure* — meshes, lights, cameras, materials, hierarchy — really is
close to 1:1 with a declarative DSL, which is the part A2 asserts.

**Qualifying, and this is the part to watch.** The teardown in
`3d-technique-reference.md` found that the visually distinctive work in a
current reference scene is **not** declarative: custom `ShaderMaterial`s, GLSL
patched into stock materials via `onBeforeCompile`, per-instance buffer
attributes rewritten each frame, and procedural canvas textures. All of that is
imperative three.js living *inside* an R3F component. JSX does not shorten it.

**So A2 splits into two claims, and only the first is safe:**

| Claim | Status |
|---|---|
| R3F keeps *scene structure* short in an emitter | supported — the docs describe exactly this |
| R3F keeps a *visually distinctive* word short | **unsupported** — the distinctive part is shader and buffer code JSX does not compress |

**Consequence for the M0 count.** A `hero 3d` that is a lit model on a camera
path will comfortably fit ~250 lines. A `hero 3d` carrying the material and
reveal techniques that make a scene look expensive will not, because the shader
source travels with it. **Measure both at M0** and record them separately —
a single number here would hide the distinction that matters.

**This strengthens, not weakens, the `If FAILED` remedy.** Shipping runtime
React components that words configure is the natural home for shader-heavy
work: the GLSL lives once in a tested runtime package, and the emitter passes
uniforms. That keeps `emit.web.ts` declarative *and* keeps the distinctive
look, and it is worth considering before M2 rather than only on failure.

---

## A3 — Indentation-based grammar is sufficient

**Status:** `UNVERIFIED` · **Confidence:** medium

That nesting by indentation expresses every layout a real site needs, with no
conditionals, loops, or variables (PRD principle 7).

**Verify:** M5 — build a real client site and count escape-hatch uses.
**If FAILED:** the temptation will be to add logic. **Do not.** Add words or
slots instead. Adding control flow turns this into a bad programming language.

---

## A4 — Eleven blocks cover a real marketing site

**Status:** `UNVERIFIED` · **Confidence:** low-medium · **This is the M5 gate**

**Verify:** M5. **Threshold:** ≥80% of the site built in words alone
(escape-hatch ratio, PRD §9).
**If FAILED at 50–79%:** normal — note which blocks were missing, add them in
Phase 1.5. **If FAILED below 50%:** the block abstraction is wrong. Stop and
reconsider the grammar before adding anything.

---

## A5 — Contributors will write word packs

**Status:** `UNVERIFIED` · **Confidence:** low

The maintenance ceiling (~40–50 words solo) is only escapable if others
contribute.

**Verify:** 6 months post-launch. **Threshold:** ≥3 packs from people who
aren't you.
**If FAILED:** cap the word count and position AZ as a curated tool, not a
platform. That is a viable outcome — but stop building registry infrastructure.

---

## A6 — `vite-react-ssg` gives adequate SEO

**Status:** `UNVERIFIED` · **Confidence:** medium

**Verify:** M5 — Lighthouse SEO ≥ 95, and confirm rendered HTML contains real
content with JS disabled.
**If FAILED:** switch the web target to Astro + React islands. This is why
`core` must not know the framework — the swap should touch only `target-web`.

### Progress (2026-09-23): the HTML half, without `vite-react-ssg`

The pre-render is the target's own, not the dependency: a generated project's
`npm run build` is `node az-vite/build.mjs` — Vite's client build, then an SSR
build of `src/entry-server.tsx` (`renderToString`), then every route's
`index.html` gets its page's markup inside `#root`. The client hydrates
(`hydrateRoot`) a root that has markup and renders one that does not (the dev
server). The build fails on any `console.error` during the pre-render, which
is where React reports a server-side problem. No new dependency: `react-dom`
and `vite` already are.

Measured, on what ships (`dist/`), not on a render in the test process:

- `pnpm verify:build`: every route's `dist/…/index.html` carries its page
  inside `#root`; the build and its pre-render print nothing.
- `pnpm test:visual` / `pnpm gate`, per word preview: `no-js` loads the page
  with JavaScript disabled — `<main>` has content, every FAQ answer is open
  and readable, an auth form has a field and a submit, a dynamic footer year
  shows its fallback; `hydration` loads it with JavaScript on and fails on
  any console or page error until the runtime marks it ready. Both are
  self-tested against an empty-root page and a half-rendered one.

Still open: the Lighthouse SEO score (M5). Status stays `UNVERIFIED` until it
is measured.

### Pre-M5 evidence (2026-10-07): synthetic sites, local — not the M5 verdict

`pnpm test:lighthouse` (stack-evaluation §17: Lighthouse 13.5.0, headless
Chrome for Testing 153, default config — mobile emulation, simulated
throttling) on 29 production builds: every word preview, the GRAMMAR §8
fixture, and `combined` (nav, hero `full 3d`, feature, gallery, pricing,
cta on one page). Each is served locally with gzip, its first page audited
three times on a quiet machine (no gate, visual or test-3d running);
perf is the median, with all three runs shown. These are this repository's
own sites on a laptop, not a real client site on a real host, so **the M5
box stays open** and the status stays `UNVERIFIED`.

Two defects were in every site, both in `target-web`, fixed there:

1. **No meta description** (SEO 90–91). A page now describes itself with
   its own lead copy — the first paragraph after its first heading
   (`target-web/src/head.ts`); a page with no such paragraph gets no tag
   rather than an invented one. Tests: `packages/target-web/test/head.test.ts`,
   and `verify:build` reads it from the shipped `/` and `/legal`.
2. **A 404 for `/favicon.ico` on every page view** (best practices 96: a
   console error). The grammar has no site icon, so each page now declares
   an empty one (`<link rel="icon" href="data:,">`) and the browser asks for
   nothing. Same tests.

| site | perf runs (before / after) | perf | a11y | best practices | SEO |
|---|---|---|---|---|---|
| auth | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| auth.signup | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| cta | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| cta.split | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| faq | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| faq.columns | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| feature | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| feature.rows | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 91 → 100 |
| footer | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 (no lead copy) |
| footer.columns | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 (no lead copy) |
| footer.mega | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 (no lead copy) |
| gallery | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 91 → 100 |
| gallery.carousel | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 91 → 100 |
| gallery.orbit | 96 100 100 / 97 100 100 | 100 | 100 | 96 → 100 | 91 (no lead copy) |
| hero | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| hero.full | 97 99 100 / 99 97 97 | 99 / 97 | 100 | 96 → 100 | 90 → 100 |
| hero.split | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| nav | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 91 (no lead copy) |
| nav.bar | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 91 → 100 |
| nav.full | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 91 (no lead copy) |
| nav.mega | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 (no lead copy) |
| nav.sheet | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 91 (no lead copy) |
| pricing | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| pricing.table | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| scene | 97 98 99 / 97 99 98 | 98 | 100 | 96 → 100 | 90 → 100 |
| text | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| text.columns | 100 100 100 / 100 100 100 | 100 | 100 | 96 → 100 | 90 → 100 |
| grammar-fixture | 96 97 99 / 95 96 99 | 97 / 96 | 100 | 96 → 100 | 91 → 100 |
| combined | 97 98 99 / 99 98 99 | 98 / 99 | 100 | 96 → 100 | 91 → 100 |

"No lead copy": the preview's page is a title-only hero plus the word, with
no paragraph after a heading, so it honestly has no description. A real
page in that shape would score the same; the author's remedy today is a
`sub`. An author-written description (a `site` / `page` key) is a grammar
decision for M5, before the freeze.

What this does and does not show:

- **Accessibility was 100 on every site before any change**; perf ≥ 95
  everywhere on a quiet machine. The M5 targets (perf ≥ 85, SEO ≥ 95,
  a11y 100) are met by every site with lead copy.
- **Perf is load-sensitive.** Earlier single runs of the fixture and
  `combined`, while other work loaded the machine, scored 63–75 (TBT 1.3–3 s);
  the same builds on a quiet machine score 96–99. A profile showed no long
  task of the site's own in a quiet run (the 3D start is ~40 ms, the first
  draw ~12–18 ms, unthrottled). M5 should measure several runs on a quiet
  machine, or a lab, not one.
- Diagnostics left as they are, none moving a score below target: unused
  JavaScript (React and the runtime, ~35–42 KiB; the 3D chunk ~105 KiB on
  3D pages only — non-3D pages fetch no 3D code), the one render-blocking
  stylesheet (~150 ms estimated), and cache lifetimes (the local server
  sends no cache headers — the host's job).
- Not shown: a real host's compression, caching, TLS and latency; a real
  phone's GPU (headless Chromium draws the 3D canvas on this laptop's);
  pages other than each site's first.

---

## A7 — Theme compliance is mechanically enforceable

**Status:** `HOLDS` · **Verified 2026-08-21** (M2, `packages/theme/src/lint.ts`)

### Measured result

`az lint` rejects a deliberately non-compliant word and accepts the same word
written correctly. Both halves matter: a linter that rejected everything would
satisfy the first test while making the language unusable, so the CONTROL —
that a compliant word produces **zero** findings — is what makes the pass mean
something.

Five rules fire, each naming the fix rather than only the problem
(CONVENTIONS §5): raw hex, raw colour functions, off-scale px, `font-family`,
and raw `z-index`. Deliberate allowances, each with its own test: a `1px`
hairline (theme-spec §6.1 makes it load-bearing), `color-mix` (it composes
tokens rather than naming a colour), and comments.

**Static text analysis was sufficient** — no AST needed. A word's source may be
TSX, CSS-in-JS or a template literal, and every banned value is recognisable in
all three without parsing any of them. The fallback this assumption named — a
runtime token-only API — is not required.

**Scope is the caller's job, not the linter's.** Raw values are legal in
`packages/theme` and nowhere else (theme-spec §4); the linter still flags them
there, and a test records that deliberately so nobody later "fixes" the linter
into ignoring hex everywhere.

That `az lint` can catch off-theme values by static analysis of word source.

**Verify:** M2 — write a deliberately non-compliant word, assert lint fails.
**If FAILED:** fall back to runtime token-only APIs (no raw style props reach
the emitter at all). Do not fall back to code review — it will not hold.

---

## A8 — Draco-compressed hero models fit under 5MB

**Status:** `HOLDS` on the opt-in model path, for geometry · texture weight
unmeasured · **Reproduced 2026-10-07** (M0 spike, `spike-m0/scripts/model.test.ts`;
first measured 2026-09-23) · **Scope: narrowed 2026-08-21 — no longer on the
critical path**

### Verdict — 2026-10-07: `HOLDS` (opt-in path, geometry only)

Re-run on this laptop after `pnpm build`, against `vite preview --port 4173`:

- `pnpm test:model` — **ALL PASS**, exit 0, 15 checks: "A8: the Draco sample
  model is under 5 MB — 0.38 MB for 218880 triangles"; "the model decodes to
  the triangles that were encoded — 218880 triangles"; "the default
  (procedural) page fetches no model code, decoder or file"; "every request is
  same-origin — the decoder is self-hosted, no CDN"; build succeeds with the
  network poisoned; heap growth over 5 model mount/unmount cycles 1.01 MB (JS
  heap only). Load to drawable 628 ms local, 1592 ms on the throttled
  ~10 Mbps / 60 ms link (**proxy**).
- `pnpm model --sweep` — the size table below reproduced to the digit, from
  0.12 MB (54,720 triangles) to 1.13 MB (875,520).

The scope note under the table stands: textures are not measured, and the
sample is a generated product-shaped assembly, not a scanned product.

### Measured result

The opt-in path is built in the spike (`?az-model=sample`; procedural stays
the default): three's `GLTFLoader` + `DRACOLoader`, the glTF decoder bundled
from three itself (same-origin, no CDN — stack-evaluation §0), `dispose()` on
unmount, and the poster while loading or on failure.

The sample is generated, not downloaded (`spike-m0/scripts/make-model.ts`): a
shoe-like assembly — a lathed sole, a smooth upper, six laces — with
positions, normals and UVs, built in three, exported by three's
`GLTFExporter`, and Draco-encoded by the reference encoder through glTF Transform
(edgebreaker, 14-bit positions, 10-bit normals, 12-bit UVs).

| Triangles | Raw .glb | Draco .glb | Ratio | < 5 MB |
|---|---|---|---|---|
| 54,720 | 1.19 MB | 0.12 MB | 9.8× | yes |
| 109,548 | 2.35 MB | 0.21 MB | 11.0× | yes |
| **218,880 (shipped sample)** | 5.92 MB | **0.38 MB** | 15.7× | yes |
| 438,736 | 11.83 MB | 0.65 MB | 18.2× | yes |
| 875,520 | 23.54 MB | 1.13 MB | 20.9× | yes |

In the browser (headless Chromium on this laptop's GPU): the model decodes to
exactly the 218,880 triangles encoded; drawable **520–625 ms** after navigation
from the local server and **1.32–1.54 s** on a throttled ~10 Mbps / 60 ms link
(**proxy** — not a device measurement); heap growth over 5 mount/unmount
cycles **0.86–1.14 MB** across runs (JS heap only); the default page fetches none of the
model code, decoder or file; the build succeeds with the network poisoned.

**Scope of `HOLDS`.** Geometry at realistic web product budgets is an order of
magnitude under 5 MB — ~875k triangles still fits in 1.13 MB. What is **not**
measured: textures. Draco compresses geometry only, and a real product model's
weight is usually its maps; two or three 2K textures can pass 5 MB on their own.
The sample is a product-shaped procedural assembly at a realistic triangle
count, not a scanned product. The texture budget stack-evaluation §15 (question
4) asks for is still the missing half, and A8 says nothing about it yet.

**Verify:** M0, using a realistic product model, not a primitive.
**If FAILED:** the LCP guidance in the hero spec needs revisiting, and the
poster-image path becomes the default rather than the fallback.

**Why it stopped being load-bearing.** A8 used to gate every 3D block, because
`hero 3d` required a `model` and `scene` required one too. `model` is now
**optional** on both, and the default source of geometry is the theme's
procedural scene (scene-spec §11.1). A8 therefore constrains only the
**opt-in product path** — the case where the subject genuinely is a specific
object the visitor is being asked to buy.

The evidence that prompted the change: a current, well-regarded 3D marketing
scene ships **no model at all** and no texture files — every surface is
generated and every map is drawn into a canvas at runtime
(`3d-technique-reference.md` §2). The Draco pipeline is a real requirement for
real products, and it was never the only way to put 3D on a page.

**Consequence for M2.** The asset pipeline (`gltf-transform`, Draco, the 5MB
budget) leaves M2's critical path and becomes author-side tooling documented
alongside the model prop. What replaces it as critical-path work is **A8b**.

---

## A8b — A seeded generator is reproducible across engines

**Status:** `HOLDS` — vertex buffer across builds, runs and three engines;
visual snapshot stable over 10 consecutive runs on the CPU rasteriser ·
**Verdict 2026-10-07** (M0 spike; measured 2026-08-21, engine axis
2026-09-22) · **Blocks:** the procedural default, and therefore the
determinism claim on any page using it

### Verdict — 2026-10-07: `HOLDS`

Every half of the threshold, re-run on this laptop:

- **Builds and runs.** `pnpm test:determinism`, run twice as separate
  processes — **ALL PASS** both times: "3 builds → identical vertex hash —
  cc723c2a1b107de4", "vertex count stable — 4802 vertices", "CONTROL: a
  different seed changes the hash — cc723c2a1b107de4 vs 6b1465d6a818ef5c",
  "CONTROL: fewer strands changes the hash".
- **The page build.** Two `pnpm build`s give the same `dist/` (sha256 of the
  sorted per-file sha256 list, paths under `dist/`: `75db68a0…` both times);
  **control** — a third build with `--base /control/` into the scratchpad
  gives a different list hash (`256fc958…` against `60c49680…` for the same
  `dist/`, both listed with `./`-relative paths).
- **Engines.** `pnpm test:engines` — **ALL PASS**: each of the three engines
  it runs gives `cc723c2a1b107de4`, 4802 vertices, and `6b1465d6a818ef5c` for
  the control seed.
- **Visual snapshots, 10 consecutive runs.** `pnpm test:snapshot` run 10
  times back to back, each exit 0 and **ALL PASS**: every run rendered the
  procedural scene at `lite` (rung 6) as `cf1eec2f038c0a5d` in both fresh
  contexts, after a browser restart and via `?az-tier=lite`, and the rung-4
  **control** as `64109f447f5ba166` — 40 rung-6 screenshots and 10 controls,
  no differing byte. Headless CPU rasteriser; a GPU driver is not
  claimed byte-stable, and a moving (scroll-linked) frame is not snapshotted.

**Not covered:** a shipping desktop browser or a mobile engine (the test
harness's bundled engine builds only), and the second OS was not re-run today
(the hash first recorded there is the same `cc723c2a1b107de4`).

### What has been verified

`spike-m0/scripts/determinism.ts` — 3 builds of the same seed produce an
identical vertex hash (`cc723c2a1b107de4`, 4802 vertices), with two controls
proving the hash is *sensitive*: a different seed and a different strand count
each change it. Without those controls a constant generator would pass.

Separately, the **build** is byte-identical across repeated runs
(`de230c6aae97…`), verified with a control that a one-character value change
does alter the hash. An earlier control using a CSS *comment* failed to move
the hash — because the minifier strips comments — and that near-miss is why the
control is itself checked rather than assumed.

The build also completes with every network route poisoned, producing the same
hash — the offline claim in PRD §6.7, with a control confirming the poison
genuinely blocks (curl exit 7, npm proxy error).

### Cross-engine — verified 2026-09-22

`spike-m0/scripts/cross-engine.ts` (`pnpm test:engines`) bundles the generator
once and runs the same bytes in Chromium (V8), Firefox (SpiderMonkey) and
WebKit (JavaScriptCore) via Playwright on macOS arm64. All three produce the
Node reference hash `cc723c2a1b107de4` (4802 vertices), and in each engine a
different seed yields `6b1465d6a818ef5c` — the control that the bundled
generator responds to its seed. The Node hash on macOS arm64 also matches the
one first recorded on Windows x64, so the OS/CPU axis holds within V8.

**Scope of the claim.** The hash covers the Float32 position buffer — what the
GPU receives. A last-bit difference in a Float64 `Math.sin` that rounds away
in Float32 would not be detected, and does not need to be: it cannot reach a
frame.

### What is still open

Visual snapshot stability across 10 consecutive runs was measured on
2026-10-07 (verdict above). Engine versions are the test harness's bundled
builds; a shipping desktop browser or a mobile engine has not been run.

Created when A8 was narrowed. Making procedural geometry the default moves
determinism from a purely *build-time* property to a *runtime* one: the same
`.az` file must produce the same mesh in every browser, on every machine,
forever.

Specific ways it could be false:

- a generator seeded from anything ambient — time, `Math.random()`, iteration
  order over a hash map — differs between runs
- floating-point differences between GPU/JS engines shift vertex positions
  enough to change a rendered frame, so visual snapshots (gate §1 checks 3 and
  7) flake without any source change
- a platform noise implementation is used instead of the compiler's own and
  changes between browser versions

**Verify:** M0. Build the procedural hero, then assert an identical vertex
buffer hash across two builds **and** two runs, in at least two browser
engines. This belongs beside `test:determinism` (VERIFICATION §4).
**Threshold:** identical hash across builds, runs and engines; visual snapshots
stable across 10 consecutive runs.
**If FAILED:** the procedural scene must be **baked at build time** into a
geometry buffer the emitter writes out, rather than generated in the browser.
That preserves determinism and costs a build step and some bundle weight — a
worse outcome than runtime generation, but not a project-level failure, and
strictly better than reinstating a mandatory model.

---

## A9 — CLI-first suits the target user

**Status:** assumed by PRD §4 · **Confidence:** medium

**Verify:** M5+ — Playground vs CLI usage after launch.
**If FAILED:** that is a *product* pivot toward non-technical users. Re-read
distribution-and-hosting §7 before acting; it changes the competitive position.

---

## A10 — Tauri desktop is cheap; mobile is not

**Status:** `UNVERIFIED` · **Confidence:** medium-high

**Verify:** Phase 2 spike (desktop), Phase 3 spike (mobile) before committing.
**If mobile FAILED:** ship desktop only. Mobile was already gated; this is not
a project-level failure.

---

## Non-assumptions — decided, not assumed

These are choices. Changing them is a decision with a cost, not a discovery:

| Decision | Where |
|---|---|
| TypeScript for compiler and output | PRD §7.1 |
| No AI in the build path | PRD principle 1 |
| Words describe intent, not implementation | PRD principle 6 |
| No actions/logic in `.az` | PRD principle 7 |
| Mobile app target uses native motion, not 3D | PRD §6.4 |
| Auth is adapters only — we never implement auth | PRD §6.5 |
| Grammar freezes at M5 | PRD §5 |
