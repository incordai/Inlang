# Token benchmark — how many tokens describe one site

**Status** measured · **Run** `pnpm bench:tokens` · **Code**
`scripts/token-benchmark.mjs`, `scripts/lib/token-bench.mjs`, tested by
`scripts/lib/token-bench.test.mjs`

An AI that builds a site with az writes a `.az` file. This measures how many
tokens that file is, against the same site written in other ways an AI could
write it: as JSON data, as a component tree, as HTML. Every number below was
produced by the script on this repository; nothing is estimated by hand.

**Result, in one line:** over all 34 sites, the median site takes
**1.50×** the `.az` source's tokens as a minimal component tree, **2.71×**
as minified Spec JSON, and **9.0×** as its pre-rendered body HTML. The
`.az` source is the smallest representation of every site. The worst case
(the site where `.az` saves least) is `text.columns`, a page that is mostly
prose: there the tree takes 1.12× and the HTML 1.55×.

## 1. Corpus

Every `.az` source in the repository that compiles, plus two full sites
written for this benchmark. All 34 are reported; none is left out.

| Group | Sites | Source |
|---|---|---|
| fixture | `minimal` | `fixtures/minimal.az` |
| fixture | `grammar-fixture` | `packages/core/test/fixture-site.az` (GRAMMAR §8), with its `fixture-assets/` |
| preview | 28 sites, one per word preview and variant preview (`auth`, `auth.signup`, `chat`, … `text.columns`) | `packages/words/<word>/preview*.az`, with the word's `preview-assets/` |
| site | `combined` | the `COMBINED` source in `scripts/lighthouse.mjs`: nav, 3D hero, feature, gallery, pricing and cta on one page |
| site | `data-e2e` | the `SITE` source in `scripts/data-e2e.mjs`: auth, a backend, six data tables and eleven pages |
| site | `ledger` | `scripts/token-benchmark/ledger.az`: a product site, six pages (nav, hero, feature, text, cta, pricing, two faqs, footer) |
| site | `harbour` | `scripts/token-benchmark/harbour.az`: a restaurant site, five pages |

The word previews are single-section pages, so the two added sites are full
multi-section, multi-page sites of the kind a real client would ask for.
`combined` and `data-e2e` are read out of their scripts as text, so the
benchmark measures exactly the sources those checks build.
`fixtures/broken.az` is not in the corpus: it is the deliberately broken
file the error tests use, and has no Spec.

## 2. Representations

Each site is compiled once, by the real CLI (`specOf` and `build` from
`packages/cli/src/az.ts`, the bundled words, `az build` into a temporary
directory, responsive images included). Every representation is derived
from that compile, so all of them describe the same site.

### 2.1 `.az` — the source

The file as written, without its full-line `#` comments (an author need not
write them). Trailing comments stay in; only the GRAMMAR fixture has one.

### 2.2 `specMin` — the Spec, minified

`JSON.stringify` of the Spec `az spec` prints. The Spec is the compiler's
complete description of the site, with every default resolved
(`"height": "peek"`, `"patternOrigin": "top"`), so it ADDS what the source
leaves implicit. It is the cost of writing az's own intermediate form by hand.

### 2.3 `specPretty` — the Spec as `az spec` prints it

Byte for byte the `az spec` output (sorted keys, two-space indent). The unit
test checks that it is identical to running `az spec` on the same file.

### 2.4 `tree` — a component tree

A typical "UI as JSON" shape, `{type, props, children}`, made from the Spec by
a fixed mapping (`componentTree` in `scripts/lib/token-bench.mjs`):

- the site is `{type: "Site"}`; its site-level blocks (nav, footer), then its
  pages, are its children;
- a page is `{type: "Page", props: {route}}`; its blocks are its children;
- a block is `{type: <word>}`, with `variant`, each modifier as
  `<name>: true`, its positional values as `args` (`link "Work" /work` is
  `args: ["Work", "/work"]`), `as`, and its props, keys exactly as the Spec
  names them;
- **what the source did not need to write is left out**, as a component
  library applies its own defaults: a prop equal to its word's declared
  default, a variant that is the word's first, a site setting equal to the
  Spec's site default, and a site-scoped value repeated on a page block;
- every null, empty string, empty list and empty object is left out.

