# Buttons, sections & content — inventory and spec

**Status** draft · Companion to AZ Web PRD v0.2 and the `hero` spec

Everything a website needs, sorted by **what it actually costs to build**.

---

## 0. Three categories — the distinction that matters

| Category | What it is | Examples | Cost each |
|---|---|---|---|
| **Primitive** | used *inside* blocks, never placed directly | button, link, input, badge | build once |
| **Block** | a section you place in a page | hero, pricing, faq, team | 1–5 days |
| **System** | a machine with routing, indexing, state | blog, docs, help, search, auth | 2–5 **weeks** |

**Putting a system in the block list is how this project dies.** `blog` looks
like one word next to `faq`. It is thirty times the work.

---

## 1. Buttons

### 1.1 A button is a primitive, not a word

You never write `button` in `.az`. Blocks expose CTA slots:

```
hero center
  cta "Reserve a pair"  /reserve
  alt "Call the studio" tel:+50412345678
```

Reason: a loose `button` word would let users place buttons anywhere, and
button placement is exactly the thing the block should be deciding.

### 1.2 Two independent axes

Most systems conflate these. Keep them separate.

**Hierarchy** — how much visual weight:

| Level | Style | Rule |
|---|---|---|
| `primary` | filled, accent | **max one per section** |
| `secondary` | outline | pairs with primary |
| `ghost` | no border, hover fill | toolbars, dense UI |
| `link` | text + underline on hover | tertiary actions |

**Intent** — what it does. This one is usually missed, and it's where the
correctness lives:

| Intent | Destination | Compiler emits |
|---|---|---|
| `go` | `/path` | `<a href>` |
| `call` | `tel:` | `<a href="tel:">`, phone icon, tap-to-call |
| `mail` | `mailto:` | `<a href="mailto:">`, mail icon |
| `download` | `.pdf` `.zip` | `download` attr, size label, download icon |
| `external` | `https://other.com` | `target="_blank" rel="noopener noreferrer"`, arrow icon |
| `play` | `video:` | opens player, focus trap, pause control |
| `show` | `#section` | smooth scroll, respects reduced-motion |
| `copy` | `copy:text` | `<button>`, clipboard API, "Copied" confirmation |

### 1.3 Intent is auto-detected

Don't make users declare it — infer from the destination:

```
alt "Call the studio"   tel:+50412345678     → call
alt "Get the deck"      ./deck.pdf           → download (+ "2.4 MB")
alt "Read the paper"    https://arxiv.org/…  → external (+ new tab, rel)
```

Override only when needed: `cta "Reserve" /reserve as ghost`.

This follows principle 6 — *the word describes intent, the target decides
implementation.*

### 1.4 The `<a>` vs `<button>` rule

**Navigates somewhere → `<a>`. Performs an action → `<button>`. Never a `<div>`.**

Almost every hand-built site gets this wrong, and it breaks keyboard nav,
middle-click, and screen readers. A template that gets it right every time is a
real, invisible quality difference — exactly the kind that never shows up in a
demo and always shows up in an audit.

### 1.5 States — all six, or it's not done

`default` `hover` `active` `focus-visible` `disabled` `loading`

- **`focus-visible`, never `outline: none`.** Keyboard users are not optional.
- **`loading` must not change width.** Swap label for spinner at fixed width, or
  the whole layout jumps. Set `aria-busy="true"`.
- **Avoid `disabled` on submits.** A disabled button gives no reason. Prefer
  enabled + inline error explaining what's missing.
- 44×44px minimum touch target including padding.

### 1.6 Labels and icons

- Verb + object, 1–4 words, sentence case: "Reserve a pair", not "SUBMIT"
- Label survives the journey: "Reserve" → page says "Reserve" → toast says "Reserved"
- Icon **leading** when it clarifies type (call, download); **trailing** when it
  shows direction (external, next). Never both.
- Icon-only buttons need `aria-label`. Always.

---

## 2. Section inventory

### Tier A — pure layout (1–2 days each)

Cheap, no state, no interactivity. These are the volume.

