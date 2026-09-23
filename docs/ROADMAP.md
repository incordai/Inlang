# ROADMAP

Milestones in dependency order. **Each has an exit criterion. Do not start the
next milestone until the current one's exit criterion is met and checked in.**

`⛔ STOP GATE` means: if the criterion fails, halt and re-plan. Do not work
around it.

Estimates assume one focused person. Roughly double for evenings/weekends.

---

## M0 — Spike · 1 week

**No compiler. No abstraction. Hand-write one thing and measure it.**

Build a single `hero 3d scroll` by hand in React + R3F:

- all three motion tiers (`full`, `lite`, `static`)
- **the runtime tier probe** — `motion-tiers-spec.md`. This is the point of M0
  now; the tiers without the probe that chooses between them prove nothing
- scroll-linked camera, poster image, and **the theme procedural scene as the
  default geometry** (scene-spec §11.1). Build the opt-in `.glb` path too, so
  both are measured — but procedural is what a `hero 3d` gets by default
- `prefers-reduced-motion` → `static`
- `dispose()` on unmount, DPR clamped
- a forced-tier override (URL parameter) so snapshots stay deterministic

**Measure on the best hardware available** — laptop plus the synthetic-throttle
proxy in `motion-tiers-spec.md` §8. If a mid-range Android is available, run
the full protocol in VERIFICATION §2 and record it; if not, M0 still completes.

**Exit criteria**
- [ ] all three tiers render correctly and are visually distinct
- [ ] the probe selects the right tier on every device available, including a
      deliberately throttled one (tests A1b)
- [ ] zero tier oscillation across a 60s scroll; downgrade ratchets one way
- [ ] `full` ≥ 50fps (p5) on a 2021+ laptop
- [ ] no memory growth across 5 mount/unmount cycles
- [ ] hand-written hero ≤ ~250 lines, **counted twice and recorded separately**
      (tests A2): once for scene structure alone, once including the shader and
      buffer code that carries the distinctive look. A2 splits into two claims
      and only the structural one is currently supported
- [x] procedural scene reproducible: identical vertex-buffer hash across two
      builds, two runs and two browser engines (tests A8b) — this replaces the
      model budget as the critical-path 3D check
- [ ] Draco model < 5MB **on the opt-in model path only** (tests A8)
- [ ] forced-tier override works; a snapshot pinned to `lite` is reproducible
- [ ] `ASSUMPTIONS.md` A1b, A2, A8, A8b updated to `HOLDS` or `FAILED`; A1 updated
      only if a real device was actually measured

⚠ **This is no longer a stop gate**, because a slow device now degrades itself
rather than shipping a broken scene (`ASSUMPTIONS.md` A1). **A1b replaces it as
the thing that can go wrong** — if the probe cannot reliably pick a tier, stop
and read A1b's failure path before starting M1.

---

## M1 — Compiler core · 2 weeks

**Entry:** M0 exit met.

- monorepo scaffold, CI green
- lexer + indentation parser → AST with positions
- `az 1` version marker parsed and validated
- link stage: manifest loading, theme resolution, graph build
- validate stage: conflicts, requires, slots
- `Spec` type + JSON snapshot tests
- `target-web` skeleton emitting a runnable Vite project
- `az build`, `az dev` (watch + HMR)
- path sandboxing, escape-on-emit, exact-pin lint, `--ignore-scripts`

**Exit criteria**
- [ ] a 5-line `.az` compiles to a site that runs
- [ ] `az build` twice → byte-identical output (automated test)
- [ ] `az build` succeeds with network disabled (`node_modules` present)
- [ ] cold compile < 1s on the reference fixture
- [ ] CI enforces the dependency rules in ARCHITECTURE §2

---

## M2 — Word set v1 + quality gate · 4 weeks

**Entry:** M1 exit met.

Vocabulary (PRD §6.2 is authoritative):

- **5 structure keywords**, in `core`: `site` `theme` `font` `page` `raw`
- **11 block words — the hard cap**, one folder each: `nav` `hero` `feature`
  `gallery` `pricing` `faq` `cta` `footer` `auth` `scene` `text`
