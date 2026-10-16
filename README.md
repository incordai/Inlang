# az

`az` is a compiler that turns one `.az` file into a production website. You
write short words — `hero center`, `faq list`, `pricing cards` — and `az build`
emits a React + Vite project that pre-renders every page, ships a strict
Content-Security-Policy, and reads its colours, spacing and type only from a
theme. The build is deterministic (two builds give byte-identical files), runs
offline after install, and has no AI in it. A site can also declare an
optional backend — accounts, sessions and data tables over SQLite,
PostgreSQL or MySQL — that `az build` generates beside it.

```az
az 1

site aurora
  width default
  theme midnight
    accent violet
    pattern glow

  nav bar
    link "Work" /work

page /
  hero center
    eyebrow "Limited run"
    title   "Built in the dark"
    sub     "Handmade. Forty pairs a month."
    height  peek

page /work
```

That is [`fixtures/minimal.az`](fixtures/minimal.az). The full grammar is
[docs/GRAMMAR.md](docs/GRAMMAR.md); `az explain <term>` says what any word
means in one line.

## Install

Needs **Node 22.18 or later** (CI runs Node 22, nightly also 24) and pnpm, which
corepack provides at the version pinned in `package.json`.

```sh
git clone https://github.com/incordai/incord-lang.git && cd incord-lang
corepack enable pnpm
pnpm install --frozen-lockfile --ignore-scripts
alias az="node $(pwd)/packages/cli/bin/az.js"
az --help
```

Always install with `--ignore-scripts`: nothing here needs a lifecycle script,
and they are the most common way a dependency attacks a machine
([word-quality-gate §2](docs/word-quality-gate.md)). `az doctor` checks the
machine for you.

## Quick start

A site is written in three steps, in this order:

1. **Colour.** Choose the `theme`, its `accent` (one hue, or a pair for a
   gradient) and its `pattern` first, from the brand or mood — see
   [Colour](#colour):

   ```sh
   az palette               # a gallery page: every theme, hue, pair and pattern
                            # in light and dark, each with its .az lines to copy
   az palette --list        # the same choices in the terminal (--json for tools)
   az explain theme         # one line per theme
   az explain theme accent  # each hue and the hues it makes a gradient with
   ```

2. **Frame.** `width` and `font` under `site` (`az explain site width`,
   `az explain font`).
3. **Sections.** The pages and their words — `hero center`, `faq list` — from
   the [words](#words) below (`az explain hero center`).

Write `site.az` (the example above), then:

```sh
az check site.az     # diagnostics only, writes nothing: "az: no problems found"
az dev site.az       # build, serve on http://127.0.0.1:5173/ and reload on every save
az build site.az     # write the project to .az-build/ (--out dir to choose)
cd .az-build && npm install --ignore-scripts && npm run build   # the site, pre-rendered, in .az-build/dist/
cd .. && az audit    # check what the build ships: secrets, CSP, new-tab links
```

`az dev` installs the generated project's dependencies on its first run
(network), then works offline. A diagnostic names the line, a stable code and
the fix:

```
broken.az:4:15 error AZ1202  hero: 'center' and 'split' are both layouts — pick one
broken.az:6:3 error AZ1201  nonsense: unknown word — see the word list
```

The generated project carries `AZ.md`, its own map for people and AI tools:
it opens with the site's colour lines and their legal values, then which
file each route and block went to, and where to change things.

## Colour

Colour is the first decision, and it is made from closed sets so the contrast
can be proven, never from a hex code. `theme` picks one of six
hand-designed themes, each with a light and a dark scheme: `midnight` (dark
product), `paper` (editorial), `signal` (industrial), `clay` (warm, cream and
terracotta), `petal` (soft, lavender and violet), `volt` (loud, black, white
and magenta). `accent` picks a hue (`violet` `indigo` `blue` `teal`
`green` `lime` `amber` `orange` `rose`), and the compiler chooses the step of
its ramp that holds every contrast floor in light and dark. Two hues make a
gradient pair:

```az
  theme midnight
    accent violet blue
```

The primary button, the highlighted pricing plan's edge and the `glow`,
`spotlight` and `ramp` patterns then draw from violet to blue in OKLCH, with
a label proven at 4.5:1 against every point of the gradient. Only pairs that
hold every floor along the whole gradient, without a grey middle, are
offered; any other is error AZ1423, naming the partners that work.
`az explain theme accent` lists them; the rule and the table are in
[theme-spec §13](docs/theme-spec.md).

To choose by eye, `az palette` writes one static page (default
`.az-build/.palette/index.html`) showing, for each theme in light and dark
side by side, its swatches, every hue as a button and a link, every allowed
pair as a gradient button over its glow, and every pattern — each with the
exact lines to paste and a copy button. `--theme clay` and `--accent violet`
narrow it; `--list` prints the choices for a terminal and `--json` for tools.
The page carries the same Content-Security-Policy a build gives its pages
([theme-spec §14](docs/theme-spec.md)).

## Commands

| Command | Purpose |
|---|---|
| `az build <file.az> [--out dir]` | compile to a runnable project (default `.az-build`) |
| `az dev <file.az> [--port N] [--open] [--no-serve]` | build, serve and reload on every save; a site with a backend runs it locally too |
| `az spec <file.az>` | print the resolved Spec as JSON |
| `az check <file.az>` | report diagnostics only, write nothing |
| `az lint [words-dir]` | theme-token check of every word pack |
| `az migrate <file.az>` | upgrade the file to this grammar version |
| `az eject <word> [--dir project]` | copy a word into the project's `words/` to own it — one-way |
| `az backend init <server-dir>` | write the backend's `.env` with a fresh secret (owner-only, never overwrites) |
| `az backend plan <file.az>` | show the data schema step the file needs; writes nothing |
| `az backend schema <file.az> [--rename a=b] [--drop x] [--unique t.f] [--expose t]` | record that step in `<file>.data.json` |
| `az backend images <server-dir> [--confirm]` | count stored images without width copies; with `--confirm`, make them |
| `az backend probe <server-dir> [--json]` | ask the configured chat model the production prompt; times, tokens, what was dropped |
| `az backend usage <server-dir> [--json]` | the chat's daily counts and budget left, and the shares kept; reads only, never a message |
| `az mcp [--root dir]` | serve the compiler's tools to an AI agent (MCP over stdio) |
| `az explain <term...>` | one line per term, e.g. `az explain hero center` |
| `az palette [--theme t] [--accent h] [--out dir]` | write the colour gallery: every theme, hue, pair and pattern in light and dark, with its `.az` lines |
| `az palette --list \| --json [--theme t] [--accent h]` | print every colour choice, for a terminal or a tool |
| `az prompt [--words a,b] [--compact] [--budget N] [--json]` | print the Markdown instructions any AI model needs to write `.az`, generated from the compiler's tables; writes nothing |
| `az doctor [file.az] [--out dir] [--json]` | check this machine and project; changes nothing |
| `az audit [--out dir] [--online] [--json]` | check a build's output; changes nothing (`--online` adds the advisory lookup) |

`az --help` prints the same list (a test keeps this table and it in step).
Exit codes: 0 success; 1 errors in the file or a failed check; 2 bad usage,
configuration, or a file that cannot be read.

## The optional backend

A site that needs accounts or data declares `backend`; one that does not
builds exactly as before. Only choices go in the `.az` file — addresses,
passwords and keys go in the server's `.env`, and the compiler refuses a
connection string written in the file.

```
site shop
  auth
    adapter azbackend
  backend
    database sqlite          # sqlite | postgres | mysql
    email    smtp            # smtp | api
```

- **Local:** `az dev site.az` runs the site and the backend with nothing to
  configure — SQLite in `.az-dev/`, a generated secret, and a local mailbox
  for reset and sign-in emails instead of sending them.
- **Production:** `az build` writes `server/` beside the site (its own
  `package.json`, `.env.example`, a runbook `README.md` and the source).
  `az backend init <out>/server` writes `server/.env` with a fresh
  `AZ_SESSION_SECRET` (mode 0600, never overwritten); fill in the rest —
  database URL, mail relay or email API, allowed origins.
- **Social sign-in:** any OpenID Connect or OAuth 2 provider, configured only
  by `AZ_OAUTH_<ID>_…` keys in `.env` (issuer or three URLs, client id and
  secret); no provider is named in the code. Accounts link by verified email.
- **Auth adapters** (`auth` → `adapter`): `azbackend` (this backend, or your
  own server speaking its protocol), `hosted` (a managed auth provider — its
  public key only, `profile standard` or `token-endpoint`), `session` (your
  own same-origin cookie routes), `custom` (your module, set with `impl`).
- **Data tables:** `data <table>` declares fields (`text`, `longtext`,
  `number`, `money`, `flag`, `date`, `datetime`, `email`, `url`, `choice`,
  `image`, `ref`) and deny-by-default `allow` rules. The build gives
  migrations for all three databases, a REST API, a typed client, an admin
  area, and `from <table>` for `feature`, `faq` and `gallery`. Schema history
  lives in a committed `<site>.data.json`: `az backend plan` shows a change,
  `az backend schema` records it, and destructive steps need an explicit flag.

Guides: [self-hosting](docs/self-hosting.md), [managed cloud setup](docs/cloud-setup.md).
Specs: [backend](docs/backend-spec.md), [auth](docs/auth-block-spec.md), [data](docs/data-spec.md).

## Words

A word is a block on the page. Each lives in `packages/words/<word>/` with
its manifest (`word.json`), web emitter, README and previews. The table below
is generated from each `word.json` by `node scripts/gen-words-index.mjs`, which
also writes the full index, [docs/WORDS.md](docs/WORDS.md) (every variant,
modifier and key with its info line, and the file to edit for each concern);
`pnpm test` fails if either is stale.

<!-- words-catalogue:start (generated by scripts/gen-words-index.mjs — do not edit) -->
| Word | Info | Variants | Docs |
|---|---|---|---|
| `auth` | Sign-in, sign-up or password-reset form on its own page | `login` `signup` `reset` | [README](packages/words/auth/README.md) |
| `chat` | A panel or a launcher where visitors ask the site's AI | `panel` `float` `none` | [README](packages/words/chat/README.md) |
| `cta` | Closing call-to-action section before the footer | `band` `card` `split` | [README](packages/words/cta/README.md) |
| `faq` | Questions with expandable answers, plus FAQ schema | `list` `columns` | [README](packages/words/faq/README.md) |
| `feature` | Set of features or benefits | `grid` `rows` `bento` | [README](packages/words/feature/README.md) |
| `footer` | Site footer: links, legal row and copyright | `minimal` `columns` `mega` | [README](packages/words/footer/README.md) |
| `gallery` | Set of images in a chosen layout | `grid` `masonry` `carousel` `orbit` | [README](packages/words/gallery/README.md) |
| `hero` | Page opener: the page's only h1, text and actions | `center` `split` `full` `stack` `minimal` | [README](packages/words/hero/README.md) |
| `nav` | Site navigation bar with links, groups and a CTA | `bar` `center` `split` `minimal` `side` `mega` `none` | [README](packages/words/nav/README.md) |
| `pricing` | Plans and prices with a monthly/annual toggle | `cards` `table` | [README](packages/words/pricing/README.md) |
| `scene` | Standalone 3D scene with a poster fallback | `inline` `full` `backdrop` `none` | [README](packages/words/scene/README.md) |
| `text` | Section of written copy from a string or .md file | `prose` `centered` `columns` | [README](packages/words/text/README.md) |
<!-- words-catalogue:end -->

## Security model

- **Content-Security-Policy:** every built page gets a strict, hashed policy
  as a `<meta>` — never `unsafe-inline` or `unsafe-eval`; the generated
  server sends `default-src 'none'` and the usual hardening headers.
- **Secret guard:** a service key in the `.az` file is an error (AZ1411); the
  build refuses a secret-looking public variable and scans the built bundle
  for key shapes. These checks have no off switch. Only `AZ_PUBLIC_…`
  variables reach the browser.
- **No network at build:** the compiler never calls the network. A project's
  own words (`words/`, e.g. after `az eject`) are code: they run when the
  project is built (`az build`, `az dev`, the MCP `az_build` tool), never in
  the read-only tools.
- **`az doctor`** checks the machine and the project (Node, image library,
  compile, `.env` key names, build secrets) and prints each fix.
- **`az audit`** checks a build's output: secrets in shipped files, page and
  backend CSP, new-tab links, and with `--online` known-vulnerable dependencies.

Details: [word-quality-gate §2–§5](docs/word-quality-gate.md),
[backend-spec §5](docs/backend-spec.md), [data-spec §13](docs/data-spec.md),
[security scanning](docs/security-scanning.md).

## Tests

| Script | Checks | Needs |
|---|---|---|
| `pnpm verify` | `pnpm typecheck` + `pnpm test`: every unit suite — compiler, theme, words (props, variants, headers, descriptions, this README's example, commands and catalogue), target, CLI, runtimes, backend on in-memory SQLite, MCP | nothing |
| `pnpm lint` | `az lint packages/words`: words use theme tokens only, and each `themeReads` lists exactly the tokens its code reads | nothing |
| `pnpm coverage` | which variants and props each emitter implements | nothing |
| `pnpm verify:build` | builds the GRAMMAR §8 fixture with the real toolchain and checks the shipped HTML, security and bundle budget | network (installs) |
| `pnpm test:visual` | every preview in three themes, light and dark: overflow, axe, keyboard, reduced motion, behaviours | browsers |
| `pnpm gate [words/<word>]` | the 12-point word gate ([VERIFICATION §3](docs/VERIFICATION.md)); `--every-variant` adds every variant without its own preview | browsers |
| `pnpm test:palette` | the `az palette` gallery in three engines: zero CSP violations (served and opened from the file), axe, phone width, keyboard, copy; a screenshot per theme in a light and a dark browser, rendered twice and identical, in `.palette-shots/` | browsers |
| `pnpm thumbnails [--verify]` | one PNG per word × variant in `.thumbnails/`; `--verify` renders twice and requires identical bytes | browsers |
| `pnpm test:auth` | auth forms, protected pages and reset against a local mock provider and the generated server | browsers |
| `pnpm test:dev` | `az dev` end to end: backend, dev mailbox, reload on save, clean Ctrl-C | browsers |
| `pnpm test:3d` | the 3D runtime in real browsers | browsers |
| `pnpm test:data` | data tables end to end: API, rules, admin, images, `from` blocks | browsers |
| `pnpm test:backend-db` | the backend on real PostgreSQL and MySQL | Docker |
| `pnpm test:cloud-auth` | the hosted adapter's token-endpoint profile against the real server software | Docker, browsers |
| `pnpm test:lighthouse` | Lighthouse on the previews and fixture sites | browsers |

Browsers: `pnpm exec playwright install chromium firefox webkit` once. Every
browser suite also installs the generated project's pinned dependencies
(network) before it builds.
CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs `verify`,
`verify:build`, the word gate with lint, auth, dev, 3D and thumbnails, and
`test:backend-db`.

## Repository map

| Path | What |
|---|---|
| `packages/core` | grammar, parser, linker, Spec, validation, `az explain` text — no filesystem, no network |
| `packages/theme` | token schema, the three themes, accent ramps and pairs, scheme CSS |
| `packages/target-web` | the web target: React + Vite project, stylesheet, CSP, `AZ.md` |
| `packages/words` | the twelve words, one folder each, and their shared tests |
| `packages/overlay` | behaviour runtime shipped to the browser: dialogs, menus, disclosures, carousel |
| `packages/scene-runtime` | the 3D runtime: one renderer per page, posters as fallback |
| `packages/auth-runtime` | the sign-in forms' browser runtime |
| `packages/backend` | the generated server's source and its emitter |
| `packages/cli` | the `az` binary |
| `packages/mcp` | the MCP server behind `az mcp` |
| `docs/` | product, grammar, architecture, one spec per block, verification |
| `fixtures/` | small `.az` files |
| `scripts/` | browser suites, the gate, thumbnails, generators |
| `spike-m0/` | the M0 spike: a hand-built hero and motion tiers, its own package |

## Docs

Start with [AGENTS.md](docs/AGENTS.md) (reading order and the rules), then
[ROADMAP](docs/ROADMAP.md) (current status), [PRD](docs/PRD.md),
[ARCHITECTURE](docs/ARCHITECTURE.md), [CONVENTIONS](docs/CONVENTIONS.md),
[GRAMMAR](docs/GRAMMAR.md), [theme-spec](docs/theme-spec.md),
[VERIFICATION](docs/VERIFICATION.md), [ASSUMPTIONS](docs/ASSUMPTIONS.md) and
[word-quality-gate](docs/word-quality-gate.md). Each word has a
`docs/<word>-block-spec.md`; shared specs cover
[buttons and sections](docs/buttons-and-sections-spec.md),
[overlays](docs/overlays-spec.md), [motion tiers](docs/motion-tiers-spec.md),
[mobile motion](docs/mobile-motion-spec.md) and the
[3D techniques](docs/3d-technique-reference.md). Background:
[stack evaluation](docs/stack-evaluation.md),
[distribution and hosting](docs/distribution-and-hosting.md),
[MCP](docs/mcp.md). Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## Using with an AI assistant

- **Any model, no connection: paste `az prompt` into its instructions.**
  `az prompt` prints one Markdown block — the authoring order (colour
  first), the syntax with a minimal site, the colour choices, every word
  with its variants and keys (types and allowed values), the backend and
  data rules, and the common errors with the compiler's own fix — generated
  from the same tables the compiler checks against, so it cannot drift.
  Every example in it compiles with zero diagnostics (a test holds it to
  that). Its size goes to stderr in characters and approximate tokens
  (characters / 4, rounded up — a model's own tokenizer will differ).
  `--compact` keeps the order, syntax, colour and every word's variants and
  keys, and a test keeps it under 12,000 characters (3,000 approximate
  tokens). `--words hero,cta` describes only those words;
  `--budget N` fits N tokens by dropping, in this order, each word's
  example, each word's validation rules, the info lines, the backend and
  data section, then the common errors; `--json` gives the prompt and its
  size to a tool, as the MCP tool `az_prompt` does.
- **Colour comes first.** An assistant chooses the theme, accent and pattern
  with the user before it writes any section, then the frame, then the
  sections. `az mcp`'s instructions say so, and docs/WORDS.md and every
  generated `AZ.md` open with that step and its legal values.
- **`az mcp`** serves the compiler as tools — `az_words`, `az_explain`,
  `az_word_docs`, `az_grammar`, `az_check`, `az_spec`, `az_build` and more —
  with read-only tools that never run project code. Setup and the safety
  model: [docs/mcp.md](docs/mcp.md).
- **`az palette`** (and the MCP tool `az_palette`) gives every colour
  choice with its `.az` line — as a gallery page to pick from by eye, or as
  `--list` / `--json`.
- **`az explain <term...>`** gives a ≤60-character line for any word,
  variant, key or value — the cheapest lookup.
- **[docs/WORDS.md](docs/WORDS.md)** lists every word, variant and key with
  its info line and the file to edit for copy, style tokens, layout and
  behaviour, plus the gate to run.
- **Per-word READMEs** (`packages/words/<word>/README.md`) are each word's
  docs page; each emitter opens with an `@az` header naming what it renders
  and how to edit it.
- **`AZ.md`** in every generated project maps routes and blocks to files.
- **Tokens:** on the median of the repository's 34 sites, the same site
  takes 1.5× the `.az` file's tokens as a component-tree JSON and 9.0× as
  pre-rendered HTML ([token benchmark](docs/token-benchmark.md), `pnpm bench:tokens`).
