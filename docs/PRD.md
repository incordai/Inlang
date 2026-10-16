# AZ Web — Product Requirements Document

**Version** 0.2 (draft) · **Status** pre-build · **Owner** you

---

## 1. One-liner

A free, offline compiler that turns short words into a production-grade 3D
website — deterministic, no AI in the build path, same source ships as a
desktop and mobile app via Tauri.

## 2. The problem

Building a high-end 3D marketing site is ~90% ceremony and ~10% taste.

The ceremony — scene setup, camera, resize handling, animation loop, lights,
scroll-linked motion, reduced-motion fallback, mobile degradation, asset
preloading, SEO, theme consistency — is nearly identical on every project and
takes 2–4 weeks to get right. Most people either skip it (site looks cheap) or
pay an agency €15k+.

The taste — the model, the palette, the copy — is the part that should get the
human's attention, and it's the part that gets rushed.

**AZ Web makes the ceremony free so all the time goes to the taste.**

## 3. Why not just use AI (v0, Lovable, Bolt)

These are real competitors and they cover infinitely more cases. We do not
compete on coverage. We compete on four axes they structurally cannot match:

| | AZ Web | AI generators |
|---|---|---|
| Cost per build | €0, unlimited | metered per generation |
| Speed | <1s, watch-mode viable | 20–40s |
| Determinism | same words → same code, forever | different every run |
| Offline / air-gapped | works | impossible |

Determinism is the headline. It makes output **diffable, reviewable, and
consistent across twenty client projects**. That is a real gap.

**Consequence we accept:** if a word doesn't exist, the user gets an error
where an AI would produce *something*. We will never win on coverage. The
strategy is "the 20 things people actually build, done correctly every time."

## 4. Target user — pick one

> **Decision: Primary user is the solo dev / small studio shipping client
> sites. Secondary is the indie hacker shipping their own product site.**

This matters because it sets every other decision. A studio building 20 similar
sites gets compounding value from determinism and reuse. A one-time user does
not, and would be better served by v0.

**Explicitly not the target in Phase 1:** non-technical users. They need a GUI,
and building one triples scope.

## 5. Non-negotiable principles

1. **The compiler never calls a network.** No AI, no telemetry, no API keys.
2. **Words are the only input.** Any AI layer sits *outside* and emits words a
   human reads and edits before compiling.
3. **The theme is global and resolved once.** No word may hardcode a color,
   font, radius, or spacing value. Enforced by lint, not by asking nicely.
4. **Every word has an escape hatch.** Design is taste; the user will always
   want to nudge. If they can't override, they edit generated files, we
   overwrite them, and they leave.
5. **A word is a folder, not a core edit.** If adding a word requires touching
   compiler internals, nobody will ever contribute one.
6. **A word describes intent, not implementation.** `hero` means *"the opening
   statement of this page"* — not *"a 3D scene."* Web renders that as
   scroll-linked 3D; mobile renders it as full-bleed image + spring transition.
   Same word, same file, two right answers. This is what makes multi-target
   possible, and it must hold from word #1.
7. **The file describes the site. The CLI does things to it.** No actions,
   conditionals, or variables in `.az` — ever. Every future feature request
   will want to violate this. Holding it is most of what keeps the language
   small.

### Stability policy

Every file starts with a version marker:

```
az 1
site aurora
```

Costs nothing now; enables `az migrate` later instead of breaking users.

**Until M5 (first real site shipped), nothing is frozen — break the grammar
aggressively while it's free. At M5, the grammar freezes.** Changes to the file
format or the word contract invalidate every file and every contributed word;
everything else (names, themes, new words, CLI flags) stays cheap forever.

---

## 6. Phase 1 scope

**Goal:** one person can build a genuinely beautiful, fast, 3D-motion marketing
site with auth, in under a day, writing only words.

### 6.1 Syntax

Indentation means nesting. That's the only structural rule.

```
az 1
site aurora
  theme midnight
  font
    display serif
    body    sans
  nav split sticky glass        # declared once, every page inherits it
    link "Work"    /work
    link "Studio"  /studio
    cta  "Reserve" /reserve
  footer columns

page /
  hero 3d scroll
    model  ./assets/shoe.glb
    title  "Built in the dark"
    sub    "Handmade, 40 pairs a month."
  feature grid
    columns 3
  gallery orbit
  cta band

page /login
  nav none                      # this page opts out of the inherited nav
  auth login
```

