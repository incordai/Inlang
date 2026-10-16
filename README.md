# az

**Describe a website in short words; az compiles them into a pre-rendered,
locked-down site — and the words are designed so an AI assistant can write
them for you.**

az is for developers, small studios and agencies shipping client sites, and
founders building their own product site — very often with an AI assistant
doing the typing. When an assistant writes a site's code directly, every run
comes out different and nothing checks the result. az gives the assistant a
small vocabulary instead (`hero center`, `faq list`, `pricing cards`), checks
every line of it, and compiles it into tested production code. The compiler
itself has no AI in it and never calls the network.

## What you get

- **Pre-rendered static pages** with a strict Content-Security-Policy on every page.
- **Colour first:** 6 themes, each light and dark, with 9 accent hues and gradient pairs proven for contrast.
- **12 building blocks ("words"):** nav, hero, text, feature, gallery, pricing, faq, cta, footer, auth, scene (3D), chat.
- **An optional backend:** accounts, social sign-in, data tables on SQLite, PostgreSQL or MySQL, and an admin area.
- **An optional AI chat block** that answers with your own components, charts and tables, with share links and operator data tools.
- **Images resized at build** into WebP widths, each `<img>` with its width and height.
- **Checks built in:** `az check` for the file, `az doctor` for the machine, `az audit` for what a build ships.
- **Deterministic builds:** the same file gives byte-identical output, every time.

## A 60-second example

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

That is [`fixtures/minimal.az`](fixtures/minimal.az). It builds a two-page
site (`/` and `/work`) in the dark `midnight` theme with a violet accent and a
soft glow behind the opening section. Both pages share a navigation bar with
a "Work" link. The home page opens with a centred headline, a small label
above it and a line of text below. Every page comes out as plain HTML with
its security policy, ready to put on any static host. `az explain <term>`
says what any word means in one line, for example `az explain hero center`.

## Quick start

**Install.** You need Node 22.18 or later and pnpm (corepack provides it).

```sh
git clone https://github.com/incordai/inlang.git && cd inlang
corepack enable pnpm
pnpm install --frozen-lockfile --ignore-scripts
alias az="node $(pwd)/packages/cli/bin/az.js"
az --help
```

Always install with `--ignore-scripts`: nothing here needs install scripts,
and they are a common way for a dependency to attack a machine.

**1. Choose the colour.** Colour is the first decision, before any section.

```sh
az palette            # writes a gallery page of every theme, hue, pair and pattern
az palette --list     # the same choices in the terminal
```

**2. Write the file.** Save the example above as `site.az`, then change the
words. [docs/WORDS.md](docs/WORDS.md) lists every word and its options.

**3. Preview it.**

```sh
az dev site.az        # serves http://127.0.0.1:5173/ and reloads on every save
```

**4. Check and build.**

```sh
az check site.az      # diagnostics only, writes nothing: "az: no problems found"
az build site.az      # writes the project to .az-build/
cd .az-build && npm install --ignore-scripts && npm run build   # the site, in .az-build/dist/
cd .. && az audit     # checks what the build ships: secrets, security policy, links
```

A mistake names the line, a stable code and the fix:

```
broken.az:4:15 error AZ1202  hero: 'center' and 'split' are both layouts — pick one
```

**5. Deploy.** `.az-build/dist/` is plain static files: upload them to any
static file host. A site with a backend also builds a `server/` folder to run
on Node 22; [docs/self-hosting.md](docs/self-hosting.md) walks through it.
There is no `az deploy` command yet.

The full walkthrough, with every option, is [docs/USAGE.md](docs/USAGE.md).

## How it works

You write one `.az` file. The az compiler reads it, checks every word against
the word list and the theme, and writes an ordinary React + Vite project. That
project's build pre-renders every page. If the file declares a backend, the
compiler also writes the server beside the site. You never edit the generated
code; you change the `.az` file and rebuild (or `az eject` a word to own it).

```
site.az ──> az compiler ──> .az-build/   React + Vite project ──> dist/  static site
            (checks,        └─ server/   optional backend (accounts, data, chat)
             no network)    └─ AZ.md     a map of the project for people and AI tools
```

## Using az with an AI assistant

- **`az prompt`** prints the instructions any AI model needs to write `.az`:
  the order (colour first), the syntax, every word and its options, and the
  common errors with their fixes. It is generated from the compiler's own
  tables, and every example in it compiles. Paste it into the assistant's
  instructions; `--compact` gives a short version.
- **`az mcp`** serves the compiler to an assistant as tools (MCP over stdio):
  look up words, check a file, build it. Setup: [docs/mcp.md](docs/mcp.md).
- **`AZ.md`**, written into every generated project, maps each page and
  block to its file and says where to change things.
- **[docs/WORDS.md](docs/WORDS.md)** lists every word, variant and key.
- **Fewer tokens:** on the median of the repository's sites, the same site
  takes about 1.5× the `.az` file's tokens as a component-tree JSON and
  about 9× as pre-rendered HTML ([token benchmark](docs/token-benchmark.md)).

