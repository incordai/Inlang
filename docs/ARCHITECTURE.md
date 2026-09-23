# ARCHITECTURE

Authoritative structure for AZ Web. If code and this file disagree, **this file
wins** — change it deliberately, in its own commit.

---

## 1. Repository layout

```
az/
├── packages/
│   ├── core/          grammar, parser, AST, Spec, graph, validation
│   ├── cli/           `az` binary, target loader, install policy, doctor
│   ├── theme/         token schema, official themes, theme resolver
│   ├── target-web/    React + Vite + R3F emitter
│   ├── words/         official word packs (one dir per word)
│   │   ├── hero/
│   │   ├── nav/
│   │   └── ...
│   ├── overlay/       overlay engine (portal, focus, dismiss, positioning)
│   ├── lsp/           [M6+] language server
│   └── playground/    [M6+] browser compiler UI
├── fixtures/          .az files used by tests
├── docs/              agent files, planning docs, and one spec per block
└── examples/          real sites built with AZ (M5 output lives here)
```

Monorepo, **pnpm workspaces**, TypeScript throughout, ESM only.

---

## 1a. The compiler is a library. The CLI is one caller.

`az build` is **not** the compiler — it is one of two callers of it. The other
is a browser: distribution-and-hosting §3 puts the Playground in a Web Worker
with **no backend at all**, so the same compiler must run in a browser exactly
as it runs in Node.

```
                 ┌─────────────────────────┐
   site.az ─────▶│  core.compile(src, {…}) │─────▶ Spec + diagnostics
                 └─────────────────────────┘
                       ▲             ▲
                    az CLI       Web Worker
                  (node:fs)      (bundled)
```

**Why a JS API and not an HTTP one.** An HTTP compile service would contradict
principle 1 (the compiler never calls a network), break the offline promise,
and reintroduce exactly the per-request cost that distribution-and-hosting §2
says AZ does not have. The whole economic argument is that compilation happens
on the user's machine — in their terminal or in their browser tab.

**Consequence, and it is load-bearing:** `core` must not touch the filesystem
or the network. Manifests are **passed in**, not loaded — the CLI reads
`words/*/word.json`, the Playground bundles them as an object. That single
constraint is what lets one compiler serve both, and it is why `node:fs` joins
the banned-import list in §2 rather than being merely discouraged.

---

## 2. Dependency rules — enforced, not advisory

```
core     → (nothing)
theme    → core
target-* → core, theme
overlay  → theme
words/*  → core, theme, overlay        (never a target directly)
cli      → everything
```

**Forbidden, and CI must fail on them:**

- `core` importing any target, word, or theme implementation
- `core` or `target-*` importing anything network-capable (`node:http`,
  `node:https`, `fetch`, `undici`) **or the filesystem (`node:fs`)** — core
  runs in a browser too (§1a), so both are unavailable there
- a word importing another word
- anything importing from `cli`

`core` must have **zero knowledge** of React, Vite, three.js or CSS. It knows
words exist, their manifests, and their relationships. Nothing about how they
render. This is what makes a second target (mobile) possible later.

---

## 3. Pipeline

Five named stages. Each has one input type and one output type.

```
.az text
  │  parse      lexer + indentation-aware parser
  ▼
AST            faithful to source, positions retained for LSP diagnostics
  │  link       resolve words from manifests, resolve theme, build graph
  ▼
LinkedAST
  │  validate   conflicts, requires, slot limits, taste warnings
  ▼
Spec           target-agnostic, fully resolved, serialisable to JSON
  │  emit       target.emit(spec) → files
  ▼
EmittedFile[]
  │  build      vite build (target-web only)
  ▼
dist/
```

**`Spec` is the contract boundary.** It must be JSON-serialisable and contain
no target-specific fields. A snapshot test asserts `Spec` shape for every
fixture — changing it is a deliberate, reviewed act.

Errors are collected, never thrown mid-stage. Each stage returns
`{ spec, diagnostics }` so the LSP can show all problems at once rather than
the first.

---

## 4. Core contracts

### 4.1 Word manifest — `words/<name>/word.json`

The single source of truth for a word. **The graph, autocomplete, lint,
auto-install and validation are all generated from this file.** Never
hand-maintain a second copy.

