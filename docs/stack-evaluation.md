# Stack evaluation — proposed additions to the web target

**Status** research · **Date of every version lookup below: 2026-08-21** ·
Companion to PRD §7.2, ARCHITECTURE §4.1

Every version in this document was read from `registry.npmjs.org` or the
project's own repository **on 2026-08-21**. Anything not read from an official
source is marked `UNVERIFIED` and is not to be pinned. Nothing was installed;
no `package.json` was created.

**FACT** = read from a cited source. **JUDGEMENT** = this document's opinion,
which the owner may overrule.

---

## 1. Verdict table

| # | Item | Status | One-line reason |
|---|---|---|---|
| 1 | `three` | **DECIDED 2026-09-23 · `0.186.0`** | §0; the 2026-08-21 lookup found `0.185.1` |
| 2 | `@react-three/fiber` | **DECIDED 2026-09-23 · `9.8.0`** | §0; the v9/React-19 migration happened (open question 1) |
| 3 | `@react-three/drei` | **DECIDED 2026-09-23 · `10.7.8`** | §0; still current, peers satisfied |
| 4 | **Next.js** | **REJECT** | `next build` generates a fresh build ID and phones Vercel by default — it attacks determinism and principle 1 at the *build* stage. Vite's equivalent of `dynamic(…,{ssr:false})` is `<ClientOnly>` from `vite-react-ssg` |
| 5 | **GSAP + ScrollTrigger** | **REJECT as an emitted dependency** | free, but not open source: a revocable, unilaterally amendable Webflow licence that AZ would inject into every client project |
| 6 | **Lenis** | **REJECT for Phase 1** | genuinely good and genuinely a11y-aware, but it has no word, taxes non-3D pages, and its rAF loop is unproven against the tier probe |
| 7 | **@react-three/postprocessing** | **ADOPT** | fills the named gap in PRD §6.4 / motion-tiers §5 rung 2; nothing else supplies the `full` tier's post-fx |
| 8 | **gltf-transform** | **AUTHOR-SIDE TOOL** | the missing A8 pipeline, but it ships `node-fetch` and `sharp` — it can never be a `target-*` dependency |
| 9 | **gltfjsx** | **AUTHOR-SIDE TOOL, and only via `raw`** | output determinism is undocumented; it competes with the emitter rather than feeding it |
| 10 | **Spline** | **AUTHOR-SIDE TOOL, asset export only** | the runtime embed is a network call in the visitor's page; the GLB export is fine and the free tier exports geometry only |
| 11 | **Blender** | **AUTHOR-SIDE TOOL — correct choice** | GLB + Draco is the right path; the official exporter is Khronos-maintained and bundled |
| — | React major | **DECIDED** | React 19; R3F `9.8.x` takes `>=19 <19.4`, so the pinned `19.3.0` is inside it (§0) |
| — | three ceiling | **DECIDED — a moving window, reviewed with each pin bump** | `postprocessing 6.39.5` widened its peer to `three < 0.187.0`; `0.186.1` is inside it (§0) |

---

## 0. Decision record — 2026-09-23 (M0 `.glb` path)

Every version below was read from `registry.npmjs.org` on **2026-09-23**.

| Package | Pinned | FACT (registry) |
|---|---|---|
| `three` | **`0.186.0`** | latest, published 2026-09-08, no peers |
| `@types/three` | **`0.186.0`** | latest, matches `three` |
| `@react-three/fiber` | **`9.8.0`** | latest, published 2026-09-22; peers `react >=19 <19.4`, `three >=0.156` |
| `@react-three/drei` | **`10.7.8`** | latest; peers `react ^19`, `three >=0.159`, `@react-three/fiber ^9.0.0` |
| `react`, `react-dom` | `19.3.0` (from `19.2.8`, 2026-10-19) | inside fiber's `>=19 <19.4`; `19.3.1` (2026-10-14) changes only server-component transport, which nothing here uses, and is inside the 7-day release age until 2026-10-21 |

**The three ceiling (§1, §8).** The ceiling was never about three: it is
`postprocessing`'s peer range. On 2026-08-21 that was `>= 0.168.0 < 0.186.0`;
`postprocessing 6.39.5` (2026-09-09) widened it to **`>= 0.168.0 < 0.187.0`**,
and `@react-three/postprocessing 3.1.2` (2026-09-22) requires `three >= 0.156.0`
and `@react-three/fiber >= 9.7.0`. So `0.186.0` sits inside the window and the
post-fx adoption (§8) still holds. Per this document's own recommendation that
"pinning is a commitment to a review cadence", the ceiling is recorded as a
**moving window**: three advances only to a minor the pinned `postprocessing`
admits, checked at each pin review — never by a routine bump alone.

