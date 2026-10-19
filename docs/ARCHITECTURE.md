# ARCHITECTURE

Authoritative structure for AZ Web. If code and this file disagree, **this file
wins** — change it deliberately, in its own commit.

---

## 1. Repository layout

```
az/
├── packages/
│   ├── core/          @az/core — the compiler API: grammar, lexer, parser, link, Spec,
│   │                  validation, diagnostics, the prompt and describe tables
│   ├── theme/         @az/theme — token schema, official themes, accents, CSS, theme lint
│   ├── target-web/    @az/target-web — Spec → React + Vite + R3F project: App, per-route
│   │                  HTML, pre-render, stylesheet, CSP, images, markdown, data client
│   ├── words/         official word packs, one dir per word (not a workspace package)
│   │   ├── auth/  chat/  cta/  faq/  feature/  footer/
│   │   ├── gallery/  hero/  nav/  pricing/  scene/  text/
│   │   ├── registry.ts   every bundled word's web emitter, as static imports
│   │   └── test/
│   ├── overlay/       @az/overlay — overlay presets from theme tokens, and the browser
│   │                  runtime copied into a site: behaviours, `from` rows, the chat panel
│   ├── auth-runtime/  @az/auth-runtime — auth adapters (session, azbackend, hosted) and
│   │                  form wiring, copied whole into a site that uses auth
│   ├── scene-runtime/ @az/scene-runtime — the lazily loaded 3D chunk, copied whole into
│   │                  a site that uses 3D
│   ├── backend/       @az/backend — the optional built-in backend: the server/ files
│   │                  `az build` writes, OpenAPI, data DDL, and the server itself (src/server/)
│   ├── chat-answer/   @az/chat-answer — the chat's answer checker: parser, rich components,
│   │                  tool shapes, history tags; copied into a server's src/chat-answer/
│   ├── mcp/           @az/mcp — `az mcp`: MCP over stdio, the tool schemas, the root sandbox
│   └── cli/           @az/cli — the `az` binary: build, dev, spec, check, lint, migrate,
│                      eject, backend, mcp, explain, palette, prompt, doctor, audit
├── fixtures/          .az files used by tests (minimal.az, broken.az)
├── scripts/           verify:build, the word gate, browser e2e suites, generators, benchmarks
├── spike-m0/          the M0 hand-built hero spike, its own pnpm project
├── docs/              agent files, planning docs, and one spec per block
└── .github/           CI and security workflows, dependency updates
```