- **Blocks** are nouns: `hero`, `gallery`, `footer`. They render something.
- **Variants** pick the block's shape and are **mutually exclusive**: `split`
  for `nav`, `orbit` for `gallery`, `login` for `auth`. Two variants on one
  block is a compile error, never a silent pick.
- **Modifiers** are adjectives that **combine freely**: `3d`, `scroll`,
  `glass`, `sticky`.
- **Properties** are indented `key value` pairs: `columns 3`.

**Scope is indentation, same as everything else.** A block nested under `site`
is site-wide and every page inherits it. The same block inside a `page`
**replaces** it for that page — not merges with it — so the nav link list lives
in exactly one place and cannot drift (nav spec §8, GRAMMAR §5.2). `none`
opts a page out entirely. There is no separate scoping syntax; the one
structural rule already says it.

This grammar is why we escape the "too many functions" problem you hit on the
backend. 11 blocks, each carrying its own small set of variants and modifiers,
cover far more ground than 11 words suggests — and the combinations are
declared per block in its manifest, so the compiler knows every legal one.

### 6.1a The frame and the theme — properties, not words

Establishing the page frame and the palette comes BEFORE any section is
written. That is a design order, not a vocabulary: **neither adds a word.**
Both attach to structure keywords that already exist, using the `key value`
property form the grammar already has.

```
az 1
site aurora
  width  wide                    # the frame
  theme  midnight
    accent  violet               # which shade ramp
    pattern glow top             # background shape + origin
  font
    display serif
    body    sans
  nav split sticky
    link "Work" /work

page /
  hero full 3d scroll            # `full` IS the full-bleed hero variant
  feature grid
```

**`site width`** — `full` · `wide` · `default` · `narrow` · `reading`. The
shell every section aligns to. Sections never declare a width of their own;
they state a fraction of the shell or a text measure. A section that invents a
px value is the defect this property exists to prevent.

*Built (2026-09-23).* The default is `default`; any other value is refused
(AZ1414). Each frame is a theme token, so it follows the theme: `full` — no
frame, the gutters only · `wide` — `size.container` plus both desktop gutters ·
`default` — `size.container` · `narrow` — `breakpoint.md` · `reading` —
`size.measure-body`. Every section insets its content to the frame at desktop
widths (`max(gutter, (100% − frame) / 2)`, emit-contract `framed`), so
backgrounds stay full-bleed while content aligns; below `breakpoint.sm` the
mobile gutter applies. (The compiler previously defaulted to `center`, which
is not one of these values and rendered nothing; the code now follows this
section.)

**`site description` / `page description`, `site icon`** — what a page tells
a search engine and a browser tab beyond its title (GRAMMAR §4.4).
`description "…"` is copy: at site level every page's, on a page that page's
own; neither written, a page describes itself with its lead copy.
`icon ./icon.svg` is a file the author supplies, PNG or SVG.

*Built (2026-10-07), before the M5 grammar freeze, from the pre-M5
Lighthouse audit (ASSUMPTIONS A6): pages with no lead copy had no
description to give, and no site could name its icon.* The page's
description wins, then the site's, then the derived one; it is escaped into
`<meta name="description">` (no Open Graph tags exist, so none are added).
An empty description is AZ1420; past 160 characters it warns (AZ1409) and
ships as written. The icon goes through the asset sandbox (AZ1210 outside
the project; a URL is AZ1402 — the icon ships with the site), its name ends
`.svg` or `.png` (AZ1410), and its first bytes must be that format (AZ1421):
the format is read, never taken from the name. Every page declares it as
`<link rel="icon" type="…">`; without `icon` every page declares an empty
one, so no `/favicon.ico` is requested.

*Built (2026-10-07): the home-screen touch icon.* A square PNG icon of
180×180 or more also gives every page a `<link rel="apple-touch-icon">`:
exactly 180 is the icon itself; larger is resized to a 180×180 PNG by the
build's resizer (its child process, the same pinned image library, a PNG
output with pinned deterministic options and no metadata, content-hash
named and cached beside the WebP variants). An SVG is never rasterised at
build — that would put an XML parser with entities and external
references on author bytes, outside the upload pipeline's raster-only
decoder allow-list — so an SVG icon, a PNG under 180px or a non-square
one gives no touch icon and warns (AZ1422); nothing is upscaled. Without
a resizer the pages are as before (GRAMMAR §4.4).

