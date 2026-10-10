# Theme tokens — schema, the three themes, and their proof

**Status** draft for M2 · Companion to PRD v0.2 §7.3 · Expands it into values

The theme is the only thing standing between twenty contributed words and a
ransom note. PRD §7.3 names the token *categories*; this document closes the
set, gives every token a type and a purpose, ships the three hand-designed
themes at ROADMAP M2 with real values, and proves the contrast arithmetic
instead of asserting it.

Two rules govern everything below:

> **The theme is global and resolved once. No word may hardcode a colour, font,
> radius, or spacing value.** — PRD §5, principle 3
>
> **A word emitter may only read design values through `ctx.theme`.** —
> ARCHITECTURE §4.4, CONVENTIONS §4

---

## 1. The token schema

### 1.1 Categories

Nine categories. PRD §7.3 names six (`color` `space` `type` `radius` `shadow`
`motion`); the other three are demanded by specs written since:

| Category | Per theme? | Per scheme? | Why it exists |
|---|---|---|---|
| `color` | yes | **yes** | the palette |
| `space` | **no — global** | no | PRD §7.3: *one scale, no arbitrary values* |
| `size` | yes | no | nav height, container, tap target, measure — nav-spec §5 requires nav height be a variable |
| `type` | yes | no | families, weights, tracking; the size scale is global |
| `radius` | yes | no | corner language |
| `shadow` | yes | **yes** | a black shadow is invisible on a black page |
| `motion` | **no — global** | no | overlays-spec §3 fixes the numbers; themes do not get to be slower |
| `layer` | **no — global** | no | CONVENTIONS §4 bans raw `z-index`; overlays-spec §1 needs a layer manager |
| `breakpoint` | **no — global** | no | a raw `768px` in a media query is an off-scale px, i.e. a lint error |

**Colour-bearing categories resolve per scheme. Nothing else does.** A theme
that changed its spacing or its motion between light and dark would be two
themes wearing one name.

**Global categories are defined once, in `packages/theme/tokens/`, and a theme
may not override them.** This is what lets a word be dropped into any theme
and still lay out correctly — the geometry and the timing are the contract, the
surface is the theme.

### 1.2 `color` — 16 tokens, per scheme

| Path | Type | What it is for |
|---|---|---|
| `color.bg` | `Color` | the page. Owned by `page`, not by `hero` (hero-spec §12 Q1) |
| `color.surface` | `Color` | a raised plane: card, dropdown panel, modal body, input field |
| `color.surface-alt` | `Color` | the second plane: solid nav, footer, table stripe |
| `color.text` | `Color` | primary body and heading text |
| `color.muted` | `Color` | sub / deck / eyebrow / caption. Still body-size — still 4.5:1 |
| `color.accent` | `Color` | the one action colour: primary fill, link text, active state |
| `color.accent-hover` | `Color` | accent under hover/active. Always further from `bg` than `accent` |
| `color.accent-contrast` | `Color` | label drawn **on** an accent fill |
| `color.border` | `Color` | decorative hairline: section rule, card edge, nav underline |
| `color.border-strong` | `Color` | the boundary of an interactive control (input, checkbox). ≥3:1, WCAG 1.4.11 |
| `color.focus` | `Color` | the focus ring. hero-spec §9 and nav-spec §7 make this mandatory |
| `color.scrim` | `Color` | the opaque anchor of a gradient laid over media — hero-spec §9, nav-spec §4 |
| `color.on-scrim` | `Color` | text drawn over a scrim. **Not `color.text`** — see §6.1 |
| `color.overlay` | `Color` | the flat modal backdrop (overlays-spec §3). Alpha applied by the overlay engine |
| `color.danger` | `Color` | form error text and destructive fills — PRD §6.5 auth error states |
| `color.danger-contrast` | `Color` | label on a danger fill |

There is no `color.success` and no `color.warning`. Nothing in the Phase 1 word
set draws one; when `auth` needs a confirmation state, propose it (§1.10).

### 1.3 `space` — global, keyed by its own value

| Path | Type | Value |
|---|---|---|
| `space.4` … `space.128` | `Px` | the ten steps from PRD §7.3 |

Full scale and the linter rule: **§7**.

### 1.4 `size` — per theme

| Path | Type | What it is for | Fixed by |
|---|---|---|---|
| `size.container` | `Px` | outer max-width | hero-spec §3 (1200–1440) |
| `size.gutter-sm` | `Px` | page gutter < `breakpoint.sm` | hero-spec §3 (24px) |
| `size.gutter-lg` | `Px` | page gutter ≥ `breakpoint.sm` | hero-spec §3 (48–80) |
| `size.nav` | `Px` | nav height. Emitted as `--az-nav-h` | nav-spec §5 — *must* be a variable |
| `size.nav-shrink` | `Px` | nav height after `shrink`. Reserved up front | nav-spec §3 (CLS) |
| `size.tap` | `Px` | minimum touch target | hero-spec §5, nav-spec §7 (44px) |
| `size.hero-min` | `CssLength` | hero min-height | hero-spec §6 (`85svh`, never `100vh`) |
| `size.measure-display` | `Ch` | display headline measure | hero-spec §3 (20–28ch) |
| `size.measure-body` | `Ch` | body measure | hero-spec §3 (45–65ch) |
| `size.scrim` | `Px` | height of the nav top-scrim gradient | nav-spec §4 (~120px) |
| `size.hairline` | `Px` | 1px. A border width is not a spacing step | — |
| `size.edge-emphasis` | `Px` | 2px. An edge that carries emphasis by weight, not colour alone — pricing-spec §7.3's highlighted plan | — |
| `size.glass-blur` | `Px` | 16px midnight, 12px paper, 0 signal. How far `glass` blurs what is behind it (nav-spec §3, cta-spec §5); signal's glass is translucent but unblurred, true to its zero-blur rule (§5.3) | per theme |
| `size.ring` | `Px` | focus ring width | hero-spec §9 |
| `size.ring-offset` | `Px` | focus ring offset. **Load-bearing** — see §6.2 | — |

`size.hero-min`, `size.tap` and `size.measure-*` are identical in all three
themes because a spec fixes them. They live here anyway so a word never types
the number.

### 1.5 `type`

| Path | Type | Scope | What it is for |
|---|---|---|---|
| `type.display` | `FontStack` | theme | display family. Overridable by the `font` word (PRD §6.1) |
| `type.body` | `FontStack` | theme | body family |
| `type.mono` | `FontStack` | theme | code, figures, labels |
| `type.size.xs` … `.2xl` | `CssLength` | **global** | the 6-step scale, `clamp()` |
| `type.size.display` | `CssLength` | global | `center`/`split`/`stack` hero — hero-spec §4 |
| `type.size.display-lg` | `CssLength` | global | `full`/`minimal` hero — hero-spec §4 |
| `type.leading.display` | `number` | theme | 0.95–1.05 — hero-spec §4 |
| `type.leading.tight` | `number` | theme | sub-heads, nav, buttons |
| `type.leading.body` | `number` | theme | 1.5–1.7 — hero-spec §4 |
| `type.tracking.<step>` | `Em` | theme | one entry per size step + `display`, `display-lg`, `caps` |
| `type.weight.display` | `number` | theme | 500–700 — hero-spec §4 |
| `type.weight.body` | `number` | theme | |
| `type.weight.bold` | `number` | theme | |

Values and the tracking rule: **§8**.

### 1.6 `radius` / `shadow`

| Path | Type | Notes |
|---|---|---|
| `radius.sm` `radius.md` `radius.lg` `radius.full` | `Px` | PRD §7.3. `full` is a pill, not necessarily round — `signal` sets it to `0` |
| `shadow.sm` `shadow.md` `shadow.lg` | `BoxShadow` | PRD §7.3. **Per scheme** |

### 1.7 `motion` — global

| Path | Type | Value | Fixed by |
|---|---|---|---|
| `motion.snap` | `Ms` | 100ms | overlays-spec §3 — tooltip fade, reduced-motion ceiling |
| `motion.fast` | `Ms` | 120ms | overlays-spec §3 — every exit |
| `motion.backdrop` | `Ms` | 150ms | overlays-spec §3 — modal backdrop, leads the panel |
| `motion.normal` | `Ms` | 160ms | overlays-spec §3 — dropdown / popover enter |
| `motion.emphasis` | `Ms` | 200ms | overlays-spec §3 — popup enter, toast slide |
| `motion.slide` | `Px` | 6px | overlays-spec §3 — the dropdown's enter offset. A motion distance, not spacing, so it is not a space-scale step |
| `motion.slow` | `Ms` | 240ms | overlays-spec §3 — drawer |
| `motion.sheet` | `Ms` | 280ms | overlays-spec §3 — sheet budget |
| `motion.ease.emphasis` | `Easing` | `cubic-bezier(0.16, 1, 0.3, 1)` | overlays-spec §3, named verbatim |
| `motion.ease.in` | `Easing` | `cubic-bezier(0.42, 0, 1, 1)` | the CSS `ease-in` curve |
| `motion.ease.out` | `Easing` | `cubic-bezier(0, 0, 0.58, 1)` | the CSS `ease-out` curve |
| `motion.spring.sheet` | `Spring` | `{ stiffness: 300, damping: 30, mass: 1 }` | derived — §9.2 |
| `motion.delay.tooltip-in` | `Ms` | 400ms | overlays-spec §3 |
| `motion.delay.tooltip-out` | `Ms` | 100ms | overlays-spec §3 |
| `motion.dwell.toast` | `Ms` | 5000ms | overlays-spec §3 (≥5s) |
| `motion.reduced` | `ReducedMotion` | `{ duration: '100ms', properties: ['opacity'] }` | overlays-spec §3, hero-spec §9 |

`motion.fast` / `motion.normal` / `motion.slow` are the three PRD §7.3 names.
The other four durations exist because overlays-spec §3 states them literally;
they are not decoration.

### 1.8 `layer` — global