This is the strongest competitor: it says what the `.az` file says and no
more, with nothing renamed or abbreviated. It OMITS each positional value's
kind (string, route, path), which the Spec carries and the `.az` syntax
spells by quoting; that makes the tree slightly smaller than a lossless one.
The tree of `minimal`, in full:

```json
{"type":"Site","props":{"accent":"violet","name":"aurora","pattern":"glow"},"children":[{"type":"nav","children":[{"type":"link","props":{"args":["Work","/work"]}}]},{"type":"Page","props":{"route":"/"},"children":[{"type":"hero","props":{"eyebrow":"Limited run","sub":"Handmade. Forty pairs a month.","title":"Built in the dark"}}]},{"type":"Page","props":{"route":"/work"}}]}
```

### 2.5 `html` — the pre-rendered body markup

What an AI writing raw markup would have to produce: the inside of
`<div id="root">` on every page, all pages concatenated. No `<head>`, no
CSS, no JavaScript. It is built from the page nodes in the generated
`src/App.tsx`, wrapped the way the runtime wraps them, and serialised as
React's server renderer writes them (`prerendered` in the script: boolean
attributes as `name=""`, void elements as `/>`, script text unescaped,
`<!-- -->` between adjacent text nodes).

That serialisation was checked against real pre-rendered pages, on the
corpus as this document first measured it: 19 sites
built with the project's own build (`az-vite/build.mjs`, React's
`renderToString`, after `npm install`). For 17 — `minimal`, `ledger`,
`harbour`, `footer.mega`, `faq`, `auth`, `auth.signup`, `nav.mega`,
`gallery`, `gallery.carousel`, `pricing.table`, `text.columns`, `feature`,
`feature.rows`, `cta.split`, `hero.full`, `combined` — the token count is
identical, and the bytes are identical except for the attribute order React
uses on `<input>` and `<button>`, once React's own
`<link rel="preload" as="image">` hints are removed (React adds them; a
person writing markup would not). The two that differ, by design:

- `grammar-fixture` (5,094 here, 5,157 pre-rendered, at that first
  measurement): its two author
  components (`raw`, `slot after`) are left out here. Their markup is the
  author's own TSX, which no representation counts.
- `data-e2e` (10,701 here, 9,820 pre-rendered): `/private` is a protected
  page. The pre-render writes a "Checking that you are signed in…"
  placeholder there; this counts the page's content, which is what the
  source describes. Its `/notes` page is an author component, left out.

The markup carries the classes the build generated (`az-s-1p95fyx`) in place
of styles. A hand-written page would need its CSS too; that is not counted,
so this representation is smaller than real hand-written markup.

### 2.6 `htmlShared` — the markup, chrome once

The same markup with each distinct nav and footer written once for the site
instead of on every page — markup with an include for what pages repeat.
Without it, a site whose pages are mostly empty (`footer.mega`: ten pages,
nine of them only the shared footer) would count its footer ten times.

### 2.7 `appTsx` — the generated React

`src/App.tsx` as `az build` writes it: every page as data, plus the code
that renders it. It is shown for completeness. It is generated, not written,
and is not a fair stand-in for hand-written React; the medians in this
document's summary line leave it out.

### 2.8 Files the markup inlines

Two kinds of file are written INTO the markup by the build: a feature item's
`icon` SVG (inlined, sanitised) and a `text` body that is a markdown file.
The `.az`, Spec and tree only name them. So each such file's text is counted
once on top of `.az`, `specMin`, `specPretty` and `tree`, which makes those
larger, not smaller. It applies to `feature` (three icons), `combined`
(three icons) and `grammar-fixture` (one markdown body). Images, 3D models
and other binary files are named by every representation and counted by none.

## 3. Tokenizer

Tokens are counted with **gpt-tokenizer 4.0.0** (a devDependency; nothing at
runtime), with two openly published BPE vocabularies:

- **`o200k_base`** — every headline number in this document;
- **`cl100k_base`** — in the JSON output, as a cross-check (§4.3).

A model's own tokenizer may differ from both; these are proxies with
published vocabularies, so anyone can reproduce the counts.

Vetting (checked 2026-10-15):