*Built (2026-10-07): a Content-Security-Policy on every page* (word-quality-gate
§2 B, §5.5). The build writes it as a `<meta http-equiv>` straight after the
charset, made per page once the page is pre-rendered: `default-src 'self'`,
`script-src 'self'` plus the hash of any inline script, `style-src 'self'`
plus `'unsafe-hashes'` and the hash of each `style` attribute the page
carries (only an author component writes one), `img-src 'self'` (and
`data:` for the empty icon), `connect-src 'self'` plus the auth adapter's or
the backend's origin from the build's public settings, `object-src 'none'`,
`base-uri 'self'`, `form-action 'self'`. A page showing a 3D model adds
`'wasm-unsafe-eval'` and a `blob:` worker for its decoder, and `blob:` in
`connect-src` for its embedded textures — not in `img-src`, which a
textured model drawn in three engines proved it does not need. Never
`'unsafe-inline'` or `'unsafe-eval'`. `frame-ancestors` cannot be sent in a
meta: the host must send it as a header (the built-in backend already sends
`frame-ancestors 'none'` on every response it serves; it serves no pages).

**`theme accent`** — selects the hue whose ramp the theme draws from. Steps are
addressed as tokens (`color.accent-700`), and every step states its contrast
against both schemes (theme-spec §6). A step that fails the floor is not
offered, so a palette choice cannot silently break legibility.

**`theme pattern`** — one of `none` `glow` `spotlight` `ramp` `grid` `hatch`
`dots`, with an optional origin. The *shape* is the option; the *colour* comes
from the theme. Patterns that name their own colours cannot be themed, which is
why this is a shape vocabulary rather than a list of gradients.

*Built (2026-10-05).* `accent` takes one of nine hues (`violet` `indigo`
`blue` `teal` `green` `lime` `amber` `orange` `rose`); their OKLCH ramps are
generated into `packages/theme/src/ramps.ts` by `scripts/gen-ramps.mjs`. The
compiler picks, per theme and scheme, the first step that holds the
theme-spec §6 floors and writes it to `color.accent`, `color.accent-hover` and
`color.accent-contrast` in both schemes; the focus ring stays the theme's own.
All 108 theme × hue × scheme choices hold (`packages/theme/test/contrast.test.ts`,
2520 pairs); a hue that could not is a build error, never a low-contrast ship.
Without `accent` the theme keeps its own. The steps are **not** exposed as
`color.accent-700`-style tokens — words read the three accent tokens only.
`pattern` is drawn from the accent token (`color-mix`, no colour of its own),
declared once in `theme.css` and painted on the hero (not under `full`'s
scrim). Its peak strength is capped at 10% accent over the ground: the largest
that holds every reading pair is 12%, and the spike's 55% glow fails
(`packages/theme/test/pattern.test.ts`). Without `pattern` there is none.
`theme` names one of six themes — `midnight` `paper` `signal` `clay`
`petal` `volt` (theme-spec §5). Unknown theme AZ1417, setting AZ1405, hue
AZ1418, shape or origin AZ1419.

*Built (2026-10-10): accent pairs — colour combinations without a palette
generator.* `accent <hue> [<hue2>]`: a second hue from the same closed set
makes a gradient pair (theme-spec §13). Not every pair is allowed. A pair is
offered only when its hues sit 30°–120° apart in OKLCH, its gradient keeps
0.8 of its chroma at the weakest point (no grey middle), and every sampled
point — of the OKLCH gradient, its `color-mix` stop-list fallback and its
plain sRGB fallback, rest and hover, in both schemes — holds the theme-spec §6
floors, with one label (`color.on-gradient`) at 4.5:1 against all of it. The
allowed pairs are a generated table per theme (`scripts/gen-pairs.mjs` →
`packages/core/src/accent-pairs.ts`; 16 pairs on midnight, paper, clay and
petal, 15 on signal and volt); any other pair is AZ1423, naming the partners that work, and
`az explain theme accent` lists them. With a pair, the primary action, the
pricing highlighted plan's edge and the `glow`/`spotlight`/`ramp` patterns
paint the gradient (`gradient.accent`, from `theme.css`, never inline); with
one hue every emitted file is byte-identical to before. This keeps §7.3's
rule: the set is closed, named and proven, so nothing is generated from an
author's colour. A headline highlight is not built — the grammar has no
emphasis form inside a title.

**Why the hero needs nothing new.** Site width and hero width are independent —
a narrow site with a full-bleed hero is a normal pairing — but `hero` already
carries that axis in its variants: `full` is full-bleed, `center`/`split`/
`stack` sit within the shell (§6.2 table, hero-spec §2). The second axis was
already there.

**Every value that encodes a decision is a WORD.** This is the rule the whole
language rests on, and it applies to property values as hard as it applies to
block names:

| Kind of value | Form | Why |
|---|---|---|
| A design decision | **word** — `width wide`, `height peek`, `accent violet`, `pattern glow` | the word carries the reasoning; a number hides it |
| Content the author owns | literal — `title "…"`, `monthly 29`, `since 2019` | a price is a price; `monthly twentynine` helps nobody |
| A count of things | literal — `columns 3`, `perpage 12` | it counts items, it does not encode taste |
| A file the author supplies | path — `model ./shoe.glb` | |

The test is simple: **could a designer disagree with this value?** If yes it is
a decision and must be a word, so the compiler can explain it, warn about it,
and keep it on-theme. If no — it is content, and a literal is honest.

`hero height` failed that test and was fixed: `85` was a raw number encoding a
judgement §6 of the hero spec spends a paragraph defending. It is now
`compact` · `peek` · `tall` · `full`, and `full` earns a warning the number
could never have carried.

**The block cap is untouched.** Eleven blocks, five structure keywords. What
grows is the *properties* two of those keywords accept, which is the cheap
direction — a property needs a validation rule and a row in a table, not a
folder, a manifest, an emitter, a preview and a snapshot set.

### 6.2 Word list — Phase 1 (hard cap)

The vocabulary has three levels, and only one of them is capped. Getting this
distinction right is what makes the cap meaningful rather than arithmetic.

**Structure keywords (5)** — implemented in `core`, not word folders:
`site` `theme` `font` `page` `raw`

**Block words (12)** — one directory each under `words/` (CONVENTIONS §3).
**This is the capped number:**
`nav` `hero` `feature` `gallery` `pricing` `faq` `cta` `footer` `auth`
`scene` `text` — and `chat`, the one dated exception below

**Variants and modifiers** are **not** separate words. Each block declares its
own in `word.json` (ARCHITECTURE §4.1) — variants are mutually exclusive,
modifiers combine freely. A block with five variants is still one folder, one
review, one maintenance burden.

| Block | Variants — pick one | Modifiers — combine |
|---|---|---|
| `nav` | `bar` `center` `split` `minimal` `side` `mega` `none`† | `sticky` `hide` `shrink` `glass` `solid` |
| `hero` | `center` `split` `full` `stack` `minimal` | `3d` `scroll` `parallax` `glass` |
| `feature` | `grid` `rows` `bento` | `reveal` |
| `gallery` | `grid` `masonry` `carousel` `orbit` | `reveal` `lightbox` |
| `pricing` | `cards` `table` | `reveal` |
| `faq` | `list` `columns` | `reveal` |
| `cta` | `band` `card` `split` | `glass` `reveal` |
| `footer` | `minimal` `columns` `mega` `none`† | `glass` |
| `auth` | `login` `signup` `reset` | `glass` |
| `scene` | `backdrop`‡ `full` `inline` | `3d` `scroll` `parallax` |
| `text` | `prose` `centered` `columns` | `reveal` |
| `chat` | `panel` (`float` in a later phase) | — |

‡ `scene backdrop` is the one block that is a *layer*, not a section: a
fixed full-viewport 3D surface that the whole page scrolls over. It is
declarable at `site` level and inherited like `nav` and `footer`, so motion can
run across an entire site rather than being trapped in one section. See
`scene-block-spec.md` §6.

† `none` is the reserved variant that opts a single page out of an inherited
site-wide block (GRAMMAR §5.2). Legal on inheritable blocks only.

Each block's own spec is authoritative for its row; this table is the index.
The manifests are generated from the specs, and the graph, autocomplete, lint
and validation are generated from the manifests — one source, no second copy.

**Cap is deliberate: 11 blocks, not one more, until Milestone 5 (dogfood) is
done** — 12 since the dated `chat` exception below, and still not one more. Every word added before real usage is a guess, and a guessed word is
the expensive kind — you maintain it forever whether it was right or not.
Adding a *variant* to an existing block is not adding a word, but it is not
free either: it needs its own snapshots and its own row in the responsive
table. Log variant requests alongside word requests.

> **Decision, 2026-10-15 (owner): `chat` is the 12th block — the cap's one
> exception before M5.** The owner approved docs/chat-block-spec.md with all
> of its recommendations (§17 there, Q1): a visitor-facing block whose
> answers come from a model the operator picks in the server's `.env` —
> the `.az` file says only `model default` under `backend`. The cap is now
> **12 blocks**, with `chat` named as the only word admitted before M5; any
> other word still waits for M5 and goes to the ROADMAP backlog first. The
> three tests that held the count at eleven hold it at twelve.

### 6.3 Why 3D first — the strategic bet