Not in the tree yet: `packages/lsp/` (language server) and
`packages/playground/` (browser compiler UI), both M6+, and `examples/`
(real sites built with AZ; M5 output lives there).

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
target-* → core, theme, overlay
overlay  → theme
words/*  → core, theme, overlay        (never a target directly)
cli      → everything
auth-runtime → (nothing)                 (copied whole into a site that uses auth)
scene-runtime → three                   (copied whole into a site that uses 3D)
backend  → core (types, data)           (its server/ is node built-ins + pinned drivers only)
         → chat-answer (by alias)       (its server/ also imports #chat-answer/…)
mcp      → (nothing but node:*)          (the CLI injects every operation)
chat-answer → (nothing)                 (runs in Node, a browser, an app webview)
```

The chat packages (chat-block-spec §22) are imported by an **alias**,
`#<package>/<file>.ts`, never by a relative path into another package: the
importer's `package.json` maps it — in this repository to the workspace
package (`"#chat-answer/*": "@az/chat-answer/*"` and a `workspace:*`
dependency), in a generated server to the folder `az build` copies the
package's `src/` into (`server/src/chat-answer/`). The same files run in
both places, so a library user and an az site never run two copies. The
rules test holds each alias to the table of which package may import which.

`mcp` serves `az mcp` (docs/mcp.md): the protocol, the tool schemas and the
root sandbox. Nothing may import from `cli`, and the tools need the CLI's
operations, so the dependency runs the other way: `cli/src/mcp.ts` builds a
`Toolbox` from the functions its own commands run and hands it to the
server. A tool and its command therefore cannot drift apart.

`backend` is the optional built-in server (backend-spec.md). Its `src/server/`
imports only its siblings, `node:*` and the chat packages it names in
`SERVER_PACKAGES` (`src/emit.ts`) — the drivers it may load are one
closed, pinned list (`drivers.ts`) — because the CLI copies it verbatim into a
site's `server/src/`, and each of those packages into `server/src/<name>/`;
`src/emit.ts` writes the rest of `server/`, its `package.json` mapping the
aliases.

`chat-answer` is the answer checker (chat-block-spec §22.1): what a model
wrote becomes checked events here, for the built-in server and for an app
alike. It imports only its own files and no Node-only API, so it runs in a
browser and an app webview as it runs in Node.

`auth-runtime` (M4) is the adapter layer a generated site runs: the §3
contract, the `hosted` and `session` adapters and the form behaviour. It
imports only its own files because the CLI copies it verbatim into
`src/az-auth/`, exactly as it copies `overlay`'s runtime; the target emits
only the wiring (`target-web/src/auth.ts`). `core/src/secrets.ts` is copied
the same way, into every site's build guard, and so imports nothing.
`target-web/src/csp.ts` is copied beside it into `az-vite/` (it imports only
`node:crypto` and `html-scan.ts`, the single-pass page scanner copied with
it, which imports only `named-references.ts`, HTML's named character
reference table generated by `scripts/gen-named-references.mjs` and copied
with them, which imports nothing): after the pre-render, `az-vite/build.mjs` gives every page a
`<meta http-equiv="Content-Security-Policy">` as the first tag after its
charset — what the page loads beyond its own files from the emitter's
per-page needs (written into `build.mjs`), and a `sha256` hash of every
inline script, inline style and `style` attribute the filled page carries
(word-quality-gate §2 B, §5.5). Only the built page has one; the dev
server's template has none.

`scene-runtime` is the 3D runtime a generated site runs (scene-spec §5): the
page's one WebGL renderer (`stage.ts`), the tier ladder and probe ported from
the M0 spike (`tiers.ts`), the seeded procedural scene, the Draco model path
and gallery `orbit`'s ring. It imports only its own files and `three`, and the
CLI copies it into `src/az3d/` only for a site whose pages declare a 3D view;
the target emits the wiring (`target-web/src/three.ts`). A site's entry
imports just `gate.ts` statically — the §2 decision — and fetches the rest
lazily, so a page at `static`, or without a view, never loads three.

`target-* → overlay` was added with the behaviour runtime: the button
primitive lives in the target (buttons-and-sections §1), and a `play` action's
popup is an overlay preset. `overlay` depends only on `theme`, so the arrow
creates no cycle and `core` stays ignorant of both.

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

A slot's `line` (GRAMMAR §4.5) names the role of each value written after
the fill — `label`, `destination`, `value`, `file`, a bare flag — and the
link stage holds the count. One role is read by no emitter: `answer`, last
on a line, is the rest of it, checked whole by a file-wide rule in core
(chat's `ask "…" use monthly`: `core/src/chat.ts askAnswer`, carried in the
Spec as `chat.asks` for the server, chat-block-spec §19.17).

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
  site: { name: string; frame?: number };  // frame: the site frame in px, when it has one
  slot(name: string): EmittedNode[];
  asset(path: string): string;  // sandboxed; throws outside project root
  // The action primitive — buttons-and-sections-spec §1:
  action(fill: SpecBlock, options?: ActionOptions): EmittedNode;
  actions(block: SpecBlock, slots: string[], options?: ActionOptions): EmittedNode[];  // <li>s
  submit(label: string, options?: SubmitOptions): EmittedNode;
}
```

**Buttons are a primitive, not markup a word writes** (buttons-and-sections
§1.1). A word hands its `cta`/`alt` fills to `ctx.actions` (or one fill to
`ctx.action`) and gets back list items holding a link or a button. Core
decides what an action DOES from its destination (`intentOf`, GRAMMAR §4.3 —
route go, anchor show, path download, tel/mailto/video/popup/copy/http(s))
and its weight (`primary`/`secondary`/`ghost`/`link`: the first `cta`
primary, every other fill secondary, an author's `as` wins). The target
decides the element (navigates → `<a>`, acts → `<button>`), icons, and all
six states through the style contract below. Options: `tone: 'inverted'` for
an accent band, `size: 'sm'` for dense bars, `fill` for a card, and
`compactBelow` (the primary fills the row, a secondary becomes a text link).
The link stage checks `as` (AZ1220), warns on two primaries in a section
(AZ1221) and on `popup:#id` until declared popups exist (AZ1222); `video:`
and `copy:` are wired by the behaviour runtime (packages/overlay/src/runtime).

A **component node** — `{ tag: '#component', attrs: { src } }` (`COMPONENT_TAG`
in `emit-contract.ts`) — stands for an author component named by `raw` or
`slot` (PRD §6.6). Targets create them; words never need to. `#` can never
begin an HTML tag, so one is never mistaken for markup. The web target imports
each module into the generated App and renders it with a `theme` prop: the
same token object words read, colours as `var(--az-…)` references.

A **3D view** is an ordinary element carrying data, never a canvas: a word
marks the box the page's one renderer draws into with `data-az-3d` (`hero`,
`scene`, `orbit`), plus `data-az-camera` (`fixed`, `scroll`, `parallax`,
`orbit`), `data-az-model` (through `ctx.asset`, so the sandbox and the copy
apply), and `data-az-variant` for a backdrop. The target adds `data-az-seed`
— FNV-1a of site name, route and the view's position (scene-spec §11.1) — so
the same site grows the same scene on every build and engine. The view's
section carries `data-az-3d-host`, and parts that change while the canvas
draws carry `data-az-live-part`; the runtime sets `data-live="true"` on all
three, which the `live` state styles (the section clears, the poster hides).
The poster stays in the DOM throughout: it is the static tier, the loading
state and the fallback after a lost context.

**WebGL colours** (theme-spec §3.4). A material cannot read a custom
property, so the 3D runtime reads a token's literal for the ACTIVE scheme at
runtime — `value(doc, token)` / `hex(doc, token)` in
`scene-runtime/src/runtime/colours.ts`, from the site's own `--az-color-*`
declarations — and repaints when the scheme changes (`onSchemeChange`: the
OS preference and `data-scheme`). A compile-time literal would be wrong the
moment the visitor switched scheme. Lint rule `webgl-colour-outside-scene`
refuses that API in any file that does not import three.

**Style is data, with variants** (`emit-contract.ts`):

```ts
interface EmittedNode {
  tag: string; attrs?: Record<string, string>; children?: (EmittedNode | string)[];
  style?: StyleMap;                                          // base declarations
  below?: Partial<Record<BreakpointName, StyleMap>>;         // "<768px" is below.sm
  states?: Partial<Record<InteractionState, StyleMap>>;      // hover, focusVisible, active,
                                                             // disabled, loading, expanded, current,
                                                             // live (3D drawing in this box)
  reducedMotion?: StyleMap;                                  // opacity-only or instant
}
type BreakpointName = 'xs' | 'sm' | 'md' | 'lg';             // = keys of theme BREAKPOINT
```

Conditions are named, never written: a word says `below.sm`, not a media
query, and `states.focusVisible`, not a selector. `below` is desktop-first
because every block spec's responsive table is written as "<768px". The web
target compiles every styled node into ONE generated class in `src/az.css`
(`target-web/src/stylesheet.ts`) and removes its inline style — an inline
declaration cannot be overridden by a media query or a state, so all of a
node's style moves, not only its variants. Rules are emitted base first,
then breakpoints widest first, then states in the order above (hover inside
`@media (hover: hover)`), then reduced motion, so the more specific condition
wins a conflict. Class names hash the canonical style (identical styles share
a class); values that could end a rule (`{ } ; < > \ /*`) are refused.

One emitter file per word **per target**: `emit.web.ts`, later `emit.mobile.ts`.
A word with no emitter for a target is simply unavailable there — the compiler
reports it, it is not an error in the word.

**Data in a block** (`from <table>`, data-spec §10). A block whose
`SpecBlock.from` is set gets its rows after the page, so the contract gives
the word three helpers in `emit-contract.ts`: `fromFill(from)` — one fill of
the slot whose mapped props are markers (`fromMark(prop)`); the word renders
it with its OWN item function, so a row is markup the word already emits,
styled by the same generated classes; `fromShell(from, list, skeleton, ctx)`
— the pre-rendered shell around that template (skeleton × limit, an empty
rows container, the hidden template list, a `role=status` line, retry and
sign-in controls, a `<noscript>` line); and `skeletonLine` for the word's
loading item. A mapped prop that would be an asset path (an image's `src`)
is a marker, never an asset: the word checks `isFromMark(value)` before
`ctx.asset`. The overlay runtime's `rows.ts` fills copies of the template
with text and checked attributes only, never markup — an image field by its
URL (through the `src` rule) and its stored width and height. A word never
fetches.

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