| | |
|---|---|
| Version | 4.0.0, published 2026-08-16. The latest, 4.0.3, was published on 2026-10-15, hours before this was written; the repository's `minimumReleaseAge` (pnpm-workspace.yaml: a week) refuses it, so 4.0.0 is the latest version that policy allows. |
| License | MIT |
| Dependencies | none |
| Size | 27 MB unpacked (the vocabularies of several encodings); a devDependency only |
| Provenance | published from its CI by a trusted publisher (npm `_npmUser.trustedPublisher`) |
| Tested | in isolation first, then in the repository: `countTokens("hello world")` is 2 tokens, `[24912, 2375]`, in `o200k_base`; the whole corpus counts in about a second |
| Alternatives | js-tiktoken 1.0.21 (MIT, one dependency, 22 MB) would do the same; gpt-tokenizer was taken for having no dependencies and one ES module per encoding. A characters-per-token estimate alone needs no package, but is off by up to a third (§4.4). |

The package is named once, in `package.json`: its `imports` map
`#tokenizer/*` to the package's encodings, and the script imports
`#tokenizer/o200k_base`. Another tokenizer is a one-line change there.

## 4. Results

`pnpm bench:tokens`, 2026-10-15, regenerated after `fixtures/minimal.az` and
the GRAMMAR fixture declared the pages they link to (`minimal` is now 78
tokens over two pages, `grammar-fixture` 673 over eight) and the `chat`
preview joined the corpus. `o200k_base` tokens; the multiple is the
representation's tokens over the `.az` source's.

### 4.1 Every site

