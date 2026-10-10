# Security scanning

How the repository is scanned, how to run each scanner locally, what the
first full pass found and what was done about each finding, and what CI runs.

The first pass ran on 2026-10-10 against `main` at `778588f`. Every count
below is from that run unless it says "after".

---

## 1. Tools and versions

| Tool | Version | What it covers | Installed with |
|---|---|---|---|
| CodeQL CLI | 2.27.2, `codeql/javascript-queries` 2.4.7, `codeql/actions-queries` 0.6.37 | dataflow and pattern queries over all JS/TS, and over the workflows | `brew install --cask codeql`, then `codeql pack download` |
| Semgrep | 1.180.0 | rule packs `p/default`, `p/typescript`, `p/nodejs`, `p/javascript`, `p/secrets`, `p/github-actions`, `p/xss` | the `semgrep/semgrep:1.180.0` container (see §2.2) |
| gitleaks | 8.30.1 | secrets in every commit and in the working tree | `brew install gitleaks` |
| osv-scanner | 2.6.0 | known vulnerabilities in `pnpm-lock.yaml` and `spike-m0/pnpm-lock.yaml` | `brew install osv-scanner` |
| pnpm audit | pnpm 10.28.2 | known vulnerabilities in the workspace lockfile | `packageManager` |
| actionlint | 1.7.12 | workflow syntax, expressions, and shellcheck over every `run:` block | `brew install actionlint` |
| shellcheck | 0.11.0 | shell; the repository tracks no shell scripts, so it runs through actionlint | `brew install shellcheck` |
| `pnpm typecheck`, `pnpm lint` | — | the baseline: tsc over all packages, theme-token lint of the word packs | — |

These are machine tools. None is a dependency of the project.

---

## 2. Running each one locally

All commands run from the repository root. Keep scan output outside the
repository (the commands below write to `$SCAN`, e.g. a temp directory).

```bash
SCAN=$(mktemp -d)
```

### 2.1 CodeQL

```bash
brew install --cask codeql
codeql pack download codeql/javascript-queries codeql/actions-queries

codeql database create "$SCAN/db-js" --language=javascript-typescript --source-root=. --overwrite
codeql database analyze "$SCAN/db-js" \
  codeql/javascript-queries:codeql-suites/javascript-security-extended.qls \
  codeql/javascript-queries:codeql-suites/javascript-code-quality.qls \
  --format=sarif-latest --output="$SCAN/codeql-js.sarif" --threads=2 --ram=4000

codeql database create "$SCAN/db-actions" --language=actions --source-root=. --overwrite
codeql database analyze "$SCAN/db-actions" \
  codeql/actions-queries:codeql-suites/actions-security-extended.qls \
  --format=sarif-latest --output="$SCAN/codeql-actions.sarif"
```

Database creation takes about a minute, analysis two to three. On an 8 GB
machine, `--threads=0` (all cores) with the default memory budget ended the
first analysis part-way with no error; `--threads=2 --ram=4000` completed.

### 2.2 Semgrep

`brew install semgrep` failed on the machine used for the first pass:
installing its Python dependency upgraded `openssl@4`, and the install
stopped twice on Homebrew's own lock on `openssl@3`. The official container
image at the same version was used instead:

```bash
docker run --rm -v "$PWD:/src:ro" -v "$SCAN:/out" -w /src semgrep/semgrep:1.180.0 \
  semgrep scan --metrics=off --disable-version-check \
  --config p/default --config p/typescript --config p/nodejs --config p/javascript \
  --config p/secrets --config p/github-actions --config p/xss \
  --exclude node_modules --exclude .az-build --exclude dist \
  --json --output /out/semgrep.json
```

Semgrep's default ignore list skips test directories; CodeQL covers those.

### 2.3 Secrets, dependencies and workflows

These are package.json scripts, so CI runs exactly the same command
(VERIFICATION §1):

```bash
pnpm scan:secrets   # gitleaks git --redact . && gitleaks dir --redact .
pnpm scan:deps      # osv-scanner over both lockfiles
pnpm scan:actions   # actionlint (calls shellcheck when it is on PATH)

pnpm audit --prod   # workspace lockfile, production dependencies
pnpm audit          # workspace lockfile, everything
```

`spike-m0/` is not a workspace member and has its own lockfile, so
`pnpm audit` does not see it; `scan:deps` does.

