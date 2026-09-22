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
- [ ] procedural scene reproducible: identical vertex-buffer hash across two
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
- [ ] thumbnails generated for every block and every variant
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
- [ ] a custom component mounts via `raw` and receives theme tokens
- [ ] `az eject hero` produces editable source that still builds

---

## M4 — Auth adapters · 1 week

Adapters only. **We never implement auth** (PRD §6.5).

- `auth hosted`, `auth azbackend`
- login / signup / reset UI from theme tokens, session hook, protected route
- **secret-leak detection** — hard error if a service-key pattern would be
  inlined (word-quality-gate §4)
- adapter docs stating anon-key vs service-key explicitly

**Exit criteria**
- [ ] working login against a real hosted-provider project
- [ ] build **fails** when a service key is present in env
- [ ] bundle scan finds no high-entropy secrets

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

**M0 not started.** The repository contains documentation only — no code, no
`package.json`, no lockfile, no git history. Every assumption in
`ASSUMPTIONS.md` is `UNVERIFIED`.

The device gate is cleared: M0 no longer waits on a mid-range Android
(`ASSUMPTIONS.md` A1). **The next action is M0 — hand-build the hero with its
three tiers and the runtime probe.**

Still outstanding before M1, and not answerable by writing code — PRD §11:
open-source vs internal, the fate of the backend project, a real client site
for the M5 dogfood, and the licence.