| site | pages | .az | spec min | spec pretty | tree | html | html shared | App.tsx |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| minimal | 2 | 78 | 202 (2.6×) | 354 (4.5×) | 107 (1.4×) | 1098 (14.1×) | 652 (8.4×) | 3891 (49.9×) |
| grammar-fixture | 8 | 673 | 1633 (2.4×) | 2781 (4.1×) | 932 (1.4×) | 10980 (16.3×) | 4099 (6.1×) | 25236 (37.5×) |
| auth | 3 | 65 | 185 (2.8×) | 331 (5.1×) | 112 (1.7×) | 663 (10.2×) | 663 (10.2×) | 2972 (45.7×) |
| auth.signup | 4 | 81 | 204 (2.5×) | 360 (4.4×) | 139 (1.7×) | 3414 (42.1×) | 3414 (42.1×) | 10892 (134.5×) |
| chat | 1 | 92 | 265 (2.9×) | 461 (5.0×) | 134 (1.5×) | 915 (9.9×) | 915 (9.9×) | 3609 (39.2×) |
| cta | 2 | 87 | 256 (2.9×) | 443 (5.1×) | 132 (1.5×) | 387 (4.4×) | 387 (4.4×) | 2342 (26.9×) |
| cta.split | 2 | 80 | 214 (2.7×) | 364 (4.5×) | 123 (1.5×) | 388 (4.8×) | 388 (4.8×) | 2374 (29.7×) |
| faq | 1 | 127 | 315 (2.5×) | 521 (4.1×) | 175 (1.4×) | 1140 (9.0×) | 1140 (9.0×) | 3702 (29.1×) |
| faq.columns | 1 | 127 | 315 (2.5×) | 521 (4.1×) | 179 (1.4×) | 1143 (9.0×) | 1143 (9.0×) | 3705 (29.2×) |
| feature | 3 | 462 | 723 (1.6×) | 1036 (2.2×) | 540 (1.2×) | 983 (2.1×) | 983 (2.1×) | 3541 (7.7×) |
| feature.rows | 1 | 149 | 330 (2.2×) | 545 (3.7×) | 197 (1.3×) | 574 (3.9×) | 574 (3.9×) | 2858 (19.2×) |
| footer | 4 | 83 | 302 (3.6×) | 545 (6.6×) | 152 (1.8×) | 1143 (13.8×) | 489 (5.9×) | 4108 (49.5×) |
| footer.columns | 6 | 123 | 482 (3.9×) | 877 (7.1×) | 244 (2.0×) | 2788 (22.7×) | 783 (6.4×) | 8085 (65.7×) |
| footer.mega | 10 | 189 | 767 (4.1×) | 1406 (7.4×) | 387 (2.0×) | 13104 (69.3×) | 1854 (9.8×) | 33205 (175.7×) |
| gallery | 1 | 123 | 303 (2.5×) | 512 (4.2×) | 157 (1.3×) | 400 (3.3×) | 400 (3.3×) | 2456 (20.0×) |
| gallery.carousel | 1 | 279 | 598 (2.1×) | 1002 (3.6×) | 354 (1.3×) | 2289 (8.2×) | 2289 (8.2×) | 6233 (22.3×) |
| gallery.orbit | 1 | 129 | 353 (2.7×) | 595 (4.6×) | 189 (1.5×) | 878 (6.8×) | 878 (6.8×) | 3381 (26.2×) |
| hero | 2 | 81 | 226 (2.8×) | 391 (4.8×) | 120 (1.5×) | 580 (7.2×) | 580 (7.2×) | 2718 (33.6×) |
| hero.full | 3 | 98 | 249 (2.5×) | 430 (4.4×) | 153 (1.6×) | 618 (6.3×) | 618 (6.3×) | 2624 (26.8×) |
| hero.split | 3 | 72 | 226 (3.1×) | 398 (5.5×) | 128 (1.8×) | 415 (5.8×) | 415 (5.8×) | 2360 (32.8×) |
| nav | 6 | 125 | 454 (3.6×) | 824 (6.6×) | 245 (2.0×) | 6242 (49.9×) | 1357 (10.9×) | 14755 (118.0×) |
| nav.bar | 4 | 127 | 368 (2.9×) | 642 (5.1×) | 203 (1.6×) | 2988 (23.5×) | 1020 (8.0×) | 7723 (60.8×) |
| nav.full | 6 | 129 | 452 (3.5×) | 820 (6.4×) | 241 (1.9×) | 5942 (46.1×) | 1307 (10.1×) | 14233 (110.3×) |
| nav.mega | 6 | 114 | 476 (4.2×) | 866 (7.6×) | 238 (2.1×) | 6474 (56.8×) | 1399 (12.3×) | 15293 (134.1×) |
| nav.sheet | 6 | 129 | 452 (3.5×) | 820 (6.4×) | 241 (1.9×) | 6206 (48.1×) | 1351 (10.5×) | 14791 (114.7×) |
| pricing | 3 | 146 | 455 (3.1×) | 835 (5.7×) | 224 (1.5×) | 792 (5.4×) | 792 (5.4×) | 3220 (22.1×) |
| pricing.table | 3 | 146 | 455 (3.1×) | 835 (5.7×) | 228 (1.6×) | 1212 (8.3×) | 1212 (8.3×) | 4226 (28.9×) |
| scene | 1 | 82 | 177 (2.2×) | 292 (3.6×) | 100 (1.2×) | 359 (4.4×) | 359 (4.4×) | 2356 (28.7×) |
| text | 2 | 84 | 220 (2.6×) | 368 (4.4×) | 124 (1.5×) | 319 (3.8×) | 319 (3.8×) | 2210 (26.3×) |
| text.columns | 1 | 230 | 326 (1.4×) | 426 (1.9×) | 257 (1.1×) | 356 (1.5×) | 356 (1.5×) | 2192 (9.5×) |
| combined | 4 | 768 | 1542 (2.0×) | 2508 (3.3×) | 950 (1.2×) | 4811 (6.3×) | 2783 (3.6×) | 11416 (14.9×) |
| data-e2e | 11 | 579 | 1932 (3.3×) | 3476 (6.0×) | 1369 (2.4×) | 10701 (18.5×) | 10701 (18.5×) | 24783 (42.8×) |
| ledger | 6 | 948 | 2528 (2.7×) | 4442 (4.7×) | 1321 (1.4×) | 10844 (11.4×) | 5744 (6.1×) | 24638 (26.0×) |
| harbour | 5 | 694 | 1671 (2.4×) | 2838 (4.1×) | 938 (1.4×) | 7587 (10.9×) | 4499 (6.5×) | 16910 (24.4×) |

### 4.2 Median, worst and best (34 sites, `o200k_base`)

"Worst" is the smallest multiple: the site where `.az` saves least.

| vs `.az` | median | worst | best |
|---|---:|---|---|
| tree | 1.50× | 1.12× (`text.columns`) | 2.36× (`data-e2e`) |
| spec min | 2.71× | 1.42× (`text.columns`) | 4.18× (`nav.mega`) |
| spec pretty | 4.65× | 1.85× (`text.columns`) | 7.60× (`nav.mega`) |
| html shared | 6.64× | 1.55× (`text.columns`) | 42.15× (`auth.signup`) |
| html | 8.99× | 1.55× (`text.columns`) | 69.33× (`footer.mega`) |
| App.tsx | 29.42× | 7.66× (`feature`) | 175.69× (`footer.mega`) |