- each block's **variants and modifiers** are declared in its own `word.json`
  and specified in its own `*-block-spec.md`. They are not separate words and
  are not counted against the cap — but each variant still needs its own
  snapshots and its own row in the block's responsive table, so they are not
  free either.

Also: the theme token system + 3 hand-designed themes; the overlay engine +
`dropdown` preset (nav needs it); the button primitive (4 hierarchies × 8
intents × 6 states); the 12-point gate in CI; **thumbnail emission** (1 day,
free while snapshots exist — authoring-experience §2).

**Exit criteria**
- [ ] all 11 blocks pass the 12-point gate, in every variant
- [ ] all 5 structure keywords implemented and covered by fixtures
- [ ] `az lint` fails a deliberately non-compliant word (tests A7)
- [ ] 3 themes, all blocks rendering correctly in each, light and dark
- [x] thumbnails generated for every block and every variant
- [ ] mobile motion vocabulary **designed and written down** (PRD §6.4)

⛔ **Do not add block #12.** Not for any reason. Log requests in a backlog file.
A new *variant* on an existing block is a smaller decision but still a
deliberate one — it costs snapshots in three widths × two schemes × three
themes, so it goes in the backlog too and gets decided, not slipped in.

---

## M3 — Escape hatch + lint · 1 week

- `raw <path>`, `slot <name> <path>`
- `az eject <word>` — one-way, prints that it is one-way
- `az lint` complete
- `az migrate` skeleton (no-op for v1 grammar, proves the path exists)

**Exit criteria**
- [x] a custom component mounts via `raw` and receives theme tokens
- [x] `az eject hero` produces editable source that still builds

---

## M4 — Auth adapters · 1 week

Adapters only. **We never implement auth** (PRD §6.5).

- `auth hosted`, `auth azbackend`
- login / signup / reset UI from theme tokens, session hook, protected route
- **secret-leak detection** — hard error if a service-key pattern would be
  inlined (word-quality-gate §4)
- adapter docs stating anon-key vs service-key explicitly

**Exit criteria**
- [ ] working login against a real hosted-provider project — **open**: needs a
      provider account; the same flows pass against a local mock provider
      speaking the §3.2 protocol (`pnpm test:auth`, in CI)
- [x] build **fails** when a service key is present in env (verify-build, by
      name and by token role; `az build` refuses first — cli/test/secrets)
- [x] bundle scan finds no high-entropy secrets (every generated build scans
      its output; verify-build proves a planted key fails it and the clean
      fixture, public key included, passes)

---

## M5 — Dogfood ⛔ STOP GATE · 2 weeks

**Entry:** M4 exit met. **A real site with a real brief.** Not a demo.

**Exit criteria**
- [ ] site shipped to production
- [ ] escape-hatch ratio ≥ 80% (tests A4)
- [ ] Lighthouse: perf ≥ 85 mobile, SEO ≥ 95 (tests A6), a11y 100
- [ ] `ASSUMPTIONS.md` A3, A4, A6 updated
- [ ] **grammar frozen** — tagged `grammar-v1`
- [ ] proof demo recorded (distribution-and-hosting §6)

⛔ **If escape-hatch ratio < 50%, stop.** The abstraction is wrong. Reconsider
the grammar before building anything else.

⛔ **Do not launch publicly before this milestone completes.** Virality is
one-shot.

---

## Phase 1.5 — after M5 · ~4 weeks

Tier A blocks (11, buttons-and-sections §2), informed by what M5 actually
needed. Add the missing words M5 revealed. `az deploy`. `az doctor`.

## Phase 2 — ~6 weeks

Tier B blocks (6). Remaining overlay presets. Tauri **desktop** (spike first).
Word-pack system + **trust tiers before the registry opens** (cannot be
retrofitted). Playground (2 weeks, no backend).

## Phase 3 — ~6 weeks, gated

Content system (one pipeline → `blog`/`docs`/`help` presets). Tauri **mobile** —
spike WebGL/WebView in week 1 before committing. Mobile word emitters.

