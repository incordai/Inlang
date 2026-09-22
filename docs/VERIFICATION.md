# VERIFICATION

How each claim is proven. **If a claim has no check here, it is not a claim we
make publicly.**

---

## 1. Commands

```bash
pnpm gate                    # everything below; what CI runs
pnpm gate words/hero         # the 12-point gate for one word

pnpm typecheck               # tsc --noEmit, all packages
pnpm lint                    # eslint + prettier + az-lint + dependency rules
pnpm test                    # vitest unit
pnpm test:visual             # playwright snapshots
pnpm test:a11y               # axe over every word preview
pnpm test:determinism        # build twice, diff
pnpm test:offline            # build with network disabled
pnpm size                    # bundle budgets
```

Every check must be runnable locally with the same command CI uses. **A check
that only exists in CI config will drift.**

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

Runs on every PR: `pnpm gate` on Node 22, Ubuntu. Visual and a11y jobs run in
parallel with unit tests. Nightly: full matrix (macOS, Windows, Node 22 + 24)
plus `npm audit` — **block on high/critical**.

**Windows is in the nightly matrix for a reason** — it is the primary
development platform for this project, and path length, line endings and
symlink permissions all bite a JS build tool there (word-quality-gate §5.3).
A Windows failure found nightly is cheap; found by a contributor is not.

Required to merge: typecheck, lint, unit, determinism, dependency rules.
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
