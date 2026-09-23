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

**Built out of milestone order; M0 is still not closed.** The authoritative,
dated summary is ROADMAP.md "Current status" — read it before starting work.
In short:

- **M0** — `spike-m0/` has the hand-built hero, the 8-rung tier ladder with a
  pure decision function (§8.2 traces pass), and the procedural scene proven
  identical across Chromium, Firefox and WebKit (A8b). Open: a genuinely slow
  device (A1/A1b), the opt-in `.glb`/Draco path (A8), a 2021+ laptop for the
  fps check.
- **M1** — the compiler core, `az build`/`dev`/`spec`/`check`, CI, offline and
  cold-compile tests: met.
- **M2** — all 11 blocks emit with their variants, responsive tables, the
  button primitive, generated stylesheet, light/dark schemes, validation
  tables, the overlay engine and behaviour runtime; `pnpm gate` runs the
  12-point gate. The 3D props (`hero.model`, `scene.model`, `scene.camera`)
  wait on the 3D runtime port.
- **M3** — `raw`, `slot`, `az eject`, `az lint`, `az migrate`: met.
- **M4** — adapters and the secret-leak guard built; the real-provider login
  and `azbackend` (PRD §11 Q2) are open.
- **M5** — not started; it needs a real client brief.

Every check an agent must keep green: `pnpm verify`, `pnpm verify:build`,
`pnpm gate`, `pnpm test:auth`, `node scripts/thumbnails.mjs --verify`.
A1b remains the assumption that can sink the motion story: if a real device
turns up, run VERIFICATION §2 and record the numbers.

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
