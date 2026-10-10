# `text` — block specification

**Status** draft for M2 · Companion to the `hero`, `feature` and `gallery` specs

`text` is the block with the least layout and the most typography. It exists so
a page can say something in sentences without an author reaching for `raw`, and
everything interesting about it is measure, rhythm and what happens to the
markdown on the way in. It is the cheapest block in Phase 1 to build and the
easiest to get wrong: "just a paragraph" is where justified text, 100-character
lines and colour-only links all come from.

---

## 1. Syntax

```
az 1

text prose
  title "Why we stopped taking commissions"
  body  ./content/commissions.md
  cta   "Read the workshop notes" /journal

text centered reveal
  body "Forty pairs a month. It is not a strategy, it is the size of the room."
```

**Variants are mutually exclusive:** `prose` `centered` `columns`. Two =
compile error. Default is `prose`.

**Modifiers combine freely:** `reveal`.

`body` takes either an inline quoted string or a path ending `.md`, told apart
by the value — the same auto-detection buttons-and-sections §1.3 already uses
for destinations, so this adds no grammar. **Inline `body` is one paragraph.**
Anything with a second paragraph goes in a `.md` file; the compiler says so
rather than inventing a multi-line string form for one word.

## 2. Choosing a variant

| Variant | Use when | Watch out for |
|---|---|---|
| `prose` | the default. An about section, a manifesto, a long answer | it is the block that most often gets pasted into rather than written — 900 words here is a page pretending to be a section |
| `centered` | one short statement that should land like a line of poetry | centred text is unreadable past ~3 lines; the ragged left edge is what kills it, and nothing about the type can save it |
| `columns` | a short editorial passage where the page wants a printed feel | a column taller than the viewport makes the reader scroll down and back up. This is the entire reason newspapers are wide and short |

**Default to `prose`.** `centered` is a statement, not a layout — if you find
yourself centring three paragraphs, you wanted `prose` and a narrower measure.
`columns` is the only variant with a hard content window: below ~120 words there
is nothing to split, above ~300 the columns get taller than the screen. Outside
that window it is the wrong variant, and the compiler warns at both ends.

## 3. Measure, layout and spacing

Measure is the whole job. Values are theme tokens (theme-spec §1): the `space`
scale is keyed by its own px value, and measures are in `ch` so they follow the
font rather than fight it — the same reasoning as hero §3.

| | Value |
|---|---|
| `prose` measure | `size.measure-body` (58–62ch). The theme owns it; this block never widens it |
| `centered` measure | 32–40ch, floor 28ch — no token exists yet, see §12.6 |
| `columns` measure | 38–45ch **per column**, gap `space.48` |
| `title` measure | `size.measure-display` |
| `title` → `body` | `space.32` |
| paragraph → paragraph | `space.24` — roughly one line of body leading |
| `body` → `cta` | `space.48` |
| Section padding block | `space.96`, `space.64` below `breakpoint.sm` |

**One paragraph separator, never two.** A blank line *or* a first-line indent —
using both is the most common typographic error on the web, and it is what
makes a page look like a word processor rather than a book.

`columns` sets `column-fill: balance`, plus `break-inside: avoid` on headings,
blockquotes and lists and `break-after: avoid` on headings — otherwise a
sub-heading lands as the last line of column one with its paragraph in column
two, which reads as a fault.

## 4. Type

The rules that differ from the defaults, and the reasons:

```
body        type.body  type.size.lg    type.leading.body   type.weight.body
title       type.display  type.size.2xl  type.leading.tight  type.tracking.2xl
blockquote  same as body; weight unchanged, color.muted, rule in color.border
code        type.mono  type.size.base  in color.surface-alt
```

- **Marketing prose is read further from the screen than app text.** `type.size.lg`
  rather than `.base` is the difference between "readable" and "designed", and
  `type.leading.body` and `type.leading.display` are unrelated scales that must
  never share a value (hero §4).
- **Never justify.** `text-align: start`, always. Browsers hyphenate
  inconsistently across languages and platforms, so justified web text produces
  rivers of white and stranded words. Justification is not offered as a prop.