3D is deliberately the hardest thing to generate, and that is the point. Four
reasons big models fail at it, none of which go away with scale:

1. **Version drift.** Three.js ships breaking changes constantly; training data
   is always stale, so models emit deprecated calls that fail silently. Our
   templates are pinned and tested. *This gap widens with every release.*
2. **No visual feedback loop.** A model can't see that the camera is inside the
   mesh or the light is behind the object. Text-correct, visually broken.
3. **Invisible failures.** Missing `dispose()` leaks memory until the tab dies.
   Unclamped DPR melts a retina GPU. Scroll-camera sync drifts on trackpad but
   not mouse wheel. None show up in a demo; all show up for the client.
4. **Degradation gets skipped.** Reduced-motion and low-end fallbacks are never
   prompted for, so they're never generated.

Each is "tune once, deliver forever" — exactly the shape a template wins at.
**If we can do 3D in words, everything easier is implied.**

### 6.4 Per-target rendering

> **Decision: mobile app target does NOT use 3D.** It uses native-feeling
> motion instead — shared-element transitions, spring physics, gesture sheets,
> haptics. Different vocabulary of impressiveness, same "expensive" outcome.

This removes what was the product's biggest technical risk (WebGL frame rate in
an Android WebView) and it makes the mobile output a *real app* rather than a
wrapped website — which is also what gets it past App Store guideline 4.2.

**Web target still needs tiers** for low-end desktop and accessibility. The
tier is **measured at runtime by the site itself, not guessed at build time**:

| Tier | Selected when | Behaviour |
|---|---|---|
| `full` | probe sustains the frame budget after settling | full scene, post-fx, scroll-linked camera |
| `lite` | probe misses the budget, or capability floor not met | reduced poly/DPR, no post-fx |
| `static` | `prefers-reduced-motion`, no WebGL2, Save-Data, or `lite` still misses | poster image, CSS-only reveals |

Device class was the old trigger and it was the wrong signal — "mobile
browser" spans a 20× performance range, and a €150 phone bought this year
beats a flagship from 2018. **The site measures its own frame interval, and
degrades itself.** Downgrades ratchet one way so the tier cannot oscillate.

This is what makes the 3D claim safe to make: the failure mode A1 guarded
against — a scroll-linked hero at 12fps on a real visitor's phone — cannot be
served, because the site notices and drops before it ships that frame. Full
mechanism, thresholds and hysteresis in `motion-tiers-spec.md`.

**Determinism is untouched.** The same words still emit byte-identical code;
the *emitted code* is what adapts on the visitor's device. Snapshots pin the
tier explicitly so visual tests stay deterministic.

**Mobile motion vocabulary:** designed in `mobile-motion-spec.md` (M2,
2026-10-06) — every motion word and modifier mapped to native motion, shared
tokens, reduced-motion, haptics and budgets. Design only; it is built with the
Phase 3 mobile emitters, and still roughly doubles design work per word.

### 6.5 Auth — honest treatment

> **Decision: Phase 1 generates auth *UI + client wiring* only. It does not
> implement auth.**

A static site cannot do auth alone. Rolling our own crypto for a *design tool*
is how projects get people breached. Instead `auth` compiles against an adapter:

```
auth hosted          # or: session | azbackend | custom
```

- `hosted` / `session` — the sane default: a managed provider or a
  self-hosted session library, both battle-tested, both with a free tier
- `azbackend` — the site owner's own backend, speaking the protocol in
  auth-block-spec §3.4. There is no separate backend project: the built-in
  backend below is the one that fulfils it, and any other server that meets
  §3.4 works too.

The word generates: login/signup/reset forms styled from the theme, session
hook, protected-route wrapper, and error states. The security lives in the
adapter.

> **Decision revised (2026-09-23, owner): an OPTIONAL built-in backend.** For
> SaaS sites, `az` can now generate the server as well — a `backend`
> declaration (site-level, choices only: `database sqlite|postgres|mysql`,
> `email smtp|api`) emits a Node server into `server/` that implements
> §3.4: accounts, sessions, sign-up with a retyped password, password reset
> and sign-in links by email, and provider sign-in (generic OpenID Connect
> and OAuth 2). The concern above still stands, so the rule becomes: **no
> hand-rolled crypto primitives.** Hashing, randomness and signature checks
> are Node's own `crypto` (scrypt, HMAC, `crypto.verify`); every security
> property has a failing test (backend-spec §5). It is opt-in: a site
> without `backend` builds exactly as before, and `hosted` / `session` /
> `custom` remain the choices for anyone who would rather not run one.
> backend-spec.md is the specification.