`z-index` numbers are banned in word source (CONVENTIONS §4), so the whole
stack lives here. overlays-spec §1 requires a layer manager; these are the
floors it manages.

| Path | Value | Occupant |
|---|---|---|
| `layer.behind` | -1 | the page's one 3D canvas (scene-spec §5, §6.1): fixed at the bottom of the stack, every block drawn over it |
| `layer.base` | 0 | page content |
| `layer.raised` | 10 | cards, hover lift |
| `layer.scrim` | 20 | hero and nav scrim gradients |
| `layer.sticky` | 100 | `nav sticky` |
| `layer.dropdown` | 200 | dropdown, popover — above nav, below modals |
| `layer.backdrop` | 300 | modal backdrop |
| `layer.modal` | 400 | popup, drawer, sheet |
| `layer.toast` | 500 | toast — above a modal, never focus-stealing |
| `layer.tooltip` | 600 | tooltip — always topmost content |
| `layer.skip` | 700 | the skip link. nav-spec §7: *first focusable element* |

Gaps of 10 and 100 are deliberate: a word pack that genuinely needs to sit
between two floors can, without a schema change.

### 1.9 `breakpoint` — global

| Path | Value | Fixed by |
|---|---|---|
| `breakpoint.xs` | 480px | hero-spec §5 — primary CTA goes full-width below this |
| `breakpoint.sm` | 768px | hero-spec §10 (`split` restacks), nav-spec §6 (mobile menu) |
| `breakpoint.md` | 1024px | feature, gallery and text specs, open question 6 — the band where three columns stop having a measure |
| `breakpoint.lg` | 1440px | hero-spec §3 container ceiling; word-gate §1 check 3 test width |

Four, not five. `md` was added when three block specs each needed the same
~1024px band; hard-coding it in three words is the drift CONVENTIONS §4
exists to stop. 390px is a **test width** (word-gate §1 check 3), not a
breakpoint — nothing changes there.

### 1.10 The set is closed

```ts
export interface ResolvedTheme {
  readonly color: Record<ColorToken, TokenRef>;
  readonly space: Record<SpaceStep, TokenRef>;
  readonly size: Record<SizeToken, TokenRef>;
  readonly type: ResolvedType;
  readonly radius: Record<'sm' | 'md' | 'lg' | 'full', TokenRef>;
  readonly shadow: Record<'sm' | 'md' | 'lg', TokenRef>;
  readonly motion: ResolvedMotion;
  readonly layer: Record<LayerToken, number>;
  readonly breakpoint: Record<'xs' | 'sm' | 'lg', number>;
  /** Literal value for the active scheme. WebGL only — see §3.4. */
  value(path: TokenPath): string;
}

type TokenRef = `var(--az-${string})`;
type SpaceStep = 4 | 8 | 12 | 16 | 24 | 32 | 48 | 64 | 96 | 128;
```

Every union above is a **closed string-literal union**, not `string`. Three
consequences, and they are the point of the whole design:

1. `ctx.theme.color.brandBlue` is a **type error**, caught by `pnpm typecheck`
   (word-gate §1 check 1) before lint ever runs.
2. `themeReads` in `word.json` (ARCHITECTURE §4.1) is validated against this
   union at the **link** stage, so an unknown path is a compile diagnostic with
   a source position, not a runtime `undefined`.
3. The graph's `theme-token` nodes (ARCHITECTURE §5) are generated from the
   union — one source, no second copy to drift.

**What a word does when it needs a token that does not exist: it doesn't.** It
proposes the token. The PR that adds it must add it to the union, to all three
themes in both schemes, and to the contrast table in §6 — which is why adding
one is deliberately more work than using an existing one. A word that "just
needs one more grey" is nearly always a word that should have used
`color.muted`.

The failure this prevents is specific: a word falls back to a literal "just
this once", the site looks fine in the theme the author was using, and it
breaks in the other two and in dark mode. That is exactly the ransom note
CONVENTIONS §4 exists to stop.

---

## 2. Semantic naming, not literal

**A token is named for the job it does, never for how it looks.**

| ✓ role | ✗ appearance |
|---|---|
| `color.accent` | `color.blue` |
| `color.accent-contrast` | `color.white` |
| `color.surface-alt` | `color.gray-100` |
| `color.muted` | `color.gray-500` |
| `radius.lg` | `radius-20` |
| `motion.fast` | `motion-120` |

Three reasons, in order of how much they cost when ignored:

1. **`signal` has no blue in it.** A word written against `color.blue` is a
   word that only works in one theme, which defeats the entire theme system.
   Role names survive a repaint; appearance names do not.
2. **Dark mode inverts the literal and preserves the role.** `color.surface` is
   *lighter* than `bg` in light and *lighter* than `bg` in dark too — but in
   `midnight` that means `hsl(0 0% 100%)` in one and `hsl(230 26% 11%)` in the
   other. A token called `gray-100` would be a lie in exactly one scheme.
3. **The name is the review.** `color.accent-contrast` states its own contract:
   it goes on `accent` and it must clear 4.5:1. `color.white` states nothing, so
   nothing can be checked.

The same rule holds for scale steps. `space.4` is keyed by its value because
the scale *is* the set of legal values (§7); `radius.lg` is not, because "large
corner" is a role and 20px is one theme's answer to it.

---

## 3. Light and dark

Every theme ships both schemes. This is not a nicety — it is **word-gate §1
check 7**, and a word cannot pass the gate without visual snapshots in both.

### 3.1 Two full sets, not an override layer

> **Decision: dark is a complete, independently-authored token set. It is not a
> patch over light.**

An override layer would let a theme author define twelve of the sixteen colour
tokens for dark and silently inherit four light values — producing a black page
with a light-grey border that nobody notices until a client does. A full set
makes completeness **mechanically checkable**: the validator asserts
`keys(dark) === keys(light) === ColorToken`, and a missing token is a build
error rather than a visual bug.

The cost is duplication of the tokens that genuinely do not change. That cost
is small (there are 16), and it buys a check that cannot be forgotten.

### 3.2 Resolution — three states, not two

The scheme has three states, and the third is the one people get wrong:
**explicit light, explicit dark, and "follow the OS", which is the default and
sets no attribute at all.**

```css
/* 1. light is the base — every token defined unconditionally */
:root { --az-color-bg: hsl(220 30% 97%); /* … */ }

/* 2. OS preference, but only when the user has not chosen light */
@media (prefers-color-scheme: dark) {
  :root:not([data-scheme="light"]) { --az-color-bg: hsl(230 30% 7%); /* … */ }
}

/* 3. explicit choice wins in both directions */
:root[data-scheme="dark"] { --az-color-bg: hsl(230 30% 7%); /* … */ }
```

Rules that fall out of this and are enforced by the theme validator:

- **No token may be defined only inside a media or `[data-scheme]` block.** Its
  first definition is always on bare `:root`, or a viewer in the untested state
  gets a page with no background.
- `<body>` gets an explicit `background: var(--az-color-bg)`. A transparent body
  borrows whatever the host paints behind it.
- `<meta name="color-scheme" content="light dark">` is emitted so form controls
  and scrollbars follow.

A theme may declare itself `defaultScheme: 'dark'` (`midnight` does). That only
changes which set is written to bare `:root`; the three-state structure is
identical.

### 3.3 What words see

`ctx.theme.color.accent` returns the string `"var(--az-color-accent)"`, **not
`"hsl(202 92% 30%)"`.** The emitter produces one tree, the browser resolves the
scheme. This is what makes dark mode free for every word rather than a per-word
feature, and it is why the emitted output is byte-identical regardless of the
author's OS setting — which CONVENTIONS §6 requires.

**One derived colour: `color.veil`.** Words may also read
`var(--az-color-veil)`: the page background at `VEIL_PERCENT` (92%)
opacity, declared once after the scheme blocks and built on
`var(--az-color-bg)`, so it follows the scheme with no copy per scheme. It
is the surface a block with no background of its own takes over a live
`scene backdrop` (scene-spec §6.5), sized so every text pair still clears its
floor against a pure-white or pure-black backdrop pixel. It is not one of the
16 role tokens: it has no value of its own.

### 3.4 The one exception: WebGL

A three.js material cannot read a CSS custom property. A `hero 3d` or `scene`
word that tints a light or a fog needs the literal, so `ResolvedTheme` exposes:

```ts
value(path: TokenPath): string   // "hsl(202 92% 30%)" for the active scheme
```

**This is an addition to the `EmitContext` contract in ARCHITECTURE §4.3** and
should be recorded there in the same commit. Constraints on its use:

- CSS-capable properties must **not** use it. Lint rule: `theme.value()` is
  legal only in a file that imports from `three` or `@react-three/fiber`.
- **Implemented** in the 3D runtime (`scene-runtime/src/runtime/colours.ts`),
  resolved at runtime from the site's custom properties rather than at
  compile time — the one moment the active scheme is known. The lint rule is
  `webgl-colour-outside-scene`. ARCHITECTURE §4.3 records it.
- A scene using it must subscribe to scheme changes
  (`matchMedia('(prefers-color-scheme: dark)')` plus the `data-scheme`
  attribute) and update the material, or the 3D object stays light on a dark
  page — a bug invisible to anyone testing in one scheme.

---

## 4. Where raw colour values are legal — the package boundary

This section exists so a linter can implement it without judgement calls.

CONVENTIONS §4 bans hex literals, `rgb(`/`hsl(` literals, off-scale px,
`font-family` and raw `z-index` **"in any file under `words/` or `target-*/`"**.
That is the complete scope of the ban. It says nothing about `packages/theme`,
and that is deliberate:

> **`packages/theme` is the one place in the repository where raw colour
> literals, raw font-family names, and off-scale px values are legal — because
> it is the place that defines what the scale is.**

Mechanically:

| Path | hex / `hsl()` / `rgb()` | `font-family` | px not on the space scale | `z-index` number |
|---|---|---|---|---|
| `packages/theme/themes/**` | **legal** | **legal** | **legal** | **legal** |
| `packages/theme/tokens/**` | legal | legal | legal | legal |
| `packages/theme/src/ramps.ts` (generated accent ramps) | legal | legal | legal | legal |
| `packages/theme/*.ts` (resolver) | **banned** | banned | banned | banned |
| `packages/words/**` | banned | banned | banned | banned |
| `packages/target-*/**` | banned | banned | banned | banned |
| `packages/overlay/**` | banned | banned | banned | banned |
| `packages/core/**` | banned | banned | banned | banned |
| `examples/**`, `fixtures/**` | not linted | | | |

Three notes for whoever writes the rule:

1. **The exemption is by path, not by heuristic.** No "allow if it's in a
   constant", no comment-based opt-out. `az lint` takes a literal allowlist of
   two globs. A path-based rule cannot be argued with at 11pm, which is the
   whole point (word-gate §7).
2. **The resolver is not exempt.** `packages/theme/resolve.ts` transforms
   tokens; it must never contain one. Keeping the data in `themes/` and the
   logic outside it is what makes "add a theme" a data change.
3. `packages/overlay` is not named in CONVENTIONS §4 but depends only on
   `theme` (ARCHITECTURE §2) and emits CSS. It is in scope for the ban; add it
   to CONVENTIONS §4's wording in the same commit that adds this rule.

---

## 5. The three themes

PRD §10 lists *"generated 3D sites all look identical"* as a **high** severity
risk, mitigated by *"3–4 hand-designed themes … ship distinct signature
elements per theme."* Three hue rotations of one design would not discharge
that risk. So the themes differ on **structure** first and colour second:

| Axis | `midnight` | `paper` | `signal` |
|---|---|---|---|
| Default scheme | dark | light | light |
| Corner language | generous (20px) | near-square (4px) | **zero, everywhere** |
| Elevation | soft coloured glow | hairline, almost no shadow | **hard offset, zero blur** |
| Display type | geometric sans, tight | serif, open | grotesque, very tight, heavy |
| Body type | sans | **serif** | sans |
| Chroma | high on one hue | very low + one deep red | neutral + one hot orange |
| Nav height | 72px | 80px | 64px |
| Signature | accent glow under raised surfaces | 1px rules and generous measure | offset shadow + mono labels |

`radius.full` being `0` in `signal` is not a bug. A theme is allowed to say
"there are no pills here", and words that ask for `radius.full` get a rectangle.
That is one of the strongest distinctness levers in the set.

All colour values are `hsl()`. **Choice stated once: `hsl()`, not OKLCH.**
WCAG 2.1 contrast is defined on sRGB, so `hsl()` converts to the ratio exactly
and the §6 table can be recomputed from the source values with no colour-space
round-trip and no gamut clipping; OKLCH would buy perceptually even ramps we do
not need for a 16-token palette, at the cost of making the a11y evidence
approximate. Browser support is not a factor either way — `hsl()` is universal,
and OKLCH has been in all evergreen browsers since 2023.

The values below are **raw colour literals living in `packages/theme/themes/`**,
which §4 establishes as the one legal home for them.

### 5.1 `midnight` — dark-native, for the 3D product launch

The theme the PRD's own example file asks for (`theme midnight`, PRD §6.1). It
is built for the case the whole product bets on: a `hero 3d scroll` with a
model floating in near-black, scroll-linked camera, one electric accent. Dark is
its **native** scheme, not its alternate — a rendered `.glb` reads as expensive
against a deep field and cheap against white, and the `full` hero's scrim
problem (hero-spec §9) largely disappears when the page is already dark.

Distinctness comes from **light**: raised surfaces carry a faint accent glow, so
cards and dropdowns look lit rather than drawn. Generous 20px radii and a
geometric display face keep it product-shaped rather than editorial. Its light
scheme is a genuine cool-white studio, not an inverted afterthought.

**Type** — a geometric display family, a neutral body family, a mono for figures

| Token | Light | Dark |
|---|---|---|
| `color.bg` | `hsl(220 30% 97%)` | `hsl(230 30% 7%)` |
| `color.surface` | `hsl(0 0% 100%)` | `hsl(230 26% 11%)` |
| `color.surface-alt` | `hsl(220 28% 92%)` | `hsl(230 24% 16%)` |
| `color.text` | `hsl(230 35% 12%)` | `hsl(220 30% 96%)` |
| `color.muted` | `hsl(228 12% 36%)` | `hsl(222 15% 72%)` |
| `color.accent` | `hsl(202 92% 30%)` | `hsl(190 92% 62%)` |
| `color.accent-hover` | `hsl(202 92% 23%)` | `hsl(190 92% 74%)` |
| `color.accent-contrast` | `hsl(0 0% 100%)` | `hsl(200 60% 8%)` |
| `color.border` | `hsl(220 20% 86%)` | `hsl(230 18% 24%)` |
| `color.border-strong` | `hsl(220 14% 52%)` | `hsl(228 14% 48%)` |
| `color.focus` | `hsl(202 92% 33%)` | `hsl(190 92% 70%)` |
| `color.scrim` | `hsl(230 35% 12%)` | `hsl(230 40% 4%)` |
| `color.on-scrim` | `hsl(220 30% 97%)` | `hsl(220 30% 96%)` |
| `color.overlay` | `hsl(230 35% 12%)` | `hsl(230 40% 4%)` |
| `color.danger` | `hsl(355 72% 38%)` | `hsl(355 88% 70%)` |
| `color.danger-contrast` | `hsl(0 0% 100%)` | `hsl(355 60% 10%)` |

| Token | Value | | Token | Light | Dark |
|---|---|---|---|---|---|
| `radius.sm` | `6px` | | `shadow.sm` | `0 1px 2px hsl(230 35% 12% / .08)` | `0 1px 2px hsl(230 40% 3% / .5)` |
| `radius.md` | `12px` | | `shadow.md` | `0 8px 24px hsl(230 35% 12% / .10)` | `0 8px 24px hsl(230 40% 3% / .6)` |
| `radius.lg` | `20px` | | `shadow.lg` | `0 24px 64px hsl(230 35% 12% / .12), 0 0 48px hsl(202 92% 30% / .08)` | `0 24px 64px hsl(230 40% 3% / .7), 0 0 48px hsl(190 92% 62% / .12)` |
| `radius.full` | `9999px` | | | | |

The second layer of `shadow.lg` is the signature: an accent glow at 8–12%
opacity. It is the one place the theme spends chroma on something that is not
an action.

| `size.*` | | `type.*` | |
|---|---|---|---|
| `container` | `1280px` | `leading.display` | `0.98` |
| `gutter-sm` | `24px` | `leading.tight` | `1.25` |
| `gutter-lg` | `64px` | `leading.body` | `1.6` |
| `nav` | `72px` | `weight.display` | `600` |
| `nav-shrink` | `56px` | `weight.body` | `400` |
| `tap` | `44px` | `weight.bold` | `600` |
| `hero-min` | `85svh` | `tracking.display` | `-0.03em` |
| `measure-display` | `24ch` | `tracking.display-lg` | `-0.04em` |
| `measure-body` | `60ch` | `tracking.2xl` | `-0.02em` |
| `scrim` | `120px` | `tracking.xl` | `-0.015em` |
| `hairline` | `1px` | `tracking.lg` | `-0.01em` |
| `ring` | `2px` | `tracking.base` `.sm` `.xs` | `0` |
| `ring-offset` | `2px` | `tracking.caps` | `0.08em` |

### 5.2 `paper` — editorial, for the studio, the portfolio, the type-led brand

For the site where the *writing* is the product: an agency, a photographer, a
practice, a manifesto. It is the theme for `hero minimal` — the variant
hero-spec §2 warns has "nowhere to hide — type must be perfect" — so it puts
its entire budget into type and measure.

Its distinctness is **subtraction**. There is essentially no shadow: elevation
is a 1px rule, and a dropdown is a bordered rectangle, not a floating card.
Corners are 4px, which reads as "cut" rather than "rounded". Body copy is set
in a serif at 1.7 leading, which no other theme does and which changes the feel
of a page more than any colour choice. The accent is a deep oxblood used
sparingly — mostly on links, rarely on a fill. Its dark scheme is warm ink, not
neutral black, and the accent warms to terracotta so it stays alive against it.

**Type** — display `Newsreader`, body `Source Serif 4`, mono `Spline Sans Mono`

| Token | Light | Dark |
|---|---|---|
| `color.bg` | `hsl(40 30% 96%)` | `hsl(30 10% 9%)` |
| `color.surface` | `hsl(40 40% 99%)` | `hsl(30 9% 13%)` |
| `color.surface-alt` | `hsl(38 22% 90%)` | `hsl(30 8% 18%)` |
| `color.text` | `hsl(30 12% 11%)` | `hsl(40 30% 92%)` |
| `color.muted` | `hsl(30 8% 36%)` | `hsl(36 12% 68%)` |
| `color.accent` | `hsl(8 68% 36%)` | `hsl(14 78% 66%)` |
| `color.accent-hover` | `hsl(8 68% 28%)` | `hsl(14 78% 76%)` |
| `color.accent-contrast` | `hsl(40 40% 99%)` | `hsl(20 45% 10%)` |
| `color.border` | `hsl(35 15% 80%)` | `hsl(30 8% 25%)` |
| `color.border-strong` | `hsl(32 10% 48%)` | `hsl(32 9% 48%)` |
| `color.focus` | `hsl(8 68% 34%)` | `hsl(14 82% 70%)` |
| `color.scrim` | `hsl(30 12% 11%)` | `hsl(30 14% 5%)` |
| `color.on-scrim` | `hsl(40 30% 96%)` | `hsl(40 30% 92%)` |
| `color.overlay` | `hsl(30 12% 11%)` | `hsl(30 14% 5%)` |
| `color.danger` | `hsl(0 62% 35%)` | `hsl(0 78% 70%)` |
| `color.danger-contrast` | `hsl(40 40% 99%)` | `hsl(0 50% 12%)` |