- `text-wrap: pretty` on paragraphs — it fixes widows without markup. `balance`
  goes on the `title` only; balancing a long paragraph is wasted work and can
  leave a stubby final line.
- **Links in prose are underlined.** Colour alone fails WCAG 1.4.1, and inside
  a paragraph there is no other cue. Underline offset and thickness come from
  theme tokens so the underline clears descenders instead of striking them.
- Blockquotes get a rule and an indent of `space.24`. No oversized decorative
  quote glyph — it is the single most dated device in this document.
- No all-caps runs longer than a label, and no letter-spacing on body sizes.
  Tracking scales with size, and at body size the correct amount is none.

## 5. Markdown: what is accepted, what is stripped

`text` parses **CommonMark plus GitHub-style tables and strikethrough**, and
nothing else.

| Accepted | Rendered as |
|---|---|
| paragraphs, emphasis, strong, strikethrough | inline elements |
| `##` / `###` headings | shifted — see §8 |
| ordered and unordered lists, nested | `<ol>` / `<ul>` |
| links | intent auto-detected exactly as in buttons §1.3 — an external href gets `target="_blank" rel="noopener noreferrer"` |
| blockquote | `<blockquote>` |
| inline code, fenced code | `<code>`, `<pre tabindex="0">` — **no syntax highlighting**; that is a docs-system concern and a dependency this word does not earn |
| horizontal rule | `<hr>` |
| images | same treatment as `gallery` §7 — intrinsic size read at build, `loading="lazy"`, alt required |
| tables | wrapped in a focusable horizontal scroll container |

| Stripped, unconditionally | Why |
|---|---|
| **all raw HTML tags and HTML comments** | see below |
| `javascript:`, `vbscript:`, `data:` URLs in links and images | script execution via a content file |
| footnotes, definition lists, directives, frontmatter-in-body | not in the subset; silent extra syntax is how content drifts between blocks |

**Raw HTML is stripped, not opt-in.** word-quality-gate §2B says "strip raw HTML
by default, opt-in per file"; this spec narrows that: in `text`, the opt-in does
not exist. The escape hatch is the `raw` word, which PRD §6.2 already lists as
a structure word and which exists for precisely this. One escape hatch that is
obvious in the source beats a per-file flag that makes an ordinary-looking
content file dangerous. **This is a deliberate narrowing of the gate document
and should be reconciled there.**

A path in `body` resolves through `ctx.asset()` (ARCHITECTURE §4.3), so
`body ../../../etc/passwd` fails at compile with a path error, not at read.
Content is escaped at emit and never string-concatenated into generated source
(CONVENTIONS §6) — a heading containing `</script>` must not break out, and
there is a fixture for it.

## 6. CTA

`text` takes `cta` (max 1) and `alt` (max 1). Slots, hierarchy, intent
detection and the six states are buttons-and-sections §1 and are not restated.

The one rule specific here: **a prose block's CTA sits after the body, never
mid-paragraph.** An inline markdown link is the mid-paragraph action, and it is
already the right control for that job. A button interrupting a sentence is a
banner wearing a paragraph's clothes.

## 7. Responsive behaviour

| Variant | <768px |
|---|---|
| `prose` | unchanged. The measure cap never binds at phone widths — the **gutter** sets the width, and the gutter is the page container's, not this block's |
| `centered` | unchanged, floor 28ch. A statement that runs past 3 lines at 390px has stopped being a statement; the compiler warns rather than silently reflowing it into a paragraph |
| `columns` | **collapses to one column at `breakpoint.md`** (1024px — proposed, §12.6), not `breakpoint.sm`. Two 38ch columns plus a `space.48` gap need roughly 900px; below that this variant is already `prose`, so it says so instead of shipping two 22ch columns |

`columns` collapsing early is the whole reason it needs its own row here: a
breakpoint copied from the other blocks would produce the exact broken layout
this table exists to prevent.

## 8. Heading levels and accessibility floor

Heading structure is where this block can break a whole page, because markdown
brings its own headings:

- **`title` emits `<h2>`.** `text` never emits an `<h1>` — the hero owns the
  only one (hero §4).
