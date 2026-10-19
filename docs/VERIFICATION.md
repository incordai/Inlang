# VERIFICATION

How each claim is proven. **If a claim has no check here, it is not a claim we
make publicly.**

---

## 1. Commands

```bash
pnpm gate                    # the 12-point word gate (§3), every word
pnpm gate words/hero         # the 12-point gate for one word
pnpm gate --self-test        # proves each non-browser item can fail
pnpm gate --every-variant    # items 3–7 also on every variant without its own preview

pnpm typecheck               # tsc --noEmit, all packages
pnpm lint                    # az lint over every word pack (theme tokens, A7)
pnpm test                    # unit: node --test; includes the dependency
                             #   rules, determinism (two builds, identical
                             #   bytes) and the offline build (M1 exit)
pnpm verify                  # typecheck + test
pnpm verify:build            # install, vite build and SSR the GRAMMAR §8
                             #   fixture; DOM rules, security, bundle budget
pnpm test:visual             # Playwright + axe over every preview: overflow,
                             #   a11y, keyboard, reduced motion, schemes
pnpm test:visual --self-test # proves each browser check can fail
pnpm thumbnails              # one PNG per word × variant, .thumbnails/
pnpm thumbnails --verify     # render twice; every variant, identical bytes
pnpm coverage                # variants and props each emitter implements

pnpm scan:secrets            # secret scan, every commit and the working tree
pnpm scan:deps               # known vulnerabilities in both lockfiles
pnpm scan:actions            # workflow lint (with shellcheck on run: blocks)
                             #   the tools and their versions:
                             #   docs/security-scanning.md
```

Every check must be runnable locally with the same command CI uses. **A check
that only exists in CI config will drift.**

### 1.1 Every suite, what it checks and what it needs