| Token | Value | | Token | Light | Dark |
|---|---|---|---|---|---|
| `radius.sm` | `2px` | | `shadow.sm` | `0 0 0 1px hsl(35 15% 80%)` | `0 0 0 1px hsl(30 8% 25%)` |
| `radius.md` | `3px` | | `shadow.md` | `0 1px 2px hsl(30 12% 11% / .06), 0 0 0 1px hsl(35 15% 80%)` | `0 1px 2px hsl(30 14% 3% / .5), 0 0 0 1px hsl(30 8% 25%)` |
| `radius.lg` | `4px` | | `shadow.lg` | `0 8px 24px hsl(30 12% 11% / .08), 0 0 0 1px hsl(35 15% 80%)` | `0 8px 24px hsl(30 14% 3% / .6), 0 0 0 1px hsl(30 8% 25%)` |
| `radius.full` | `9999px` | | | | |

Note the shape of these: every level carries the same hairline and adds only
blur. Nothing in `paper` ever appears to leave the page.

| `size.*` | | `type.*` | |
|---|---|---|---|
| `container` | `1200px` | `leading.display` | `1.05` |
| `gutter-sm` | `24px` | `leading.tight` | `1.3` |
| `gutter-lg` | `64px` | `leading.body` | `1.7` |
| `nav` | `80px` | `weight.display` | `500` |
| `nav-shrink` | `60px` | `weight.body` | `400` |
| `tap` | `44px` | `weight.bold` | `600` |
| `hero-min` | `85svh` | `tracking.display` | `-0.015em` |
| `measure-display` | `26ch` | `tracking.display-lg` | `-0.02em` |
| `measure-body` | `62ch` | `tracking.2xl` | `-0.01em` |
| `scrim` | `120px` | `tracking.xl` | `-0.005em` |
| `hairline` | `1px` | `tracking.lg` `.base` `.sm` `.xs` | `0` |
| `ring` | `2px` | `tracking.caps` | `0.12em` |
| `ring-offset` | `2px` | | |

`paper` tracks display type at the *loose* end of hero-spec §4's −0.02…−0.04em
band and stops at −0.015em for `display`, because a serif at 5rem with −0.04em
tracking collides. Deviating below the band is deliberate and is the one place
a theme is allowed to: the band is a rule about sans display faces.

### 5.3 `signal` — industrial, for the tool, the launch, the loud product

For a developer tool, a hardware launch, a product that wants to look
engineered rather than curated. Everything soft has been removed: **every
radius is `0`**, every shadow is a hard 2/4/8px offset with **zero blur**, and
the mono face is used structurally — section numbers, spec labels, figures — not
just for code.

It is the highest-contrast of the three (18.42:1 body in light) and the most
saturated on its one accent, a hot orange that appears only on actions.
`color.focus` is deliberately **blue**, not accent-derived, so a focus ring is
never confused with an orange button. Its dark scheme is neutral black rather
than the tinted blacks of the other two, and the hard shadow inverts to a light
offset so elevation survives.

**Type** — display `Archivo`, body `Archivo`, mono `Space Mono`

One family for display and body at two very different weights is itself a
signature: `signal` gets its hierarchy from weight and size, not from a family
change.

| Token | Light | Dark |
|---|---|---|
| `color.bg` | `hsl(0 0% 100%)` | `hsl(0 0% 6%)` |
| `color.surface` | `hsl(0 0% 96%)` | `hsl(0 0% 10%)` |
| `color.surface-alt` | `hsl(0 0% 90%)` | `hsl(0 0% 16%)` |
| `color.text` | `hsl(0 0% 8%)` | `hsl(0 0% 97%)` |
| `color.muted` | `hsl(0 0% 36%)` | `hsl(0 0% 70%)` |
| `color.accent` | `hsl(18 92% 34%)` | `hsl(24 100% 60%)` |
| `color.accent-hover` | `hsl(18 92% 26%)` | `hsl(24 100% 70%)` |
| `color.accent-contrast` | `hsl(0 0% 100%)` | `hsl(0 0% 8%)` |
| `color.border` | `hsl(0 0% 78%)` | `hsl(0 0% 26%)` |
| `color.border-strong` | `hsl(0 0% 8%)` | `hsl(0 0% 62%)` |
| `color.focus` | `hsl(215 100% 38%)` | `hsl(210 100% 66%)` |
| `color.scrim` | `hsl(0 0% 8%)` | `hsl(0 0% 2%)` |
| `color.on-scrim` | `hsl(0 0% 100%)` | `hsl(0 0% 97%)` |
| `color.overlay` | `hsl(0 0% 8%)` | `hsl(0 0% 2%)` |
| `color.danger` | `hsl(0 84% 36%)` | `hsl(0 92% 68%)` |
| `color.danger-contrast` | `hsl(0 0% 100%)` | `hsl(0 60% 10%)` |

| Token | Value | | Token | Light | Dark |
|---|---|---|---|---|---|
| `radius.sm` | `0` | | `shadow.sm` | `2px 2px 0 0 hsl(0 0% 8%)` | `2px 2px 0 0 hsl(0 0% 62%)` |
| `radius.md` | `0` | | `shadow.md` | `4px 4px 0 0 hsl(0 0% 8%)` | `4px 4px 0 0 hsl(0 0% 62%)` |
| `radius.lg` | `0` | | `shadow.lg` | `8px 8px 0 0 hsl(0 0% 8%)` | `8px 8px 0 0 hsl(0 0% 62%)` |
| `radius.full` | `0` | | | | |

The shadow offsets are 2/4/8px — **not** space-scale steps, because a shadow
offset is not spacing. They live in `shadow`, so no word ever types them.

| `size.*` | | `type.*` | |
|---|---|---|---|
| `container` | `1280px` | `leading.display` | `0.95` |
| `gutter-sm` | `24px` | `leading.tight` | `1.2` |
| `gutter-lg` | `48px` | `leading.body` | `1.5` |
| `nav` | `64px` | `weight.display` | `700` |
| `nav-shrink` | `52px` | `weight.body` | `400` |
| `tap` | `44px` | `weight.bold` | `700` |
| `hero-min` | `85svh` | `tracking.display` | `-0.035em` |
| `measure-display` | `22ch` | `tracking.display-lg` | `-0.04em` |
| `measure-body` | `58ch` | `tracking.2xl` | `-0.025em` |
| `scrim` | `120px` | `tracking.xl` | `-0.02em` |
| `hairline` | `1px` | `tracking.lg` | `-0.01em` |
| `ring` | `2px` | `tracking.base` `.sm` `.xs` | `0` |
| `ring-offset` | `2px` | `tracking.caps` | `0.1em` |

---

## 6. Contrast proof

**132 pairs: 3 themes × 2 schemes × 22 pairs. All pass.**

Floors from hero-spec §9: **4.5:1** body text, **3:1** large text. The 3:1 rows
below are not large text — they are non-text UI (focus rings, input borders)
where WCAG 2.1 SC 1.4.11 sets the same 3:1 floor. Applying the stricter
interpretation costs nothing here and removes an argument.

Method: `hsl()` → sRGB → WCAG 2.1 relative luminance → `(L1+0.05)/(L2+0.05)`.
Ratios are **truncated**, never rounded up, so a printed `4.50:1` is genuinely
at or above the floor. The generator is a ~40-line script with no dependencies
and ships as `packages/theme/contrast.test.ts` (§10).

### 6.1 Two fixes this table forced

The table is only evidence if it is allowed to fail. It failed 9 of 132 on the
first run, in two clusters, and both were real design bugs rather than bad
numbers:

**`color.text` on `color.scrim` — 1.00:1 in all three light schemes.**
The scrim anchor is dark by definition (hero-spec §9, nav-spec §4 both describe
a dark gradient over media), and in a light scheme `color.text` is *also* dark,
so hero text over a `full`-variant scrim was black on black. Setting the scrim
lighter would defeat its purpose. **Fix: added `color.on-scrim`** — text drawn
over a scrim is light in *both* schemes, because the scrim is dark in both.
`nav` gets it for free in its transparent-over-hero state (nav-spec §4), which
is the same problem one element up. Now 15.71–19.02:1.

**`color.focus` on `color.accent` — 1.02–1.15:1 in all six.**
A focus ring drawn on a filled accent button was invisible, in every theme. The
tempting fix is a focus colour that clears 3:1 against both the background and
the accent — for `midnight light` that admits a luminance window of roughly
0.28–0.30, which is one theme repaint away from failing. **Fix: the mechanism,
not the colour.** The ring is emitted as

```css
outline: var(--az-size-ring) solid var(--az-color-focus);
outline-offset: var(--az-size-ring-offset);
```

The 2px offset means the ring's adjacent colour on both sides is the
*background*, never the fill, so the requirement collapses to `focus` vs `bg` /
`surface` / `surface-alt` — all of which clear 3:1 with room. `size.ring-offset`
is therefore load-bearing, not decorative: setting it to `0` in a theme
reintroduces the failure. The validator asserts it is ≥ `1px`.

`outline` also survives `overflow: hidden` and `border-radius: 0`, which a
`box-shadow` ring does not — relevant because `signal` sets every radius to 0.

### 6.2 `midnight` / light