## Phase 4 — only if warranted

LSP + VS Code extension. Machine-readable index + `llms.txt`. Fuzzy matcher.
A model only after real LSP usage data exists.

---

## Current status

*Updated 2026-09-22. Every figure below is from a run on that date.*

**Milestones were built out of order.** M0 is not closed, yet most of M1 and
M2 exists. The gates above still stand: nothing below waives them.

**M0 — partly done.** `spike-m0/` has the hand-built hero, the three tiers and
the runtime probe.
- Procedural determinism (A8b) is verified across builds, runs, macOS arm64
  and Windows x64, and three engines — Chromium, Firefox, WebKit
  (`pnpm test:engines`). Visual-snapshot stability over 10 runs is unmeasured.
- Probe logic tests pass (`pnpm test:probe`); A1b stays `TESTING` until a
  deliberately throttled device is measured.
- Still open: the throttled-device probe run, the 60s no-oscillation scroll,
  the fps and memory measurements, the two line counts, and the opt-in
  `.glb`/Draco path — **which the spike never built**, so A8 cannot be
  measured yet.

**M1 — compiler core built.** Lexer, parser, link, validate, Spec and the web
target exist; `az build`, `az dev`, `az spec` and `az check` work.
`.github/workflows/ci.yml` runs typecheck and unit tests on every push, a
nightly OS/Node matrix, and an end-to-end build that installs, builds and
server-renders a compiled site (`pnpm verify:build`); its results on GitHub
were not checked when this was written.
The offline build (every network path poisoned) and the <1s cold compile of
the reference fixture are automated in `packages/cli/test/m1-exit.test.ts`.

**M2 — words mostly built.** All 11 blocks emit; 39/39 variants and 47/51
props are implemented (`pnpm coverage`). Three themes exist; theme lint (A7)
holds. The remaining four props are blocked:
`hero.model`, `scene.model` and `scene.camera` need the 3D runtime ported
from the spike (after M0, and after the pin, renderer-placement and Draco
decoder decisions). `auth.impl` is consumed by the target's auth wiring
(M4) rather than the word's markup, so `pnpm coverage` still lists it.
Styling: words describe `style` plus named variants — `below.<breakpoint>`,
`states.<state>`, `reducedMotion` (ARCHITECTURE §4.3) — and the target
compiles every styled node into one generated class in `src/az.css`; lint
rejects raw conditions in word source.
Responsive tables: every row that changes layout is implemented for all 11
words (hero, cta, faq, text, feature, auth, scene, gallery, footer, pricing;
nav takes only the mobile gutter), and every section takes `gutter-sm` below
sm. Pricing `table` transposes to per-plan panels by emitting both forms
(decision D5). Rows that change columns are checked in a browser at 390 vs
1440 (`restack`), hero split's text column at 1440 (`column`).
Buttons: one action primitive (buttons-and-sections §1) — words hand their
`cta`/`alt` fills to `ctx.actions`; intent from the destination, weight from
position or `as`, link vs button by intent, all six states, 44px targets,
inverted tone on the cta band. feature, gallery and text had been dropping
their section actions; they now render them.
All of this is checked by `pnpm test:visual` in CI (axe, keyboard, overflow,
reduced motion, schemes, restack, column, skip link; Chromium, plus Firefox
and WebKit for overflow, page errors and every behaviour check). Block validation tables are
manifest `checks`; `az lint` exists.
`pnpm gate [words/<name>]` runs the 12-point word gate as one command and
passes for all eleven words: it aggregates typecheck, `az lint`, the
browser checks, each preview with a site nav and footer built and
server-rendered, the bundle budget, exact pins, docs and previews, and the
`tested` field (`pnpm gate --self-test` proves each non-browser item can
fail). The browser items cover each word's previews — preview.az and any
preview.<variant>.az — in all three themes. `pnpm gate --every-variant`
adds every other variant (preview.az with the variant swapped in, default
theme, light and dark, all widths and engines; 85 sites): every word and
variant passes except nav `side`. Its 256px column takes the full viewport
height and the page's content flows BELOW it instead of beside it, so an
anchor lands under it (scroll-padding check, Firefox and WebKit). Putting
content beside a sidebar is page layout — nav-spec open question 2
("page layout that happens to contain a nav … decide before docs") — so it
is left for that decision, and the "every variant" box stays open. CI runs
the gate without the flag.
`pnpm thumbnails` renders one PNG per word × variant (37; `none` renders
nothing) into the gitignored .thumbnails/ — no doc says where thumbnails
ship, so they are build output; `--verify` renders twice and requires
identical bytes. CI runs the gate and the thumbnail check.
Footer `mega` accordions (cabe922) and pricing's "in every plan" list
(4c4a61f) have landed. The overlay engine and behaviour runtime exist
(packages/overlay, copied into each site as src/az/): nav's mobile menu
is a drawer and its links collapse into it below sm; every bar group is a
dropdown; `solid` turns solid on scroll with its logo swap; faq answers
are disclosures (hidden="until-found"); `video:` opens a popup player and
`copy:` copies with an announcement; nav `hide` retracts on scrolling
down and `shrink` shrinks inside a frame that reserves its height (no
layout shift); a pinned nav ships §5's scroll-padding from `--az-size-nav`;
gallery `carousel` has previous/next controls and `lightbox` a popup viewer
(no wrap, polite counter, focus back to the thumbnail shown); faq answers
open from a text-fragment link on arrival; feature icons are inlined and
sanitised at build (feature-spec §7). Each behaviour is checked in
Chromium, Firefox and WebKit by `pnpm test:visual` (drawer, dropdown,
solid, hide-shrink, scroll-padding, faq, faq-deep-link, carousel,
lightbox, copy, play, overlay-motion, nav-motion), with a self-test
proving each fails without what it tests. Still not built: `popup:#id`
declared popups (Phase 1.5 grammar, warned AZ1222) and the
`sheet`/`tooltip`/`toast` presets.

