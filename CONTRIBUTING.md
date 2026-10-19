# Contributing to Incord Intelligent Language (inlang)

The language's command is `az`, and that name stays in code, file names and
error codes (`AZ1234`).

Read [docs/AGENTS.md](docs/AGENTS.md) first: the reading order, the seven
non-negotiable rules and the stop conditions. The binding code rules are
[docs/CONVENTIONS.md](docs/CONVENTIONS.md); what "done" means for a word is
[docs/word-quality-gate.md](docs/word-quality-gate.md); every command is in
[docs/VERIFICATION.md](docs/VERIFICATION.md).

## Setup

```sh
corepack enable pnpm                              # pnpm at the version package.json pins
pnpm install --frozen-lockfile --ignore-scripts   # never without --ignore-scripts
pnpm verify                                       # typecheck + every unit suite; must be green before you start
pnpm exec playwright install chromium firefox webkit   # once, for the browser suites
```

Node 22.18 or later. The toolchain — `node:test`, `tsc --noEmit`, `az lint`,
no build step and no formatter — is [CONVENTIONS §1](docs/CONVENTIONS.md#1-language--tooling).
To run one file:
`node --experimental-strip-types --test packages/words/test/faq-schema.test.ts`.

## Which checks to run

Run them locally with the same command CI uses; a check that exists only in CI
drifts.

| You changed | Run |
|---|---|
| anything | `pnpm verify` |
| a word (`packages/words/**`), a theme, `target-web` | `pnpm verify`, `pnpm lint`, `node scripts/gen-words-index.mjs` if a manifest, README or emitter header changed, then `pnpm gate words/<word>` and `pnpm thumbnails <word> --verify` |
| a variant or a preview | the word row above, plus `pnpm gate words/<word> --every-variant` |
| the overlay or scene runtime, generated pages, CSP | `pnpm verify`, `pnpm verify:build`, `pnpm test:visual` (and `pnpm test:3d` for 3D) |
| the grammar or the linker (`packages/core`) | `pnpm verify`, `pnpm verify:build`; update GRAMMAR.md and ARCHITECTURE.md in the same commit |
| the CLI or MCP server | `pnpm verify`; `pnpm test:dev` for `az dev` |
| auth (word, target wiring, auth runtime) | `pnpm verify`, `pnpm test:auth`; `pnpm test:cloud-auth` for the token-endpoint profile (Docker) |
| the backend or data tables | `pnpm verify`, `pnpm test:backend-db` (Docker), `pnpm test:data`, `pnpm test:auth` |
| chat (the word, its runtime, the `/chat` route) | the backend row, plus `pnpm test:chat` |
| a chat library package (`packages/chat-*`) | `pnpm verify`, `pnpm test:chat-lib`; the chat row too, since `az build` copies the packages into every chat site |
| docs only | `pnpm verify` (word READMEs, the root README and docs/WORDS.md are tested) |

`pnpm gate` with no argument runs all 12 items for every word; `--self-test`
on `gate` and `test:visual` proves each check can fail. `--every-variant` runs
items 3–7 on every variant without its own preview and takes hours; run it in
the background. `pnpm coverage` lists variants and props an emitter does not
yet implement.

## House rules

From CONVENTIONS, word-quality-gate and the way this repository already
works — a change that breaks one is sent back:

- **A test must fail on the old code.** Write the test, watch it fail, then
  fix. A check that cannot fail proves nothing: suites carry `CONTROL` tests
  that tamper with the input and require the failure (see
  `packages/words/test/descriptions.test.ts`, `packages/core/test/headers.test.ts`).
- **Never silence a check.** No lint-suppression comments, no skipped or
  deleted tests, no loosened types to force a green run. `@ts-expect-error`
  needs a same-line reason (CONVENTIONS §1). Fix the cause, at its source.
- **Words read theme tokens only** — no hex, `rgb(`/`hsl(`, off-scale px,
  `font-family` or numeric `z-index` in `packages/words` or `target-*`
  (CONVENTIONS §4, `pnpm lint`). Colour is the site's first decision
  (PRD §6.1a), made by its `theme`, `accent` and `pattern`, so a word —
  new or changed — takes every colour from theme tokens (`color.*`,
  `gradient.accent`) and names them in its `themeReads`. `pnpm lint` fails a
  word whose `themeReads` is not exactly the tokens its code reads
  ([the themeReads check](packages/theme/src/theme-reads.ts)).
- **No vendor, product or client names** in code, identifiers, comments,
  diagnostics or commit messages. Use neutral words — "hosted adapter",
  "managed provider", "token-endpoint profile". The secret patterns are
  generic shapes for the same reason. A doc may name a tool the user
  installs or configures (a database, Docker) where it must.
- **No secrets anywhere.** Tests generate throwaway values; logs and reports
  print key names, offsets and shapes, never values.
- **Bound every wait.** Every child process, navigation and `page.evaluate`
  has a deadline (`scripts/lib/bounded.mjs`); wait on a condition, never a
  fixed sleep. A stuck engine must be a named failure, not a hang.
- **Back up before you edit or delete.** Copy a file you are about to
  rewrite to `.backups/` (gitignored) or your own scratch space; dump a
  database before a destructive step.
- **Scope discipline.** Change only what the task needs. Something else worth
  fixing goes in the PR description as a suggestion, not into the diff.
- **Deterministic output.** No timestamps, random ids or unstable key order;
  `az build` twice is byte-identical (CONVENTIONS §6, tested).
- **Exact dependency versions,** committed lockfile, `--ignore-scripts`; a
  new runtime dependency in `core` needs a written justification
  (CONVENTIONS §7). `core` and `target-*` import nothing network-capable.
- **Diagnostics** read `<word>: <what is wrong> — <what to do>`, lowercase,
  no trailing period, with a stable `AZxxxx` id (CONVENTIONS §5) from the
  ranges and per-word blocks of [GRAMMAR §7.4–§7.5](docs/GRAMMAR.md#74-diagnostic-id-ranges).
  Errors block the build; taste is a warning.
- **Every source file opens with an `@az` header** (`Purpose`, `Spec`,
  `Exports`, `Edit guide`, `Tests`; words also `Renders`, `Variants`,
  `Modifiers`, `Props`, `Styling`, `Behaviour`). `headers.test.ts` checks it
  against the code, so keep it true when you change the file.

## Where things live

| Path | What |
|---|---|
| `packages/core` | grammar, parser, linker, Spec, validation, `az explain` text — no filesystem, no network |
| `packages/theme` | token schema, the six themes, accent ramps and pairs, scheme CSS |
| `packages/target-web` | the web target: React + Vite project, stylesheet, CSP, `AZ.md` |
| `packages/words` | the twelve words, one folder each, and their shared tests |
| `packages/overlay` | behaviour runtime shipped to the browser: dialogs, menus, disclosures, carousel |
| `packages/scene-runtime` | the 3D runtime: one renderer per page, posters as fallback |
| `packages/auth-runtime` | the sign-in forms' browser runtime |
| `packages/backend` | the generated server's source and its emitter |
| `packages/chat-answer` | the chat's answer checker, for the generated server and for any app (chat-block-spec §22) |
| `packages/chat-instructions` | what a chat's model is told, for the build, the generated server and any app |
| `packages/chat-render` | the chat's page renderer, for a site's panel and any app; per-theme shells in `themes/` (`node scripts/gen-chat-themes.mjs` after a change to the chat word or a theme) |
| `packages/chat-react` | `<AzAnswer>` for React apps |
| `packages/chat-runtime` | the chat for an app: its own model (checked, budgeted, kept) or a chat server, local or hosted (chat-block-spec §22.4) |
| `packages/cli` | the `az` binary |
| `packages/mcp` | the MCP server behind `az mcp` |
| `docs/` | product, grammar, architecture, one spec per block, verification |
| `fixtures/` | small `.az` files |
| `scripts/` | browser suites, the gate, thumbnails, generators |
| `spike-m0/` | the M0 spike: a hand-built hero and motion tiers, its own package |

Every test suite, what it checks and what it needs is in
[VERIFICATION §1.1](docs/VERIFICATION.md#11-every-suite-what-it-checks-and-what-it-needs).

## How a word is wired

A word is a folder. The compiler, `az explain`, the MCP catalogue, the
thumbnails and the gate all discover words by scanning `packages/words/*/word.json`
— **adding a word never requires editing `packages/core`** (ARCHITECTURE §4;
if it seems to, the abstraction is wrong — stop and say so). The places that
name words explicitly:

| Place | Why |
|---|---|
| `packages/words/registry.ts` | static import of every bundled emitter, so a bundler can see it |
| `docs/<word>-block-spec.md` | the authority; its first `az 1` example is compiled by `packages/core/test/spec-examples.test.ts` |
| `packages/words/test/docs.test.ts`, `words.test.ts`, `packages/core/test/link.test.ts`, `packages/mcp/test/mcp.test.ts` | assert the word count (twelve: the eleven and `chat`) — the block cap |
| `scripts/visual.mjs` (`RESTACK`, `COLUMN`, `OVER_MEDIA`, `CENTRED`, …) | per-variant browser checks; a variant listed there needs its own `preview.<variant>.az` |
| `packages/overlay/src/runtime/behaviours.ts`, `scripts/visual/behaviours.mjs` | only for a word with browser behaviour (`data-az-behaviour`) |

## Adding a word

The block cap is twelve until M5 (PRD §6.2, ROADMAP M2): the eleven Phase 1
words and `chat`, the one dated exception (2026-10-15). Another word is an
owner decision: log it in the ROADMAP backlog first. When it is approved:

1. **Spec.** Write `docs/<word>-block-spec.md` — syntax, variants, responsive
   table, accessibility floor, validation table. Its first `az 1` example
   must compile.
2. **`packages/words/<word>/word.json`** — the single source of truth
   (ARCHITECTURE §4.1):
   - `name` (lowercase, one token, permanent after M5), `version`, `kind: "block"`;
   - `description` and `descriptions.variants` / `.modifiers` / `.children`,
     and a `description` on every prop, slot, `from` mapping, plus
     `valueDescriptions` on every `enum`/`list` value: each **≤60 characters,
     no trailing period** (`descriptions.test.ts`). These are the info lines
     `az explain`, the MCP catalogue and docs/WORDS.md show;
   - `variants` (first is the default), `modifiers`, `props` (type, bounds,
     `required`, `default`, `scope: "site"` for site-level settings), `slots`
     (`min`/`max`, nested `props`/`slots`, and the `line` of values the fill
     takes — GRAMMAR §4.5), `childLines` for each `children` word,
     `requires`, `recommends`, `requiresWhen`;
   - `checks`: the spec's validation table as data, using the rule kinds in
     `packages/core/src/checks.ts`. Codes are permanent and never reused;
     a new word takes the next free block of twenty and adds its row to the
     table in [GRAMMAR §7.5](docs/GRAMMAR.md#75-per-word-id-blocks)
     (`packages/core/test/diagnostic-codes.test.ts` holds every word to it);
   - `themeReads`: exactly the token paths the word's own code reads
     through `ctx.theme` (`pnpm lint` fails on one missing or extra; tokens
     read inside shared helpers such as `framed` are the helper's), `deps`
     (exact versions), `targets: ["web"]`, and `tested` with only the
     engines and companions a run actually covered (gate item 12).
3. **`emit.web.ts`** — `export function emit(block, ctx): EmittedNode`. Every
   design value comes from `ctx.theme`; buttons come from `ctx.action(s)`;
   assets through `ctx.asset`; responsive styles through `below`; user text is
   escaped by the target, never concatenated into code. Open the file with an
   `@az word <word>` header (copy `faq/emit.web.ts`'s shape) naming every
   variant, modifier, prop and rendered class.
4. **Register** the emitter in `packages/words/registry.ts`.
5. **`preview.az`** — a minimal site that uses the word; it drives snapshots,
   the gate and thumbnails. Add `preview.<variant>.az` for variants that need
   their own content (see the next section).
6. **`README.md`** — copy an existing word's layout: Example, Variants,
   Modifiers, Properties, Children, Accessibility, Status (what `pnpm coverage`
   reports and the known gaps), Tested (what really runs). It must link
   `docs/<word>-block-spec.md` (`docs.test.ts`).
7. **Tests** in `packages/words/test/<word>-*.test.ts` for what the generic
   suites cannot see. The generic ones already run the new word:
   `props`, `variants`, `structure`, `conformance`, `descriptions`, `docs`,
   `headers`, `words` (theme lint).
8. **Behaviour** (only if it is interactive): mark the markup with
   `data-az-behaviour`, implement it in `packages/overlay/src/runtime/behaviours.ts`,
   and add a browser check in `scripts/visual/behaviours.mjs`.
9. **Regenerate** `node scripts/gen-words-index.mjs`, then run the word row
   of the table above and `pnpm gate words/<word>` until all 12 items pass.
   Thumbnails need no registration: `pnpm thumbnails <word> --verify` renders
   one per variant.

## Adding a variant to an existing word

1. Add it to `variants` and `descriptions.variants` in `word.json` (≤60
   characters). The first entry stays the default.
2. Make the emitter render it **differently** — `variants.test.ts` and
   `pnpm coverage` compare the output, not the source. Follow the word's
   `Edit guide` header line (e.g. nav's `LAYOUT` table, auth's `FIELDS`).
   Name it in the header's `Variants:` line (`headers.test.ts`).
3. Add a row to the README's Variants table and to the spec.
4. **Preview.** Without one, thumbnails and `test:visual --every-variant` use
   `preview.az` with the variant swapped in — no file needed. Add
   `preview.<variant>.az` when the variant needs other content to show
   (media for `split`, more items for `columns`) or when it is listed in a
   `scripts/visual.mjs` table. Both tools pick the file up by name; the file
   must compile and use the variant it is named after (`docs.test.ts`). A
   preview named for a modifier or an enum value (`preview.sheet.az` for
   `nav mobile sheet`) works the same way, for `test:visual` only.
5. `node scripts/gen-words-index.mjs`, `pnpm verify`, `pnpm lint`,
   `pnpm thumbnails <word> --verify`, `pnpm gate words/<word> --every-variant`.

A modifier or a prop follows the same path: manifest entry with its info
line, emitter, header line, README row, spec row, regenerate the index.

## Adding a CLI command or MCP tool

- **CLI** (`packages/cli/src/az.ts`): add the command to `USAGE` and
  `COMMANDS`, dispatch it in `main`, put filesystem work in the CLI (never in
  `core`), and test it in `packages/cli/test/`. Add its row to the README's
  Commands table — `words-index.test.ts` fails until `az --help` and the
  README list the same commands.
- **MCP** (`packages/mcp/src/tools.ts`): add a `ToolDef` to `TOOLS` with its
  input schema and annotations (mark anything that writes or runs project
  code), implement it on the `Toolbox` in `packages/cli/src/mcp.ts` by calling
  the same function the CLI command calls, update the tool list asserted in
  `packages/mcp/test/mcp.test.ts`, and add a row to [docs/mcp.md](docs/mcp.md).
  Read-only tools must compile from manifests alone and never load project code.

## Adding a backend or data feature

The server source is `packages/backend/src/server/` and is copied verbatim
into every generated `server/`; `packages/backend/src/emit.ts` decides which
files and dependencies a site gets.

- A setting: the one env schema, `server/env.ts` (the server, `.env.example`
  and `az backend init` all read it). Server settings never get the
  `AZ_PUBLIC_` prefix.
- A schema change for accounts: a new versioned step in `server/migrations.ts`
  for all three engines — never edit a shipped step. Every query is one
  unnamed statement with `?` placeholders (backend-spec §3.1).
- Data tables: grammar in `packages/core/src/data.ts`, the lock and its diff
  in `packages/core/src/data-lock.ts` (AZ1700–AZ1749), SQL in
  `packages/backend/src/data-ddl.ts`, routes in `server/data-api.ts`, the
  commands in `packages/cli/src/data-schema.ts`. A new keyword or setting
  also needs its line in `packages/core/src/describe.ts`.
- Each security property gets a test that fails without it (backend-spec §5).
  Run `pnpm test:backend-db` (Docker) and `pnpm test:data` before you push.

## Commits and pull requests

- Branching, the subject format (`<scope>: <what is now true>`), the body
  and the review of `git diff --staged` before a commit are
  [CONVENTIONS §8](docs/CONVENTIONS.md#8-commits--branches) — the one source
  for them.
- A PR lists the checks you ran and their results, anything you did not
  run and why, and any snapshot or thumbnail change with what changed
  visually. Never blind-accept a snapshot update.

## Conduct, security and license

- Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
- Never report a security problem in a public issue or pull request. Report
  it privately as [SECURITY.md](SECURITY.md) describes.
- az is licensed under the [Apache License 2.0](LICENSE). By submitting a
  contribution you agree it is licensed under the same terms, as the
  license's section 5 states. Only submit work you have the right to
  contribute.