### 2.4 Generated code

The emit templates in `packages/target-web` and the server in
`packages/backend/src/server` ship to users. CodeQL reads them as source,
and the scanners were also run over projects the compiler actually wrote: the
`scene`, `gallery` (orbit), `nav` (sheet) and `pricing` (table) previews, and
the site from `scripts/data-e2e.mjs` (auth, backend, six data tables),
each built with `node packages/cli/bin/az.js build <file.az> --out <dir>`
into a temp directory, then scanned with the CodeQL and Semgrep commands above
pointed at that directory.

---

## 3. Findings

Counts per tool, first pass:

| Tool | Findings | Real, fixed | Accepted | False positive |
|---|---|---|---|---|
| `pnpm typecheck` / `pnpm lint` | 0 / 0 | — | — | — |
| CodeQL, JS/TS (repository) | 53 | 5 | 14 | 34 |
| CodeQL, JS/TS (generated projects) | 13 | the same files as the repository's | | |
| CodeQL, actions | 0 | — | — | — |
| Semgrep (repository) | 17, plus 3 files only partly scanned | 3 | — | 14 |
| Semgrep (generated projects) | 0 | — | — | — |
| gitleaks, history (216 commits) and tree | 2 (the same two values) | — | — | 2 |
| osv-scanner | 1 | 1 | — | — |
| pnpm audit, prod and full | 0 / 0 | — | — | — |
| actionlint (with shellcheck) | 0 | — | — | — |

After the fixes, on the tree rebased onto `8bd4d9a`: CodeQL 51 — the 48
accepted and false-positive results below, the one icon result that remains
after its fix (§3.3), and two new results from commits that landed after the
first pass (rows marked "after the rebase" in §3.3); Semgrep 16 — the 14 false positives below
and two from the same later commits; gitleaks 0 over 230 commits;
osv-scanner 0, actionlint 0 on both workflows.

### 3.1 Real — fixed

| Finding | Where | Fix |
|---|---|---|
| CodeQL `js/polynomial-redos`: `[ \t]+$` on every source line | `packages/core/src/lex.ts` | `9903ceb` — a scan back from the end. A line with 60 000 tabs before a word took 8.8 s in `az check`. Test: `hardening.test.ts` "a long run of tabs inside a line is lexed in linear time" |
| CodeQL `js/polynomial-redos`: `\/+$` on a route ending in `/` | `packages/core/src/spec.ts` | `9903ceb` — a scan back from the end. `page /a` + 60 000 `/` + `x/` took 7.6 s. Tests: "a route with a long run of slashes before its last is reported in linear time", and a control for the suggested route |
| CodeQL `js/polynomial-redos`: `[^[>]*\s*>` in the icon sniffer | `packages/core/src/icon.ts` | `9903ceb` — the `\s*` that `[^[>]*` already covers is gone; same language. An unclosed `<!doctype` and 64 KiB of spaces took 7.3 s. Test: `head-settings.test.ts` "iconFormat refuses an unclosed doctype followed by blanks in linear time", with controls |
| CodeQL `js/remote-property-injection`: cookie names written as keys of a plain object | `packages/backend/src/server/http.ts` | `db568fc`, `2e9f72e` — cookies are read into a `Map`. A cookie named `__proto__` was dropped, and an unsent name such as `constructor` read back as a function. The server only reads its own fixed names, so nothing reached a wrong value. Test: `security.test.ts` "SECURITY cookies: a name that is not sent reads as absent…" |
| CodeQL `js/unused-local-variable` | `scripts/backend-db.mjs` | `3c7e080` — the unused import removed |
| osv-scanner GHSA-68fv-2mgg-jv7q (source-map-js 1.2.1, indexed-map offsets) | `spike-m0/pnpm-lock.yaml`, through the spike's dev build tooling | `f43e185` — lockfile moves to 1.2.2 (integrity checked against the registry); the manifest is unchanged |
| Semgrep `pnpm-block-exotic-sub-dependencies`, `pnpm-trust-policy`, `pnpm-minimum-release-age` | `pnpm-workspace.yaml` | `7e18537` — `blockExoticSubdeps: true`, `trustPolicy: no-downgrade`, `minimumReleaseAge: 10080`. The frozen install is unchanged; a fresh resolution on a copy of the workspace passes |