More detail: [docs/USAGE.md §6](docs/USAGE.md#6-using-az-with-an-ai-assistant).

## Feature guides

| Topic | Guide | Reference |
|---|---|---|
| Words (building blocks) | [WORDS.md](docs/WORDS.md) | [GRAMMAR](docs/GRAMMAR.md), one `docs/<word>-block-spec.md` per word |
| Themes and colour | [USAGE §3](docs/USAGE.md#3-colour) | [theme-spec](docs/theme-spec.md) |
| Backend and data | [USAGE §4](docs/USAGE.md#4-the-optional-backend), [self-hosting](docs/self-hosting.md), [managed cloud setup](docs/cloud-setup.md) | [backend-spec](docs/backend-spec.md), [data-spec](docs/data-spec.md) |
| Sign-in | [USAGE §4](docs/USAGE.md#4-the-optional-backend) | [auth-block-spec](docs/auth-block-spec.md) |
| AI chat | [chat README](packages/words/chat/README.md) | [chat-block-spec](docs/chat-block-spec.md) (§19: what is built) |
| Images | [gallery-block-spec §7](docs/gallery-block-spec.md) | [hero-block-spec](docs/hero-block-spec.md) |
| Security | [USAGE §5](docs/USAGE.md#5-security-model) | [security scanning](docs/security-scanning.md), [word-quality-gate](docs/word-quality-gate.md) |
| Testing | [VERIFICATION §1.1](docs/VERIFICATION.md#11-every-suite-what-it-checks-and-what-it-needs) | [VERIFICATION](docs/VERIFICATION.md) |
| AI assistants | [USAGE §6](docs/USAGE.md#6-using-az-with-an-ai-assistant) | [mcp](docs/mcp.md), [token benchmark](docs/token-benchmark.md) |
| Every other doc | [USAGE §7](docs/USAGE.md#7-all-the-docs) | [ARCHITECTURE](docs/ARCHITECTURE.md), [PRD](docs/PRD.md) |

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

## Words

A word is a block on the page. Each lives in `packages/words/<word>/` with
its manifest (`word.json`), web emitter, README and previews. The table below
is generated from each `word.json` by `node scripts/gen-words-index.mjs`,
which also writes the full index, [docs/WORDS.md](docs/WORDS.md); `pnpm test`
fails if either is stale.

<!-- words-catalogue:start (generated by scripts/gen-words-index.mjs — do not edit) -->
| Word | Info | Variants | Docs |
|---|---|---|---|
| `auth` | Sign-in, sign-up or password-reset form on its own page | `login` `signup` `reset` | [README](packages/words/auth/README.md) |
| `chat` | A panel or a launcher where visitors ask the site's AI | `panel` `float` `none` | [README](packages/words/chat/README.md) |
| `cta` | Closing call-to-action section before the footer | `band` `card` `split` | [README](packages/words/cta/README.md) |
| `faq` | Questions with expandable answers, plus FAQ schema | `list` `columns` | [README](packages/words/faq/README.md) |
| `feature` | Set of features or benefits | `grid` `rows` `bento` | [README](packages/words/feature/README.md) |
| `footer` | Site footer: links, legal row and copyright | `minimal` `columns` `mega` `none` | [README](packages/words/footer/README.md) |
| `gallery` | Set of images in a chosen layout | `grid` `masonry` `carousel` `orbit` | [README](packages/words/gallery/README.md) |
| `hero` | Page opener: the page's only h1, text and actions | `center` `split` `full` `stack` `minimal` | [README](packages/words/hero/README.md) |
| `nav` | Site navigation bar with links, groups and a CTA | `bar` `center` `split` `minimal` `side` `mega` `none` | [README](packages/words/nav/README.md) |
| `pricing` | Plans and prices with a monthly/annual toggle | `cards` `table` | [README](packages/words/pricing/README.md) |
| `scene` | Standalone 3D scene with a poster fallback | `inline` `full` `backdrop` `none` | [README](packages/words/scene/README.md) |
| `text` | Section of written copy from a string or .md file | `prose` `centered` `columns` | [README](packages/words/text/README.md) |
<!-- words-catalogue:end -->

## Project status

- **Built:** the compiler and web target, all 12 words, the six themes, the
  backend with accounts, sign-in adapters and data tables, and the chat
  block through its operator data tools (C6). Details: [ROADMAP](docs/ROADMAP.md#current-status).
- **Still open:** chat's interactive controls and maps (C7, C8); a sign-in
  test against a real provider; 3D measurements on a genuinely slow device.
- **Not started:** M5, the first real site shipped with az. The grammar is
  frozen only after it, so the file format can still change.
- **Not built yet:** `az deploy`, an editor language server, a playground.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md): setup, which checks to run for each
kind of change, the house rules, and where things live in the repository.
Before any change, `pnpm verify` must pass.

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).
Report security problems privately, as [SECURITY.md](SECURITY.md) describes —
never in a public issue.

**License:** [Apache License 2.0](LICENSE). See also [NOTICE](NOTICE).