| fg | bg | ratio | floor | |
|---|---|---|---|---|
| `color.text` | `color.bg` | **16.52:1** | 4.5 | PASS |
| `color.text` | `color.surface` | **17.73:1** | 4.5 | PASS |
| `color.text` | `color.surface-alt` | **14.56:1** | 4.5 | PASS |
| `color.on-scrim` | `color.scrim` | **16.52:1** | 4.5 | PASS |
| `color.muted` | `color.bg` | **6.87:1** | 4.5 | PASS |
| `color.muted` | `color.surface` | **7.38:1** | 4.5 | PASS |
| `color.muted` | `color.surface-alt` | **6.06:1** | 4.5 | PASS |
| `color.accent` | `color.bg` | **6.38:1** | 4.5 | PASS |
| `color.accent` | `color.surface` | **6.84:1** | 4.5 | PASS |
| `color.accent-hover` | `color.bg` | **8.90:1** | 4.5 | PASS |
| `color.accent-contrast` | `color.accent` | **6.84:1** | 4.5 | PASS |
| `color.accent-contrast` | `color.accent-hover` | **9.55:1** | 4.5 | PASS |
| `color.danger` | `color.bg` | **6.91:1** | 4.5 | PASS |
| `color.danger` | `color.surface` | **7.42:1** | 4.5 | PASS |
| `color.danger-contrast` | `color.danger` | **7.42:1** | 4.5 | PASS |
| `color.focus` | `color.bg` | **5.50:1** | 3 | PASS |
| `color.focus` | `color.surface` | **5.91:1** | 3 | PASS |
| `color.focus` | `color.surface-alt` | **4.85:1** | 3 | PASS |
| `color.border-strong` | `color.bg` | **3.75:1** | 3 | PASS |
| `color.border-strong` | `color.surface` | **4.03:1** | 3 | PASS |
| `color.accent` | `color.surface-alt` | **5.62:1** | 3 | PASS |
| `color.border` | `color.bg` | 1.32:1 | — | decorative |

### 6.3 `midnight` / dark

| fg | bg | ratio | floor | |
|---|---|---|---|---|
| `color.text` | `color.bg` | **17.48:1** | 4.5 | PASS |
| `color.text` | `color.surface` | **16.17:1** | 4.5 | PASS |
| `color.text` | `color.surface-alt` | **14.28:1** | 4.5 | PASS |
| `color.on-scrim` | `color.scrim` | **18.25:1** | 4.5 | PASS |
| `color.muted` | `color.bg` | **9.17:1** | 4.5 | PASS |
| `color.muted` | `color.surface` | **8.48:1** | 4.5 | PASS |
| `color.muted` | `color.surface-alt` | **7.49:1** | 4.5 | PASS |
| `color.accent` | `color.bg` | **11.57:1** | 4.5 | PASS |
| `color.accent` | `color.surface` | **10.71:1** | 4.5 | PASS |
| `color.accent-hover` | `color.bg` | **13.29:1** | 4.5 | PASS |
| `color.accent-contrast` | `color.accent` | **10.85:1** | 4.5 | PASS |
| `color.accent-contrast` | `color.accent-hover` | **12.47:1** | 4.5 | PASS |
| `color.danger` | `color.bg` | **6.85:1** | 4.5 | PASS |
| `color.danger` | `color.surface` | **6.34:1** | 4.5 | PASS |
| `color.danger-contrast` | `color.danger` | **6.53:1** | 4.5 | PASS |
| `color.focus` | `color.bg` | **12.62:1** | 3 | PASS |
| `color.focus` | `color.surface` | **11.68:1** | 3 | PASS |
| `color.focus` | `color.surface-alt` | **10.31:1** | 3 | PASS |
| `color.border-strong` | `color.bg` | **3.93:1** | 3 | PASS |
| `color.border-strong` | `color.surface` | **3.64:1** | 3 | PASS |
| `color.accent` | `color.surface-alt` | **9.45:1** | 3 | PASS |
| `color.border` | `color.bg` | 1.61:1 | — | decorative |

### 6.4 `paper` / light

| fg | bg | ratio | floor | |
|---|---|---|---|---|
| `color.text` | `color.bg` | **15.71:1** | 4.5 | PASS |
| `color.text` | `color.surface` | **16.65:1** | 4.5 | PASS |
| `color.text` | `color.surface-alt` | **13.75:1** | 4.5 | PASS |
| `color.on-scrim` | `color.scrim` | **15.71:1** | 4.5 | PASS |
| `color.muted` | `color.bg` | **6.10:1** | 4.5 | PASS |
| `color.muted` | `color.surface` | **6.46:1** | 4.5 | PASS |
| `color.muted` | `color.surface-alt` | **5.34:1** | 4.5 | PASS |
| `color.accent` | `color.bg` | **6.99:1** | 4.5 | PASS |
| `color.accent` | `color.surface` | **7.41:1** | 4.5 | PASS |
| `color.accent-hover` | `color.bg` | **9.42:1** | 4.5 | PASS |
| `color.accent-contrast` | `color.accent` | **7.41:1** | 4.5 | PASS |
| `color.accent-contrast` | `color.accent-hover` | **9.99:1** | 4.5 | PASS |
| `color.danger` | `color.bg` | **7.92:1** | 4.5 | PASS |
| `color.danger` | `color.surface` | **8.39:1** | 4.5 | PASS |
| `color.danger-contrast` | `color.danger` | **8.39:1** | 4.5 | PASS |
| `color.focus` | `color.bg` | **7.52:1** | 3 | PASS |
| `color.focus` | `color.surface` | **7.97:1** | 3 | PASS |
| `color.focus` | `color.surface-alt` | **6.59:1** | 3 | PASS |
| `color.border-strong` | `color.bg` | **3.82:1** | 3 | PASS |
| `color.border-strong` | `color.surface` | **4.05:1** | 3 | PASS |
| `color.accent` | `color.surface-alt` | **6.12:1** | 3 | PASS |
| `color.border` | `color.bg` | 1.45:1 | — | decorative |

### 6.5 `paper` / dark

| fg | bg | ratio | floor | |
|---|---|---|---|---|
| `color.text` | `color.bg` | **15.30:1** | 4.5 | PASS |
| `color.text` | `color.surface` | **13.70:1** | 4.5 | PASS |
| `color.text` | `color.surface-alt` | **11.52:1** | 4.5 | PASS |
| `color.on-scrim` | `color.scrim` | **16.60:1** | 4.5 | PASS |
| `color.muted` | `color.bg` | **8.24:1** | 4.5 | PASS |
| `color.muted` | `color.surface` | **7.38:1** | 4.5 | PASS |
| `color.muted` | `color.surface-alt` | **6.20:1** | 4.5 | PASS |
| `color.accent` | `color.bg` | **6.85:1** | 4.5 | PASS |
| `color.accent` | `color.surface` | **6.14:1** | 4.5 | PASS |
| `color.accent-hover` | `color.bg` | **9.18:1** | 4.5 | PASS |
| `color.accent-contrast` | `color.accent` | **6.71:1** | 4.5 | PASS |
| `color.accent-contrast` | `color.accent-hover` | **8.99:1** | 4.5 | PASS |
| `color.danger` | `color.bg` | **6.41:1** | 4.5 | PASS |
| `color.danger` | `color.surface` | **5.75:1** | 4.5 | PASS |
| `color.danger-contrast` | `color.danger` | **6.32:1** | 4.5 | PASS |
| `color.focus` | `color.bg` | **7.69:1** | 3 | PASS |
| `color.focus` | `color.surface` | **6.89:1** | 3 | PASS |
| `color.focus` | `color.surface-alt` | **5.79:1** | 3 | PASS |
| `color.border-strong` | `color.bg` | **4.30:1** | 3 | PASS |
| `color.border-strong` | `color.surface` | **3.85:1** | 3 | PASS |
| `color.accent` | `color.surface-alt` | **5.16:1** | 3 | PASS |
| `color.border` | `color.bg` | 1.74:1 | — | decorative |

### 6.6 `signal` / light

| fg | bg | ratio | floor | |
|---|---|---|---|---|
| `color.text` | `color.bg` | **18.42:1** | 4.5 | PASS |
| `color.text` | `color.surface` | **16.89:1** | 4.5 | PASS |
| `color.text` | `color.surface-alt` | **14.76:1** | 4.5 | PASS |
| `color.on-scrim` | `color.scrim` | **18.42:1** | 4.5 | PASS |
| `color.muted` | `color.bg` | **6.68:1** | 4.5 | PASS |
| `color.muted` | `color.surface` | **6.13:1** | 4.5 | PASS |
| `color.muted` | `color.surface-alt` | **5.35:1** | 4.5 | PASS |
| `color.accent` | `color.bg` | **6.62:1** | 4.5 | PASS |
| `color.accent` | `color.surface` | **6.07:1** | 4.5 | PASS |
| `color.accent-hover` | `color.bg` | **9.39:1** | 4.5 | PASS |
| `color.accent-contrast` | `color.accent` | **6.62:1** | 4.5 | PASS |
| `color.accent-contrast` | `color.accent-hover` | **9.39:1** | 4.5 | PASS |
| `color.danger` | `color.bg` | **7.60:1** | 4.5 | PASS |
| `color.danger` | `color.surface` | **6.97:1** | 4.5 | PASS |
| `color.danger-contrast` | `color.danger` | **7.60:1** | 4.5 | PASS |
| `color.focus` | `color.bg` | **7.10:1** | 3 | PASS |
| `color.focus` | `color.surface` | **6.51:1** | 3 | PASS |
| `color.focus` | `color.surface-alt` | **5.69:1** | 3 | PASS |
| `color.border-strong` | `color.bg` | **18.42:1** | 3 | PASS |
| `color.border-strong` | `color.surface` | **16.89:1** | 3 | PASS |
| `color.accent` | `color.surface-alt` | **5.30:1** | 3 | PASS |
| `color.border` | `color.bg` | 1.69:1 | — | decorative |

### 6.7 `signal` / dark

