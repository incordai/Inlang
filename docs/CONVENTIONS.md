# CONVENTIONS

Binding rules. CI enforces most of them; the rest are review-blocking. This
file is the one source for them; setup, which checks to run for which change,
and how to add a word are in [CONTRIBUTING.md](../CONTRIBUTING.md).

---

## 1. Language & tooling

| | |
|---|---|
| Runtime | Node 22.18+ (CI: 22 on every push and PR; the nightly run adds 24) |
| Package manager | pnpm (the version `packageManager` pins), workspaces |
| Language | TypeScript, `strict: true`, run as source by Node's type stripping — no build step |
| Modules | ESM only. No CommonJS |
| Type check | `tsc --noEmit` over every package (`pnpm typecheck`) |
| Lint | `az lint` (`pnpm lint`): the theme rule of §4 and each manifest's `themeReads`; there is no formatter or general-purpose linter |
| Tests | `node:test` with `--experimental-strip-types` (unit, `pnpm test`); Playwright driven by `scripts/*.mjs` (browser) |
| Gate | `pnpm verify` = typecheck + every unit suite; must be green before a commit |

- **No `any`.** Use `unknown` and narrow. `// @ts-expect-error` requires a
  comment explaining why, on the same line.
- **Named exports only**, except a target module's default `Target` export.
- **No barrel files** (`index.ts` re-exporting everything) — they defeat
  tree-shaking and hide the dependency graph the CI rules check.
- Install with `--ignore-scripts`. Always.

## 2. Naming

| Thing | Rule | Example |
|---|---|---|
| Word | lowercase, single token, no hyphen | `hero`, `nav`, `interrupt` |
| Variant | lowercase adjective | `center`, `split` |
| Prop | lowercase, single token | `title`, `model` |
| File | kebab-case | `theme-resolver.ts` |
| Type | PascalCase | `LinkedAST` |
| Theme token | dot path | `color.accent`, `space.4` |

Word names are **permanent after M5**. Choose as if you cannot rename them,
because you cannot.

## 3. Word package layout

Every word is a self-contained directory. Adding a word must never require
editing `core`.

```
packages/words/hero/
├── word.json           manifest — the source of truth
├── emit.web.ts         web emitter, opening with its @az header
├── emit.mobile.ts      [Phase 3]
├── preview.az          minimal example: gate, visual checks, thumbnails
├── preview.<variant>.az  a variant that needs its own content
├── preview-assets/     images and models the previews use
└── README.md           docs page source
```

A word's tests live in `packages/words/test/` (§9), not in its folder.

**To add a word:** create the directory, fill the manifest, write the emitter,
add `preview.az`, run `pnpm gate words/<name>`. No core changes. If a word
cannot be added without touching `core`, `core` has the wrong abstraction —
fix that instead of special-casing.

## 4. The theme rule — hard

In any file under `words/` or `target-*/`:

```ts
// ✗ lint error
color: "#3b82f6"
padding: "13px"
fontFamily: "<any-family>, sans-serif"

// ✓
color: ctx.theme.color.accent
padding: ctx.theme.space[4]
fontFamily: ctx.theme.type.body
```

Banned by lint: hex literals, `rgb(`/`hsl(` literals, px values not on the
space scale, `font-family`, `z-index` numbers (use `theme.layer`).

Rationale: ten contributors picking their own blues produces a ransom note.
This rule is the only thing preventing that, so it is not negotiable per-word.

## 5. Error and diagnostic messages

Format: `<word>: <what is wrong> — <what to do>`

```
hero: 'center' and 'split' are both layouts — pick one
hero: '3d' needs a model — add: model ./path.glb
nav: 9 links, max is 7 — group them or simplify the IA
```

- Lowercase after the colon; no trailing period
- Name the fix, always. A diagnostic with no action is a complaint
- Quote user input in `'single quotes'`
- **Errors block the build. Warnings never do** — taste advice (`weak primary
  CTA`) is always a warning
- Every diagnostic carries a source position (LSP needs it)
- Stable IDs (`AZ1042`) so they are documentable and suppressible; ranges
  and per-word blocks are GRAMMAR §7.4–§7.5

## 6. Generated code

- Header on every emitted file (ARCHITECTURE §7)
- Emit readable output — the target writes indented source and indented JSON
  itself; no formatter runs at build. Generated code gets read; unreadable
  output undermines trust in the tool
- **Never string-concatenate user content into code.** Escape at emit. A
  `title` containing `</script>` must not break out — there is a test for this
- Deterministic output: no timestamps, no random IDs, stable key order.
  **`az build` twice must produce byte-identical files** — this is a test, and
  it is the product's core claim

## 7. Dependencies

- Exact versions only, in `word.json` and every `package.json`
- Lockfile committed; CI uses `pnpm install --frozen-lockfile`
- New runtime dependency in `core` requires justification in the PR description
- `core` and `target-*`: no network-capable imports (CI-enforced)

## 8. Commits & branches

Subject: `<scope>: <what is now true>` — lowercase, no type prefix, no
trailing period. The scope is the package, word or area changed (`core`,
`target-web`, `hero`, `docs`, `test:data`); a change across two names both,
comma-separated. From `git log`:

```
overlay: a modal's scroll lock restores the body's style
scene: a change of layout wakes the stopped render loop
target-web, cli: width/height on every image the build ships (CLS 0)
docs: root README, CONTRIBUTING, and a generated word index an AI can start from
```

The body says why, what was measured, and how it was verified (the checks
run and their results). Review `git diff --staged` before every commit: no
debug output, no commented-out code, no secrets, no vendor names.

Branch from `main`. One logical change per commit. Grammar changes get their
own commit and must update `ARCHITECTURE.md` in the same commit.

## 9. Tests

- Unit tests live in each package's `test/` folder
  (`packages/core/src/link.ts` → `packages/core/test/link.test.ts`); the
  words' tests are in `packages/words/test/`, script helpers' beside them in
  `scripts/lib/*.test.mjs`
- A check carries a `CONTROL` test that feeds it a deliberately bad input
  and requires the failure — a check that cannot fail proves nothing
- Shared fixtures in `/fixtures` (`minimal.az`, `broken.az`); a test's own
  cases are inline `.az` sources in the test file
- Every diagnostic needs a test case that triggers it
- Every word needs a `preview.az` that renders
- **Snapshot updates are reviewed, never blind-accepted.** `-u` in a PR
  requires an explanation of what changed visually and why

## 10. Docs

- Each word's `README.md` is its docs page — one source, no duplication
- Update `ASSUMPTIONS.md` status when something is verified; do not leave stale
  `UNVERIFIED` entries after they have been tested
- The planning docs in `/docs` are the *why*. These agent files are the
  *what*. Keep them separate; do not merge them
