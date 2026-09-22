# ASSUMPTIONS

Beliefs this project is built on that are **not yet proven**. Each has a
verification method and a stated consequence if false.

**Rule for the agent: do not treat any `UNVERIFIED` assumption as fact in code
comments, docs, or user-facing copy.** If work depends on one, say so.

Status values: `UNVERIFIED` · `TESTING` · `HOLDS` · `FAILED`

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

**Status:** `TESTING` — logic verified, hardware coverage still narrow ·
**Measured 2026-08-21** (M0 spike) · **Blocks:** the A1 mitigation, and
therefore the 3D positioning

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

### What has been verified

`spike-m0/scripts/probe.test.ts` — 11 assertions, 5 of them controls, driving
the real `TierProbe.sample()` with synthetic frame intervals:

- a 60fps device holds `full` (the false-positive case that would quietly
  degrade every visitor) — and the control proves fast and slow reach
  *different* tiers, so the threshold discriminates
- a 20fps device downgrades; load jank inside the settle window does not
- the ratchet is one-way: 1200 fast frames after a drop never promote
- ≤2 transitions across ~60s of alternating load — no oscillation
- a 30s tab-hidden gap does not trip it, with a control proving sustained slow
  frames at the same point *do*
- **closed loop**: when dropping a tier actually improves frame time, the probe
  **rests at `lite`** in one step rather than falling through to `static` — and
  its control proves a lite-incapable device still continues to `static`

`spike-m0/scripts/browser.test.ts` — 16 assertions in real Chromium: forced
tier pinning works for all three, DPR is clamped to exactly 1.750 at `full`,
the three tiers render visibly differently, and `prefers-reduced-motion`
reaches `static`.

**A real bug was found and fixed by this test.** The probe was constructed from
React's initial state rather than from the capability gate, so its polling loop
wrote `full` back over the gate's `static` — a `prefers-reduced-motion` visitor
was served the full scene. Re-introducing the defect makes the test fail on the
intended assertion; the fix is `Hero.tsx`, where the gate is now resolved
before first render and is a ceiling the probe may only move *down* from.

### What is still open

Only one machine, and headless Chromium at that — its p95 sat at 25–27ms,
uncomfortably near the 33ms threshold, which is likely software rasterisation
rather than a real GPU. **The thresholds are unvalidated against varied real
hardware**, and that is exactly the gap A1 describes. Status stays `TESTING`
until the probe has run on at least one genuinely slow device.


---

## A2 — R3F keeps word emitters short

**Status:** `HOLDS` for structure · `FAILED` for a distinctive word ·
**Measured 2026-08-21** (M0 spike, `spike-m0/`)

Declarative R3F should map near 1:1 from the DSL, keeping `emit.web.ts` files
readable.

**Verify:** M0 — count lines of the hand-built hero. **Threshold:** the `hero`
emitter fits in ~250 lines.
**If FAILED:** emitters become string-heavy and contributor-hostile. Consider
shipping runtime React components that words merely configure, rather than
emitting JSX.

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

**Status:** `UNVERIFIED` · **Confidence:** medium · **Scope: narrowed
2026-08-21 — no longer on the critical path**

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

**Status:** `HOLDS` for the vertex buffer across three engines · visual
snapshot stability (10 consecutive runs) still unmeasured ·
**Measured 2026-08-21, engine axis 2026-09-22** (M0 spike) · **Blocks:** the
procedural default, and therefore the determinism claim on any page using it

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

Visual snapshot stability across 10 consecutive runs (the second half of the
threshold) has not been measured. Engine versions are Playwright's bundled
builds; a real Safari or mobile engine has not been run.

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
