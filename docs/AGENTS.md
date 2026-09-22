# AGENTS.md

Entry point for any agent or contributor working on AZ Web. **Read this first.**

## What this project is

A compiler that turns short words into a production-grade 3D website.
Deterministic, no AI in the build path, offline after install.

```
site.az  ──[az build]──>  React + Vite + R3F site
```

## Reading order

| File | Read when |
|---|---|
| **AGENTS.md** (this) | first, always |
| **ROADMAP.md** | before starting any work — find the current milestone |
| **ARCHITECTURE.md** | before writing code that crosses a package boundary |
| **CONVENTIONS.md** | before writing any code |
| **ASSUMPTIONS.md** | before relying on anything unproven |
| **VERIFICATION.md** | before claiming something works |
| **GRAMMAR.md** | before touching the parser, or writing any `.az` by hand |
| **theme-spec.md** | before emitting any design value |
| `*-block-spec.md` | before implementing or changing that block |
| `/docs/*.md` | the *why* behind decisions |

## Non-negotiable rules

1. **The compiler never calls a network.** Setup may install once; build never does.
2. **No AI in the build path.** Any model sits outside, emitting words a human reads.
3. **Words read theme tokens only.** No hex, no off-scale px, no font-family.
4. **A word is a folder.** Adding one must never require editing `core`.
5. **`.az` describes the site; the CLI does things to it.** No actions, conditionals or variables in the language — ever.
6. **Words describe intent, not implementation.** `hero` is "the opening statement," not "a 3D scene."
7. **`az build` twice must produce byte-identical output.** This is the product.

## Current state

**M0 has not started.** The project is specced and entirely unbuilt — the
repository holds documentation only: no code, no `package.json`, no lockfile,
no git history.

The next action is **M0** (ROADMAP M0): hand-build one `hero 3d scroll` with
all three motion tiers **and the runtime tier probe**
(`motion-tiers-spec.md`). Do not build the compiler first.

The mid-range-Android gate is cleared — tier selection is measured at runtime
by the generated site, so A1 no longer blocks anything (`ASSUMPTIONS.md` A1).
**A1b replaces it as the assumption that can sink M0:** that the probe can
actually pick the right tier. If a real device turns up, run VERIFICATION §2
and record the numbers — it is still the only way to learn where the tier
boundary falls.

## Stop conditions

Halt and re-plan rather than working around these:

| Condition | Where |
|---|---|
| A1b fails — the runtime probe cannot reliably pick a tier | ROADMAP M0, ASSUMPTIONS A1b |
| Escape-hatch ratio < 50% at M5 | ROADMAP M5 |
| A word cannot be added without editing `core` | ARCHITECTURE §4 — fix the abstraction |
| A feature seems to need logic in `.az` | rule 5 — add words or slots instead |
| Block count would exceed 11 before M5 | ROADMAP M2 — log it in the backlog |

## When unsure

- Between two designs → prefer the one that keeps `core` ignorant of the target.
- Between shipping a word and shipping a fix → the fix. Words are permanent.
- Whether something is verified → check `ASSUMPTIONS.md`. If it says
  `UNVERIFIED`, say so rather than asserting it.
- Whether to add a word before M5 → no.