- Markdown headings are **shifted, never emitted at their authored level.**
  With a `title` present, the highest level in the file becomes `<h3>`; with no
  `title`, it becomes `<h2>`. So `#` in a content file is never an `<h1>`, and
  the outline never skips a level however the file was written.
- After shifting, levels clamp at `<h4>`. A marketing section with four heading
  levels is a docs page; the compiler says that rather than emitting `<h6>`.
- The section is a `<section aria-labelledby>` when it has a `title`, and a
  plain container when it does not — an unlabelled landmark is noise.

The rest of the floor:

- Prose links underlined, and `focus-visible` rings on all of them — never
  `outline: none`.
- Link text is meaningful out of context. "Read more" repeated four times gives
  a screen-reader user four identical entries in a link list.
- Every markdown image needs alt text; `![](…)` is accepted **only** as an
  explicit empty alt on a decorative image, which the compiler makes the author
  write as `![]()` rather than infer from a missing attribute.
  *Resolved at implementation (2026-09-23):* markdown has no image without an
  alt — `![](bench.webp)` **is** the written-empty form, so it renders
  `alt=""` (decorative) and the §10 "no alt" row cannot fire on a `.md` file.
  Images and file links resolve relative to the `.md` file, through the same
  asset sandbox as every other path.
- `<pre tabindex="0">` on code blocks and `tabindex="0"` on the table scroll
  container: a region that scrolls must be reachable by keyboard, which is the
  most-missed rule in this list.
- Contrast ≥ 4.5:1 on body text. Grey body copy at 55% opacity is the failure
  this block ships most often.
- Text reflows to 320px with no horizontal scroll (WCAG 1.4.10) — the tables
  and code blocks scroll inside their own container, never the page.

## 9. The `reveal` modifier

Same engine as `feature` §9 — script-applied hidden state, once only, observer
disconnected, nothing hidden by CSS alone, no observer at all under
`prefers-reduced-motion`.

Two rules specific to text:

- **Reveal the block, not the paragraphs.** Staggering paragraphs means the
  reader reaches the bottom of paragraph one and waits for paragraph two.
  Reading speed is not a scroll position, and the block has no way to know
  which.
- `reveal` on `prose` is discouraged outright and warned about. It reads as jank
  on the one block whose entire job is to be read. On `centered` — a single
  statement, arriving as a unit — it earns its place.

## 10. Compiler validations

| Check | Message |
|---|---|
| two variants | `text: 'prose' and 'columns' are both layouts — pick one` |
| no `body` | `text: no body — add: body "…" or body ./content/about.md` |
| inline `body` with a blank line | `text: inline body is one paragraph — move it to a .md file` |
| `body` path not `.md` | `text: 'about.txt' is not markdown — rename it .md` |
| `body` outside the project | `text: 'commissions.md' resolves outside the project — move it under the project root` |
| raw HTML in the file | `text: html in 'about.md' is stripped — use the 'raw' word if you need markup` |
| `javascript:` URL | `text: 'javascript:' link in 'about.md' is not allowed — use a path or an https url` |
| `prose` over 800 words | `text: 1,400 words is an article, not a section — move it to 'content'` |
| `centered` over 60 words | `text: 'centered' is for one statement, this is 90 words — use 'prose'` |
| `centered` over 3 lines at 390px | `text: the statement wraps to 5 lines on a phone — shorten it or use 'prose'` |
| `columns` under 120 words | `text: 60 words is too short to split — use 'prose'` |
| `columns` over 300 words | `text: 420 words makes columns taller than the screen — use 'prose'` |
| `#` heading in the file | `text: '# Our story' becomes an h2 — the page h1 belongs to the hero` |
| heading level skipped | `text: 'Materials' jumps from h2 to h4 — use the next level down` |
| headings past 4 levels | `text: 4 heading levels is a docs page — flatten it, or use 'content'` |
| markdown image with no alt | `text: image 'bench.webp' has no alt text — write ![]() if it is decorative` |
| weak link text | `text: 'click here' says nothing out of context — name the destination` |
| table wider than 6 columns | `text: an 8-column table will scroll on a phone — cut columns, or wait for 'compare'` |
| `reveal` with `prose` | `text: 'reveal' delays the one block people came to read — drop it, or use 'centered'` |
| `title` over 10 words | `text: 'Why we decided to stop taking on new commissions this year' is a sentence — titles are 3–8 words` |
| two `cta` | `text: 2 CTAs — a section gets one primary and one alt` |

