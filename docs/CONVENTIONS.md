# CONVENTIONS

Binding rules. CI enforces most of them; the rest are review-blocking.

---

## 1. Language & tooling

| | |
|---|---|
| Runtime | Node 22+ (CI matrix: 22 and 24) |
| Package manager | pnpm, workspaces |
| Language | TypeScript, `strict: true` |
| Modules | ESM only. No CommonJS |
| Format / lint | Prettier + ESLint, no per-file overrides |
| Tests | Vitest (unit), Playwright (browser) |

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
words/hero/
├── word.json           manifest — the source of truth
├── emit.web.ts         web emitter
├── emit.mobile.ts      [Phase 3]
├── preview.az          minimal example, used for snapshots + LSP thumbnails
├── hero.test.ts        unit tests
├── __snapshots__/      visual snapshots (390/768/1440 × light/dark)
└── README.md           docs page source
```

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
- Stable IDs (`AZ1042`) so they are documentable and suppressible

## 6. Generated code

- Header on every emitted file (ARCHITECTURE §7)
- Emit formatted output — run Prettier on emitted source before writing.
  Generated code gets read; unreadable output undermines trust in the tool
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

Conventional Commits, scoped by package:

```
feat(words/hero): add split variant
fix(core): keep positions through the link stage
chore(deps): pin three to 0.170.0
docs(architecture): record the Spec contract
```

One logical change per commit. Grammar changes get their own commit and must
update `ARCHITECTURE.md` in the same commit.

## 9. Tests

- Unit tests colocated: `foo.ts` → `foo.test.ts`
- Fixtures in `/fixtures`, named for behaviour: `hero-3d-no-model.az`
- Every diagnostic needs a fixture that triggers it
- Every word needs a `preview.az` that renders
- **Snapshot updates are reviewed, never blind-accepted.** `-u` in a PR
  requires an explanation of what changed visually and why

## 10. Docs

- Each word's `README.md` is its docs page — one source, no duplication
- Update `ASSUMPTIONS.md` status when something is verified; do not leave stale
  `UNVERIFIED` entries after they have been tested
- The planning docs in `/docs` are the *why*. These agent files are the
  *what*. Keep them separate; do not merge them