| Word | Purpose | Note |
|---|---|---|
| `logos` | client/press logo row | grayscale + opacity, or it looks like a mess |
| `stats` | big numbers | 3–4 max; one decimal max |
| `testimonial` | quote + attribution | needs a real face or none at all |
| `team` | people grid | 
| `steps` | numbered process | only if it's genuinely ordered |
| `timeline` | dated history |
| `contact` | address, map, hours |
| `newsletter` | single email capture | one field. Never two |
| `banner` | announcement strip | must be dismissible |
| `legal` | privacy / terms body | plain, generous measure |
| `notfound` | 404 | needs search or nav back |

### Tier B — layout + state (3–5 days each)

| Word | Purpose | Hidden cost |
|---|---|---|
| `feature` | feature grid/rows | 3 sub-variants (grid, alternating, bento) |
| `gallery` | image/media grid | lazy-load, lightbox, focus trap, keyboard nav |
| `pricing` | plan comparison | monthly/annual toggle, "most popular", currency |
| `faq` | accordion | correct ARIA, deep-linkable, one-open-at-a-time option |
| `tabs` | tabbed content | full keyboard roving tabindex |
| `compare` | feature matrix | horizontal scroll on mobile is the hard part |

### Tier C — systems (2–5 weeks each) — NOT words

| Name | Why it's a system |
|---|---|
| `blog` | markdown pipeline, frontmatter, slugs, index + detail routes, pagination, tags, RSS, OG images, reading time |
| `docs` | all of the above + sidebar tree, TOC, syntax highlighting, versioning, prev/next |
| `help` | all of the above + categories, search, feedback widget |
| `search` | index build, client-side query, ranking, empty states |

---

## 3. The content system

**Blog, docs, and help are one pipeline with three presets.** Build the machine
once; the presets are chrome.

```
az 1

content blog ./posts
  layout   list
  perpage  12
  rss      on

content docs ./docs
  layout   sidebar
  toc      on
  versions v1 v2
```

Shared pipeline: read markdown → parse frontmatter → build routes → generate
TOC → build search index → emit sitemap + RSS.

Preset differences are only: index layout, navigation chrome, and sort order
(blog = date desc, docs = manual tree, help = category).

**This is the single highest-leverage decision in this document.** Three
separate blocks = three pipelines to maintain and three places for bugs. One
pipeline = one place, and adding `changelog` later becomes a preset, not a
project.

---

## 4. Honest scope impact

Phase 1 is capped at **11 block words** (PRD §6.2). This document adds:

- 11 Tier A + 6 Tier B blocks = **17 blocks**
- 1 content system (≈3 words) = **3–4 weeks alone**
- button primitive with 4 hierarchies × 8 intents × 6 states

**Realistic total if you build all of it: 5–7 months, not 10–11 weeks.**

That is not an argument against building it. It's an argument against building
it *before M5*. The PRD's reasoning still holds: every word written before a
real site ships is a guess, and guessed words are the expensive kind — you
maintain them forever whether they were right or not.

### Recommended sequencing

| Phase | Add | Why |
|---|---|---|
| **1 (unchanged)** | the original 20 + button primitive | button is a primitive — it was always implied by `cta`, not a new word |
| **1.5 — after M5** | Tier A (11 words) | cheap, and by now you know which you actually needed |
| **2** | Tier B (6 words) | the interactive ones, informed by real usage |
| **2.5** | content system + blog/docs/help presets | the big one. Give it its own milestone |
| **3** | search, changelog | presets on top of content |

**The button primitive is the one thing from this document that belongs in
Phase 1**, because `hero` already has `cta` and `alt` slots. Specifying it
properly now costs nothing extra and prevents every later block inventing its
own button.

---

## 5. What to cut

Say no to these now, or they'll arrive as "just one more word":

- **e-commerce / cart / checkout** — that's a product, not a block
- **comments** — moderation, spam, storage; use a third-party embed
- **i18n** — touches every block; a Phase 3 architecture decision, not a word
- **CMS / visual editor** — triples scope, changes the target user
- **dashboard/app UI** — different product entirely; AZ Web is marketing sites

---

## 6. Open questions

1. Does `feature` split into three words (`feature`, `bento`, `alternating`) or
   stay one word with modifiers? *(Recommend: modifiers — consistent with `hero`.)*
2. Where does `search` live — a block, a nav modifier, or a content-system flag?
3. Do Tier A blocks each need mobile motion variants, or does a shared default
   cover them? *(This decides whether Tier A is 11 days or 22.)*