```jsonc
{
  "name": "hero",
  "version": "1.0.0",
  "kind": "block",                      // block | primitive | structure
  "variants": ["center","split","full","stack","minimal"],  // mutually exclusive
  "modifiers": ["3d","scroll","parallax","glass"],          // free to combine
  "props": {
    "title": { "type": "string", "required": true, "maxWords": 12 },
    "model": { "type": "path", "ext": [".glb"], "maxBytes": 5242880 }
  },
  "slots": { "cta": { "max": 2 } },
  "requires": { "3d": ["model"] },
  "themeReads": ["color.accent", "space.*", "type.display"],
  "deps": { "three": "0.170.0", "@react-three/fiber": "8.17.10" },
  "targets": ["web"],
  "tested": {
    "browsers": ["chrome-latest","safari-latest","firefox-latest","ios-17"],
    "with": ["nav","footer"]
  }
}
```

`deps` versions are **exact**. No `^`, no `~`, no `latest`. CI fails otherwise.

### 4.2 Target interface

```ts
export interface Target {
  readonly name: string;              // "web"
  readonly ext: string;               // "tsx"
  run(entry: string): string;         // human-readable run command
  emit(spec: Spec, ctx: EmitContext): EmittedFile[];
}
```

### 4.3 Word emitter — `words/<name>/emit.web.ts`

```ts
export interface WordEmitter {
  emit(node: BlockNode, ctx: EmitContext): EmittedNode;
}

export interface EmitContext {
  theme: ResolvedTheme;   // ONLY source of colour/space/type values
  target: string;
  slot(name: string): EmittedNode[];
  asset(path: string): string;  // sandboxed; throws outside project root
}
```

A **component node** — `{ tag: '#component', attrs: { src } }` (`COMPONENT_TAG`
in `emit-contract.ts`) — stands for an author component named by `raw` or
`slot` (PRD §6.6). Targets create them; words never need to. `#` can never
begin an HTML tag, so one is never mistaken for markup. The web target imports
each module into the generated App and renders it with a `theme` prop: the
same token object words read, colours as `var(--az-…)` references.

One emitter file per word **per target**: `emit.web.ts`, later `emit.mobile.ts`.
A word with no emitter for a target is simply unavailable there — the compiler
reports it, it is not an error in the word.

### 4.4 The theme rule

A word emitter may only read design values through `ctx.theme`. Raw hex, raw px
outside the space scale, and `font-family` declarations in word source are
**lint errors**, not style preferences. See CONVENTIONS §4.

---

## 5. Graph

Generated at build time **from the manifests**. Never hand-written.

Nodes: `word`, `variant`, `modifier`, `prop`, `slot`, `theme-token`, `dep`.

Edges: `conflicts`, `requires`, `accepts`, `themeReads`, `dependsOn`,
`similarTo` (the only hand-authored edge; aesthetic association for later
retrieval).

Consumers: validator (conflicts/requires), LSP (accepts → completions), lint
(themeReads), installer (dependsOn), and — post-M6 — AI retrieval.

**Below ~200 words, feed AI the whole index; do not retrieve.** Retrieval
introduces a recall failure the full index does not have.

---

## 6. Network boundary

> **Setup may touch the network once. Build never does.**

- `az add` / first `az build` — may install (Tier 1/2 only, see word-quality-gate §5.1)
- `az build` with `node_modules` present — **must work fully offline**
- `core` and `target-*` — no network imports at all, CI-enforced

An integration test runs `az build` with network disabled and asserts success.

---

## 7. Generated output

Every emitted file starts with:

```
/* GENERATED BY AZ v0.1.0 — do not edit. Edit site.az instead. */
```

JSON files cannot carry a comment, so they carry the same statement as data:
a top-level `"_generated"` string. `tsconfig.json` is read as JSONC by
TypeScript and takes the comment form. The rule is that **every** emitted file
says it is generated; the spelling follows the format, and a test checks each
file by its extension rather than exempting the ones that are awkward.

Output goes to `.az-build/` (gitignored). `dist/` is the built site.
`az eject <word>` copies a word's source into the project's `words/<word>/`
(with verbatim copies of the emit contract in `words/_az/`, which its imports
are pointed at) and removes it from
management — one-way, and it prints that it is one-way.
