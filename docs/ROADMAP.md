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
- [x] all three tiers render correctly and are visually distinct — spike `browser.test.ts` (CONTROL: the three tiers render differently)
- [ ] the probe selects the right tier on every device available, including a
      deliberately throttled one (tests A1b)
- [x] zero tier oscillation across a 60s scroll; downgrade ratchets one way — 60s at 4×/6× throttle held rung 0; a synthetic 22ms load stepped 0→5 one way (`m0.test.ts`, proxy)
- [ ] `full` ≥ 50fps (p5) on a 2021+ laptop
- [x] no memory growth across 5 mount/unmount cycles — +1.0 MB JS heap (`m0.test.ts`)
- [x] hand-written hero ≤ ~250 lines, **counted twice and recorded separately** — 237 structural / 481 with the look (ASSUMPTIONS A2)
      (tests A2): once for scene structure alone, once including the shader and
      buffer code that carries the distinctive look. A2 splits into two claims
      and only the structural one is currently supported
- [x] procedural scene reproducible: identical vertex-buffer hash across two
      builds, two runs and two browser engines (tests A8b) — this replaces the
      model budget as the critical-path 3D check
- [x] Draco model < 5MB **on the opt-in model path only** (tests A8) — 0.38 MB
      for a 218,880-triangle sample, geometry only (ASSUMPTIONS A8; textures unmeasured)