| fg | bg | ratio | floor | |
|---|---|---|---|---|
| `color.text` | `color.bg` | **17.89:1** | 4.5 | PASS |
| `color.text` | `color.surface` | **16.24:1** | 4.5 | PASS |
| `color.text` | `color.surface-alt` | **13.57:1** | 4.5 | PASS |
| `color.on-scrim` | `color.scrim` | **19.02:1** | 4.5 | PASS |
| `color.muted` | `color.bg` | **9.14:1** | 4.5 | PASS |
| `color.muted` | `color.surface` | **8.30:1** | 4.5 | PASS |
| `color.muted` | `color.surface-alt` | **6.93:1** | 4.5 | PASS |
| `color.accent` | `color.bg` | **7.90:1** | 4.5 | PASS |
| `color.accent` | `color.surface` | **7.17:1** | 4.5 | PASS |
| `color.accent-hover` | `color.bg` | **9.75:1** | 4.5 | PASS |
| `color.accent-contrast` | `color.accent` | **7.59:1** | 4.5 | PASS |
| `color.accent-contrast` | `color.accent-hover` | **9.37:1** | 4.5 | PASS |
| `color.danger` | `color.bg` | **6.31:1** | 4.5 | PASS |
| `color.danger` | `color.surface` | **5.73:1** | 4.5 | PASS |
| `color.danger-contrast` | `color.danger` | **6.05:1** | 4.5 | PASS |
| `color.focus` | `color.bg` | **7.67:1** | 3 | PASS |
| `color.focus` | `color.surface` | **6.96:1** | 3 | PASS |
| `color.focus` | `color.surface-alt` | **5.82:1** | 3 | PASS |
| `color.border-strong` | `color.bg` | **7.15:1** | 3 | PASS |
| `color.border-strong` | `color.surface` | **6.49:1** | 3 | PASS |
| `color.accent` | `color.surface-alt` | **5.99:1** | 3 | PASS |
| `color.border` | `color.bg` | 1.90:1 | — | decorative |

### 6.8 What this table does not prove

Stated so nobody reads more into it than is there (VERIFICATION §8):

- **`color.border` has no floor.** It is a decorative hairline and WCAG exempts
  it. The values run 1.32–1.90:1; `midnight` light is the faintest and is a
  deliberate choice, not an oversight. Anything a user must *see to operate*
  uses `color.border-strong`, which is checked.
- **Text over media is not provable from tokens.** A `full` hero puts text over
  an arbitrary image. The scrim (hero-spec §9) is what makes it provable, and
  what this table proves is that the scrim's own anchor colour clears 4.5:1
  against `color.on-scrim`. The remaining risk — a scrim too short or too
  transparent for a bright image — is a `hero` emitter concern, not a token one.
- **This is contrast only.** It says nothing about whether the type is
  legible at `type.size.xs` or whether the accent is used too often. Those are
  axe (word-gate §1 check 4) and human review.
- **WCAG 2.1, not APCA.** APCA models thin light-on-dark type better, and
  `midnight` is exactly the case where the two disagree. WCAG is what axe
  enforces and what a client audit will cite, so it is the floor we commit to.

---

## 7. The space scale

One scale. PRD §7.3, verbatim:

| Path | Value | Typical use |
|---|---|---|
| `space.4` | `4px` | icon gap, focus offset, hairline inset |
| `space.8` | `8px` | inline gap, chip padding |
| `space.12` | `12px` | button padding block |
| `space.16` | `16px` | eyebrow → title (hero-spec §7), card padding |
| `space.24` | `24px` | title → sub (hero-spec §7), mobile gutter (hero-spec §3) |
| `space.32` | `32px` | sub → buttons floor (hero-spec §7) |
| `space.48` | `48px` | sub → buttons ceiling (hero-spec §7), desktop gutter floor |
| `space.64` | `64px` | desktop gutter (hero-spec §3: 48–80) |
| `space.96` | `96px` | section end floor (hero-spec §7) |
| `space.128` | `128px` | section end ceiling (hero-spec §7) |

**Keyed by its own value.** `space.4` is `4px`, not "step 4". CONVENTIONS §4
already writes `ctx.theme.space[4]`, and value-keying makes that read correctly.
It also makes the linter rule trivial:

> **A px literal in `words/`, `target-*/` or `overlay/` is an error unless the
> number is a key of `space`.**

```
hero: '13px' is not on the space scale — use space.12 or space.16   (AZ2101)
```

Four notes:

1. **The scale is global. A theme cannot change it.** Density is expressed by
   which step a word picks, not by redefining what `space.24` means. If themes
   could rescale, a word tested in one theme would overflow in another, and
   word-gate §1 check 3 would start failing for reasons the word author cannot
   see.
2. **`0`, `1px`, `auto`, `100%`, `ch`, `svh`, `rem` and `%` are not px literals**
   and are not caught by this rule. `1px` borders come from `size.hairline`
   anyway; the lint additionally rejects a bare `1px` so there is one path.
3. **Non-spacing px is not on this scale and must not be.** Radius (`20px`),
   shadow offset (`4px`), ring width (`2px`), nav height (`72px`) are all real
   px values that are not spacing. They live in `radius`, `shadow`, `size` —
   which is why those categories exist, and why the lint rule can stay a flat
   number check with no context sensitivity.
4. **80px is not on the scale**, so hero-spec §3's "48–80px desktop gutter" is
   satisfied at `space.64` (`signal` uses `space.48`). No theme needs 80.

---

## 8. The type scale

### 8.1 Families

Set per theme (§5), overridable per site by the `font` word (PRD §6.1):

```
font
  display serif
  body    sans
```

Each token is a full stack ending in a generic family. `packages/theme` is the
only place a `font-family` name may appear (§4).

| Theme | `type.display` | `type.body` | `type.mono` |
|---|---|---|---|
| `midnight` | `<display-family>, system-ui, sans-serif` | `<body-family>, system-ui, sans-serif` | `<mono-family>, ui-monospace, monospace` |
| `paper` | `"Newsreader", Georgia, serif` | `"Source Serif 4", Georgia, serif` | `"Spline Sans Mono", ui-monospace, monospace` |
| `signal` | `"Archivo", system-ui, sans-serif` | `"Archivo", system-ui, sans-serif` | `"Space Mono", ui-monospace, monospace` |

All six faces are open-licence and self-hosted as `woff2` — the compiler never
calls a network (PRD §5, principle 1), and that includes the *generated site*
reaching a font CDN. The theme package declares its faces so the emitter can
`preload` the display face and set `font-display: swap`. Those declarations are
package metadata, **not `ctx.theme` tokens** — no word ever reads them.

*Status, 2026-10-05.* The table above is the design; **the code ships system
stacks for all three themes** (`system-ui, sans-serif` /
`ui-monospace, monospace`) and no face files yet — adding the six faces needs
licence-vetted `woff2` files (CONVENTIONS check 9). What is built:

- **`font` roles** (`display`, `body`, `mono`) each name one family from a
  closed set — `sans`, `serif`, `mono`, `rounded` — resolved by
  `FONT_STACKS` in `packages/theme` to system stacks, so nothing is downloaded
  and builds stay offline. The role overrides that `type.*` token, so every
  block reading it follows. Unknown role AZ1405, unknown family AZ1416.