### 6.6 Escape hatch

Two mechanisms, both designed before word #1:

```
  raw ./custom/Badge.tsx          # drop in your own component anywhere
  hero 3d
    slot after ./custom/Ticker.tsx  # inject into a named slot of a block
```

Plus: **eject**. `az eject hero` copies that block's source into your project
and stops managing it. One-way, loud, documented. Users need to know they're
never trapped.

### 6.7 Dependencies and CLI

**Auto-install.** The user must never hunt for packages. Each word declares
what it needs; the compiler unions the set across the whole file and installs
**once** — not once per word (4 seconds vs 40).

```json
{
  "word": "hero",
  "modifiers": {
    "3d": { "deps": ["three@0.170.0", "@react-three/fiber@8.17.10"] }
  }
}
```

**Versions are pinned exactly. Never `^`, never `latest`.** A pinned, tested
three.js is the entire reason our output works and a model's doesn't.

**The network boundary — state it precisely or the offline promise dies:**

> Installing dependencies is **setup**. Compiling words to code is the
> **build**. Setup may touch the network once. Build never does.

Once `node_modules` exists, `az build` works offline forever. Cache packages in
a shared location so three.js isn't re-downloaded per project, and always print
what's being installed — silent network activity in a tool that promises
offline is how trust dies.

**CLI.** Actions live here, never in the `.az` file (principle 7):

```bash
az dev          # compile, serve, watch, hot-reload, open browser
az build        # compile to dist/
az add 3d       # pre-install deps (az build auto-runs this if needed)
az lint         # theme-token enforcement
az eject hero   # take ownership of one block's source
az migrate      # upgrade .az files across grammar versions
az mcp          # the same operations as tools for an AI agent (MCP, stdio)
az explain      # one ≤60-char line per term: az explain hero center
az doctor       # check this machine and project; changes nothing
az audit        # check a build's output; changes nothing
```

`az dev` with sub-second recompile is the single best demo we have — it is the
thing AI generators structurally cannot do. ~1 day of work on top of Vite.

*Natural phrasing* (`az "show me the website"` → `az dev`) is a thin CLI alias
layer, and is exactly where the Phase 4 suggestion model belongs. It must never
become a word in the file.

### 6.8 Non-goals for Phase 1

Explicitly out — say no now, or the phase never ships:

- CMS / content editing · e-commerce & checkout · blog engine
- multi-language i18n · analytics dashboards · a GUI or visual editor
- the AI front-end (Phase 4) · Go/Rust backend targets
- **anything mobile-app-specific** (Phase 3)

*Decision, 2026-10-05 (owner):* **data tables are in.** `data <table>` under
`site` generates database tables, a REST API, a typed client and a protected
admin area, and existing blocks can show rows (`from <table>`) — the design is
docs/data-spec.md. This narrows "CMS / content editing" above: checkout,
payments and a visual page editor stay out.

*Decision, 2026-10-15 (owner):* **"the AI front-end (Phase 4)" above is the AI
that WRITES `.az` files** — it stays a non-goal. The `chat` block
(docs/chat-block-spec.md) is a different thing: a visitor on a built site
asks the site's own backend a question, and the generated server — never the
compiler, which still calls no network (principle 1) — asks the model the
operator chose. It can show only the site's own content, and it can do
nothing (no tools, no actions).

---

## 7. Technical decisions

### 7.1 Compiler language: **TypeScript**

You asked whether TypeScript or something else. TypeScript, clearly:

- The output is TypeScript/React. One language for the whole project means
  word-pack authors need to learn one thing, not two.
- `npx az build` is the lowest-friction distribution that exists for this
  audience. No Python install, no version hell.
- Word packs become npm packages — dependency resolution, versioning, and
  discovery for free.
- Tauri's tooling assumes a JS project.

*Rejected:* Python (mismatch with output, worse distribution to web devs),
Rust (best for a real compiler, but you'd lose contributors — and this project
lives or dies on contributed words).

### 7.2 Output stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **React + Vite** | biggest contributor pool |
| 3D | **React Three Fiber + drei** | declarative, so DSL→JSX is nearly 1:1 |
| Scroll motion | **Framer Motion + R3F ScrollControls** | handles reduced-motion natively |
| Styling | **CSS custom properties** from theme | mechanically enforceable; a lint can grep for hex literals |
| Prerender | **vite-react-ssg** | marketing sites need SEO; an SPA shell will not rank |