- [x] forced-tier override works; a snapshot pinned to `lite` is reproducible —
      byte-identical PNGs across fresh contexts and a browser restart, spike
      (`pnpm test:snapshot`) and generated site (`pnpm test:3d`), each with a
      differing control (ASSUMPTIONS A1b, motion-tiers-spec §6.1) (2026-10-06)
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
- [x] a 5-line `.az` compiles to a site that runs — verify-build builds and renders a 5-line site
- [x] `az build` twice → byte-identical output (automated test) — `cli.test.ts` DETERMINISM, verify-build
- [x] `az build` succeeds with network disabled (`node_modules` present) — `m1-exit.test.ts`
- [x] cold compile < 1s on the reference fixture — `m1-exit.test.ts` (measured 140–260ms)
- [x] CI enforces the dependency rules in ARCHITECTURE §2 — `deps.test.ts` in `pnpm verify`, run by CI

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
- [x] all 11 blocks pass the 12-point gate, in every variant
- [x] all 5 structure keywords implemented and covered by fixtures — `site`
      (`width`, `theme`; core `link.test.ts`, `compile.test.ts`, the gate's
      `frame` check), `page` and `raw` (`fixture-site.az`, `escape-hatch.test.ts`
      in core and cli), `font` (core and target `font.test.ts`, verify-build,
      the gate's `font` check in three themes), and `theme`'s settings
      `accent` and `pattern` (core and target `theme-settings.test.ts`,
      `packages/theme/test/{accent,pattern,contrast}.test.ts` — 54 accent
      choices, 1260 pairs — verify-build, and the gate's `theme-settings`
      check on the hero) (2026-10-05)
- [x] `az lint` fails a deliberately non-compliant word (tests A7) — `lint-migrate.test.ts`
- [x] 3 themes, all blocks rendering correctly in each, light and dark — `pnpm gate --every-variant`
- [x] thumbnails generated for every block and every variant
- [x] mobile motion vocabulary **designed and written down** (PRD §6.4) —
      `docs/mobile-motion-spec.md`; design only, built with Phase 3's mobile emitters (2026-10-06)

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
      speaking the §3.2 protocol (`pnpm test:auth`, in CI). The owner's chosen
      cloud is reached through `profile token-endpoint` (auth-spec §3.5, unit
      tested); `pnpm test:cloud-auth` drives it against the **real
      open-source server software** that cloud runs, in Docker, with no
      account — **passes, 16/16** (2026-09-23): sign-up, sign-in, the
      protected page, sign-out, the wrong-password copy, reset through the
      emailed link, a sign-in link continuing to `next`, and the same answer
      for an unknown address. The box stays open because that is the server
      software, not a hosted account.
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

*Delivered early (2026-09-23):* `az mcp` exposes the word catalogue, the
grammar and the compiler's commands to an agent over MCP — a machine-readable
index in practice (docs/mcp.md). The LSP and `llms.txt` remain.

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
  the fps and memory measurements, and the two line counts. The opt-in
  `.glb`/Draco path is built and measured (2026-09-23, `pnpm test:model`):
  A8 holds for geometry, textures unmeasured.
- §5's deferral deadline (rungs 3–7 never past 2s) was a spike scheduler
  defect, not load: the deadline counted from when a 100ms poll first saw the
  decision and was checked only on poll ticks. It now runs from the frame the
  probe decided on, enforced by a timer. `test:m0`'s ≤2300ms check measured
  2111/2148/2224/2143/2137ms over 5 runs (load average 2–7); the previous
  scheduler measured 2227 and 2346ms (the second a failure) the same day.

**M1 — compiler core built.** Lexer, parser, link, validate, Spec and the web
target exist; `az build`, `az dev`, `az spec` and `az check` work.
`.github/workflows/ci.yml` runs typecheck and unit tests on every push, a
nightly OS/Node matrix, and an end-to-end build that installs, builds and
server-renders a compiled site (`pnpm verify:build`); its results on GitHub
were not checked when this was written.
The offline build (every network path poisoned) and the <1s cold compile of
the reference fixture are automated in `packages/cli/test/m1-exit.test.ts`.

**M2 — words built.** All 11 blocks emit; 39/39 variants and 50/52 props
(`pnpm coverage`). Three themes exist; theme lint (A7) holds. The two props
coverage still lists — `auth.impl` and `auth.protect` — are consumed by the
target's auth wiring (M4) rather than the word's markup, which is all the
script reads.
3D (2026-09-23): the spike's runtime is ported into generated sites
(`packages/scene-runtime`): one WebGL renderer per page drawing every view
by scissor (scene-spec §5), the 8-rung ladder and probe, the seeded
procedural scene (the ported generator reproduces the spike's cross-engine
hash `cc723c2a1b107de4`), Draco models with the decoder self-hosted, camera
`fixed`/`scroll`/`parallax`/`orbit`, and gallery `orbit`'s image ring. Only
a site that declares a 3D view gets `three` (0.186.0) and the runtime; its
entry loads the 3D chunk lazily after paint, and never at `static` or under
reduced motion. `pnpm test:3d` checks it in Chromium (and smoke-tests
Firefox and WebKit). Headless WebGL is software, so none of it is device
evidence — M0's real-device checks remain open.
Also built: §7 budget eviction (64MB of estimated GPU memory; the
least-recently-visible paused view goes back to its poster and is rebuilt on
return; shared models are freed only when unreferenced), and the §6.5 veil —
over a backdrop, `hero` and `text` sit on `color.veil`, sized so contrast
holds against any backdrop pixel. Browser-checked: eviction and its memory
release, scheme-change repaint (OS and `data-scheme`), the veil and axe on a
backdrop page. Open, as a spec conflict for the owner: scene-spec §8 says at
`lite` only the scene nearest the centre animates, while motion-tiers-spec §5
rung 6 makes `lite` a static camera for every view — so the runtime's
nearest-centre branch can never run.
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
variant passes (verified 2026-09-23, 607s). nav `side` was the last
failure: nav-spec §10 Q2 is resolved as its recommendation — `side` is a page
layout, so the target lays such pages out as a sticky nav column beside the
content column, stacking below `breakpoint.sm`. CI runs
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
Images (gallery-spec §7, 2026-10-06): every `<img>` of a project file ships
its header's `width`/`height` (rule 1), and gallery images ship a `srcset`
resized at build (rule 3, owner option A): up to four WebP widths (480, 768,
1200, 1800), never upscaled, with a `sizes` from the layout; the original
stays the `src`. The CLI encodes in a bounded child process with the
backend's vetted image library and limits (stack-evaluation §16), names each
file by a hash of its bytes and the pinned options, and caches it outside the
output; the lightbox carries each image's srcset and size. §11's 500KB
gallery-image budget warns. Measured in `pnpm test` and `pnpm verify:build`
(shipped srcsets, file widths, cold-cache determinism). Not yet: srcset on
other words' images (they give no `sizes`), `orbit`, and `from` rows.

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
`azbackend` is built: PRD §11 Q2 was decided (the backend project continues),
auth-block-spec §3.4 is the protocol the backend implements, and
`pnpm test:auth` proves the site's side against a mock on another origin in
three engines. Open: the real-provider login, and a login against the real
backend once it implements §3.4.

**Data (data-spec) — D1 and D2 built 2026-10-05; D3 (images) and D4 (`from` in blocks) built 2026-10-06.** `data <table>`
under `site` declares fields and closed `allow` rules (AZ1226–AZ1249, AZ1415);
`az backend plan` / `az backend schema` record each schema change in the
`<site>.data.json` lock, which `az build` checks and never writes
(AZ1701–AZ1708). The generated server applies the steps claimed and
resumable — destructive ones only with `--migrate --confirm <version>` — and
serves `/data/<table>` with the owner check inside each statement; the site
gets a typed client (`src/data/client.ts`), the server an `openapi.json`. The
same claim-before-run now guards the auth migrations. Measured that day:
`pnpm test` (the rule matrix — every legal rule set × 3 actors × 5 routes — and
the §13 rows without uploads or admin), `pnpm test:backend-db` (every
migration kind, resume, two migrators, a unique race on PostgreSQL 18.6 and
MySQL 8.4.11; the spec's three inferences settled, data-spec §18.2) and
`pnpm test:data` (the typed client from a built site in Chromium, Firefox and
WebKit — WebKit signed-out only, as it drops Secure cookies on http loopback).
D2, the admin area: verified accounts listed in `AZ_ADMIN_EMAILS` reach
`/admin/...` on the server (rules bypassed, validation never, every write an
`az_data_audit` row without values); the site gets generated `/admin` and
`/admin/<table>` pages inside `<Protected>` (AZ1268 for `page /admin`).
Measured the same day in `pnpm test`, `pnpm test:backend-db` and
`pnpm test:data` (axe, keyboard, refusals) — data-spec §18.3.
D3, images: an `image` field is uploaded raw to `PUT /data/<t>/<id>/<field>`,
sniffed, decoded under a loader allow-list with pixel limits, and stored
re-encoded as WebP without metadata (`sharp` 0.35.5, vetted —
stack-evaluation §14); replace, clear and row deletes remove the old file, an
hourly sweep removes orphans; the typed client and the admin editor upload,
replace and remove. Measured in `pnpm test`, `pnpm test:backend-db` and
`pnpm test:data` — data-spec §18.4.
D4, `from <table>` in `feature`, `faq` and `gallery` (grid, masonry):
compile-time checks against the tables (AZ1260–AZ1267, AZ1269), a
pre-rendered shell (skeleton, status line, Try again, Sign in, noscript),
rows filled as text — images as checked URLs — by the behaviour runtime
through the typed client as the visitor — data-spec §18.5; measured in
`pnpm test` and `pnpm test:data` (three engines, axe in every state).
Open: gate snapshots of the `from` states; gallery `carousel`, `orbit` and
`lightbox` with `from` (AZ1214 today).

**M5 — not started.**

Still outstanding and not answerable by writing code — PRD §11: open-source
vs internal, a real client site for the M5 dogfood, and the licence. (The
backend project continues — decided 2026-09-23.)