On the five full sites alone (`grammar-fixture`, `combined`, `data-e2e`,
`ledger`, `harbour`) the medians are: tree 1.38×, spec min 2.43×, spec
pretty 4.13×, html shared 6.09×, html 11.44×.

Corpus totals:

| | tokens | characters | characters per token |
|---|---:|---:|---:|
| .az | 7,499 | 27,352 | 3.65 |
| spec min | 19,656 | 72,458 | 3.69 |
| spec pretty | 33,865 | 161,123 | 4.76 |
| tree | 11,333 | 42,228 | 3.73 |
| html | 108,733 | 325,262 | 2.99 |
| html shared | 55,863 | 176,768 | 3.16 |
| App.tsx | 289,038 | 1,523,142 | 5.27 |

### 4.3 The second vocabulary

With `cl100k_base` the medians move by 8.1% or less: tree 1.40×,
spec min 2.49×, spec pretty 4.51×, html shared 6.48×, html 8.84×, App.tsx
28.80×; the worst case is the same site for every representation. `.az` is
the smallest on every site under both.

### 4.4 Characters per token, and why the estimate is not enough

The script also writes `approxTokens`, characters ÷ 4, the common rule of
thumb. Over the corpus it is 0.91× the counted tokens for `.az`, 0.93× for
the tree, 0.75× for the HTML and 1.32× for App.tsx: markup packs fewer
characters into a token (3.0) than prose-like source (3.65), and
indentation-heavy files more (5.3). An estimate would understate HTML by a
quarter, so the counted tokens are the figures to use.

### 4.5 What the numbers say

- `.az` is the smallest representation of every site in the corpus, under
  both vocabularies. No site was found where it is not.
- The saving is in structure, not content. Against the closest competitor —
  a component tree that drops every default — the median is 1.5×; it falls
  to 1.1× on `text.columns`, a page that is mostly a long paragraph of prose,
  which costs the same in any format.
- Against what an AI would otherwise write to ship a page, raw markup, the
  median is 9× (6.6× with shared chrome written once), before any CSS.
- The structure a word expands to is where the gap is widest: a sign-up form
  (`auth.signup`, 42×), a mega menu (`nav.mega`, 12× with the nav written
  once), a mega footer.

## 5. Limits

- **A proxy tokenizer.** Two published vocabularies, not any particular
  model's; counts with another tokenizer will differ, the ratios less so
  (§4.3).
- **Tokens written, not cost.** This counts the tokens of the finished
  file. It does not count the instructions, retries or reading an AI needs
  to produce it, nor how often it gets each format right first time.
- **The tree is one mapping.** A different "UI as JSON" schema with shorter
  keys or positional props would be smaller; one with explicit defaults,
  larger. The mapping is in code and tested, so it can be argued with.
- **HTML without CSS.** The markup carries generated class names in place
  of the styles; real hand-written markup also needs a stylesheet, which is
  not counted. Responsive image `srcset` lists are counted (they are what
  the build ships).
- **Author code is out.** `raw` and `slot` components, and the data lock
  file `az backend schema` writes (derived from the source), are counted by
  no representation.
- **Previews dominate the median.** 28 of the 34 sites are single-word
  previews; §4.2 gives the five full sites separately.
- **Two sites were written for this.** `ledger` and `harbour` are realistic
  but are this benchmark's own; their results sit inside the range of the
  repository's own full sites.

## 6. Reproduce

```sh
pnpm install --frozen-lockfile
pnpm bench:tokens                       # every site; JSON to <tmp>/az-token-benchmark.json
pnpm bench:tokens ledger harbour        # named sites only
pnpm bench:tokens --json out.json       # the JSON somewhere else
```

No network and no browser: each site is compiled and built with `az build`
into a temporary directory that is removed afterwards. A run takes about
two seconds. The output is deterministic: two runs write byte-identical
JSON (the unit test checks this on two sites). The JSON holds every site's
characters, tokens per vocabulary and the estimate for every
representation, and the summaries for both vocabularies.