- **The page's body family.** `theme.css` sets `body { font-family: type.body }`
  and form controls inherit it. Before this, text a word did not style itself
  (a hero's sub, a text block, an FAQ answer) fell back to the browser's
  default face — a serif in most browsers — on every theme.

### 8.2 Sizes — six steps, global

`clamp()` throughout: hero-spec §4 requires *"fluid, not breakpoint-stepped"*.
Each step is anchored so it hits its minimum at exactly 390px and its maximum at
exactly 1440px — the two ends of the word-gate §1 check 3 test range — and is
flat outside them.

| Path | Value | 390px | 768px | 1440px |
|---|---|---|---|---|
| `type.size.xs` | `clamp(0.75rem, 0.727rem + 0.095vw, 0.8125rem)` | 12.00 | 12.36 | 13.00 |
| `type.size.sm` | `clamp(0.875rem, 0.852rem + 0.095vw, 0.9375rem)` | 14.00 | 14.36 | 15.00 |
| `type.size.base` | `clamp(1rem, 0.954rem + 0.19vw, 1.125rem)` | 16.00 | 16.72 | 18.00 |
| `type.size.lg` | `clamp(1.25rem, 1.157rem + 0.381vw, 1.5rem)` | 20.00 | 21.44 | 24.00 |
| `type.size.xl` | `clamp(1.5rem, 1.314rem + 0.762vw, 2rem)` | 24.00 | 26.88 | 32.00 |
| `type.size.2xl` | `clamp(2rem, 1.6286rem + 1.524vw, 3rem)` | 32.00 | 37.76 | 48.00 |
| `type.size.display` | `clamp(2.5rem, 6vw, 5.5rem)` | 40.0 | 46.1 | 86.4 |
| `type.size.display-lg` | `clamp(3rem, 8vw, 7rem)` | 48.0 | 61.4 | 112.0 |

Computed at a 16px root, values in px. The two display rows are hero-spec §4
**verbatim** — `display` for `center`/`split`/`stack`, `display-lg` for
`full`/`minimal` — and are not re-derived here.

The preferred term is `A rem + C vw` rather than pure `vw` so the text still
scales when a user raises their browser's default font size. A pure-`vw` clamp
ignores that setting entirely, which is an accessibility failure axe does not
catch. hero-spec §4's display clamps are pure `vw`; they are kept verbatim
because the spec fixes them, and they are large enough that the zoom path (which
does work) covers the case.

**Why the scale stops at `2xl`.** PRD §7.3 says six steps. Anything between 48px
and the display sizes is a display size — use `type.size.display` with a smaller
`type.leading`. A seventh step is where scales start to sprawl.

### 8.3 Leading and tracking

hero-spec §4 gives the bands; each theme picks inside them (§5), and both rules
are the ones the spec calls the tells of an amateur site:

| | Band (hero-spec §4) | `midnight` | `paper` | `signal` |
|---|---|---|---|---|
| `type.leading.display` | 0.95–1.05 | 0.98 | 1.05 | 0.95 |
| `type.leading.tight` | — | 1.25 | 1.3 | 1.2 |
| `type.leading.body` | 1.5–1.7 | 1.6 | 1.7 | 1.5 |

**Tracking is a function of the size step, never a fixed value** — hero-spec §4:
*"Tie tracking to the size step, not a fixed value."* So `type.tracking` is
keyed by step, and a word writes `letterSpacing: ctx.theme.type.tracking['2xl']`
next to `fontSize: ctx.theme.type.size['2xl']`. The two always move together.

| Step | `midnight` | `paper` | `signal` |
|---|---|---|---|
| `display-lg` | −0.04em | −0.02em | −0.04em |
| `display` | −0.03em | −0.015em | −0.035em |
| `2xl` | −0.02em | −0.01em | −0.025em |
| `xl` | −0.015em | −0.005em | −0.02em |
| `lg` | −0.01em | 0 | −0.01em |
| `base` / `sm` / `xs` | 0 | 0 | 0 |
| `caps` | +0.08em | +0.12em | +0.1em |

Three rules the table encodes:

- **Negative tracking only above `lg`.** hero-spec §4: *"at 14px it needs none."*
  Every theme is `0` at `base` and below. This is a validator check, not a
  convention.
- **`caps` is the eyebrow**, and it is positive. hero-spec §4 wants the eyebrow
  small/caps/tracked — and marked up as a `<p>` or `<span>`, never an `<h2>`.
  The token styles it; the emitter owns the tag.
- **Serif display tracks looser.** `paper` sits outside hero-spec §4's
  −0.02…−0.04em band at −0.015em, deliberately: the band describes sans display
  faces, and a serif at 5rem with −0.04em collides on the ascenders. This is the
  only sanctioned deviation, and the validator allows it only when
  `type.display` resolves to a serif stack.

---

## 9. Motion tokens

### 9.1 Durations and curves

Values in §1.7. Every one is traceable to overlays-spec §3 except the spring
(§9.2). Applied:

| Case | Tokens | Source |
|---|---|---|
| dropdown / popover enter | `motion.normal` + `motion.ease.emphasis` | overlays-spec §3 |
| any exit | `motion.fast` + `motion.ease.in` | overlays-spec §3 |
| popup enter | `motion.emphasis`, backdrop `motion.backdrop` slightly ahead | overlays-spec §3 |
| drawer | `motion.slow` + `motion.ease.out` | overlays-spec §3 |
| sheet | `motion.spring.sheet` | overlays-spec §3 |
| tooltip | `motion.snap`, delays `motion.delay.tooltip-{in,out}` | overlays-spec §3 |
| toast | `motion.emphasis` in, `motion.dwell.toast` before auto-dismiss | overlays-spec §3 |
| nav `hide` / `shrink` | `motion.fast` + `motion.ease.out` | nav-spec §3 |

**Exit is always faster than enter** — 120ms out against 160ms in. overlays-spec
§3: the user has already decided, so a slow dismissal reads as unresponsive.
The validator asserts `motion.fast < motion.normal`; it is the one motion
relationship worth checking mechanically because it is the one that gets
"tidied" into symmetry.

**Themes cannot override motion.** A theme that made everything 400ms would
break the enter/exit relationship and the tooltip delays that stop it flickering
on pass-through, in every word at once, invisibly.

### 9.2 The sheet spring

overlays-spec §3 asks for a spring on the sheet — *"the one place a spring earns
its keep"* — inside a 280ms budget. A spring is specified by physics, not a
duration, so the values are derived rather than cited:

`{ stiffness: 300, damping: 30, mass: 1 }`

- damping ratio ζ = 30 / (2·√(300·1)) = **0.866** — underdamped, so it settles
  rather than stopping dead
- ω = √300 = 17.32 rad/s; settling time to 2% ≈ 4/(ζω) = **267ms**, inside the
  280ms budget
- peak overshoot = e^(−πζ/√(1−ζ²)) = **0.43%** — perceptible as a settle, not as
  a bounce

For comparison, `{ stiffness: 320, damping: 34 }` gives ζ = 0.950 and 0.01%
overshoot: it settles faster (235ms) but has no spring in it at all, which
defeats the reason overlays-spec §3 asked for one.

### 9.3 Reduced motion

```ts
motion.reduced = { duration: '100ms', properties: ['opacity'] }
```

hero-spec §9 and overlays-spec §1/§3 both state the rule in the same words:
**opacity-only or instant — never "slower".** A reduced-motion user who gets a
600ms version of the same slide is worse off than before.

What this means per case, and all of it is checked by word-gate §1 check 6:

| Normally | Under `prefers-reduced-motion` |
|---|---|
| overlay enter/exit | opacity only, `motion.reduced.duration` |
| sheet spring | no spring — opacity, 100ms |
| nav `hide` / `shrink` | **instant.** nav-spec §3 says so explicitly |
| hero `scroll` / `parallax`, 3D camera | **nothing.** `static` tier: poster image, no scroll-linked camera (hero-spec §9, PRD §6.4) |
| toast auto-dismiss | unchanged — `motion.dwell.toast` is a timeout, not motion |

The `static` tier is a *rendering* decision made at the target level (PRD §6.4),
not something a token can express. `motion.reduced` covers the CSS transitions;
the tier covers whether the scene mounts at all. A word must honour both, and
they are different mechanisms — this is the most common place to ship half the
fix.

---

## 10. Authoring and validating a theme

### 10.1 File shape

```
packages/theme/
├── tokens/
│   ├── space.ts          the ten steps — global, no theme overrides it
│   ├── motion.ts         durations, curves, spring, reduced
│   ├── layer.ts          the z-index stack
│   ├── breakpoint.ts     xs / sm / lg
│   └── type-scale.ts     the six clamp() steps + the two display sizes
├── themes/
│   ├── midnight/
│   │   ├── theme.ts      the whole theme — one file, data only
│   │   └── faces/        self-hosted woff2
│   ├── paper/
│   └── signal/
├── schema.ts             the closed unions; the source for §1
├── resolve.ts            Theme → ResolvedTheme + CSS custom properties
├── contrast.ts           hsl → sRGB → WCAG ratio
└── contrast.test.ts      regenerates §6 and fails on any drift
```

One file per theme, containing only data. Adding a theme touches no other file —
the same property CONVENTIONS §3 demands of a word, for the same reason.

```ts
// packages/theme/themes/midnight/theme.ts
import type { Theme } from '../../schema.js';

export const midnight: Theme = {
  name: 'midnight',
  defaultScheme: 'dark',
  color: {
    light: { bg: 'hsl(220 30% 97%)', /* … all 16 … */ },
    dark:  { bg: 'hsl(230 30% 7%)',  /* … all 16 … */ },
  },
  shadow: { light: { /* sm md lg */ }, dark: { /* sm md lg */ } },
  size:   { container: '1280px', nav: '72px', /* … */ },
  type:   { display: '<display-family>, system-ui, sans-serif', /* … */ },
  radius: { sm: '6px', md: '12px', lg: '20px', full: '9999px' },
};
```

`Theme` has no `space`, `motion`, `layer` or `breakpoint` field. A theme cannot
override a global category because there is nowhere to write it — which is
stronger than a lint rule and needs no error message.

### 10.2 Acceptance checks

`pnpm gate theme/<name>`. All must pass:

| # | Check | Fails when |
|---|---|---|
| 1 | **Completeness** | any of the 16 colour tokens missing from either scheme, or any `size`/`type`/`radius`/`shadow` token missing |
| 2 | **Both schemes present** | `color.light` or `color.dark` absent — word-gate §1 check 7 depends on this |
| 3 | **Contrast** | any pair in §6 below its floor. Recomputed from source; no stored numbers |
| 4 | **No global overrides** | a `space`/`motion`/`layer`/`breakpoint` key appears in `theme.ts` (type error) |
| 5 | **Colour format** | any value not parseable as `hsl(H S% L%[ / A])` |
| 6 | **Tracking rule** | negative tracking at `base` or below (§8.3) |
| 7 | **Ring offset** | `size.ring-offset` < `1px` — the §6.1 focus fix depends on it |
| 8 | **Scheme structure** | any token defined only inside a media/`[data-scheme]` block (§3.2) |
| 9 | **Font licence** | a face in `faces/` without an OFL/Apache licence file beside it |
| 10 | **Every block renders** | all 11 blocks × every variant × this theme × light/dark, snapshot clean |

Check 10 is the expensive one and the reason ROADMAP M2 budgets themes
alongside words rather than after them: *"3 themes, all words rendering
correctly in each, light and dark."* Adding a fourth theme multiplies the visual
snapshot count by 4/3 — a real, and acceptable, cost.

Check 3 must be a **test that recomputes**, never a stored table. A stored table
is a comment, and comments lie (this document's §6 is generated output, and
regenerating it is how it stays true).

### 10.3 Selecting a theme

```
az 1
site aurora
theme midnight
```

Unknown theme, per CONVENTIONS §5's message format:

```
theme: 'midnite' is not a theme — try: midnight, paper, signal   (AZ2110)
```

---

## 11. Deliberately not in the theme

**No "generate a palette from a hex code."** PRD §7.3 rules it out and PRD §10
explains why: auto-generated palettes are precisely what makes a site look
templated, and looking non-templated is the entire value proposition. A
generator would also make §6 unprovable — you cannot ship a contrast table for
a palette that does not exist yet, so the a11y floor would degrade from
*proven* to *usually*.

Also out, and for related reasons:

| Not shipping | Why |
|---|---|
| Per-word theme overrides (`hero accent:#ff0`) | it is the theme rule with extra steps; the ransom note returns one word at a time |
| Runtime theme switching (theme, not scheme) | three full token sets in the bundle, for a feature a marketing site does not have. Scheme switching *is* supported (§3) |
| A `color.brand` free slot | a token nothing checks. It would be used for exactly the literals §4 bans |
| Theme-level spacing density | §7 note 1 — a word tested in one theme would overflow in another |
| Semantic colour ramps (`accent.100`…`900`) | 16 role tokens fit a marketing page. A ramp invites picking by number instead of by role (§2) |

The escape hatch for anyone who needs more is the one PRD §6.6 already
provides: `raw`, `slot`, and `eject`. A custom component mounted via `raw`
receives the theme (ROADMAP M3) and is not lint-scoped, so it can do whatever it
likes — visibly, in the user's own file, rather than by weakening the rule for
everyone.

---

## 12. Open questions

1. **Is three enough?** PRD §7.3 says 3–4. Three cover dark-product, editorial
   and industrial. The missing archetype is *warm/organic* — hospitality,
   wellness, food. Recommend deciding after M5: a fourth theme costs a third
   more visual snapshots (§10.2 check 10) and the dogfood site will say whether
   the gap is real.
2. **Does `page` own `color.bg`, or may a section override it?** hero-spec §12
   Q1 recommends `page` owns background. If a section may set its own, the
   contrast table needs a row per legal section background, which roughly
   doubles §6. Recommend: `page` owns it, sections get `color.surface-alt` for
   banding — no new tokens, no new rows.
3. **Should `color.accent-hover` be authored, or derived?** Deriving it (a fixed
   lightness delta) is fewer values and guarantees direction, but it fails on
   an accent already near the extremes. Authored for now — the §6 rows prove it
   either way.
4. **Does `theme.value()` (§3.4) need to exist before M2?** Only if a `scene` or
   `hero 3d` word tints from the theme in M2. If the M0 spike hardcodes its
   lighting, this can wait — but ARCHITECTURE §4.3 should record the intent now
   rather than growing the contract later.

---

## 13. Accent pairs and gradients

*Built (2026-10-10).* Colour is the first decision of every site (PRD §6.1a),
and a product site often wants two colours in one accent — a gradient. §11
still holds: there is no "generate a palette", no free hex, no ramp exposed by
number. A pair is two names from the closed hue set, and only the pairs whose
whole gradient is proven are offered. The proof is a generator, the way §6 is,
and the table it writes is what the compiler checks against.

### 13.1 Grammar

```
theme midnight
  accent violet blue        # first hue → second hue
```

`accent <hue> [<hue2>]`. One hue is exactly what it was before this section:
every emitted file of a one-hue site is byte-identical (checked over every
word preview in all three themes and four accent/pattern settings — 189 sites,
5320 files). A second hue must be an allowed partner of the first on the
site's theme; otherwise the compiler stops with AZ1423 naming the partners:

```
theme: accent 'violet indigo' is not a pair on midnight — violet pairs with blue, teal, orange, rose   (AZ1423)
```

`az explain theme accent` prints one line per hue with its partners.

### 13.2 The pair rule

`packages/theme/src/gradient.ts` decides; every number is a named constant
there.

1. **Hue distance** — the two ramps' OKLCH hues (`ACCENT_HUE_DEGREES`, written
   by `scripts/gen-ramps.mjs`) are **30°–120°** apart, measured the short way
   round. Closer reads as one flat colour; further sweeps through hues nobody
   chose (and at 180° the direction is ambiguous).