*R3F over vanilla three.js:* your DSL is declarative and so is R3F, so
templates stay short. Vanilla three.js is imperative and would turn your
templates into tangled string-building.

*Considered and rejected:* Astro + islands. Better raw perf and SEO, but pack
authors would write both `.astro` and `.tsx` files. Contributor simplicity is a
core strategic need, so one file type wins. Revisit if perf becomes binding.

*Tailwind:* deliberately not in Phase 1. It makes theme enforcement harder
(authors can write `bg-blue-500` and bypass the theme). Possible later as an
optional preset that only exposes theme tokens.

### 7.3 Theme system

The most important architectural piece. One resolved token set, injected once:

```
color   bg surface text muted accent accent-contrast
space   4 8 12 16 24 32 48 64 96 128     (one scale, no arbitrary values)
type    display body mono + 6-step size scale
radius  sm md lg full
shadow  sm md lg
motion  fast normal slow + easing curves
```

Ship 3–4 hand-designed themes. *Revised 2026-10-10 (owner decision): six —
`midnight`, `paper`, `signal`, `clay`, `petal`, `volt` (theme-spec §5) —
because colour is the first step of every site (§6.1a); each is still
hand-designed, in both schemes, and proven by theme-spec §6.* Do **not** ship a "generate a theme from a hex
code" feature — auto-generated palettes are exactly what makes a site look
templated, and looking non-templated is the entire value proposition.

**Enforcement:** `az lint` fails any word pack containing a raw hex, px value
outside the space scale, or font-family declaration. Without this, ten
contributors produce a ransom note.

### 7.4 Tauri — honest cost breakdown

> **Decision: Desktop in Phase 2. Mobile in Phase 3, gated on a spike.**

Your instinct that "web done → app is just a small addition" is **true for
desktop and not true for mobile.**

**Desktop (Phase 2) — genuinely cheap.** Tauri wraps the same static output.
Realistic cost: 1–2 weeks including window config, auto-update, and signing.

**Mobile (Phase 3) — not cheap.** Tauri v2 does support iOS/Android, but:

- **WebGL in a mobile WebView is the risk.** A scroll-linked 3D scene that runs
  at 60fps in desktop Chrome can drop to 15fps in an Android WebView. This is
  the whole product on mobile. **Spike this in week 1 of Phase 3 before
  promising anything.**
- App Store review, code signing, provisioning profiles, an Apple Developer
  account (~$99/yr) — days of work, and unavoidable.
- Deep links, push, safe-area insets, back-button handling: all app-specific.
- A marketing website wrapped in an app shell is usually a *bad app* and gets
  rejected under App Store guideline 4.2 (minimum functionality). Mobile only
  makes sense for the `auth`-gated app-like pages, not the marketing site.

**Realistic:** desktop 1–2 weeks, mobile 4–6 weeks plus ongoing store
maintenance. Plan accordingly; don't put mobile in Phase 1 marketing copy.

---

## 8. Milestones

Estimates assume one person, focused. Multiply by ~2 for evenings/weekends.

| # | Milestone | Output | Est. |
|---|---|---|---|
| M0 | **Spike** | Hand-build ONE `hero 3d scroll` in R3F, all 3 motion tiers **plus the runtime tier probe**. Measure on the best hardware available. No compiler. | 1 wk |
| M1 | **Compiler core** | Parser (indent nesting), spec, theme resolver, emits a running Vite project | 2 wks |
| M2 | **Word set v1** | 11 blocks + 5 structure keywords, with their variants and modifiers; 3 themes | 3–4 wks |
| M3 | **Escape hatch + lint** | `raw`, `slot`, `eject`, `az lint` | 1 wk |
| M4 | **Auth adapter** | Two adapters (hosted-provider + `azbackend`), styled forms | 1 wk |
| M5 | **Dogfood + proof** | Ship ONE real site end-to-end. Fix what hurts. Cut the demo (below). Freeze the grammar. | 2 wks |
| — | **Phase 1 done** | | **10–11 wks** |

### The proof artifact (M5 deliverable)

The whole strategic bet is "show the world this is possible," so design the
demo as a first-class deliverable, not an afterthought:

- **Under 5 minutes**, reproducible by a stranger on their own machine
- **Run the compile twice on camera, show byte-identical output** — this is the
  one thing no AI demo can do
- `.az` file and running site side by side, both on screen
- Real phone in frame for the mobile target, not a resized browser window

Frame it as *"ten words, one second, same result every time."* Do **not** frame
it as "better than AI" — that invites a coverage argument we lose. Let viewers
draw the comparison themselves; it lands harder.