| Script | Checks | Needs |
|---|---|---|
| `pnpm verify` | `pnpm typecheck` + `pnpm test`: every unit suite — compiler, theme, words (props, variants, headers, descriptions, the root README's example, commands and catalogue), target, CLI, runtimes, backend on in-memory SQLite, MCP | nothing |
| `pnpm lint` | `az lint packages/words`: words use theme tokens only, and each `themeReads` lists exactly the tokens its code reads | nothing |
| `pnpm coverage` | which variants and props each emitter implements | nothing |
| `pnpm bench:tokens` | the token benchmark: each site as `.az`, Spec JSON, a component tree and HTML ([token-benchmark](token-benchmark.md)) | nothing |
| `pnpm verify:build` | builds the GRAMMAR §8 fixture with the real toolchain and checks the shipped HTML, security and bundle budget | network (installs) |
| `pnpm test:visual` | every preview in three themes, light and dark: overflow, axe, keyboard, reduced motion, behaviours | browsers |
| `pnpm gate [words/<word>]` | the 12-point word gate (§3); `--every-variant` adds every variant without its own preview | browsers |
| `pnpm test:palette` | the `az palette` gallery in three engines: zero CSP violations (served and opened from the file), axe, phone width, keyboard, copy; a screenshot per theme in a light and a dark browser, rendered twice and identical, in `.palette-shots/` | browsers |
| `pnpm thumbnails [--verify]` | one PNG per word × variant in `.thumbnails/`; `--verify` renders twice and requires identical bytes | browsers |
| `pnpm test:auth` | auth forms, protected pages and reset against a local mock provider and the generated server | browsers |
| `pnpm test:dev` | `az dev` end to end: backend, dev mailbox, reload on save, clean Ctrl-C | browsers |
| `pnpm test:3d` | the 3D runtime in real browsers | browsers |
| `pnpm test:data` | data tables end to end: API, rules, admin, images, `from` blocks | browsers |
| `pnpm test:chat` | the chat block end to end against the generated server with the scripted `fake` model, in three engines (chat-block-spec §12); then `test:chat-lib` | browsers |
| `pnpm test:chat-lib` | the chat library's packages as an app's page loads them, in three engines (chat-block-spec §22): the injection corpus through the answer checker, Web Crypto history tags equal to the server's, no policy violation | browsers |
| `pnpm test:backend-db` | the backend on real PostgreSQL and MySQL | Docker |
| `pnpm test:cloud-auth` | the hosted adapter's token-endpoint profile against the real server software | Docker, browsers |
| `pnpm test:lighthouse` | Lighthouse on the previews and fixture sites | browsers |

Browsers: `pnpm exec playwright install chromium firefox webkit` once. Every
browser suite also installs the generated project's pinned dependencies
(network) before it builds. CI (`.github/workflows/ci.yml`, §7) runs every
suite in this table: all of them on every push and PR except
`test:lighthouse`, which runs nightly.

---

## 2. Real-device measurement protocol

**This is the full-confidence protocol.** It is no longer required to complete
M0 — the runtime tier probe (`motion-tiers-spec.md`) removed the need to prove
A1 before building. Run it whenever a device becomes available; it is the only
thing that answers *where the tier boundary actually falls*, which the probe
cannot tell you from here. Do it before M5 ships a real site.

The weaker laptop-plus-throttle proxy that M0 actually runs is specified in
`motion-tiers-spec.md` §8. It is labelled weaker on purpose — see the device
note below for exactly what it fails to reproduce.

**Device:** a real mid-range Android, ~€150 new, 4GB RAM, released within 3
years. **Not** a flagship. **Not** a simulator. **Not** desktop Chrome with CPU
throttling — throttling does not reproduce mobile GPU behaviour or thermal
response, which is precisely why the proxy protocol cannot replace this one.

**Setup**
1. Serve the M0 hero over LAN (`vite preview --host`)
2. Chrome on device → `chrome://inspect` from desktop → Performance panel
3. Device at ~50% battery, not charging, screen at 50%, no other apps
4. Run each measurement **twice**, five minutes apart — thermal throttling
   often only appears on the second run. Record the worse number.

**Measure, per tier**
- sustained FPS over a 10s continuous scroll (record p50 and p5, not just mean)
- long tasks > 50ms
- JS heap after 5 mount/unmount cycles
- time to first meaningful paint of the **headline** (must precede the canvas)

**Thresholds**

| Metric | Pass |
|---|---|
| `lite` sustained FPS (p5) | ≥ 30 |
| `full` FPS on 2021+ laptop (p5) | ≥ 50 |
| Heap growth over 5 cycles | < 5MB |
| Headline paints before canvas | yes |
| Draco model | < 5MB |

**Record results in `ASSUMPTIONS.md`** — A1, A2, A8 — with device model, Chrome
version, and date. Not in a commit message. Not in your head.

**Also record which protocol produced the number.** A figure from the throttle
proxy and a figure from a real phone are not comparable, and six months from
now nobody will remember which one a bare "42fps" came from. Tag every recorded
measurement `real-device` or `proxy`.

---

## 3. The 12-point word gate

From word-quality-gate §1. Mapped to commands:

| # | Check | Command |
|---|---|---|
| 1 | Valid TS, no type errors | `pnpm typecheck` |
| 2 | Theme lint — no hex/off-scale px/font-family | `pnpm lint` |
| 3 | Renders 390/768/1440 without overflow | `pnpm test:visual` |
| 4 | Axe zero violations | `pnpm test:a11y` |
| 5 | Keyboard reachable, focus visible, no stray traps | `pnpm test:visual` |
| 6 | `prefers-reduced-motion` honoured | `pnpm test:visual` |
| 7 | Both themes, light and dark | `pnpm test:visual` |
| 8 | Works combined with `nav` + `footer` | integration fixture |
| 9 | Bundle delta within budget | `pnpm size` |
| 10 | Deps pinned exactly | `pnpm lint` |
| 11 | `README.md` + `preview.az` present | `pnpm lint` |
| 12 | `tested` field populated in manifest | `pnpm lint` |

**Point 12 is what we publish.** Per-word: "Tested on Chrome/Safari/Firefox
latest, iOS 17+, combined with nav and footer." Never "bug-free."

---

## 4. Product-claim verification

Each public claim maps to a test. No test, no claim.

| Claim | Test |
|---|---|
| "Same words, same code, every time" | `pnpm test:determinism` — build twice, assert byte-identical |
| "Works offline" | `pnpm test:offline` — network disabled, build succeeds |
| "Sub-second compile" | benchmark on reference fixture; CI fails > 1s |
| "Accessible by default" | `pnpm test:a11y` — zero axe violations, all words |
| "No secrets in your bundle" | entropy + prefix scan of `dist/` (M4) |
| "No boilerplate bugs" | **not a claim.** Say: *bugs are found once and fixed for everyone* |

That last row matters. The defensible statement is about **convergence**, not
perfection: our bugs are shared and get fixed for everyone; AI-generated bugs
are private and recur in every new project.

---

## 5. Architectural invariants — CI-enforced

| Invariant | How |
|---|---|
| `core` imports no target/word/theme impl | dependency-cruiser rule |
| `core`/`target-*` import nothing network-capable | import allowlist |
| No word imports another word | dependency-cruiser rule |
| `Spec` stays JSON-serialisable and target-agnostic | snapshot test on every fixture |
| Emitted output is deterministic | `test:determinism` |
| User content cannot break out of emitted code | fixture with `</script>` in a `title` |
| Paths cannot escape project root | fixture with `model ../../../etc/passwd` |

The last two are security tests. **Write them in M1**, not later.

---

## 6. Milestone exit verification

| Milestone | Verified by |
|---|---|
| M0 | three tiers build; probe picks correctly incl. throttled (A1b); proxy protocol in `motion-tiers-spec.md` §8; results in `ASSUMPTIONS.md` |
| M1 | determinism + offline + <1s compile + dependency rules green |
| M2 | 11 blocks (every variant) pass `pnpm gate`; lint rejects a bad word; thumbnails exist |
| M3 | `raw` mounts with theme access; `eject` output still builds |
| M4 | real hosted-provider login; build fails on service key; bundle scan clean |
| M5 | shipped site; escape-hatch ratio ≥80%; Lighthouse thresholds; grammar tagged |

**Escape-hatch ratio** — measure it, don't estimate it:

```
ratio = blocks_from_words / (blocks_from_words + raw_blocks + ejected_blocks)
```

`az stats site.az` should print this. Build it in M3 so M5 can measure rather
than guess.

---

## 7. CI

`.github/workflows/ci.yml` runs on every push to `main`, every PR, nightly
(03:00 UTC) and on demand. Eight parallel jobs on every run, and a ninth
nightly and on demand, each on Ubuntu 24.04 and Node 22 unless noted, each
step a command from §1, so CI and a local run cannot differ. A push does not
cancel the nightly run (the concurrency group holds the event). Firefox on
Linux has WebGL only with a display, so every suite that draws scenes or maps
in it runs under `xvfb-run -a`. The runner has 4 cores, which the capability
gate caps at `lite` (motion-tiers-spec §2); a check of the scroll-linked
camera emulates a capable device and first confirms it entered a `full` rung:

- **verify** (typecheck + unit) — `pnpm verify`: the typecheck and every
  unit suite (dependency rules, determinism, offline build); then
  `pnpm coverage` and `pnpm bench:tokens` (seconds each; the benchmark
  fails when a corpus site does not compile). On a
  push or PR it runs on Ubuntu, Node 22; nightly it runs across Ubuntu,
  macOS and Windows on Node 22 and 24.
- **build** (end-to-end build and render) — after installing the three
  engines: `pnpm verify:build`.
- **gate** (12-point word gate) — after installing the three engines:
  `pnpm gate --self-test`, then `xvfb-run -a pnpm gate` (all 12 items for
  every word; it runs the browser checks itself).
- **visual** (visual, auth, dev, 3D, thumbnails and palette) — after
  installing the pinned Playwright's Chromium, Firefox and WebKit:
  `pnpm lint`, `pnpm test:visual --self-test`, `pnpm test:auth` (auth
  forms, `<Protected>` and the reset flow against a local mock provider),
  `pnpm test:dev` (`az dev` with no setup, the dev mailbox, reload on save,
  a clean Ctrl-C), `xvfb-run -a pnpm test:3d` (the 3D runtime, on software
  WebGL), `pnpm thumbnails --verify` and `pnpm test:palette` (the palette
  gallery in three engines, theme-spec §14).
- **backend-db** (built-in backend on PostgreSQL and MySQL) —
  `pnpm test:backend-db`, which starts and removes its pinned database
  images itself (backend-spec §10).
- **chat** (chat block end to end) — after installing the three engines:
  `xvfb-run -a pnpm test:chat` (chat-block-spec §12), over local https with a
  certificate made at test time; no model is called.
- **data** (data tables end to end) — after installing the three engines:
  `pnpm test:data` (data-spec §14), over local https likewise.
- **cloud-auth** (hosted auth against the real identity server) — after
  installing Chromium: `pnpm test:cloud-auth`, which starts and removes the
  pinned server image and its database in the runner's Docker
  (auth-block-spec §3.5).
- **lighthouse** (Lighthouse on every preview; nightly and on demand only) —
  after installing Chromium:
  `pnpm test:lighthouse --fail-under m5 --json … --reports …`, alone on its
  runner. It fails when a site cannot be built or audited, or when any site
  is below an M5 target (`scripts/lib/lighthouse-targets.mjs`): perf ≥ 85,
  a11y 100, best practices 100, SEO ≥ 95. Perf moves with the runner's
  load, so it is judged on the median of the site's three runs; the other
  three do not, so they are judged on every run. Each score below target is
  printed as `BELOW <site>: <category> <score> < <target>` (the run named),
  and the table, which shows each site's median run, marks it with `!`. Without `--fail-under` (a local
  run) scores are reported, not failed; `--fail-under perf=90,seo=100`
  enforces only the scores it names. The summary, the JSON and every site's
  full report are kept as the `lighthouse-results` artifact for 30 days,
  pass or fail. Local run (2026-10-16, ASSUMPTIONS A6): all 31 sites
  meet the thresholds. Perf medians were 96–100, and a11y, best practices
  and SEO were 100 on every run. Restoring one preview to SEO 91 fails the
  run, naming it.