Each test was run against the original code and fails there: against a 1 s
budget, the lexer and route tests took 2.7 s and 3.5 s at half the input size
they now use, and the icon test 9.5 s; the new code takes 10–15 ms. The
cookie test fails on the old plain object.

### 3.2 Accepted, with the reason

| Finding | Where | Reason |
|---|---|---|
| CodeQL `js/file-system-race` (14) | `packages/cli/src/` `backend-init.ts:58`, `dev-backend.ts:65,72`, `doctor-checks.ts:45,703`, `az.ts:685`, `output.ts:139`, `shipped.ts:69,106`, `words.ts:186`; four in `packages/cli/test/`; the same `shipped.ts` lines in each generated `az-vite/` | A check and a use of a path inside the author's own project. Whoever can swap files there between the two can already edit the `.az` file and the custom components the build runs, so the race grants nothing new. The one write that matters most, the backend `.env` with its secret, already uses an exclusive create (`flag: 'wx'`) and fails rather than overwrite |

### 3.3 False positives, with the reason

| Finding | Where | Reason |
|---|---|---|
| CodeQL `js/polynomial-redos`: `[?#].*$` | `packages/core/src/checks.ts:199` (`routePath`) | Its input is one token from one source line, so it has no line break; `.*$` then matches from the first `?` or `#` to the end on the first try. `az check` on a link with 60 000 `#` runs in 0.5 s, all of it start-up |
| CodeQL `js/polynomial-redos`: `^-+\|-+$` | `packages/target-web/src/emit.ts:115` (`packageName`) | The replace before it turns every run of non-alphanumerics into one `-`, so the input never holds two dashes in a row; 64 KiB of dashes takes 0.1 ms |
| CodeQL `js/polynomial-redos` (after the fix): the prolog's PI, comment and subset shapes | `packages/core/src/icon.ts:44` | Input is capped at 64 KiB (`ICON_HEAD_BYTES`) and nothing follows the starred group, so it never backtracks across iterations. Each shape CodeQL names, with seven different endings, at the full 64 KiB: worst 0.9 ms |
| CodeQL `js/user-controlled-bypass` (2) | `packages/backend/src/server/app.ts:405` | This is the OAuth `state` check itself: the value from the URL must equal the one bound to this browser's cookie (constant-time `safeEqual`), and is then taken from the server's single-use store. Comparing request values is the protection |
| CodeQL `js/bad-code-sanitization` (3) | `packages/target-web/src/data-rows.ts:52`, `data-client.ts:119,123` | Table names reach these templates only after `data.ts` accepts `^[a-z][a-z0-9]*$`; a name like ``Notes`x`` stops the build with AZ1008/AZ1229 and nothing is written. The text goes into a `.ts` module, not inline HTML |
| CodeQL `js/incomplete-multi-character-sanitization` | `packages/target-web/src/svg.ts:143` | Comments are removed before parsing, and the output is re-serialised from the parsed, allow-listed tree. A remnant such as `<!<!-- -->--` leaves `<!--`, which the parser refuses ("not well-formed"); it never passes through |
| CodeQL `js/identity-replacement` (7), `js/bad-code-sanitization` (1) | `scripts/visual/behaviour-selftest.mjs` | The self-test swaps a never-matching `/(?!)/` in for each regression it is not simulating (a deliberate no-op), and injects constant markup into its own test page |
| CodeQL `js/incomplete-sanitization` (6) | `packages/target-web/test/csp.test.ts`, `actions.test.ts`, `packages/words/test/type-on-scrim.test.ts` | Tests escaping `(`, `)`, `+`, `/` in theme values and hashes to build an assertion regex; the values hold no backslash |
| CodeQL `js/incomplete-multi-character-sanitization` (6), `js/bad-tag-filter` (1) | `packages/target-web/test/legacy-scan.ts`, `scripts/verify-build.mjs:348,802` | Test oracles that read the build's own output to count styles and scripts; nothing is sanitised for display |
| CodeQL `js/incomplete-url-substring-sanitization` | `scripts/verify-build.mjs:668` | Asserts that a bundle contains a URL string; not a URL check |
| CodeQL `js/regex-injection` (2) | `scripts/gate.mjs:196`, `scripts/thumbnails.mjs:44` | Word names from the repository's own word packs, given on the developer's command line |
| CodeQL `js/file-access-to-http` (2) | `packages/cli/test/dev-serve.test.ts:102,153` | The test posts to the loopback backend it started itself |
| Semgrep `detect-non-literal-regexp` (2) | `packages/core/src/checks.ts:271,285` | The patterns come from the compiler's own `word.json` files (`\?\s*$`, `\n\s*\n`, `[*/+×=]`), not from an author; each is linear |
| Semgrep `detect-non-literal-regexp` (9) | `scripts/gate.mjs`, `thumbnails.mjs`, `verify-build.mjs` (5), `visual.mjs`, `spike-m0/scripts/browser.test.ts` | Test harnesses building a regex from a class name, word name or key that the harness itself chose |
| Semgrep `unknown-value-with-script-tag` (3) | `scripts/verify-build.mjs:890,907`, `scripts/visual.mjs:1042` | Deliberate XSS fixtures and a CSP test page; the checks around them assert that no script runs |
| CodeQL `js/incomplete-sanitization` (after the rebase) | `packages/theme/src/theme-reads.ts:61` | Escapes `$` in names that matched `[A-Za-z_$][\w$]*` a line earlier; an identifier cannot hold a backslash |
| CodeQL `js/incomplete-sanitization` (after the rebase) | `scripts/gen-words-index.mjs:66` | Escapes the pipe for a markdown table cell in the generated word index, from the repository's own word manifests and READMEs; no outside input reaches it |
| Semgrep `detect-non-literal-regexp` (after the rebase) | `packages/theme/src/theme-reads.ts:67`, `scripts/gen-words-index.mjs:71` | The lint and the index generator build patterns from identifiers in the word packs' own code and from word names in the repository |
| gitleaks `generic-api-key` (2) | `packages/mcp/test/mcp.test.ts:187`, `packages/core/test/secrets.test.ts:103` | Made-up values: a planted session secret the test asserts is never echoed, and a random-looking key the scanner test asserts is still caught. `.gitleaks.toml` (`c320dea`) allows each by rule, file and exact value together, so another key in either file is still reported (checked) |

Semgrep could not finish three files: one rule timed out on
`scripts/visual/behaviours.mjs`, and it parsed `packages/target-web/src/svg.ts`
and `spike-m0/scripts/determinism.ts` only in part. CodeQL extracted all three.

The 13 CodeQL results on the generated projects are the server's
`app.ts:405` (2), `http.ts:103` (1) and `az-vite/shipped.ts:69,106` in each of
the five projects (10): the same files copied verbatim, with the verdicts above.
The emitted React code and client modules had no findings from either tool.

---

## 4. CI

`.github/workflows/security.yml` runs on every push to `main`, every pull
request, weekly (Monday 04:30 UTC, so a new advisory against an unchanged
lockfile still surfaces) and on demand. The workflow's default permission is
`contents: read`.

| Job | What it runs | Extra permissions |
|---|---|---|
| `codeql (javascript-typescript)`, `codeql (actions)` | CodeQL init + analyze, `security-extended` queries, `build-mode: none`; results go to code scanning | `security-events: write`, `actions: read` |
| `dependency review` | on pull requests only; fails on a new dependency with a moderate or higher advisory | — |
| `secret scan (full history)` | `pnpm scan:secrets` on a full-depth checkout | — |
| `dependency vulnerabilities` | `pnpm scan:deps` | — |
| `workflow lint` | `pnpm scan:actions` (shellcheck is on the runner image) | — |

gitleaks, osv-scanner and actionlint are downloaded from their release pages
at the version in §1 and checked against a SHA-256 pinned in the workflow
(each value was checked by downloading the file) before they run. Every
action is pinned to a full commit SHA with its version in a comment (as in
`ci.yml`), and every checkout in `security.yml` sets `persist-credentials: false`.

`.github/dependabot.yml` proposes npm updates (root and `spike-m0`) and
GitHub Actions updates weekly, with a seven-day cooldown to match
`minimumReleaseAge` in `pnpm-workspace.yaml`.

The workflows were checked locally with actionlint and the CodeQL actions
queries; neither reported anything. They have not run on GitHub yet.
Dependency review needs the dependency graph enabled on the repository, and
on a private repository both it and CodeQL upload need code security
enabled.

To clear a code-scanning alert for one of the false positives in §3.3,
dismiss it in the code scanning view as "False positive" with the reason from
the table. No suppression comments are used in the code.