**M0 still comes first**, but it is no longer a project-killing gate. The
runtime tier probe (§6.4) means an underperforming device gets a degraded
scene rather than a broken one, so the thesis no longer rests on one
measurement. What M0 must still prove is that the three tiers are *buildable*
and that the probe correctly picks between them — see `motion-tiers-spec.md`
§8 for what M0 can and cannot establish without a physical mid-range phone.

**M5 is the real gate.** Do not open-source, announce, or add words until one
real site has shipped.

Phase 2: Tauri desktop + word-pack system (~4 wks).
Phase 3: mobile, gated on spike (~6 wks).
Phase 4: AI word-suggestion front-end — fuzzy keyword matching first; only
train a model once you have real correction data from users.

## 9. Success metrics

| Metric | Target | Why it matters |
|---|---|---|
| **Escape-hatch ratio** | ≥80% of a real site built in words alone | the core health metric — if it's 50%, the words are wrong |
| Time to first real site | < 1 day | the promise |
| Cold compile | < 1s | enables watch-mode, the thing AI can't do |
| Lighthouse perf (mobile, `lite` tier) | ≥ 85 | proves the motion budget works |
| Bundle, non-3D pages | < 150KB gz | 3D must not tax pages that don't use it |

## 10. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| ~~3D perf on mobile app~~ | *retired* | resolved by design: mobile target uses native motion, not 3D (§6.4) |
| 3D perf on mobile *browsers* (web target) | medium | runtime-measured tiers (§6.4): the site probes its own frame rate and degrades itself, so the bad frame is never served. Residual risk is *quality* — where the boundary falls — not breakage |
| Mobile motion vocabulary never gets designed | high | it is an explicit M2 deliverable, not an afterthought |
| Auto-install breaks the offline promise | medium | hard setup/build split (§6.7); build never touches network |
| Contributed words break theme coherence | high | `az lint` from day one; tokens-only rule |
| Word count explodes, quality drops | high | hard cap of 20 until M5 |
| Generated 3D sites all look identical | high | 3–4 *hand-designed* themes; strong `raw`/`slot` story; distinct signature elements per theme. **Sharpened by the procedural default** (scene-spec §11.1): each theme ships its own generator and they must differ in kind, not hue — one shared generator would make every AZ site recognisable at a glance |
| Tauri mobile WebGL underperforms | medium | Phase 3 gated on spike; don't market mobile early |
| Solo maintenance burden | medium | word packs as npm packages so growth isn't all yours |
| The built-in backend carries a security flaw into every site that uses it | high | opt-in only; Node's own crypto, no hand-rolled primitives; a failing test per property (backend-spec §5); real PostgreSQL/MySQL runs; an external review before a production launch |

## 11. Open questions — answer before M1

1. **Public open-source project, or your internal studio tool?** This changes
   curation, docs, and contribution model, and an internal tool ships ~2x
   faster. *(Recommendation: build it internal, open-source after M5.)*
2. ~~**Does the backend AZ project continue,** or does it survive only as the
   `azbackend` adapter?~~ **Answered (2026-09-23): yes, as the optional
   built-in backend** — `az` generates it from a `backend` declaration, and it
   implements `azbackend` (§6.5, backend-spec.md). There is no separate
   backend project.
3. **Do you have a real client site to dogfood at M5?** If not, find one now —
   M5 is the gate and it needs a real brief, not a demo.
4. ~~**Which mid-range Android do you own for the M0 spike?**~~ **Answered:
   none, and M0 no longer requires one.** Tier selection moved from a
   build-time assumption to a runtime probe (§6.4, `motion-tiers-spec.md`), so
   a slow device degrades itself instead of shipping a broken scene. Testing
   3D only on a fast laptop is still how this product fails *quietly* — so the
   question becomes a standing one: **borrow a mid-range phone before M5**, to
   learn where the tier boundary actually falls. That is a quality question
   now, not a gate.
5. **License?** *Decided 2026-10-17:* Apache License 2.0 ([LICENSE](../LICENSE),
   [NOTICE](../NOTICE)). It keeps adoption as open as MIT and adds an explicit
   patent grant; contributions come in under the same terms (Apache-2.0 §5).

---

## Appendix: what makes this defensible

Not the compiler — anyone can write one. The defensibility is:

1. **The curated word set.** Taste is hard to copy. The words that are *right*
   come from shipping real sites, and that's earned, not forked.
2. **The themes.** Hand-designed, coherent, and the reason output doesn't look
   AI-generated.
3. **Determinism as a category.** No AI product can offer it without stopping
   being an AI product.