The `javascript:` and path rows are errors, and so is a missing `body`. The
word-count rows are warnings: they are taste, and taste never blocks a build
(CONVENTIONS §5).

## 11. `word.json`

```jsonc
{
  "name": "text", "version": "1.0.0", "kind": "block",
  "variants": ["prose", "centered", "columns"],
  "modifiers": ["reveal"],
  "props": {
    "title": { "type": "string", "required": false, "maxWords": 10 },
    "body":  { "type": "markdown", "required": true,
               "ext": [".md"], "maxBytes": 262144, "maxWords": 800 }
  },
  "slots": {
    "cta": { "max": 1 },
    "alt": { "max": 1 }
  },
  "requires": {},
  // Exactly the tokens this word's own code reads; az lint (pnpm lint) fails on a missing or extra entry.
  "themeReads": [
    "color.text", "color.veil", "size.gutter-sm", "size.measure-body",
    "size.measure-display", "space.16", "space.24", "space.48", "space.96",
    "type.display", "type.leading-body", "type.leading-tight", "type.size.2xl",
    "type.size.base", "type.weight-display"
  ],
  // Exact pins resolved at implementation time (CONVENTIONS §7 — never a
  // range). "<PIN>" marks an unverified value, not a guessed one.
  "deps": { "micromark": "4.0.2", "micromark-extension-gfm": "3.0.0" },
  "targets": ["web"],
  "tested": { "with": ["nav", "hero", "footer"],
              "browsers": ["chrome-latest","safari-latest","firefox-latest","ios-17"] }
}
```

The `markdown` prop type is new: a string **or** a `.md` path, resolved by
value, parsed and sanitised at link time so that word counts and heading levels
are available to the validator rather than discovered at emit.

Selection criterion for the parser, which matters more than the name: **it must
not emit raw HTML unless explicitly enabled** — sanitising afterwards is a scrub,
and scrubs get bypassed. It is the only runtime dependency these three blocks
introduce, and it is vetted and tested in isolation before adoption.

## 12. Open questions

1. **Multi-paragraph inline bodies.** §1 forces a `.md` file for anything past
   one paragraph, which is a real limit on a two-paragraph section. *(Recommend:
   leave it — a multi-line string form is a grammar change that affects every
   word, and it belongs to the grammar spec, not to `text`.)*
2. **The `raw`-HTML narrowing in §5** contradicts word-quality-gate §2B's
   "opt-in per file". One of the two documents has to move. *(Recommend: this
   one wins and the gate is amended — an opt-in flag inside a content file is
   invisible in review, whereas the `raw` word is visible in the `.az` source.)*
3. **`markdown` as a prop type.** ARCHITECTURE §4.1 documents `string` and
   `path` only, and `feature`/`gallery` need nested slots. *(Recommend: one
   manifest-schema revision covering all three, before any is written.)*
4. **Does `text` own a `lang` prop** for a passage in another language? It is
   one attribute and it is the correct fix for a mispronounced quotation.
   *(Recommend: defer — i18n is explicitly cut in buttons-and-sections §5, and a
   `lang` prop is the thin end of it.)*
5. **Where does a pull quote live?** A quotation big enough to be a design
   element is not a blockquote, and `testimonial` (Tier A) is about attribution.
   *(Recommend: a `quote` variant in Phase 1.5, once real pages show demand.)*
6. **Two tokens this block needs and theme-spec §1 does not have:**
   `breakpoint.md` 1024 (the band where two columns stop fitting — `feature` and
   `gallery` need it too) and a tight measure for `centered`, currently 32–40ch
   inline. *(Recommend: add both. `size.measure-tight` beside `measure-display`
   and `measure-body` keeps every measure in one closed set.)*