**M3 — exit criteria met.** `raw <path>` and `slot <name> <path>` are
validated at the link stage (placement AZ1217, slot name AZ1218, shape
AZ1219, sandbox and type AZ1210/AZ1410); the CLI copies each module into the
generated project's `src/user/` through the asset sandbox, and the App renders
it with the theme (verify-build: a `slot after` component follows its hero, a
page `raw` sits in the flow, both receive `var(--az-…)` tokens). `az eject`
hands a word to the project's `words/`, whose words override the bundled ones;
an edited ejected hero builds through `az build` and `vite build`. `az lint`
and the `az migrate` skeleton exist. Known limits: a component is copied as a
single file (its own relative imports are not carried), and `az dev` must be
restarted to pick up edits to an ejected emitter.

**M4 — built; one exit criterion open.** Adapters only (PRD §6.5):
`packages/auth-runtime` holds the contract (auth-spec §3.1), the `hosted`
adapter (a provider-neutral protocol over `AZ_PUBLIC_AUTH_URL` and the public
`AZ_PUBLIC_AUTH_KEY`, §3.2), the `session` adapter (same-origin cookie routes,
§3.3) and the form behaviour; `custom` imports the author's `impl` through the
module sandbox. It is copied only into sites that use `auth` — a site without
it is byte-identical to before. Protected pages are a site-level
`protect /route …` list; `<Protected>` shows the nav while checking, then the
page with a signed-in bar, or sends the visitor to login with a same-origin
`?next`. Secret leakage is refused three ways, none suppressible: AZ1411 for a
key in the `.az` file, `az build`'s scan of the env and `.env` files, and a
guard inside every generated build (env again, then every emitted file).
`azbackend` is refused (AZ1214) until PRD §11 Q2 is decided. Open: the
real-provider login.

**M5 — not started.**

Still outstanding and not answerable by writing code — PRD §11: open-source
vs internal, the fate of the backend project (decides `auth azbackend`), a
real client site for the M5 dogfood, and the licence.