2. **No grey middle** — along every chroma-bearing rendering (below), the
   weakest point keeps **0.8** of the weaker end's OKLCH chroma.
3. **Contrast at every point, both schemes** — each end is the hue's own
   accent from §6's accent picker, so the ends already hold their floors; the
   proof is about the points between them. Every sampled point of the rest
   gradient holds 4.5:1 on `bg` and `surface` and 3:1 on `surface-alt` (the
   pricing edge); the hover gradient holds 4.5:1 on `bg`; and one label,
   `color.on-gradient`, holds 4.5:1 against every point of both gradients. The
   label is the first of: the first hue's `accent-contrast`, the second's,
   `bg`, `text`.
4. **Pattern** — under the two-hue glow/spotlight/ramp at
   `PATTERN_MAX_ALPHA` (and at ¼, ½, ¾ of it), `text`, `muted`, `accent`,
   `accent2` hold 4.5:1 and `border-strong` 3:1, as §6 and the pattern proof
   require of one hue.

A gradient reaches a visitor in one of three renderings, and **all three are
sampled** (256 points each; the test re-samples at 1024):

| Rendering | Where | Sampled for |
|---|---|---|
| `linear-gradient(to right in oklch, a, b)` | engines with OKLCH gradient interpolation — Chromium 153, Firefox 155 and WebKit 26.6 in the gate all report it | contrast, chroma |
| a stop list of `color-mix(in oklch, a p%, b)` at 0/25/50/75/100%, interpolated in sRGB between stops | engines with color-mix but not gradient interpolation | contrast, chroma |
| `linear-gradient(to right, a, b)` in sRGB | any engine | contrast only — its grey middle is why the other two exist |

An OKLCH point outside sRGB is sampled both channel-clipped and
chroma-reduced, since engines differ. Ratios are truncated as in §6.

A failure in any scheme refuses the pair on that theme. The table is per
theme because the grounds differ: `signal` refuses `green amber` (its light
hover gradient keeps 0.79 of its chroma) while `midnight` and `paper` allow
it.

### 13.3 The allowed pairs

Generated by `node scripts/gen-pairs.mjs` into
`packages/core/src/accent-pairs.ts` (names only, so the linker can refuse a
pair without importing the theme — ARCHITECTURE §2).
`packages/theme/test/gradient.test.ts` regenerates it and fails on any drift,
then re-proves every listed pair from the tokens it ships. Pairs are symmetric:
`violet blue` and `blue violet` are the same pair, drawn the other way.

| Hue | midnight | paper | signal |
|---|---|---|---|
| violet | blue, teal, orange, rose | blue, teal, orange, rose | blue, teal, orange, rose |
| indigo | teal, rose | teal, rose | teal, rose |
| blue | violet, teal | violet, teal | violet, teal |
| teal | violet, indigo, blue, green, lime, amber | violet, indigo, blue, green, lime, amber | violet, indigo, blue, green, lime, amber |
| green | teal, amber | teal, amber | teal |
| lime | teal, amber, orange, rose | teal, amber, orange, rose | teal, amber, orange, rose |
| amber | teal, green, lime, rose | teal, green, lime, rose | teal, lime, rose |
| orange | violet, lime, rose | violet, lime, rose | violet, lime, rose |
| rose | violet, indigo, lime, amber, orange | violet, indigo, lime, amber, orange | violet, indigo, lime, amber, orange |

18 pairs on midnight and paper, 17 on signal. Refused inside the hue window:
`blue green` (its middle keeps 0.55–0.59 of its chroma) and `green orange`
(0.67–0.72) on every theme, and `green amber` on signal.

**A new theme joins** by being added to `THEMES` and running the generator;
nothing else changes. If its grounds refuse a pair the others allow, the
table says so and the compiler follows it.

### 13.4 Tokens

Declared only on a pair site, after the scheme blocks; a one-hue site has none
of them.

| Path | What | Value |
|---|---|---|
| `color.accent2` | the second hue's accent | the §6 accent picker run on the second hue, per scheme |
| `color.accent2-hover` | its hover | likewise |
| `color.on-gradient` | label on the gradient fill, rest and hover | the first passing candidate of rule 3 |
| `gradient.accent` | `accent` → `accent2` | the three-tier declaration below |
| `gradient.accent-hover` | `accent-hover` → `accent2-hover` | likewise |

Words read `gradient.*` as `var(--az-gradient-…)` through
`ctx.theme.gradient`, which exists only on a pair site (core
`emit-contract.ts` `ThemeLike.gradient`); `color.accent2`, `color.accent2-hover`
and `color.on-gradient` exist only then too. As with §11's "no ramps by
number", `accent2` is a role, not a ramp step: the second hue's ramp is not
exposed.

```css
:root {
  --az-gradient-accent: linear-gradient(to right, var(--az-color-accent), var(--az-color-accent2));
  …
}
@supports (color: color-mix(in oklch, transparent, transparent)) {
  :root { --az-gradient-accent: linear-gradient(to right, var(--az-color-accent),
    color-mix(in oklch, var(--az-color-accent) 75%, var(--az-color-accent2)), …, var(--az-color-accent2)); … }
}
@supports (background-image: linear-gradient(in oklch, transparent, transparent)) {
  :root { --az-gradient-accent: linear-gradient(to right in oklch, var(--az-color-accent), var(--az-color-accent2)); … }
}
```

Every tier is valid wherever it applies, so a `var(--az-gradient-…)` never
makes a background invalid at computed-value time. The values are references,
so the gradient follows the scheme with no copy per scheme.

### 13.5 Where a gradient is painted

Opt-in by the pair; nothing else changes.

| Surface | With a pair | Without |
|---|---|---|
| Primary action (`ctx.actions`, buttons-spec §1) | `gradient.accent` over the solid `color.accent`, label `color.on-gradient`, a transparent 1px border, `background-origin: border-box`; hover and pressed `gradient.accent-hover` | solid accent, as before |
| Pricing highlighted plan edge | the gradient as a border-box layer under a padding-box `surface-alt` fill, the edge transparent — corners keep their radius | `color.accent` edge |
| `pattern glow` / `spotlight` / `ramp` | first hue nearest the origin, the second taking over halfway along the fade (`PATTERN.glowMid`/`spotMid`/`rampMid`) | one hue |
| `pattern grid` / `hatch` / `dots` | unchanged — a hairline cannot show a gradient | |

Not painted: the cta `band` (its surface stays `color.accent`, so its inverted
buttons keep their proven pairs), links, the focus ring, inverted actions.
**A headline highlight is not built**: GRAMMAR has no emphasis form inside a
title, and this section adds no syntax. It is a follow-up that needs a grammar
decision first.

### 13.6 Accessibility and policy

- **Focus** — unchanged: the ring is `color.focus` at `size.ring-offset`, so
  it sits on the ground, never on the gradient (§6.1). Off the page (a scrim)
  it is drawn in the surface's ink as before.
- **Disabled** — the `disabled` state sets the `background` shorthand, which
  clears the gradient: a disabled primary is flat `surface-alt`.
- **Forced colours** — engines drop background images there; the transparent
  border is painted in a system colour, so the button and the highlighted plan
  keep a visible edge. Checked in a browser by `pnpm test:visual` (Chromium
  emulation).
- **Motion** — gradients are static; nothing animates or transitions, so the
  reduced-motion net has nothing to undo.
- **Content-Security-Policy** — gradients are declarations in `theme.css`
  and generated classes in `az.css`. No page carries an inline `style`
  for them, so the policy (PRD §6.1a) is unchanged.