Every job is bounded by `timeout-minutes`. When chat, data or cloud-auth
fails, its log (and chat's pixel snapshots, `.visual-out/chat/`) is kept as
an artifact for 14 days.

`.github/workflows/security.yml` runs on every push to `main`, every PR,
weekly (Monday 04:30 UTC) and on demand — see docs/security-scanning.md:

- **codeql** — CodeQL (security-extended) over `javascript-typescript` and
  over `actions`, one job each; on a public repository only;
- **dependency-review** (dependency review) — PRs on a public repository
  only, failing on moderate or worse;
- **secrets** (secret scan, full history) — `pnpm scan:secrets`;
- **dependencies** (dependency vulnerabilities) — `pnpm scan:deps`;
- **workflows** (workflow lint) — `pnpm scan:actions`.

**Windows is in the nightly matrix for a reason** — it is the primary
development platform for this project, and path length, line endings and
symlink permissions all bite a JS build tool there (word-quality-gate §5.3).
A Windows failure found nightly is cheap; found by a contributor is not.

Required to merge: every job above except lighthouse, which runs only
nightly and on demand. The repository ruleset "main: required checks" names
them (dependency review counts on pull requests, where it runs); repository
admins may bypass it, so the owner can still push to `main` directly. Branch
protection on `main` refuses force pushes and deletion, admins included.
Visual snapshots may be updated in a PR **only with a written explanation of
what changed and why** (CONVENTIONS §9).

---

## 8. What we deliberately do not verify

Recorded so nobody spends a week here:

- Penetration testing the generated marketing site — no server, no DB, no
  sessions. Nothing to penetrate
- CSRF, SQL injection, rate limiting — not applicable to the web target
- Browser support below the `tested` field's floor — out of scope, and stated
- Exhaustive word-combination testing — combinatorially impossible. We test
  each word with `nav` + `footer`, and fix reported combinations as found

Combination bugs are the known gap. **Say so in the docs** rather than implying
coverage we do not have.