**What a generated site takes (2026-09-23, the compiler's 3D runtime).**
Only `three`. The page's one renderer (scene-spec §5) is DOM-driven — it
draws every view into its element's rectangle from one fixed canvas, the way
the behaviour runtime attaches by data attributes — so it needs no React
binding: `@react-three/fiber` and `@react-three/drei` stay the spike's, and
the words' manifests pin `three` alone. drei's `Environment`/`Lightformer`
became three's own `PMREMGenerator` over emissive planes.

**Draco decoder hosting.** Self-hosted, and from `three` itself. In `0.186.0`,
`DRACOLoader` references its decoder files with `new URL(…, import.meta.url)`
and exports `DRACO_GLTF_CONFIG`, the glTF-only decoder (192 KB wasm). The
bundler therefore emits the decoder into the site as same-origin assets — no
CDN request and nothing to copy by hand. Verified in the spike: the model page
fetches exactly one wasm from its own origin, and the build succeeds with the
network poisoned (`spike-m0/scripts/model.test.ts`). drei's `useGLTF` is not
used on this path: its default decoder location is a public CDN.

**Author-side encoding tools (§9), spike devDependencies only:**
`@gltf-transform/core` `4.5.1` and `@gltf-transform/extensions` `4.5.1`
(MIT; the `KHR_draco_mesh_compression` writer), `draco3dgltf` `1.5.7`
(Apache-2.0; the reference Draco encoder, the build three's decoder is
paired with). `@gltf-transform/functions` is deliberately not added — its image
dependencies are not needed to encode geometry. None of these ship in a site.


## 2. `three`

**FACT.** Current stable: **`0.185.1`**, no `peerDependencies`.
[registry.npmjs.org/three/latest](https://registry.npmjs.org/three/latest)

**FACT.** The project pins `0.170.0` in five places: `ARCHITECTURE.md:113`,
`PRD.md:299`, `CONVENTIONS.md:125`, `gallery-block-spec.md:325`,
`scene-block-spec.md:308`.

**JUDGEMENT.** The pin is fifteen minors stale. This is not a criticism of the
pinning rule — the rule is right, and PRD §6.3 reason 1 ("version drift") is
the whole argument for it. But a pin chosen in a planning document and never
touched again *becomes* the drift it was written to prevent. **Pinning is a
commitment to a review cadence, not a one-time act.** Nothing in the docs
currently schedules that review; §6 below proposes where it belongs.

---

## 3. `@react-three/fiber`

**FACT.** Current: **`9.7.0`**, published `2026-07-31T16:19:29Z` — three weeks
old, not stale.
[api.github.com/repos/pmndrs/react-three-fiber/releases/latest](https://api.github.com/repos/pmndrs/react-three-fiber/releases/latest)

**FACT.** `9.7.0` peer dependencies
([registry](https://registry.npmjs.org/@react-three/fiber/latest)):

```json
{ "react": ">=19 <19.3", "react-dom": ">=19 <19.3", "three": ">=0.156",
  "expo": ">=43.0", "expo-gl": ">=11.0", "expo-asset": ">=8.4",
  "react-native": ">=0.78", "expo-file-system": ">=11.0" }
```

`react-dom`, `react-native` and all `expo-*` entries are `optional` in
`peerDependenciesMeta`. `react` and `three` are **not** optional.

**FACT.** The pinned `8.17.10` declares `"react": ">=18.0"`, `"three":
">=0.133"` ([registry](https://registry.npmjs.org/@react-three/fiber/8.17.10)).

**FACT.** React current: **`19.3.1`**; the pinned `19.3.0` (§0)
([registry](https://registry.npmjs.org/react/latest)).

**The upper bound is the finding.** R3F 9.7.0 does not say `>=19`. It says
`>=19 <19.3`, and React is at 19.2.8 — **one minor release from falling out of
the declared range.** A word manifest that pins `react` exactly is protected;
a `^` anywhere in the emitted `package.json` is not. (R3F 9.8.x widened the range
to `<19.4`, and React moved to `19.3.0` inside it on 2026-10-19.)

`motion-tiers-spec.md:475` flags `frameloop="demand"`, `performance.regress()`
and `<Canvas performance>` for verification "against `@react-three/fiber@8.17.10`
per PRD §6.7". If the pin moves to v9 that row must be re-verified against
v9.7.0, not just renumbered. **UNVERIFIED:** whether those three APIs are
unchanged between 8.17.10 and 9.7.0. Not checked here; check before M0.

---

## 4. `@react-three/drei`

**FACT.** Current: **`10.7.8`**. Peers
([registry](https://registry.npmjs.org/@react-three/drei/latest)):

```json
{ "react": "^19", "react-dom": "^19", "three": ">=0.159",
  "@react-three/fiber": "^9.0.0" }
```

**FACT.** drei bundles 21 runtime dependencies of its own, including
`three-stdlib`, `three-mesh-bvh`, `camera-controls`, `troika-three-text`,
`@mediapipe/tasks-vision`, `hls.js`, `zustand` and `detect-gpu`.

**FACT.** `ScrollControls` is present in drei's README under *Controls*
([github.com/pmndrs/drei](https://github.com/pmndrs/drei)). PRD §7.2 calls it
"R3F ScrollControls"; it is a **drei** component, not an R3F one, and drei is
therefore load-bearing for the scroll-motion decision, not an optional extra.

**JUDGEMENT — two consequences the docs do not yet record:**

1. **drei `^9.0.0` on fiber is what forces the v9/React 19 migration.** There
   is no drei 10 that runs on fiber 8. The three pins move together or not at
   all.
2. **`detect-gpu` inside drei is a build-time GPU blocklist.**
   `motion-tiers-spec.md` §10 says of `WEBGL_debug_renderer_info`: "verify —
   and prefer not to use … a GPU blocklist is the build-time guessing being
   removed." If any drei component pulls `detect-gpu` into the bundle, the
   thing the tier spec deliberately rejected ships anyway. **UNVERIFIED:**
   which drei components import it and whether it tree-shakes out. Worth one
   bundle check at M0 — CONVENTIONS §1 already bans barrel files for exactly
   this reason, and drei is a large surface.

---

## 5. Next.js — **REJECT**

Contradicts PRD §7.2, which chose Vite + `vite-react-ssg`. Assessed honestly
rather than dismissed.

**FACT.** Current: **`16.3.2`**, MIT. Peer `react`: `"^18.2.0 || 19.0.0-rc-… ||
^19.0.0"` ([registry](https://registry.npmjs.org/next/latest)). React
compatibility is not the problem.

### What would genuinely be gained

- File-based routing that maps cleanly onto `page /work` — AZ would write
  fewer route files.
- `next/image`, `next/font` — real, tested solutions to two problems the
  project has not yet specified.
- A much larger contributor pool than Vite + `vite-react-ssg` (which is at
  **`0.9.2`** — pre-1.0, [registry](https://registry.npmjs.org/vite-react-ssg/latest)).
- Streaming/RSC, if AZ ever grows a server target.

### What it costs the stated priorities

**FACT — determinism.** "Next.js generates an ID during `next build` to
identify which version of your application is being served… If you are
rebuilding for each stage of your environment, you will need to generate a
consistent build ID"
([nextjs.org/docs/…/generateBuildId](https://nextjs.org/docs/app/api-reference/config/next-config-js/generateBuildId)).
CONVENTIONS §6 requires that "`az build` twice must produce byte-identical
files — this is a test, and it is the product's core claim." Next's default
behaviour fails that test. It is overridable via `generateBuildId`, but the
compiler would then own that config forever, and the failure mode is silent.

**FACT — the network boundary.** Next telemetry tracks "Command invoked (`next
build`, `next dev`, or `next export`)", "Duration of `next build` and size of
application", sent to Vercel; disabled with `next telemetry disable` or
`NEXT_TELEMETRY_DISABLED=1` ([nextjs.org/telemetry](https://nextjs.org/telemetry)).
The page frames participation as **opt-out** — "you may opt-out if you'd not
like to share any information" — and does not state a default in words.
*(JUDGEMENT: opt-out phrasing plus a `disable` subcommand means on-by-default;
the page does not say so verbatim.)* PRD §5 principle 1 is "The compiler never
calls a network. No AI, no telemetry, no API keys," and ARCHITECTURE §6 has an
integration test that runs `az build` with the network disabled. Telemetry
fires during **build**, not setup — the exact side of the line PRD §6.7 draws.
Again overridable; again the compiler owns it forever; again silent if the env
var is ever dropped.

**JUDGEMENT — contributor simplicity.** PRD §7.2 rejected Astro because "pack
authors would write both `.astro` and `.tsx` files. Contributor simplicity is a
core strategic need, so one file type wins." Next 16's App Router keeps one
file *extension* but adds a server/client boundary, `"use client"`, and the
`layout.tsx`/`page.tsx`/`route.ts` conventions. That is more concepts for a
word author than Astro's two file types, not fewer. **The Astro rejection
argues against Next.js more strongly than it argued against Astro.**

**JUDGEMENT — `core` staying framework-ignorant (ARCHITECTURE §2).** Be fair:
adopting Next would **not** violate this. `core` never imports the framework;
Next would replace the internals of `target-web` only, which is precisely the
swap ASSUMPTIONS A6 already contemplates for Astro. This is not an argument
against Next and should not be used as one.

### The `dynamic(…, { ssr: false })` question — yes, there is a direct equivalent

**FACT.** `vite-react-ssg` exports `ClientOnly`
([github.com/Daydreamer-riri/vite-react-ssg](https://github.com/Daydreamer-riri/vite-react-ssg)):

```jsx
import { ClientOnly } from 'vite-react-ssg'

<ClientOnly>
  {() => <div>{window.location.href}</div>}
</ClientOnly>
```

with the documented caveat that "the children of `<ClientOnly>` is not a JSX
element, but a function that returns an element. Because React will try to
render children, and may use the client's API on the server."

That is exactly the WebGL-canvas case: the `<Canvas>` must not be prerendered.
**The capability Next was proposed for is already present in the chosen stack.**

**Verdict: REJECT.** Revisit only if ASSUMPTIONS A6 comes back `FAILED` — at
which point Next and Astro should be compared together, and `vite-react-ssg`'s
`0.9.2` pre-1.0 status is the honest reason that day might come.

---

## 6. GSAP + ScrollTrigger — **REJECT as an emitted dependency**

This is the item most likely to be got wrong, so the licence is quoted in full
rather than summarised.

**FACT.** Current: **`3.15.0`**. The npm `license` field is not an SPDX
identifier — it is the literal string `"Standard 'no charge' license:
https://gsap.com/standard-license."`
([registry](https://registry.npmjs.org/gsap/latest)).

**FACT.** The plugins became free with **3.13**: GSAP is "100% FREE including
ALL of the bonus plugins like SplitText, MorphSVG, and all the others that were
exclusively available to Club GSAP members" ([gsap.com/blog/3-13](https://gsap.com/blog/3-13/)).
The 3.13 post names SplitText and MorphSVG. **It does not mention ScrollTrigger
at all** — ScrollTrigger was not on the members-only list, so "ScrollTrigger is
now free" is the wrong framing; ScrollSmoother and SplitText are the ones that
changed.

**FACT.** From [gsap.com/standard-license](https://gsap.com/standard-license),
effective 2025-04-30, last modified 2025-05-30, © 2025 **Webflow**:

> **"Prohibited Uses"** means any implementation and/or use of GSAP Products in
> tools that allow users to build visual animations without code that
> encourages, induces, or materially assists in creating a solution that
> competes with Webflow's visual animation building capabilities.

> **II. GRANT OF LICENSE.** Subject to the terms and conditions of this GSAP
> License, Webflow grants you a non-exclusive, worldwide license to use,
> reproduce, display, and implement GSAP Products solely for Permitted Uses.

> **V. TERMINATION.** Webflow may terminate this GSAP License and revoke your
> access in its discretion if you fail to comply with any of these terms and
> conditions. Upon termination, you must cease all use of GSAP Products and
> destroy all copies in your possession.

> **VI.2 Amendments.** Webflow reserves the right to update or modify this GSAP
> License at any time by posting the revised terms on this website… If you do
> not accept the revised GSAP License, you are prohibited from using versions of
> the GSAP Products released after the effective date of the revised GSAP
> License (as well as any updates made to previous versions). Notwithstanding,
> you may continue using previous versions of GSAP Products under the applicable
> terms licensed to you prior to the effective date of the revised GSAP License.

> **FAQ.** *Is it acceptable for AI tools like ChatGPT, Cursor, Lovable,
> Webstudio, etc. to generate GSAP code?* **Absolutely! AI-generated code is not
> a "Prohibited Use".**

> **FAQ.** *Can I really use GSAP in commercial projects without paying
> anything?* **Yes, really!** … All of GSAP including the plugins that were
> formerly "members-only" like SplitText and MorphSVG can be used in commercial
> projects at no charge.

### Reading this for a code generator specifically

**FACT-adjacent JUDGEMENT — AZ is probably not a Prohibited Use.** "Prohibited
Uses" targets *tools that allow users to build visual animations without code*.
AZ is a CLI that compiles text to source files. PRD §6.8 explicitly excludes "a
GUI or visual editor" from Phase 1. The AI FAQ answer removes any doubt about
the Phase 4 word-suggestion front-end. **On the face of the text, AZ Web as
specified is permitted.**

**JUDGEMENT — that is not the reason to reject it. These three are:**

1. **It is not open source, and the grant is discretionary.** MIT is
   irrevocable and has no counterparty. This licence is granted by a named
   company, revocable under §V, and amendable at will under §VI.2. AZ's whole
   value proposition to a studio is "same code, twenty client projects,
   forever." Shipping a revocable licence into all twenty is a category of risk
   that does not exist with `motion` (MIT).
2. **AZ makes the licensee out of someone who never read it.** A developer
   writing `hero 3d scroll` would receive a Webflow-licensed dependency in
   their client's commercial site, with no prompt, no notice and no acceptance.
   That is materially different from a human choosing GSAP for one site.
   `word-quality-gate.md` §3 makes exactly this argument about trust tiers
   ("must be stated plainly, not discovered"); it applies to licences too.
3. **PRD §6.8 already frames AZ against builders.** §VI.2's escape hatch — old
   versions keep their old terms — is durable *only* because AZ pins exactly
   (PRD §6.7). That works. But it means the mitigation for a licence risk is
   "never upgrade," which is the opposite of §2 above.

**JUDGEMENT — what is honestly lost by rejecting it.** Non-trivial:

- **ScrollTrigger `pin` + `scrub`** is materially better than drei
  `ScrollControls` for *DOM-side* choreography. `ScrollControls` governs
  scroll inside the canvas; ScrollTrigger governs the page. The gap is real.
- **SplitText** has no free MIT equivalent of comparable quality for
  per-character text reveals — a signature effect for the theme system
  (PRD §10, "generated 3D sites all look identical").
- `gsap.matchMedia()` handles `prefers-reduced-motion` cleanly.

**If the owner overrules this**, the correct shape is: GSAP behind `raw`/`slot`
(PRD §6.6) as a *user* choice in their own project, never in a `word.json`
`deps` block. That keeps the licence decision with the person who owns the
site, which is where it belongs.

---

## 7. Lenis — **REJECT for Phase 1**

**FACT.** Current: **`1.3.26`**, **MIT**, **no `dependencies` object at all**.
Peers: `react >=17.0.0`, `vue >=3.0.0`, `@nuxt/kit >=3.0.0`
([registry](https://registry.npmjs.org/lenis/latest)).
**UNVERIFIED:** gzipped bundle size. The README claims "a few KB with zero
runtime dependencies" but publishes no measured figure, and none was found on
an official source. Do not quote a number.

### The accessibility question — Lenis is better than its category

**FACT.** `respectReducedMotion` — type `boolean`, **default `true`**. From the
README: when `prefers-reduced-motion` is `reduce`, "smoothing is disabled
(`lerp` is forced to `1` so the scroll tracks the input device 1:1, ignoring
`duration`/`easing`) and programmatic scrolls (`scrollTo`, anchor links) jump
instantly to their target."
([github.com/darkroomengineering/lenis](https://github.com/darkroomengineering/lenis))
**It respects `prefers-reduced-motion` natively. No wiring required.** That
satisfies `word-quality-gate.md` §1 check 6 on its face.

**FACT.** It drives native scroll position rather than transforming a wrapper:
Lenis "wraps the browser's own scroll, so `position: sticky`, anchor links, and
accessibility keep working." **JUDGEMENT:** that is the architectural reason
find-on-page and keyboard scrolling should survive — the old wrapper-transform
libraries broke them because the document never actually scrolled.

**FACT — but say this plainly:** the README's *Limitations* section does **not**
mention find-on-page (Ctrl+F), keyboard scrolling, scroll-anchoring, or
scrollbar behaviour at all. Those are **UNVERIFIED**. What it does list:

> - no support for CSS scroll-snap, you must use `lenis/snap`
> - capped to 60fps on Safari and 30fps on low power mode
> - smooth scroll will stop working over iframe since they don't forward wheel events
> - position fixed seems to lag on MacOS Safari pre-M1
> - touch events may behave unexpectedly when `syncTouch` is enabled on iOS < 16
> - nested scroll containers require proper configuration to work correctly

### Why it still does not belong in Phase 1

1. **It has no word.** PRD §6.2 caps the vocabulary at 11 blocks; smooth-scroll
   is a site-wide *behaviour* with no block, no variant and no modifier that
   expresses it. Adding it means either a new structure keyword (a grammar
   change, PRD §5) or a hidden always-on default the `.az` file never mentions
   — which violates principle 7's spirit: the file describes the site.
2. **It taxes pages that gain nothing.** PRD §9 sets a **< 150KB gz** budget
   for non-3D pages, justified as "3D must not tax pages that don't use it."
   A global scroll layer runs on the `/pricing` page too.
3. **It is unproven against the tier probe, and that collision is specific.**
   `motion-tiers-spec.md` §3.1 measures rAF frame intervals; §3.4 trips
   `full`→next rung at p95 > 20.0 ms and `lite`→`static` at p95 > 33.3 ms.
   Lenis runs its own rAF loop on every frame of every page, and its own
   Limitations say it is "capped to 60fps on Safari and 30fps on low power
   mode." **JUDGEMENT, and it needs a measurement not an argument:** 30 fps is
   33.3 ms, which is *exactly* the `lite`→`static` trip threshold. If that cap
   affects the frames the probe samples, a perfectly capable Mac in low-power
   mode gets downgraded to a poster image. That is the precise failure
   ASSUMPTIONS A1b names as disqualifying — "no capable device downgraded."
   **UNVERIFIED:** whether Lenis's cap touches the page's rAF cadence or only
   its own interpolation. Nothing in the README answers it.

**Verdict: REJECT for Phase 1.** Revisit after M5 with a measurement against
the probe. It is a good library; it is the wrong thing to add before the thing
it might break has ever run.

---

## 8. `@react-three/postprocessing` — **ADOPT**

This is the one clear adopt. PRD §6.4's tier table promises "post-fx" at the
`full` tier and `motion-tiers-spec.md` §5 rung 2 promises to remove "post-fx
chain off (bloom / AA / any post pass)" — **and no document names a library
that provides either.** The gap is real and this fills it.

**FACT.** `@react-three/postprocessing` current: **`3.0.5`**. Peers
([registry](https://registry.npmjs.org/@react-three/postprocessing/latest)):

```json
{ "react": "^19.2.0", "three": ">= 0.182.0",
  "postprocessing": "^6.36.0", "@react-three/fiber": ">=9.7.0" }
```

Its own dependencies: `n8ao`, `maath`.

**FACT.** `postprocessing` (the required peer) current: **`6.39.4`**, licence
**Zlib**, peer `"three": ">= 0.168.0 < 0.186.0"`
([registry](https://registry.npmjs.org/postprocessing/latest)).

**`postprocessing` is a peer, not a transitive dependency — it must be pinned
explicitly in the word manifest or install fails.**

### The compatibility sandwich — the practical consequence

Combining the three peer ranges:

| Constraint | Source |
|---|---|
| `three >= 0.182.0` | `@react-three/postprocessing@3.0.5` |
| `three < 0.186.0` | `postprocessing@6.39.4` |
| `@react-three/fiber >= 9.7.0` | `@react-three/postprocessing@3.0.5` |
| `react >= 19 < 19.3` | `@react-three/fiber@9.7.0` |

**The viable `three` window is `0.182.0 ≤ three < 0.186.0`. Current stable is
`0.185.1` — the last minor inside it.** Adopting post-fx therefore also decides
items 2 and 3: R3F must go to 9.7.0 (exactly current, no room below), React to
19.x, drei to 10.x. There is no partial adoption.

### Interaction with the motion tiers

`motion-tiers-spec.md` §5 puts post-fx at **rung 2** — dropped second, after the
DPR clamp and before shadows — and §6.1 requires each rung be "individually
forceable and *has its measured effect*… post-pass count". **JUDGEMENT:** this
constrains *how* post-fx is emitted, not whether. The `<EffectComposer>` must
be mountable/unmountable as a unit so rung 2 is one conditional render, and the
post-pass count must be readable at runtime for the §6.1 assertion. Rebuilding
the chain is also explicitly called out at `motion-tiers-spec.md:150` as
"rebuilding a post-fx chain mid-scroll, which *causes* the jank it is" meant to
cure — so rung 2 must **unmount**, never reconfigure.

**Bundle cost: UNVERIFIED.** No official gzipped figure was found for either
package. `word-quality-gate.md` §1 check 9 (`size-limit`) is the right place to
learn it. Do not quote a number until it is measured.

---

## 9. `gltf-transform` — **AUTHOR-SIDE TOOL**

ASSUMPTIONS **A8** asserts Draco compression under 5MB and
`ARCHITECTURE.md:113` encodes `"maxBytes": 5242880` — but **no document
specifies a pipeline that produces such a file.** This closes that gap.

**FACT.** `@gltf-transform/cli` current: **`4.4.2`**, **MIT**, description "CLI
interface to glTF Transform", bin `gltf-transform → ./bin/cli.js`
([registry](https://registry.npmjs.org/@gltf-transform/cli/latest)).
`@gltf-transform/core` is also `4.4.2`, MIT, with one dependency
(`property-graph`) ([registry](https://registry.npmjs.org/@gltf-transform/core/latest)).

**FACT.** It is **both** a CLI and a library: "glTF 2.0 SDK for JavaScript and
TypeScript, on Web and Node.js" ([gltf-transform.dev](https://gltf-transform.dev/)).

**FACT — the three compressions, from the official site:**

| Technique | What it compresses | Official CLI |
|---|---|---|
| **Draco** | geometry | `gltf-transform draco input.glb output.glb --method edgebreaker` |
| **Meshopt** | "geometry, morph targets, and keyframe animation" | `gltf-transform meshopt input.glb output.glb --level medium` |
| **KTX2 + Basis** | textures; "improve VRAM usage and performance" | `gltf-transform uastc in.glb out1.glb` then `gltf-transform etc1s out1.glb out2.glb` |

**FACT.** The site "does not explicitly state which compression method to
prefer" — there is no official recommendation to cite.

**JUDGEMENT — when to pick which, for this project:**

- **Draco** — smallest *transfer* size for static geometry. Costs a
  decompression pass on the main thread (or a worker) at load. Right for a
  single hero product model, which is A8's exact case.
- **Meshopt** — decodes far faster and handles animation; slightly larger
  files. Right if a hero model is animated, which `hero-block-spec` does not
  currently require.
- **KTX2/Basis** — **orthogonal to both, and the one the docs miss.** Draco
  shrinks the *file*; KTX2 shrinks what sits in **GPU memory**.
  `motion-tiers-spec.md:53` already reasons about this — "a Draco hero
  decompresses to hundreds of MB of GPU-side buffers and textures. Under 2GB
  the tab is a candidate for eviction." **A 4.9MB Draco GLB with four 4096²
  PNG textures still passes A8's byte budget and still evicts the tab.** A8
  measures the wrong thing on its own.

**Placement — it must not be a compiler dependency.** `@gltf-transform/cli`
depends on **`node-fetch`** (network-capable) and **`sharp`** (native binary),
plus `draco3dgltf`, `meshoptimizer`, `mikktspace`, `watlas` and
`gltf-validator`. ARCHITECTURE §2 forbids `core` or `target-*` importing
anything network-capable and says CI must fail on it; CONVENTIONS §1 requires
`--ignore-scripts` on every install, which native-binary packages are the
usual casualty of.

**Recommendation: a documented author-side step, run by the human before the
model ever reaches `assets/`.** Optionally a Tier-2 prompt under
`word-quality-gate.md` §5.1 — but `az doctor` should *detect an unoptimised
GLB and print the exact command*, matching the §5.1 pattern of "detect
everything and install almost nothing."

---

## 10. `gltfjsx` — **AUTHOR-SIDE TOOL, and only via `raw`**

**FACT.** Current: **`6.5.3`**, MIT, "A small command-line tool that turns GLTF
assets into declarative and re-usable react-three-fiber JSX components",
invoked `npx gltfjsx [Model.glb] [options]`
([github.com/pmndrs/gltfjsx](https://github.com/pmndrs/gltfjsx)).

**FACT.** It **bundles its own `three`** as a direct dependency, alongside
`prettier`, `draco3dgltf`, `three-stdlib`, `meshoptimizer` and three
`@gltf-transform/*` packages
([registry](https://registry.npmjs.org/gltfjsx/latest)).

**FACT.** Its docs present it as a one-time author step whose output is meant
to be hand-edited afterwards (changing materials, adding handlers).
**Determinism is not addressed anywhere** — the README says nothing about
stable output, regeneration, or whether the same GLB produces identical JSX
twice. **UNVERIFIED, and unverifiable from the docs.**

**JUDGEMENT — it does not belong in the build path, for two reasons that are
independent:**

1. **Undocumented determinism against a byte-identical claim.** CONVENTIONS §6
   requires "no timestamps, no random IDs, stable key order" and makes
   byte-identical rebuild "the product's core claim." A tool whose own
   maintainers never claim stable output cannot sit inside that promise. Even
   if it happens to be deterministic today, nothing contracts it to stay so.
2. **Its bundled `three` is a second, unpinned three.js in the tree.** PRD
   §6.3 reason 1 is that pinned three.js is the entire reason AZ's output works.
   A build-time dependency that carries its own copy reintroduces exactly the
   drift the pin exists to prevent.

There is also a **shape** objection: gltfjsx generates the same artefact
`emit.web.ts` generates. Two generators writing the same file is the "second
copy" ARCHITECTURE §4.1 forbids ("Never hand-maintain a second copy").

**Recommendation:** document it as an author convenience for *inspecting* a
model and for producing a starting point the author then drops in via `raw`
(PRD §6.6). Never in `word.json` `deps`. Never invoked by `az build`.

---

## 11. Spline — **AUTHOR-SIDE TOOL, asset export only**

Two completely different propositions, and only one is acceptable.

**As a runtime embed — REJECT.**
**FACT.** `@splinetool/react-spline` current: **`4.1.0`**; peers `next
>=14.2.0` (optional), `react *`, `react-dom *`, `@splinetool/runtime *`
([registry](https://registry.npmjs.org/@splinetool/react-spline/latest)).
`@splinetool/runtime` current: **`2.0.4`**, description "Spline is a
collaborative design platform… © 2025 Spline, Inc."
([registry](https://registry.npmjs.org/@splinetool/runtime/latest)).

**FACT — and this is the disqualifier: neither package publishes a `license`
field on npm.** Not MIT, not "see file" — **absent**. For a tool that
redistributes dependencies into client sites, an unstated licence is worse than
a restrictive one.

Beyond the licence: the embed pattern loads a scene from Spline's hosting at
runtime, which puts a third-party network call in the *visitor's* page. PRD §5
principle 1 governs the compiler, not the emitted site — so this is not a
literal violation — but "offline, no telemetry, no API keys" is the product's
positioning, and emitting a vendor callback into a client's marketing site is
off-message and outside the CSP that `word-quality-gate.md` §2B wants emitted
by default.

**As an asset source — acceptable, with a caveat worth knowing.**
**FACT.** Spline exports GLTF/GLB with two material options
([docs.spline.design/exporting-your-scene/files/exporting-as-gtlf-glb](https://docs.spline.design/exporting-your-scene/files/exporting-as-gtlf-glb)):

- **Default Color (Grey)** — "Exports only the scene geometry with default grey
  color material." Free.
- **Color & Texture** — "Exports the scene geometry with material layers (Color
  layer), including textures." **"⚡ Paid feature, included in Pro and Max
  subscriptions."**

**FACT.** Documented export limits: "Texture support is limited to only
primitive geometries with UV projection mode. No texture support for geometries
with 'Smooth & Edit'." Unsupported on export: all material layers beyond color,
post-processing, animations, physics, environment, interactivity, components.
**The docs make no mention of Draco compression** — so a Spline GLB still needs
the §9 pipeline.

**JUDGEMENT.** A Spline GLB is just a GLB; once exported it is indistinguishable
from a Blender one and carries none of Spline's runtime. That path is fine and
costs the project nothing. **But the free tier exports untextured grey
geometry**, so "use Spline instead of Blender, for free" is not true for a real
marketing hero. Say that in the docs rather than letting a user discover it.

---

## 12. Blender — **AUTHOR-SIDE TOOL, correct choice**

**FACT.** The exporter is the **official Khronos Group Blender glTF 2.0
importer and exporter**; "Blender 2.80 and higher bundle this addon in the main
Blender install package." Current stable target **Blender 5.0**, current LTS
**4.5**, `main` targeting 5.2
([github.com/KhronosGroup/glTF-Blender-IO](https://github.com/KhronosGroup/glTF-Blender-IO)).

**GLB is the right export target.** It is the single-file binary container — no
sidecar `.bin` or loose textures — which matters for `ARCHITECTURE.md:113`'s
`"ext": [".glb"]` and for `ctx.asset()`'s sandboxed single-path resolution
(ARCHITECTURE §4.3).

**Export settings that affect the <5MB budget — flagged honestly.**
`docs.blender.org` returned **HTTP 403** to both the manual and the Python API
on 2026-08-21, so the exporter's exact option names and defaults could **not**
be read from an official source. **Marked `UNVERIFIED`; do not encode specific
parameter names or defaults into a spec until they are read from the manual
directly.** What can be said from a cited source is only that Draco is
available in the exporter's Geometry section and is controlled by a compression
level plus per-attribute quantisation bits.

**JUDGEMENT — the guidance that actually matters is not a Blender setting:**
**textures dominate the 5MB budget, and Draco does not touch them.** Draco
compresses geometry only (§9). A hero with 4K colour/normal/roughness maps
blows the budget before the mesh is counted, and — per
`motion-tiers-spec.md:53` — decompresses to hundreds of MB of GPU memory
regardless of the file size. **The `hero`/`scene` specs should carry a texture
budget alongside A8's byte budget**, or A8 will be satisfied by files that
still fail on device.

---

## 13. Version pins — the complete list

Every row read from `registry.npmjs.org/<pkg>/latest` on **2026-08-21** unless
noted. `.../latest` returns whatever is current *at fetch time* — **re-read
before pinning if this document is more than a few weeks old.**

### Runtime (candidates for `word.json` `deps`)

| Package | Version | Licence | Status |
|---|---|---|---|
| `three` | `0.186.1` | MIT | **VERIFIED** 2026-10-19 — the only 3D dependency a generated site takes (§0); the latest, published 2026-09-24; against `0.186.0` it changes only the WebGPU and node-material builds, which no generated site loads [↗](https://registry.npmjs.org/three/0.186.1) |
| `@react-three/fiber` | `9.8.0` | MIT | **VERIFIED** 2026-09-23 — the spike's; generated sites do not use it (§0) [↗](https://registry.npmjs.org/@react-three/fiber/latest) |
| `@react-three/drei` | `10.7.9` | — | **VERIFIED** 2026-10-19 — the spike's; the latest, published 2026-09-25; peers met by fiber 9.8.0, react 19.2.8, three 0.186.0 [↗](https://registry.npmjs.org/@react-three/drei/10.7.9) |
| `@react-three/postprocessing` | `3.0.5` | — | **VERIFIED** [↗](https://registry.npmjs.org/@react-three/postprocessing/latest) |
| `postprocessing` | `6.39.4` | Zlib | **VERIFIED** — required peer, must be pinned explicitly [↗](https://registry.npmjs.org/postprocessing/latest) |
| `react` | `19.3.0` | MIT | **VERIFIED** 2026-10-19 — published 2026-09-09; `react-dom` 19.3.0 peers `react ^19.3.0` and brings `scheduler ^0.28.0` (MIT) [↗](https://registry.npmjs.org/react/19.3.0) |
| `motion` | `13.1.1` | MIT | **VERIFIED** — current package name [↗](https://registry.npmjs.org/motion/latest) |
| `framer-motion` | `13.1.1` | MIT | **VERIFIED** — same version line; upgrade guide says swap to `motion` [↗](https://registry.npmjs.org/framer-motion/latest) |
| `maplibre-gl` | `6.14.0` | BSD-3-Clause | **VERIFIED** 2026-10-19 — only a site whose chat shows maps (§19); the newest release older than the 7-day `minimumReleaseAge` (published 2026-10-11; `6.15.0`, published 2026-10-18, is 1 day old); against `6.13.0` its worker file, dependencies and policy needs are unchanged (§19) [↗](https://registry.npmjs.org/maplibre-gl/6.14.0) |
| `pmtiles` | `4.5.0` | BSD-3-Clause | **VERIFIED** 2026-10-16 — only beside `maplibre-gl` (§19); the latest, published 2026-08-10; one dependency, `fflate ^0.8.2` (MIT) [↗](https://registry.npmjs.org/pmtiles/4.5.0) |
| `@protomaps/basemaps` | `5.7.2` | BSD-3-Clause | **VERIFIED** 2026-10-16 — only beside `maplibre-gl` (§19); the latest, published 2026-03-10; no dependencies [↗](https://registry.npmjs.org/@protomaps/basemaps/5.7.2) |

### Build (`target-web` / project scaffold)

| Package | Version | Licence | Status |
|---|---|---|---|
| `vite` | `8.2.2` | MIT | **VERIFIED** [↗](https://registry.npmjs.org/vite/latest) |
| `vite-react-ssg` | `0.9.2` | MIT | **VERIFIED** — pre-1.0 [↗](https://registry.npmjs.org/vite-react-ssg/latest) |
| `@types/react` | `19.3.0` | MIT | **VERIFIED** 2026-10-19 — a generated project's devDependency, so its author's `tsc --noEmit` passes; the latest (published 2026-09-09), matching `react` 19.3.0; brings `csstype ^3.2.2` (MIT) [↗](https://registry.npmjs.org/@types/react/19.3.0) |
| `@types/react-dom` | `19.3.0` | MIT | **VERIFIED** 2026-10-19 — a generated project's devDependency; the latest (published 2026-09-09); no dependencies, peer `@types/react ^19.3.0` [↗](https://registry.npmjs.org/@types/react-dom/19.3.0) |
| `@types/three` | `0.186.0` | MIT | **VERIFIED** 2026-10-16 — a generated 3D project's devDependency, only beside `three`; matches the `three` 0.186 line (§0, published 2026-09-11; there is no `0.186.1` of it) [↗](https://registry.npmjs.org/@types/three/0.186.0) |

### Author-side (never a compiler dependency)

| Package | Version | Licence | Status |
|---|---|---|---|
| `@gltf-transform/cli` | `4.4.2` | MIT | **VERIFIED** [↗](https://registry.npmjs.org/@gltf-transform/cli/latest) |
| `@gltf-transform/core` | `4.4.2` | MIT | **VERIFIED** [↗](https://registry.npmjs.org/@gltf-transform/core/latest) |
| `gltfjsx` | `6.5.3` | MIT | **VERIFIED** [↗](https://registry.npmjs.org/gltfjsx/latest) |

### Rejected — recorded so the decision is not re-litigated blind

| Package | Version | Licence | Status |
|---|---|---|---|
| `next` | `16.3.2` | MIT | **VERIFIED** — rejected §5 [↗](https://registry.npmjs.org/next/latest) |
| `gsap` | `3.15.0` | proprietary "Standard 'no charge'" | **VERIFIED** — rejected §6 [↗](https://registry.npmjs.org/gsap/latest) |
| `lenis` | `1.3.26` | MIT | **VERIFIED** — rejected §7 [↗](https://registry.npmjs.org/lenis/latest) |
| `@splinetool/react-spline` | `4.1.0` | **no `license` field** | **VERIFIED (absence confirmed)** — rejected §11 [↗](https://registry.npmjs.org/@splinetool/react-spline/latest) |
| `@splinetool/runtime` | `2.0.4` | **no `license` field** | **VERIFIED (absence confirmed)** [↗](https://registry.npmjs.org/@splinetool/runtime/latest) |

### Explicitly UNVERIFIED — do not state these as fact

| Claim | Why unverified |
|---|---|
| Gzipped bundle size of `lenis` | README claims "a few KB"; no measured official figure |
| Gzipped bundle size of `@react-three/postprocessing` + `postprocessing` | no official figure found; measure with `size-limit` |
| Blender exporter option names, defaults, and Draco parameter ranges | `docs.blender.org` returned **HTTP 403** on 2026-08-21 for both the manual and the Python API |
| Whether `frameloop="demand"`, `performance.regress()`, `<Canvas performance>` behave identically in R3F 9.7.0 vs 8.17.10 | not checked; `motion-tiers-spec.md:475` depends on it |
| Whether drei's `detect-gpu` dependency reaches the shipped bundle | not measured |
| Whether Lenis's Safari/low-power fps cap affects the page's rAF cadence | not documented; not measured |
| Whether `gltfjsx` output is byte-stable across runs | maintainers make no such claim |
| Whether Next.js telemetry is on by **default** | page uses opt-out phrasing and ships a `disable` command, but never states a default verbatim |

---

## 14. What this changes in the existing docs

**No file below was edited by this document.** Each row is a proposal
contingent on the owner accepting the matching verdict.

### If the version refresh is accepted (§2, §3, §4)

| File · section | Change |
|---|---|
| `PRD.md:299` (§6.7 example manifest) | `three@0.170.0` → `0.185.1`; `@react-three/fiber@8.17.10` → `9.7.0` |
| `ARCHITECTURE.md:113` (§4.1 manifest) | same two pins in the `deps` object |
| `CONVENTIONS.md:125` (§8 commit example) | `chore(deps): pin three to 0.170.0` → the new pin |
| `gallery-block-spec.md:325` | same two pins |
| `scene-block-spec.md:308` | same two pins |
| `motion-tiers-spec.md:475` (§10 API table) | row currently reads "verify against `@react-three/fiber@8.17.10` per PRD §6.7" — must name 9.7.0 **and** be re-verified, not just renumbered |
| `PRD.md` §7.2 (output stack table) | add the React 19 requirement; note `Framer Motion` now ships as `motion` |
| `CONVENTIONS.md` §7 (dependencies) | **new rule:** pins carry a review date; a pin with no scheduled re-read is drift with extra steps |

### If `@react-three/postprocessing` is adopted (§8)

| File · section | Change |
|---|---|
| `PRD.md` §6.4 (tier table) | `full` row says "post-fx" — name the library so it is not an unbacked promise |
| `PRD.md` §6.7 | add `@react-three/postprocessing` and `postprocessing` to the example `deps`, with the note that `postprocessing` is a **peer** |
| `ARCHITECTURE.md` §4.1 | same |
| `motion-tiers-spec.md` §5 rung 2 | state that the effect composer **unmounts** rather than reconfigures — cross-reference line 150's own warning about rebuilding a chain mid-scroll |
| `motion-tiers-spec.md` §6.1 | "post-pass count" assertion now has a concrete API to read it from |
| `hero-block-spec.md`, `scene-block-spec.md` | `themeReads` / manifest need whatever post-fx parameters become theme tokens |
| `theme-spec.md` | if bloom intensity or similar is author-tunable, it needs tokens — a raw number in a word is a CONVENTIONS §4 lint error |
| **new** `ARCHITECTURE.md` §4.1 or CONVENTIONS §7 | a **compatibility-window** note: `0.182.0 ≤ three < 0.186.0`, `react < 19.3`. These ceilings are invisible in an exact-pin list and will be violated by a routine bump |

### If the asset pipeline is documented (§9, §11, §12)

| File · section | Change |
|---|---|
| **new** `docs/asset-pipeline.md` | the Blender → GLB → `gltf-transform` steps, the Draco/Meshopt/KTX2 decision, and the Spline caveat. Nothing currently owns this and A8 assumes it exists |
| `ASSUMPTIONS.md` A8 | A8 measures file bytes only. Add the texture/VRAM dimension, or A8 can pass while the page still evicts (`motion-tiers-spec.md:53`) |
| `hero-block-spec.md` §8, `scene-block-spec.md` | add a **texture budget** beside the 5MB byte budget |
| `word-quality-gate.md` §5.1 | `az doctor` detects an unoptimised GLB and prints the exact `gltf-transform` command — Tier 3 "detect and instruct", not Tier 1 |
| `PRD.md` §6.6 | note `gltfjsx` as an author convenience feeding `raw`, explicitly not a build step |

### If the rejections are accepted (§5, §6, §7)

| File · section | Change |
|---|---|
| `PRD.md` §7.2 | the "Considered and rejected" paragraph currently names only Astro and Tailwind. Add **Next.js**, **GSAP** and **Lenis** with one line each — a rejection that isn't written down gets re-proposed every quarter |
| `ASSUMPTIONS.md` A6 | A6's failure path says "switch to Astro + React islands". Next.js is now the other candidate; name both, and record `vite-react-ssg@0.9.2`'s pre-1.0 status as part of A6's risk |

---

## 15. Open questions for the owner

1. **Does the React-19 migration happen now, or is R3F held at v8?** It is one
   decision, not four: drei 10 requires fiber `^9`, and post-fx requires fiber
   `>=9.7.0`. Holding at v8 means holding drei and giving up post-fx, which
   means PRD §6.4's `full` tier promises something no pinned dependency
   delivers. *(Recommendation: migrate now, pre-build, while it costs nothing —
   ARCHITECTURE §4.1 has no code behind it yet.)*

2. **Who owns the pin-review cadence, and when does it run?** Both existing
   pins went stale before a single line of code was written. A pin without a
   scheduled re-read is the drift PRD §6.3 was written to defeat.

3. **Is a proprietary, revocable licence acceptable in emitted output — ever?**
   GSAP forces the question, but it will recur. **JUDGEMENT: make it a
   `word.json` rule — emitted `deps` must be OSI-approved — so it is decided
   once rather than per-library.** That rule also makes Spline's missing
   `license` field an automatic fail rather than a judgement call.

4. **Does A8's 5MB byte budget stay as the only asset gate?** It can be
   satisfied by a file that still evicts the tab. A texture/VRAM budget is the
   missing half.

5. **What replaces ScrollTrigger's `pin`/`scrub` for DOM-side scroll?** drei
   `ScrollControls` governs the canvas. `motion` covers reveals. Pinned page
   sections are a real gap in the chosen stack and no doc currently names an
   answer. *(This is the one place the GSAP rejection genuinely costs
   something.)*

6. **`vite-react-ssg` is `0.9.2` — pre-1.0 — and A6 is `UNVERIFIED`.** The SEO
   assumption rests on a package that has not committed to a stable API. Is
   that acceptable through M5, or does A6 get verified earlier than planned?

7. **PRD §7.2 says "Framer Motion" — is the package `motion` or
   `framer-motion`?** Both are `13.1.1`; the official upgrade guide says to
   "uninstall `framer-motion` and install `motion`" and swap imports to
   `motion/react`. Pick one name before it is written into eleven manifests.

## 12. MCP server for `az mcp` — **implement the stdio protocol; no SDK dependency**

Decided 2026-09-23 when `az mcp` was added (docs/mcp.md).

The reference TypeScript SDK (`@modelcontextprotocol/sdk` 1.30.1, MIT,
published 2026-09-23, Node ≥ 18) was checked on the npm registry. It declares
17 runtime dependencies — among them an HTTP framework and a second one, CORS
and rate-limit middleware, a JOSE library, SSE clients, two JSON-schema
validators — plus a schema library as a peer, 4.3 MB unpacked before those.
They serve its HTTP transports and OAuth client; a stdio tool server uses
none of them.

What `az mcp` needs is small and fully specified: newline-delimited JSON-RPC
2.0, and six methods (`initialize`, `ping`, `tools/list`, `tools/call`,
`resources/list`, `resources/read`). That is ~150 lines in `packages/mcp`
with node built-ins only, tested at the protocol level against the real
binary. Version negotiation follows the SDK's own supported list
(2025-11-25 back to 2024-11-05).

Revisit if `az mcp` ever needs an HTTP transport, sampling, or OAuth — the
SDK's weight pays for those.

## 13. Markdown for `text` bodies — **ADOPT, build-time only**

Decided 2026-09-23 when `text` began rendering `.md` bodies (text-spec §5).

Checked on the npm registry the same day; each is the latest release, MIT,
ESM-only, and runs on the repo's Node:

| Package | Pinned | Role |
|---|---|---|
| `mdast-util-from-markdown` | `2.1.0` | the parser's syntax tree — the only module `markdown.ts` calls |
| `micromark` | `4.0.3` | the CommonMark tokenizer underneath it |
| `micromark-extension-gfm-table` | `2.1.2` | tables |
| `mdast-util-gfm-table` | `2.0.0` | tables, as tree nodes |
| `micromark-extension-gfm-strikethrough` | `2.1.0` | strikethrough |
| `mdast-util-gfm-strikethrough` | `2.0.1` | strikethrough, as tree nodes |

On 2026-10-19 `micromark` `4.0.3`, `mdast-util-from-markdown` `2.1.0` and
`mdast-util-gfm-strikethrough` `2.0.1` replaced `4.0.2`, `2.0.3` and `2.0.0`:
each is the latest release, past the 7-day `minimumReleaseAge`, and its notes
list fixes, performance work and one additive listener API, no breaking change.

**Why a syntax tree, not an HTML compiler.** text-spec §11's criterion is a
parser that never emits raw HTML. The tree meets it by construction: raw HTML
is an `html` node the mapper drops with a warning, and every other node maps
to an emit-contract element that React escapes. There is no HTML string to
sanitise, so there is no scrub to bypass.

**Why not the combined extension the spec named** (`micromark-extension-gfm`
`3.0.0`): it also turns on footnotes, task lists, literal autolinks and the tag
filter, which §5 puts outside the subset. The two extensions §5 accepts are
taken individually instead.

**Where they live.** In `packages/target-web` — the compiler — not in any
generated site: the file is parsed at build and the site receives nodes. The
`text` manifest pins the same set so the gate's exact-pin check covers it, and
`packages/target-web/test/pins.test.ts` keeps the two lists equal.

---

## 14. Image library for uploads — **ADOPT `sharp` 0.35.5, server-only, only with an image field**

Decided 2026-10-06 for data-spec §8 / §16 Q6 (owner approval recorded in the
D3 work). Vetted before adoption, measured on this machine and in Linux
containers; the vetting harness lived outside the repository.

**What it is.** `sharp` 0.35.5 (Apache-2.0) with its prebuilt libvips 8.18.7
(**LGPL-3.0-or-later**, shipped unmodified as a separate shared library per
platform; ~20 MB installed, 19–29 MB measured across macOS arm64, Linux
x64/arm64 glibc, Linux x64 musl and Windows x64). It installs from optional
platform packages with no install script: it loads under
`--ignore-scripts`, the flag the repository's installs use.

**Advisories checked.** GHSA-rgj7-g3m4-5g8c (fixed 0.35.4),
GHSA-f88m-g3jw-g9cj (fixed 0.35.0), GHSA-54xq-cgqr-rpm3 (fixed 0.32.6),
CVE-2022-29256 (fixed 0.30.5): none affects 0.35.5.

**The pipeline it is used in** (`server/src/data-images.ts`), every step tested:

1. the type from the first bytes only — JPEG, PNG, WebP, AVIF; HEIC named and
   refused (no HEVC decoder);
2. every loader blocked (`VipsForeignLoad`), then only the JPEG, PNG, WebP and
   HEIF loaders unblocked — SVG, GIF, TIFF and the rest cannot decode in the
   process at all;
3. the header read alone: each side ≤ 8000, width × height ≤ 40 MP;
4. decode with `limitInputPixels: 40 000 000`, `failOn: 'error'`,
   `sequentialRead`; `autoOrient()`; fit inside 2048 × 2048 without
   enlarging; re-encode to WebP — never `keepMetadata`/`withMetadata`/`withExif`;
5. `sharp.cache(false)`, `sharp.concurrency(1)`, and one image at a time
   through a queue of 8 (beyond it, `429`).

**Measured (vetting, macOS arm64).** 24 MP JPEG fit to 2048: 478–514 ms, peak
RSS 148 MB; 40 MP: 471 ms, 137 MB; header bombs (100 000², 65 000²) refused in
1–2 ms; output byte-identical across the platforms above. **In the repository
(`packages/backend/test/data-images.test.ts`, fresh process):** nine 24 MP
uploads at once through the queue grew RSS by +19 MB over ~160 MB, against
+100 MB for the same nine run unqueued (the CONTROL).

**Alternatives.** The same libvips compiled to WebAssembly: on the same 24 MP
photo 871–914 ms and ~450 MB RSS, and full-size output failed — rejected. A
pure-JS decoder was set up but not measured to completion. A metadata-only
stripper (no decoding) was rejected on principle: it stores the uploaded
bytes, so a polyglot or malformed file survives and a decompression bomb is
never seen.

**Where it lives.** `BACKEND_PINS.sharp` in `packages/backend/src/emit.ts`,
written into a generated server's `package.json` only when a table has an
`image` field (a site without one is byte-identical); the repository's
`devDependencies` pin the same version for the tests
(`packages/backend/test/emit.test.ts` ties the two).

---

## 16. Image library for build-time resizing — **ADOPT the same `sharp` 0.35.5, CLI-only**

Decided 2026-10-06 for gallery-spec §7 rule 3 (the owner chose option A:
resize at build). No new library: the one vetted in §14, at the same pin.

**Where it lives.** `packages/cli/package.json` `dependencies` — the CLI only.
`core` and `target-web` never import it (they must run in a browser; the
target receives a `resize` function and stays pure), and a generated site
never ships it: it runs at build, on the author's machine or CI.
`packages/cli/test/images.test.ts` ties the CLI pin to `BACKEND_PINS.sharp`
and to the versions the encoder checks at run time.

**How it is run** (`packages/cli/src/images.ts`, `image-encode.ts`):

1. only in a child process (at most 8 images per child, each child killed at
   10s + 20s per image — 10× the slowest measured), so the compiler stays
   synchronous, a decoder fault ends the child and not the build, and no
   wait is unbounded;
2. §14's defences unchanged: the decoder allow-list (JPEG, PNG, WebP, HEIF
   for AVIF — now one constant, `IMAGE_DECODERS`, shared with the server),
   the header-only check (≤ 8000px a side, ≤ 40 MP), `limitInputPixels`,
   `failOn: 'error'`, `autoOrient()`, and no metadata written;
3. pinned output: WebP, effort 4, alpha quality 100, no smart
   subsampling or deblocking, lanczos3, never enlarged — lossy at quality
   80 for a photograph, lossless (near-lossless, level 60, where lossless
   outgrows the source) for line art, by gallery-spec §7's rule, and no
   variant larger than its source shipped; every option, the rule, and the
   library, core and WebP codec versions, hashed into each file's name; the
   child refuses to encode under any other library version;
4. a cache outside the build output (`AZ_IMAGE_CACHE`, default
   `$XDG_CACHE_HOME/az/images` or `~/.cache/az/images`), keyed by that hash;
   an entry is used only when every file matches its recorded SHA-256.

**Measured (macOS arm64, 2026-10-06).** Library load in a fresh process
~0.1s; a 6000×4000 noise JPEG (the worst case for the encoder) to all four
widths, 1.16s; two cold caches give byte-identical variants
(`pnpm verify:build`, `images.test.ts`), and a warm rebuild encodes nothing.

**Cost.** ~20 MB of prebuilt binaries per platform in the CLI's install,
already in the repository for the backend's tests. By design (not exercised on
such a platform) a missing binary or another library version builds without
srcset, with one warning, and never fails the build.


---

## 17. Lighthouse for the pre-M5 audit — **ADOPT `lighthouse` 13.5.0, root devDependency only**

Decided 2026-10-07 for ROADMAP M5's exit criterion (Lighthouse perf ≥ 85
on mobile, SEO ≥ 95, a11y 100 — ASSUMPTIONS A6), run early on synthetic
sites so M5 does not trip on defects the compiler puts into every site.

**What it is.** `lighthouse` 13.5.0 — read from the npm registry on
2026-10-07: `latest` dist-tag, published 2026-09-18 (newer entries are
`-dev` nightlies under the `next` tag). Apache-2.0. `engines.node >=22.19`;
the repository runs Node 22.23.2. No peer dependencies. 19.2 MB unpacked,
106 packages added to the lockfile (`pnpm audit`: no known
vulnerabilities on the day).

**How it runs here.** Programmatically (`import lighthouse from
'lighthouse'`), against Playwright's own Chromium (`chromium
.executablePath()`, Chrome for Testing 153 at Playwright 1.63.0), started
by `scripts/lighthouse.mjs` as a child with `--headless=new
--remote-debugging-port=0` and a fresh profile, then passed to Lighthouse
as `port` — so no second browser is downloaded and Lighthouse's own
launcher is not used. The default config is used unchanged: mobile
emulation, simulated throttling. Its error reporting is off unless the
`enableErrorReporting` flag is set (`core/lib/sentry.js`); the script
never sets it, so a run sends nothing anywhere.

**Where it lives.** The repository root's `devDependencies`, for
`pnpm test:lighthouse` only. No `packages/*` manifest, no `word.json`, and
no emitted `package.json` names it; a generated site never installs it.

**Alternatives.**
- *Playwright plus `web-vitals` by hand*: LCP, CLS and INP from the page
  itself, no new dependency. But M5's criterion is a Lighthouse score —
  a weighted model over simulated throttling plus the SEO, a11y and
  best-practice audit sets — and re-implementing it would measure
  something else under the same name.
- *axe alone* (already pinned, `@axe-core/playwright`): covers the a11y
  category's rules (Lighthouse runs axe for it) and nothing of perf, SEO
  or best practices.
- *Lighthouse CI* (`@lhci/cli`): adds a server, assertions and history —
  machinery for a dashboard M5 does not need, around the same engine.
- *A hosted page-speed service*: sends the site to a third party and
  cannot reach a local build.

**Drawbacks.** A large tree for a check (106 packages, among them a
second browser-automation client and an error-reporting SDK that stays
unloaded). Performance scores are sensitive to the machine's load, so the
script runs sites one at a time, waits for the other browser checks to
finish, audits each site three times and reports the median with the
spread and the load average. Desktop headless Chromium on Apple silicon
is not a phone: simulated throttling models a mid-range device's CPU and
network, but GPU work (the 3D canvas) runs on this machine's GPU.

**Decision.** Adopt as a root devDependency for `pnpm test:lighthouse`.
Revisit when M5 measures a deployed site (a real host's compression,
caching and latency), or if the engine requirement outruns the
repository's Node.

## 18. The chat's model client — **no dependency: Node's `fetch`, `AbortSignal`, `TextDecoder`, `crypto`**

The generated server's `POST /chat` (chat-block-spec.md §4.3) calls a model
over HTTP and reads its streamed answer. Evaluated 2026-10-15 for C1:

| Option | Verdict | Why |
|---|---|---|
| a provider's official SDK | **REJECT** | ties the server to one vendor (owner's rule: providers are switchable, services are thin proxies), brings its own dependency tree into every generated server, and its value — retries, typed responses for dozens of endpoints — is for one call we use |
| a generic multi-provider client library | **REJECT** | a second abstraction over ours; its provider list is a vendor list in our lockfile; supply-chain surface |
| an SSE parsing package | **REJECT** | the format is a few dozen lines (line framing, `data:`, blank-line dispatch); `chat-sse.ts` is tested against chunks split at every byte offset and a line cap |
| Node built-ins (`fetch`, `AbortSignal`, `TextDecoder`, `crypto`) | **ADOPT** | already required (Node ≥ 22.18, backend-spec §8); the adapters (`chat-adapters.ts`) are named by wire shape — `completions`, `fake` — and every endpoint, key and model id comes from `.env` |

## 19. Maps in chat answers — **ADOPT `maplibre-gl` 6.14.0, `pmtiles` 4.5.0, `@protomaps/basemaps` 5.7.2, only on a site whose chat shows maps**

Chat-block-spec §21.4 (phase C8, owner-decided 2026-10-16, §17 Q19a–Q19h)
draws a map in a chat answer: pins and routes, from a public table's rows or
from numbers the model wrote. The research is the chat spec's [R11]; this
section is the vetting global rule 11 asks for, done again when C8 was built
(2026-10-16).

| Package | Role | Version pinned | Licence | Dependencies |
|---|---|---|---|---|
| `maplibre-gl` | the WebGL vector-map renderer; ESM, its own type declarations; draws in a module worker (`dist/maplibre-gl-worker.mjs`) | `6.14.0` | BSD-3-Clause | 18, all MIT, ISC, BSD-2/3 or (MIT OR Apache-2.0) |
| `pmtiles` | reads a single-file tile archive over HTTP `Range` and hands the renderer its tiles (an `addProtocol` handler) | `4.5.0` | BSD-3-Clause | `fflate` (MIT) |
| `@protomaps/basemaps` | the basemap's style layers for that archive's schema, in a light and a dark set the page re-colours from its tokens | `5.7.2` | BSD-3-Clause | none |

**FACT** (registry, 2026-10-16): `maplibre-gl` `latest` was `6.14.0`,
published 2026-10-11 — five days old, inside the workspace's 7-day
`minimumReleaseAge` (`pnpm-workspace.yaml`, 10 080 minutes). The newest
release past it was `6.13.0` (2026-10-06), pinned when C8 was built; R11's
`6.14.0` was the next bump once it was a week old. `pmtiles` `4.5.0`
(2026-08-10) and `@protomaps/basemaps` `5.7.2` (2026-03-10) are each the
latest.
`npm audit` on the three at these versions (28 packages, a clean install
outside the repository): **0 vulnerabilities**; `pnpm audit` in the
repository after adding them as development dependencies: no known
vulnerabilities. Licences of the 28 packages in the tree: BSD-3-Clause (5),
ISC (8), MIT (12, the type-only `@types/geojson` among them), BSD-2-Clause
(2), (MIT OR Apache-2.0) (1).

**The bump to `6.14.0`** (2026-10-19, eight days old; `6.15.0`, published
2026-10-18, is inside the release age). Compared tarball to tarball against
`6.13.0`: the worker file differs only in the version in its licence line
(508 314 bytes both), so the `blob:` start, `setWorkerUrl` and
`worker-src 'self' blob:` are as before; the dependencies are the same; the
stylesheet only merges two popup-anchor rules; the renderer's bundle has the
same `createObjectURL`, `innerHTML` and `new Worker` uses as before and no
`eval` or `new Function`. What changes: the line, circle, collision and
symbol shaders drop `flat` interpolation (a workaround for blank maps on
some iPadOS 16 devices); a frame is skipped while the WebGL context is lost;
a tile that fails triggers a repaint, so `load` and `idle` still fire; and
a `globalState` option. None of it touches the frame `chat-map-gl.ts` draws
after `load` for WebKit on Linux: `triggerRepaint` is unchanged.

**Where they go.** They are runtime dependencies of a *generated* site,
pinned exactly in its `package.json` (target-web `PINS.maplibre`,
`PINS.pmtiles`, `PINS.basemaps`; `pins.test.ts` ties them to the rows of §13)
— and only a site whose chat shows `map` gets them, with the map runtime
files; every other site's package.json and output are unchanged. The
repository has them as development dependencies, at the same versions, so
the overlay runtime's map module type-checks and the generated-types test
checks a map site against them.

**Measured** (a built map site, 2026-10-19, `maplibre-gl` 6.14.0, gzip -9):
the map module chunk (renderer, archive reader, styles) 293 KB, its worker
144 KB, its stylesheet 10 KB — **447 KB** (446 KB on 6.13.0), loaded by a
dynamic `import()` only when the first map event arrives on a chat page that
shows maps (Q19f accepts ≈ 440 KB). The
page's own bundle grows by the map's list and drawing code only.

**What each brings to the page's policy, measured in Chromium, Firefox and
WebKit (2026-10-16):**

- The renderer's worker. Started from the same-origin URL, a worker is
  governed by its own response, not the page's `<meta>` policy (Q19b). The
  page starts it from a `blob:` URL whose one line imports the site's worker
  file, which the renderer's `setWorkerUrl` takes; a worker from `blob:`
  inherits the page's policy. The policy gains `worker-src 'self' blob:` on
  map pages only — nothing else.
- The renderer's navigation control draws its icons from `data:` images: on
  a page whose `img-src` has no `data:` that is three violations per map
  (measured). It is never added; the chat word's own buttons zoom and reset.
- The renderer's popup close button writes `&#215;` with `innerHTML`; popups
  are made with `closeButton: false` and their content is an element
  (`setDOMContent`) whose text is `textContent`.
- The stylesheet ships as a build file (`style-src 'self'`); the renderer
  sets sizes and transforms through the CSSOM, which a policy does not
  govern. No `'unsafe-eval'`, no `'wasm-unsafe-eval'`.
- The build's secret guard read the renderer's minified bundle as holding
  keys: `NAME=value` sequences in its shaders and code, a path of words in a
  message link, and the worker file's own hashed name. The guard now reads a
  key's run with `=` only as trailing padding, skips a `/`-path every segment
  of which is all digits or lowercase words, and allows the names of the
  files the bundler emitted (core `secrets.ts`); a key in any of those places
  is still found (`secrets.test.ts`).

**Rejected alternatives** (R11): a raster tile service (every pan a request
to a third party, and a key in the page); the renderer's own CDN build (a
third-party script origin); a hosted vector tile service by default (its
origin in `connect-src`, and every place a visitor looks sent to it — kept as
the operator's explicit choice, `AZ_PUBLIC_MAP_TILES_URL`, which `az doctor`
names).

**Data.** The default archive is the world to zoom 6 (≈ 46 MB), which the
operator downloads and serves from their own backend
(docs/self-hosting.md); the tests make a few-kilobyte archive of their own
(`scripts/lib/map-fixture.mjs`) and never download one. The map data's
licence (ODbL for the usual source) requires its attribution under every
map: the operator writes it in `AZ_MAP_ATTRIBUTION`, which the server
refuses to start without once an archive is set.

