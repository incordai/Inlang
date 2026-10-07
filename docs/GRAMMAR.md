# GRAMMAR — the `.az` language

**Status** normative for M1 · Companion to ARCHITECTURE §3 and CONVENTIONS §5

This file defines the `.az` file format exactly. It binds the lexer and the
parser in `packages/core`. Where an example in another doc disagrees with a
rule here, this file wins for *syntax*; the other doc wins for *taste*.

Every rule below is decidable by a parser with no manifest knowledge, except
where a rule is explicitly marked **link stage** — those need `word.json` and
are checked after parsing (ARCHITECTURE §3). The parse stage never guesses.

**Grammar version: `1`.** Frozen at M5 (PRD §Stability policy). Until then,
break it deliberately and bump nothing — after M5, changes go through
`az migrate`.

---

## 1. Lexical structure

### 1.1 Character set and file encoding

| Rule | Value |
|---|---|
| Encoding | UTF-8. A leading BOM is stripped and ignored |
| Line separator | `\n`. A `\r` immediately before `\n` is stripped |
| Legal control characters | `\n`, `\r` (only as above), `\t` (only where §2 permits) |
| Any other C0/C1 control byte | error `file: byte 0x0b is not allowed — save the file as plain UTF-8 text` (AZ1022) |
| Non-ASCII | legal **only** inside a quoted string and in comments |
| File extension | `.az` |
| Empty file | error `file: empty — start with 'az 1'` (AZ1023) |

Non-ASCII outside a string is an error, not a warning:
`token: non-ASCII character 'é' outside a string — quote the value` (AZ1024).
Rationale: word names, variants, prop keys and paths are all ASCII by
CONVENTIONS §2, so the only place a human legitimately types é is copy.

### 1.2 Line processing order

A conforming lexer performs these steps **in this order**. The order is part of
the specification — several rules below only make sense given it.

1. Decode UTF-8, strip BOM.
2. Split into lines on `\n`; strip one trailing `\r` per line.
3. **Strip trailing whitespace** from each line (spaces and tabs).
4. If the line is now empty → *blank line*. Skip it. No token, no indent event.
5. Measure leading whitespace. A tab here is an error (§2.1).
6. If the first non-whitespace character is `#` → *comment line*. Skip it. No
   token, no indent event.
7. Otherwise → *statement line*. Emit indent events (§2), then tokenise §1.3.

Consequence, and it is intentional: a blank line may contain tabs (step 3
removes them before step 5 sees them), and a comment line may be indented to
any column, including one that is not a multiple of the indent unit (step 6
runs before indent tracking). Neither can ever break a file.

### 1.3 Tokens

Only four token kinds survive lexing, plus the structural events from §2.

| Token | Form |
|---|---|
| `STRING` | a double-quoted string, §1.5 |
| `PAIR` | a bare run whose first `:` is preceded only by `[A-Za-z0-9_-]`, §1.7 |
| `BARE` | any other run of non-whitespace characters, §1.6 |
| `NEWLINE` | end of a statement line |

Structural events: `INDENT`, `DEDENT`, `EOF`.

**Token separation.** Tokens are separated by one or more spaces. Only
*leading* whitespace is significant; alignment padding between tokens is free,
which is why every example in these docs aligns values into a column:

```
  link   "Work"    /work
  link   "Studio"  /studio
```

**One statement per line.** There is no statement separator, no line
continuation, and no way to put two statements on one line. A line is a
statement; a statement is a line.

### 1.4 Words and keys

The first token of a statement line is its **word**. Two shapes are legal:

```ebnf
word-name = lower , { lower | digit } ;
prop-key  = lower , { lower | digit } , { "-" , ( lower | digit ) , { lower | digit } } ;
lower     = "a" … "z" ;
digit     = "0" … "9" ;
```

- A **word name** (`hero`, `nav`, `page`, `auth`) is lowercase, single token,
  **no hyphen** — CONVENTIONS §2.
- A **prop key** follows the same rule: lowercase, single token, no hyphen.
  *Decision (revised): the hyphen relaxation existed for exactly one key,
  `logo-light`, which is now `inverse`. With its only justification gone the
  rule binds everywhere — one shape for every name the author types, and
  nothing to remember about which position allows what.*
- No leading digit, no trailing hyphen, no double hyphen, no underscore, no
  uppercase. `Logo`, `logo_light`, `2col`, `logo-` are all
  `syntax: 'Logo' is not a word — words are lowercase, letters and digits`
  (AZ1104).

The parse stage cannot tell a word from a prop key — both are just the first
token. The distinction is a **link stage** one, resolved against the enclosing
word's manifest.

### 1.5 Quoted strings

```ebnf
string = '"' , { string-char } , '"' ;
string-char = ? any character except '"' , '\' , newline ? | escape ;
escape = "\" , ( '"' | "\" | "n" ) ;
```

| Rule | Detail |
|---|---|
| Quote character | `"` only |
| Legal escapes | `\"`, `\\`, `\n` — **exactly three** |
| Illegal escape | error `string: '\t' is not a legal escape — use \" \\ or \n` (AZ1011) |
| Single quotes | not a string. `'Work'` lexes as `BARE`. Diagnostics quote user input in `'single quotes'` (CONVENTIONS §5), so single quotes stay free for that job |
| Multi-line | not supported. A string never crosses a newline |
| Interpolation | none, ever (PRD principle 7) |
| Empty string | `""` is legal and distinct from an absent argument |
| Unterminated | error `string: unterminated quote — close it with "` (AZ1010); recovery §7.2 |
| `#` inside | **never a comment.** `title "Item #4"` is one string |
| Raw content | a string is data, not code. It is escaped at emit, never concatenated (CONVENTIONS §6) |

### 1.6 Bare values

```ebnf
bare = bare-char , { bare-char } ;
bare-char = ? any printable ASCII except space, tab, '"' ?
          - ? a '#' that starts a comment per §1.8 ? ;
```

Deliberately permissive. `85`, `on`, `v1`, `30d`, `50%scroll`, a family name, `/work`,
`./assets/shoe.glb`, `#pricing`, `https://example.org/x` are all one `BARE`.

A `"` inside a bare run is an error, not a silent split:
`token: '"' inside a bare value — quote the whole value` (AZ1013). This catches
`title Built in the "dark"` — a real typo class.

**A `BARE` has no type at parse time.** §4 assigns one at link stage from the
receiving prop's declared `type`. This is what lets `30d` and `85` and `on`
share a token kind without the lexer knowing anything about words.

### 1.7 Pairs, schemes, paths and routes

A `BARE` whose **first** `:` is preceded only by `[A-Za-z0-9_-]` (and by at
least one such character) is re-classified as `PAIR(key, value)`, split at that
first colon. No whitespace is permitted around the colon.

**PAIR exists for real-world URI schemes only.** AZ's own properties use
the plain `key value` form on an indented line — a colon is configuration
syntax, and the author writes words, not configuration. `tel:` and
`mailto:` are conventions the author already knows from the web.

```
tel:+50412345678      → PAIR("tel", "+50412345678")
mailto:hi@studio.com  → PAIR("mailto", "hi@studio.com")
video:./film.mp4      → PAIR("video", "./film.mp4")
popup:#sizes          → PAIR("popup", "#sizes")
copy:AZ-2026          → PAIR("copy", "AZ-2026")
https://example.org/x → PAIR("https", "//example.org/x")
./a:b.glb             → BARE  (a '/' precedes the ':')
80:20                 → PAIR("80", "20")   ← link stage rejects it, §4
```

*Decision (revised): `font` no longer uses the colon form. A colon pair is
configuration syntax, and this language is words — `display serif` on its own
indented line is the same `key value` shape as `height peek` and `width wide`.
The PAIR token stays in the lexer because `tel:+504…` and `mailto:` genuinely
need it, but those are real-world URI conventions the author already knows, not
punctuation AZ invented for its own properties. The lexer still emits one kind
and the **parser decides by position** — `font` takes
keyed arguments, a destination slot takes a URL. A hardcoded scheme list in the
lexer would have to change every time a word adds a scheme, which violates
"a word is a folder, not a core edit" (PRD principle 5).*

Destinations that are **not** pairs:

| Form | First character | Meaning | Type (§4) |
|---|---|---|---|
| `/work`, `/` | `/` | site route | `url` |
| `#pricing` | `#` not followed by space/EOL | in-page anchor | `url` |
| `./deck.pdf` | `.` | project-relative file path | `path` |

`/` first means route; `.` first means file. That single character is the whole
disambiguation, and it is decidable at parse time.

### 1.8 Comments

`#` begins a comment in exactly two situations:

1. It is the **first non-whitespace character on the line** — regardless of
   what follows. The whole line is a comment.
2. It is **preceded by whitespace** and **followed by a space, a tab, or the
   end of the line**.

In every other position `#` is an ordinary bare character.

```
# a whole-line comment                    → comment (rule 1)
#anchors-are-not-valid-statements         → comment (rule 1)
page /docs        # inherits nav          → comment (rule 2)
alt "Pricing"     #pricing                → BARE "#pricing", not a comment
title "Item #4"                           → inside a string, never a comment
cta "Buy" #buy    # jump to the section   → BARE "#buy", then a comment
```

*Decision: the "space after `#`" test is the only rule that lets `#anchor`
values (buttons-and-sections §1.2 `show` intent) and end-of-line comments
(nav-block-spec §8) coexist. The cost is that `#comment` mid-line is not a
comment; the fix is a space, and the diagnostic says so if the run then fails
to type-check as a URL.*

A comment runs to end of line. There are no block comments. A comment is
discarded by the lexer and reaches no later stage — it is not attached to the
AST and never appears in output.

### 1.9 The version marker

The **first statement line of the file** must be exactly `az` followed by one
integer:

```
az 1
```

- Blank lines and comment lines may precede it.
- It must be at column 0.
- Missing → `file: line 1 must be 'az 1' — add the version marker at the top`
  (AZ1020). This is fatal: parsing stops, because a future grammar version may
  lex differently.
- Unknown version → `file: version '2' is not supported by this compiler
  (supports 1) — run az migrate` (AZ1021). Also fatal.
- `az` is a reserved word and may not be used as a block word or prop key.

---

## 2. Indentation — normative

Indentation is the only structural mechanism in the language (PRD §6.1).
Everything below is an error, not a warning, and none of it is inferred.

### 2.1 Spaces only

**Tabs are illegal in leading whitespace.** No tab-width setting, no mixed-mode
inference, no "tabs are 4 or 8" negotiation.

```
indent: tab character in leading whitespace — use spaces, 2 per level   (AZ1001)
```

*Decision: allowing tabs means the file renders differently in two editors, and
the compiler's whole claim is that the same source produces the same output.
Forbidding them costs a one-line editor setting and removes a class of bug
permanently.* A tab *after* the first non-whitespace character is a plain token
separator and is fine (step 3 of §1.2 also removes trailing ones).

### 2.2 The indent unit is exactly 2 spaces

Not "consistent within a file", not inferred from the first indented line —
**2, always**. Any leading-whitespace width that is not a multiple of 2 is an
error:

```
indent: 3 spaces is not a multiple of 2 — use 2 spaces per level        (AZ1002)
```

*Decision: inferring the unit from first use is the standard approach and it is
the standard bug — a file that mixes 2 and 4 then has two defensible readings.
A fixed unit makes indentation a pure function of the byte count, which the
formatter, the LSP and `az migrate` can all rely on.*

### 2.3 One level at a time

An indent may increase the depth by exactly one level. Two levels at once is an
error:

```
indent: jumps 2 levels at once — indent one level at a time             (AZ1003)
```

Dedents may drop any number of levels at once, provided the target column is a
currently open one (§2.4).

### 2.4 Dedents must land on an open column

The lexer keeps a stack of open indent columns, starting `[0]`. For a statement
line at column *c*:

| Condition | Action |
|---|---|
| *c* equals the top of the stack | emit nothing; the line is a sibling |
| *c* is greater than the top by exactly 2 | push *c*; emit `INDENT` |
| *c* is greater than the top by more than 2 | AZ1003 |
| *c* is less than the top and **is on the stack** | pop until the top equals *c*; emit one `DEDENT` per pop |
| *c* is less than the top and **is not on the stack** | AZ1004 — see below |

AZ1004 is **reserved and cannot occur**. With a fixed 2-space unit (§2.2) and
one level per indent (§2.3), the open columns are always `0, 2, 4, …` with no
gaps, so every even column below the top is on the stack. A column that is not
a multiple of 2 is AZ1002 first. The row stays so the table is complete and the
ID is never reused.

At `EOF`, emit one `DEDENT` for every column above 0 still on the stack. An
unclosed block at end of file is not an error — the file simply ends.

### 2.5 Maximum nesting depth is 4

A statement line may sit at indent level 0, 1, 2, 3 or 4 (columns 0, 2, 4, 6,
8). Level 5 is an error:

```
indent: 5 levels of nesting, max is 4 — move this content into a word or flatten it   (AZ1005)
```

*Why 4:* the deepest legitimate chain in any doc is `site` → `nav` → `group` →
`link` (nav-block-spec §1 and §8), which is level 3, plus one spare level for a
property on that `link`. Anything deeper is content that wants to be a word
(PRD principle 5) or a nested layout the language deliberately cannot express
(§6). A hard cap also bounds the parser's stack and makes the "no arbitrary
nesting" promise checkable rather than aspirational.

### 2.6 Blank lines, comment lines, trailing whitespace

| Case | Behaviour |
|---|---|
| Blank line (empty after trailing-whitespace strip) | invisible to indent tracking. Does **not** close a block. May appear anywhere, including inside a block |
| Whitespace-only line containing tabs | becomes blank at §1.2 step 3, so AZ1001 never fires on it |
| Comment-only line | invisible to indent tracking. May be at any column, including a non-multiple of 2 |
| Trailing whitespace on a statement line | silently stripped. Never an error, never significant |
| Final line without a newline | legal |

A blank line between two sibling statements is therefore purely cosmetic, which
is what every example in these docs assumes.

### 2.7 Indentation diagnostics summary

| ID | Message |
|---|---|
| AZ1001 | `indent: tab character in leading whitespace — use spaces, 2 per level` |
| AZ1002 | `indent: 3 spaces is not a multiple of 2 — use 2 spaces per level` |
| AZ1003 | `indent: jumps 2 levels at once — indent one level at a time` |
| AZ1004 | reserved — unreachable under §2.2 and §2.3 (see §2.4) |
| AZ1005 | `indent: 5 levels of nesting, max is 4 — move this content into a word or flatten it` |

Numbers in AZ1002/AZ1004/AZ1005 are the observed values, substituted per
occurrence. All five are errors and block the build (CONVENTIONS §5).

**Reserved pseudo-words.** CONVENTIONS §5 fixes the format as
`<word>: <what is wrong> — <what to do>`, but a lexical failure happens before
any word is in scope. The reserved pseudo-words `file`, `indent`, `string`,
`token` and `syntax` fill the slot. They are not usable as word names.

---

## 3. Grammar

### 3.1 Core grammar — what the parse stage accepts

The parser is deliberately tiny. Every construct in the language is one
statement shape; what a statement *means* is decided at link stage against
`word.json`.

```ebnf
(* ===== file ===== *)

file            = version-marker , block-body , EOF ;

version-marker  = "az" , BARE , NEWLINE ;          (* BARE must be "1" *)

(* ===== statements ===== *)

block-body      = { statement } ;

statement       = head , NEWLINE , [ INDENT , block-body , DEDENT ] ;

head            = word , { argument } , [ as-clause ] ;

word            = BARE ;                            (* matching §1.4 *)

argument        = STRING
                | PAIR
                | BARE ;

as-clause       = "as" , BARE ;                     (* BARE matching word-name *)
```

That is the entire parse-stage grammar. It is LL(1) on the token stream and
cannot fail on anything except the shapes listed in §7.1.

`as` is the language's only keyword besides the `az` marker. It is recognised
positionally — a statement's arguments end at the first `BARE` equal to `as`.
A value that must literally be the text `as` is written `"as"`.

### 3.2 Specialised productions — what the link stage accepts

These are the constrained instances of §3.1 that the link and validate stages
recognise. A statement matching §3.1 but no production here is
`<word>: unknown word — see the word list` (AZ1201, link stage).

```ebnf
(* ===== top level ===== *)

file-member     = site-decl | page-decl
                | popup-decl | content-decl | interrupt-decl ;   (* deferred, §3.4 *)

(* ===== structure words (implemented in core, not words/) ===== *)

site-decl       = "site" , name , NEWLINE ,
                  [ INDENT , { site-member } , DEDENT ] ;

site-member     = theme-decl | font-decl | description-decl | icon-decl
                | inheritable-block
                | popup-decl | content-decl | interrupt-decl ;

description-decl = "description" , STRING , NEWLINE ;   (* site or page, §4.4 *)

icon-decl       = "icon" , path , NEWLINE ;               (* site only, §4.4 *)

theme-decl      = "theme" , name , NEWLINE ;

font-decl       = "font" , NEWLINE , INDENT , font-role , { font-role } , DEDENT ;
font-role       = ( "display" | "body" | "mono" ) , WORD , NEWLINE ;

page-decl       = "page" , route , NEWLINE ,
                  [ INDENT , { page-member } , DEDENT ] ;

page-member     = block | inheritable-block | raw-decl | description-decl ;

raw-decl        = "raw" , path , NEWLINE ;

(* ===== block words (one folder each under words/) ===== *)

block           = block-word , { atom } , [ as-clause ] , NEWLINE ,
                  [ INDENT , { block-member } , DEDENT ] ;

block-word      = "nav" | "hero" | "feature" | "gallery" | "pricing"
                | "faq"  | "cta"  | "footer"  | "auth"    | "scene" | "text" ;

inheritable-block = block ;      (* block-word ∈ { nav, footer }, §5.2 *)

atom            = variant        (* ∈ this block's word.json "variants"; max one *)
                | modifier       (* ∈ this block's word.json "modifiers"; free *)
                | positional ;   (* BARE consumed by word.json "arg", max one *)

block-member    = property | slot-decl | raw-decl | child-block ;

child-block     = block ;        (* only where word.json "children" permits, §3.3 *)

(* ===== properties and slots ===== *)

property        = prop-key , value , { value } , [ as-clause ] , NEWLINE
                | prop-key , NEWLINE ;               (* flag form, e.g. bare `cta` *)

slot-decl       = "slot" , slot-name , path , NEWLINE ;

(* ===== deferred, §3.4 ===== *)

popup-decl      = "popup" , name , NEWLINE ,
                  [ INDENT , { property } , DEDENT ] ;

content-decl    = "content" , preset , path , NEWLINE ,
                  [ INDENT , { property } , DEDENT ] ;

interrupt-decl  = "interrupt" , name , NEWLINE ,
                  INDENT , { property } , DEDENT ;   (* body required: `once` is mandatory *)

(* ===== terminals ===== *)

name            = BARE matching word-name ;
prop-key        = BARE matching prop-key ;
slot-name       = BARE matching word-name ;
variant         = BARE matching word-name ;
modifier        = BARE matching word-name ;
positional      = BARE ;
preset          = "blog" | "docs" | "help" ;
route           = BARE beginning with "/" ;   (* shape: §5.5 *)
path            = BARE beginning with "./" ;
value           = STRING | PAIR | BARE ;
```

### 3.3 Where each construct may appear

| Construct | Legal parents | Phase | Source |
|---|---|---|---|
| `az 1` | file, line 1 | 1 | PRD §Stability |
| `site <name>` | file | 1 | PRD §6.1 |
| `width <preset>` | `site` | 1 | PRD §6.1a — the frame |
| `theme <name>` | file, `site` | 1 | PRD §6.1 |
| `accent <hue>` | `theme` | 1 | PRD §6.1a — shade ramp |
| `pattern <shape> [origin]` | `theme` | 1 | PRD §6.1a — background |
| `font` + indented roles | file, `site` | 1 | PRD §6.1 |
| `display` / `body` / `mono` `<family>` | `font` | 1 | PRD §6.1 |
| `description "<text>"` | `site`, `page` | 1 | §4.4 — the meta description; the page's wins |
| `icon <path>` | `site` | 1 | §4.4 — the site icon, PNG or SVG |
| `page <route>` | file | 1 | PRD §6.1 |
| `raw <path>` | `page`, any block | 1 (M3) | PRD §6.6 |
| `backend` + indented settings | `site` | 1 | backend-spec §2 — optional; site-level, one per site; not a block |
| `database sqlite\|postgres\|mysql` · `email smtp\|api` | `backend` | 1 | backend-spec §2 — closed choices; addresses and keys live in the backend's `.env`, never here |
| `data <table>` + indented lines | `site` | 1 | data-spec §4 — needs `backend`; a table and its `/data/<table>` API; not a block |
| `<field> <type> [type-arg…] [modifier…]` | `data` | 1 | data-spec §4.2–§4.5 — types `text longtext number money flag date datetime email url choice image ref`; modifiers `required unique index search private locked default <v>` |
| `allow <who> <action…>` | `data` | 1 | data-spec §4.7 — who `anyone signedin owner`, action `read create edit delete`; the matrix is closed |
| `nav …` | `site`, `page` | 1 | nav-spec §8 |
| `footer …` | `site`, `page` | 1 | PRD §6.1 |
| `scene backdrop` | `site`, `page` | 1 | scene-spec §6 — the only *layer* block |
| other block words (incl. `scene full`/`inline`) | `page` | 1 | PRD §6.2 |
| property | any block | 1 | PRD §6.1 |
| `link "L" <dest>` | `nav`, `group`, `footer` | 1 | nav-spec §1 |
| `group "L" [as dropdown]` | `nav` | 1 | nav-spec §1, overlays §4 |
| `cta "L" <dest>` | any block with a `cta` slot | 1 | buttons §1.1 |
| `alt "L" <dest>` | any block with an `alt` slot | 1 | hero-spec §1 |
| `slot <name> <path>` | any block | 1 (M3) | PRD §6.6, ROADMAP M3 |
| `popup <id>` | file, `site` | **1.5** | overlays §4, §7 |
| `content <preset> <dir>` | file, `site` | **2.5** | buttons §3, §4 |
| `interrupt <name>` | file, `site` | **deferred** | overlays §5, §7 |

`group` is a `nav`-only child block; it is the only nested block in Phase 1.
Nesting is permitted exactly where the parent's `word.json` declares a
`children` list — there is no general "any block inside any block" rule, and a
block placed somewhere its parent does not accept is
`<word>: not allowed inside 'nav' — move it to the page` (AZ1202, link stage).

`backend`'s diagnostics: AZ1223 declared outside `site` · AZ1224 not a backend
setting · AZ1225 a setting missing · AZ1412 a value outside its choices (a
connection string is told where it belongs) · AZ1506 declared twice · AZ1507
the site's `auth` must use `adapter azbackend`.

`data`'s diagnostics are AZ1226–AZ1249 and AZ1415 at the link stage (data-spec
§12) — AZ1236, the modifier conflict, includes `unique` with `private` (a
`taken` answer would reveal others' values) and `unique` with `default`
(data-spec §18.6) — plus AZ1701–AZ1708 when the file and its schema lock
`<site>.data.json` disagree, the lock is damaged, or a change needs its flag:
AZ1708 is a read rule or a removed `private` that shows stored rows to more
people, until `az backend schema --expose <table>` (data-spec §6, §18.7).
`from <table>` in a block is AZ1260–AZ1269 (data-spec §10, §12): a gallery's
`alt` maps only to a `required` field (AZ1262), and a site with data owns
`/admin`, so a page there is AZ1268 (§5.5).

### 3.4 Deferred constructs

`popup`, `content` and `interrupt` are **in the grammar and out of Phase 1**.
They parse, and the Phase 1 compiler rejects them with a phase diagnostic
rather than a syntax error:

```
popup: not available until Phase 1.5 — build it as its own page          (AZ1301)
content: not available until Phase 2.5 — link out to an external blog    (AZ1302)
interrupt: deferred, no ship date — capture email with 'newsletter'      (AZ1303)
```

*Decision: they are specified now because the grammar freezes at M5 and adding
a statement shape afterwards costs a migration. Reserving the shape costs
nothing; discovering at Phase 2.5 that `content blog ./posts` does not fit the
statement form costs a grammar break.*

Deferred forms, for the record:

```
popup sizes
  title "Size guide"
  text  ./content/sizes.md

content blog ./posts
  layout  list
  perpage 12
  rss     on

content docs ./docs
  layout   sidebar
  toc      on
  versions v1 v2

interrupt newsletter
  trigger exit
  once    30d
```

Note `versions v1 v2` — a property taking more than one value. §4.5 defines it.

---

## 4. Value types

Seven types. A `BARE`, `STRING` or `PAIR` token has **no type until link
stage**, where it is checked against the `type` declared for that prop in the
receiving word's `word.json` (ARCHITECTURE §4.1).

### 4.1 The type set

| Type | Accepts | `word.json` extras | Link-stage check |
|---|---|---|---|
| `string` | `STRING` only | `maxWords`, `maxChars` | length limits; escaped at emit, never concatenated |
| `path` | `BARE` starting `./` | `ext`, `maxBytes` | resolves inside the project root, extension in `ext`, size under `maxBytes` |
| `url` | `BARE` starting `/` or `#`, or `PAIR` with a known scheme | `schemes` | scheme in the allowed set; route matches a declared `page`; anchor is non-empty |
| `number` | `BARE` matching `["-"] digit {digit} ["." digit {digit}]` | `min`, `max`, `int` | range and integrality |
| `bool` | `BARE` equal to `on` or `off` | — | nothing further |
| `enum` | `BARE` matching word-name | `values` (required) | membership |
| `ref` | `BARE` matching word-name, or `#name` | `refKind` | a declaration with that name and kind exists in the file |

A `bool` is spelled `on`/`off`, matching `rss on` and `toc on` in
buttons-and-sections §3. `true`/`false`/`yes`/`no`/`1`/`0` are rejected:
`content: 'true' is not a switch — use 'on' or 'off'` (AZ1401). One spelling,
no synonyms.

### 4.2 `path` — the sandbox rule

A `path` is **project-relative and must begin `./`**. All of these are errors:

| Input | Diagnostic |
|---|---|
| `assets/shoe.glb` | `hero: 'assets/shoe.glb' is not a path — write './assets/shoe.glb'` (AZ1402) |
| `../../secrets.env` | `hero: '../../secrets.env' leaves the project — keep assets inside the project` (AZ1403) |
| `/etc/passwd` | lexes as a route; fails `path` typing with AZ1402 |
| `~/models/x.glb` | AZ1402 |

`..` is rejected **anywhere** in the path, not only at the start, and the check
is on the literal text before resolution — a segment check on the resolved path
is the mitigation word-quality-gate §2A calls for, and doing it on the text as
well means no symlink can defeat it.

### 4.3 `url` — destinations

`url` is the type of anything a button or link points at (buttons §1.3). Four
sub-kinds, distinguished by the first character, all decidable at parse time:

| Sub-kind | Form | Detected intent (buttons §1.2) |
|---|---|---|
| route | `/reserve`, `/` | `go` |
| anchor | `#pricing` | `show` |
| scheme | `PAIR` with key in `tel` `mailto` `video` `popup` `copy` | `call` `mail` `play` `play` `copy` |
| absolute | `PAIR` with key `http` or `https` | `external` |

A `PAIR` whose key is none of those — anywhere in the file, since a colon form
exists only for these schemes (§1.7):
`nav: 'ftp:' is not a supported destination — use a route, an anchor, or tel/mailto/video/popup/copy` (AZ1404).

A **quoted** value in a destination position (any argument after a fill's
label) is refused with the same AZ1404 when it names a scheme that runs code —
`javascript:`, `vbscript:` or `data:` — after the normalisation a browser
applies (leading spaces and control characters dropped, tabs and line breaks
removed). Such a value becomes an `href`, and a link that runs script is never
compiled. Any other quoted text is left alone: a second argument is sometimes a
value, not a destination (`feature "Projects" "10"`).

A `path`-shaped value in a `url` position is legal and means *download*
(buttons §1.3, `./deck.pdf` → download); it is then checked as a `path`.

**Intent is never declared, always inferred** (buttons §1.3). There is no
grammar for it. The `as` clause overrides *hierarchy* (`as ghost`), not intent.

### 4.4 How `word.json` `props` map onto types

```jsonc
"props": {
  "title":  { "type": "string", "required": true, "maxWords": 12 },
  "model":  { "type": "path",   "ext": [".glb"], "maxBytes": 5242880 },
  "height": { "type": "number", "min": 40, "max": 100, "int": true },
  "mobile": { "type": "enum",   "values": ["drawer","sheet","full"] },
  "rss":    { "type": "bool" },
  "cta":    { "type": "string", "with": { "type": "url" }, "max": 2 }
}
```

- `type` names one of the seven and is required.
- `required: true` → a missing prop is
  `<word>: '<key>' is required — add: <key> <example>`.
- `with` declares a **second positional value** on the same statement, which is
  how `cta "Reserve a pair" /reserve` (a `string` then a `url`) is typed. Only
  one `with` per prop; anything needing three positionals is a child block.
- `max` on a prop bounds how many times it may repeat within one block, giving
  hero-spec §11's `hero: 3 CTAs. Maximum is 2 (one primary, one secondary)` and
  nav-spec §9's link cap directly from the manifest.

**Keyed arguments.** A `PAIR` argument in a non-`url` position is a keyed
value: the key selects the sub-prop and the value is typed by that sub-prop's
declared type. `font` with indented `display` and `body` roles is one statement with two keyed
arguments, `display` and `body`. An unknown role is
`font: 'heading' is not a font role — use display, body, mono` (AZ1405). Each
role names one family from a closed set — `sans`, `serif`, `mono`, `rounded`,
each a system face (theme-spec §8.1); any other is
`font: 'comic' is not a family — use sans, serif, mono, rounded` (AZ1416). A role
with no family, or `font` with no roles, is AZ1205; a repeated role warns
(AZ1203) and the first is kept.

**Theme settings.** `theme <name>` takes one of `midnight`, `paper`,
`signal`; any other is
`theme: 'purple' is not a theme — use midnight, paper, signal` (AZ1417). Its
indented settings are `accent` and `pattern`; any other is
`theme: 'sparkle' is not a theme setting — use accent, pattern` (AZ1405).
`accent <hue>` names one hue from a closed set — `violet`, `indigo`, `blue`,
`teal`, `green`, `lime`, `amber`, `orange`, `rose` — whose ramp step is chosen
per scheme to hold the theme-spec §6 floors; any other is
`theme: accent 'magenta' is not a hue — …` (AZ1418). Without `accent` the
theme keeps its own. `pattern <shape> [origin]` takes a shape — `none`,
`glow`, `spotlight`, `ramp`, `grid`, `hatch`, `dots` — and an origin — `top`
(the default), `bottom`, `left`, `right`, `center`; an unknown shape or origin
is AZ1419. Without `pattern` there is none. A setting with no value is AZ1205,
an extra value AZ1406, and a repeated setting warns (AZ1203) and the first is
kept. `az explain theme accent` lists the hues.

**Site and page settings: `description` and `icon`.** Both are one value on
one line, like `width`.

```
site aurora
  description "Handmade shoes from a two-person workshop."
  icon        ./brand/icon.svg

page /work
  description "Every pair we made this year, and who wears them."
```

- `description "<text>"` — what a search result shows under the page's
  title (its `<meta name="description">`). At site level it is every page's;
  a page's own replaces it for that page. Neither written, the page's lead
  copy stands in — the first paragraph after its first heading — and a page
  with none has no description. It is copy, so it is quoted (a bare value is
  AZ1205), its whitespace is collapsed to one line, and it is escaped at
  emit. An empty one is
  `site: description is empty — write what the site is about, or remove the line`
  (AZ1420). Past 160 characters it warns —
  `site: description is 182 characters, 160 is the limit — search results cut the rest; shorten it`
  (AZ1409, the text-limit warning) — and ships as written.
- `icon <path>` — the site icon, site level only (under a page it is
  `icon: declared under a page — move it to site level, one icon per site`,
  AZ1503). A project file, sandboxed like every `path` (§4.2: outside the
  project is AZ1210); a URL, a route or a quoted value is
  `site: icon 'https://…' is not a project file — write: icon ./icon.svg`
  (AZ1402), so the icon always ships with the site. The name ends `.svg` or
  `.png` (AZ1410), and the file's **first bytes** must be that format, since a
  host serves a file by its name: a file that cannot be read, is neither PNG
  nor SVG, or is the other one is
  `site: icon './icon.png' is an SVG file — name it .svg` (AZ1421, checked
  when the compiler is given the project's files — `az build`, `az check`,
  `az spec`, the MCP tools). Every page declares it with the type its bytes
  say. Without `icon` each page declares an empty one, so the browser asks
  for no `/favicon.ico`.

  **The home-screen icon.** A phone saving the site to its home screen asks
  for a PNG `<link rel="apple-touch-icon">`, 180×180. `az build` makes it
  from a **square PNG icon of 180×180 or more**: exactly 180 is that file as
  it is; larger is resized down to 180×180 by the build's image resizer — a
  PNG with pinned options (fixed compression level, no palette, no
  interlace, no metadata), named by a hash of the file and those options,
  cached with the responsive-image variants and shipped under `/az-img/`.
  Every page declares it after the icon, with a href relative to the page
  like the icon's. It is never upscaled and never rasterised from SVG: an
  SVG icon, a PNG under 180px a side, or one that is not square gives no
  touch icon and the warning
  `site: icon './icon.svg' is an SVG, and a home-screen icon must be a PNG — the site has none; use a square PNG of 180×180 or more for one`
  or `site: icon './icon.png' is 64×64, and a home-screen icon needs a square PNG of 180×180 or more — the site has none; it is never upscaled`
  (AZ1422, a warning: the site builds, with its icon). *Decision: an SVG is
  not rasterised at build. That would run a second, larger parser — XML
  with entities and references to other files — over author bytes, for one
  icon; the resizer allows only the raster decoders the upload pipeline
  allows (JPEG, PNG, WebP, AVIF), and keeping it so is the safer choice.
  An author who wants the touch icon supplies a PNG.* With no resizer (the
  Playground, unit tests, `az check`) or one that cannot run, no page
  declares a touch icon and the pages are otherwise unchanged.

Each is set once: a second `description` in the same site or page, or a
second `icon`, is AZ1504. No value is AZ1205, a second value AZ1406, an
indented body AZ1219.

### 4.5 Repeated values

A prop declared `"repeat": true` accepts more than one value on one line, all
of the same declared type. This exists for `versions v1 v2`
(buttons-and-sections §3) and nothing else in Phase 1. Without `repeat`, a
second value is
`<word>: '<key>' takes one value — put the rest on their own lines` (AZ1406).

*Decision: `repeat` rather than a list type keeps the type set at seven and
keeps the parse grammar unchanged — a repeated prop is just a statement with
more arguments.*

---

## 5. Resolution order

### 5.1 The precedence ladder

Lowest to highest. A higher level always wins outright.

| # | Level | Example |
|---|---|---|
| 1 | compiler default | the `static` motion tier |
| 2 | `word.json` default variant | `hero` → `center`, `nav` → `bar` |
| 3 | site-level declaration | `site` → `theme midnight` |
| 4 | page-level declaration | `page /docs` → `nav side` |
| 5 | block-level property | `hero` → `height 85` |
| 6 | statement `as` clause | `cta "Reserve" /reserve as ghost` |

### 5.2 Site versus page — the exact rule

> **A page-level declaration of an inheritable word replaces the site-level one
> entirely. It does not merge with it.**

Inheritable words in Phase 1: **`nav` and `footer`.** Everything else declared
at site level (`theme`, `font`) is site-scoped and cannot be redeclared.

```
site aurora
  nav split sticky
    link "Work" /work

page /                     # inherits the site nav, links and all
page /docs
  nav side                 # replaces it — this nav has no links at all
```

*Decision: replace, not merge. Merging makes "why is that link still in the
docs nav" unanswerable without reading two places, which is the exact failure
nav-block-spec §8 is trying to prevent. Replacement is one rule, visible on one
screen, and the compiler warns when a replacement drops every link:*
`nav: this override has no links — the site nav had 4` (AZ1501, warning).

*This corrects PRD §6.1, whose example puts `nav` under `page`. That example
still parses and remains valid — a page-level `nav` with no site-level `nav` is
simply a page declaring its own. nav-block-spec §8's recommendation wins on
where nav **should** live.*

**Suppressing an inherited block:** the reserved variant `none`.

```
page /login
  nav none
  auth login
```

`none` is legal on inheritable words only, takes no other atoms and no body.
*Decision: without it there is no way to write a page with no nav — a login or
campaign page — and PRD §6.1's `page /login` example needs one. This is an
addition to the taxonomy, not a re-litigation of it.*

### 5.3 Where an inherited block renders

Source order decides render order **within a page body**. Inherited blocks are
not in the page body, so their position comes from `word.json`:

```jsonc
"position": "top"      // nav
"position": "bottom"   // footer
"position": "flow"     // everything else — source order
```

A page-level `nav` renders at the top whether it is written first or last in
the page body. *Decision: nav-block-spec §5 requires nav height to be a CSS
variable that hero height and scroll padding depend on, so nav's position is a
structural fact, not an authoring choice.*

### 5.4 Duplicates are errors, not last-wins

| Case | Result |
|---|---|
| `theme` twice at site level | `theme: declared twice — keep one` (AZ1502) |
| `theme` under a `page` | `theme: declared under a page — move it to site level, one theme per site` (AZ1503) |
| `icon` under a `page` | `icon: declared under a page — move it to site level, one icon per site` (AZ1503) |
| `description` twice in one site or page, `icon` twice | `site: 'description' set twice — keep one` (AZ1504) |
| Two `hero` blocks on one page | `hero: only one per page (it owns the <h1>)` — hero-spec §11 |
| Same prop twice in one block, no `max` | `hero: 'title' set twice — keep one` (AZ1504) |
| `site` twice | `site: declared twice — keep one` (AZ1508) |
| Two `page` declarations on one route | `page: '/' declared twice — keep one` (AZ1509) |
| Two variants on one block | `hero: 'center' and 'split' are both layouts — pick one` — hero-spec §11 |

*Decision: last-wins silently discards a line the author wrote. A file this
short has no case where two spellings of the same setting are useful, so the
error costs nothing and catches copy-paste.* PRD principle 3 ("the theme is
global and resolved once") makes AZ1503 non-negotiable.

### 5.5 Page routes

A page is served at exactly the path its route names: the generated site
compares the visitor's path to the route byte for byte. So a route must be a
path no browser rewrites — `/`, or `/`-separated segments of letters, digits
and `- . _ ~` (the URL-unreserved set), with no trailing slash and no `.` or
`..` segment. Anything else can never be reached, and is refused rather than
compiled into a page that always says "not found" (AZ1413):

| Input | Diagnostic |
|---|---|
| `page /about/` | `page: '/about/' ends with '/' — write: page /about` |
| `page "about"` | `page: 'about' is not a route — write: page /about` |
| `page "/a b"`, `page "/café"` | `page: '/a b' has characters an address would change — use letters, digits and - . _ ~ between slashes` |
| `page /admin`, `page /Admin/x` in a site with `data` | `page: '/admin' is generated for data — use another route` (AZ1268, any case) |

Routes compare **case-insensitively** when checked for collisions: `/About`
beside `/about` is AZ1509 (`page: '/About' and '/about' differ only in case —
rename one`): each page is a folder in the build, and on a case-insensitive
disk the two would be one folder.

---

## 6. What the grammar cannot express — normative

The following are **not missing features**. They are the language (PRD
principle 7: *the file describes the site; the CLI does things to it*). Every
one of them will be requested. None of them is coming.

| Wanted | Not expressible | Do this instead |
|---|---|---|
| **Variables** — `$accent`, `let brand = …` | no binding form; a `BARE` is never a name lookup | theme tokens. A word reads `ctx.theme.color.accent`; you pick the theme once, at site level |
| **Conditionals** — `if mobile: …` | no `if`, no ternary, no truthiness | targets and tiers. `hero` already renders three motion tiers and a mobile variant (PRD §6.4, hero-spec §10). A block needing a different shape on mobile handles it in its emitter, not in your file |
| **Loops** — `for post in posts: …` | no iteration form | the content system (`content blog ./posts`, Phase 2.5). Repetition over data is a pipeline, not a syntax |
| **Arithmetic** — `height 100 - navheight` | `-` is a bare character, never an operator | the space scale and CSS variables. nav-block-spec §5 already exposes nav height as a variable so hero can subtract it in CSS, where subtraction belongs |
| **Includes** — `include ./shared/nav.az` | no include statement; one file, one site | site-level declarations. That is what §5.2 inheritance is for. One file you can read top to bottom is a feature |
| **Expressions** — `title upper("x")`, string concat | `"` strings are data, never evaluated | write the final text. A compiler that transforms your copy is a compiler you have to debug |
| **Comments as directives** — `# az-ignore` | comments are discarded at lex time (§1.8) | suppress by diagnostic ID via CLI config. Load-bearing comments are a second grammar hiding in the first |
| **Arbitrary nesting** — a grid of cards of blocks | depth cap of 4 (§2.5); children only where `word.json` allows | a word. A layout needing five levels is a block someone should contribute (PRD principle 5) |
| **Inline styling** — a raw colour literal, `padding 13px` | no such props; lint bans hex and off-scale px (CONVENTIONS §4) | the theme, or `raw ./custom/Thing.tsx`, or `az eject <word>` |
| **Custom markup** | no HTML, no JSX, no markdown in `.az` | `raw <path>` for a whole component, `slot <name> <path>` to inject into a named slot of a block (PRD §6.6) |

**The escape hatch is the answer to all ten.** `raw`, `slot` and `eject` exist
precisely so the grammar never has to grow an expression language (PRD
principle 4). When a user is fighting the grammar, the correct outcome is a
`raw` component or a new word — never a new operator.

When one of these is written, the diagnostic names the escape hatch:

```
syntax: '$accent' is not a value — use a theme token, or 'raw ./custom/…' for custom markup   (AZ1601)
syntax: 'if' is not a word — .az has no conditionals; targets handle per-device output        (AZ1602)
syntax: 'include' is not a word — one file per site; put shared blocks under 'site'           (AZ1603)
```

---

## 7. Error recovery

> **Errors are collected, never thrown mid-stage.** Each stage returns
> `{ ast, diagnostics }` so the LSP shows every problem at once, not the first
> — ARCHITECTURE §3.

A parser that stops at the first error makes the editor experience "fix, save,
find the next one", which is the most common complaint about indentation
languages. Recovery is therefore specified, not left to the implementation.

### 7.1 The five parse-stage failures

These are the only ways §3.1 can fail. Everything else is a link-stage or
validate-stage diagnostic on a well-formed tree.

| ID | Condition | Message |
|---|---|---|
| AZ1101 | `as` with nothing after it | `syntax: 'as' with no name — write: as dropdown` |
| AZ1102 | line begins with `STRING` or `PAIR` | `syntax: line starts with '"Work"' — a statement must start with a word` |
| AZ1103 | two `as` clauses in one head | `syntax: two 'as' clauses — one override per statement` |
| AZ1104 | first token is not a legal word-name/prop-key | `syntax: 'Logo' is not a word — words are lowercase, letters and digits` |
| AZ1105 | `INDENT` under the version marker | `syntax: 'az 1' takes no body — start the site on the next line at column 0` |

### 7.2 Resynchronisation rules

The parser recovers at **line granularity**. Six rules, applied in order:

1. **Unterminated string** (AZ1010) terminates at end of line and never
   consumes the next line. The synthesised string's value is the text up to the
   line end. This is why strings are single-line: it makes every lexical error
   recoverable within one line.

2. **Bad argument, good word.** If the statement's word lexed cleanly and a
   later token failed (AZ1013, AZ1101, AZ1103), discard the remaining tokens on
   that line, emit `NEWLINE`, and **keep the statement**. Its body still parses
   and still produces diagnostics. One bad prop must not silence a whole block.

3. **Bad word.** If the first token failed (AZ1102, AZ1104), discard the line
   **and every following line at a greater indent** — the body has no parent to
   attach to. Emit exactly one additional diagnostic for the skipped body:
   `syntax: skipped 4 lines nested under the error above — fix the line above first` (AZ1106).

4. **Indentation error** (AZ1001–AZ1005). Do not skip the line. Attach it to the
   nearest enclosing open column **less than or equal to** its own, reset the
   indent stack to that column, and continue. The rest of the file stays
   parseable, which is what matters: a stray space on line 12 must not produce
   sixty diagnostics on lines 13–80.

5. **Cascade suppression.** After an indentation error, further AZ1001–AZ1005
   diagnostics are suppressed until a statement line arrives at a column already
   on the stack. At most one diagnostic per `(line, id)` pair ever, in every
   case.

6. **Diagnostic ceiling.** Stop reporting after 100 diagnostics and emit
   `file: 100 problems, stopped reporting — fix these first` (AZ1099). Parsing
   still runs to `EOF` so the AST is complete; only reporting stops.

### 7.3 What recovery guarantees

- The parse stage **always** returns an AST, even for a file that is entirely
  malformed. A file with only errors yields an AST with zero statements.
- Every node carries a source position (line, column, length) — required by
  CONVENTIONS §5 and by the LSP.
- Recovery never invents a node. A skipped line produces no AST node, so the
  link stage never reports a phantom word.
- Two fatal exceptions to "collect, don't throw": a missing version marker
  (AZ1020) and an unsupported version (AZ1021). Both stop parsing immediately,
  because the grammar of the rest of the file is then unknown.

### 7.4 Diagnostic ID ranges

| Range | Stage |
|---|---|
| AZ1000–AZ1099 | lexical, encoding, indentation, ceiling |
| AZ1100–AZ1199 | parse-stage syntax |
| AZ1200–AZ1299 | link stage — unknown word, illegal parent |
| AZ1300–AZ1399 | phase gating |
| AZ1400–AZ1499 | value typing |
| AZ1500–AZ1599 | resolution and duplication |
| AZ1600–AZ1699 | "the grammar cannot express this" |
| AZ1700–AZ1749 | the data schema lock — file vs `<site>.data.json` (data-spec §6) |
| AZ2000+ | per-word validations (hero-spec §11, nav-spec §9) |

IDs are permanent once shipped. A retired ID is never reused.

---

## 8. Worked example

A complete, valid Phase 1 file. Every construct in it is Phase 1 scope; the
deferred forms are in §3.4.

```
az 1

# Aurora — a studio site. One file, top to bottom.

site aurora
  theme midnight
  font
    display serif
    body    sans

  nav split sticky solid
    logo       ./assets/logo.svg
    inverse ./assets/logo-w.svg
    link  "Work"   /work
    link  "Studio" /studio
    group "Products" as dropdown
      link "Shoes" /shoes
      link "Bags"  /bags
    cta    "Reserve" /reserve
    mobile drawer

  auth
    adapter hosted

  footer
    link "Pricing" #pricing
    link "Privacy" /legal
    link "Email"   mailto:studio@aurora.example

page /
  hero split 3d scroll
    eyebrow "Limited run"
    title   "Built in the dark"
    sub     "Handmade. Forty pairs a month."
    cta     "Reserve a pair"  /reserve
    alt     "Call the studio" tel:+50412345678
    model   ./assets/shoe.glb
    height  peek
    slot after ./custom/Ticker.tsx

  feature grid
    columns 3
    item "Hand-cut leather"
      text "One hide, cut by hand, for every pair."
    item "Sewn, not glued"
      text "Every seam can be opened and redone."
  gallery orbit
    poster ./assets/orbit.webp
    image ./assets/orbit-1.webp
      alt "The last, before the upper goes on"
    image ./assets/orbit-2.webp
      alt "Welting the sole by hand"
    image ./assets/orbit-3.webp
      alt "A finished pair on the bench"
    image ./assets/orbit-4.webp
      alt "The sole, stitched and trimmed"

  text
    title "Made to be repaired"
    body  ./content/repair.md

  cta band
    title "Reserve for the autumn run"
    cta   "Reserve a pair" /reserve

  raw ./custom/Badge.tsx

page /login       # no nav, nothing to distract
  nav none
  auth login

page /legal
  text
    title "Privacy"
    body  "We keep your order and your address, and nothing else."
```

### 8.1 Line-by-line commentary

Line numbers count from the first line of the block above.

| Line | Source | What the parser does |
|---|---|---|
| 1 | `az 1` | Version marker. Must be the first statement line, at column 0. `1` is a `BARE`, compared against the supported set `{1}` (§1.9) |
| 2 | *(blank)* | Skipped at §1.2 step 4. No indent event |
| 3 | `# Aurora — …` | Comment line. Skipped at step 6. The em-dash is non-ASCII and legal here (§1.1) |
| 5 | `site aurora` | Column 0, level 0. Word `site`, one `BARE` argument. Opens a body |
| 6 | `  theme midnight` | `INDENT` to level 1. Site-scoped; a copy under a `page` would be AZ1503 (§5.4) |
| 7 | `  font` then indented `display <family>` / `body <family>` | Two roles, each a `key value` line like every other property. Alignment padding is not significant (§1.3) |
| 8 | *(blank)* | Invisible. Does **not** close the `site` body (§2.6) |
| 9 | `  nav split sticky solid` | Level 1, so `nav` is site-level and inherited by every page (§5.2). `split` is a variant; `sticky` and `solid` are modifiers — the parser cannot tell them apart, the link stage can (§3.2) |
| 10 | `    logo       ./assets/logo.svg` | `INDENT` to level 2. Type `path`: must begin `./`, must stay inside the project (§4.2) |
| 11 | `    inverse ./assets/logo-w.svg` | A plain prop key, same shape as every other name (§1.4). Its absence alongside `solid` is a warning per nav-spec §9 |
| 12 | `    link  "Work"   /work` | `STRING` then a route — a two-positional prop via `with` (§4.4). `/work` → intent `go` (§4.3) |
| 14 | `    group "Products" as dropdown` | Child block, `nav`-only (§3.3). The `as` clause is the last element of the head (§3.1) and selects the overlay preset (overlays §4) |
| 15 | `      link "Shoes" /shoes` | `INDENT` to level 3 — the deepest legitimate chain in the language (§2.5) |
| 17 | `    cta    "Reserve" /reserve` | `DEDENT` from level 3 to level 2. Column 4 is on the stack, so the dedent is legal (§2.4) |
| 18 | `    mobile drawer` | Type `enum`, values from `nav`'s manifest: `drawer` `sheet` `full` (nav-spec §6) |
| 20 | `  footer` | `DEDENT` to level 1. A block word with no atoms and no arguments — legal (§3.2 `block`, zero `atom`s) |
| 21 | `    link "Pricing" #pricing` | `#` is followed by a letter, so it is **not** a comment (§1.8). Anchor → intent `show` |
| 23 | `    link "Email" mailto:…` | `PAIR` with scheme key `mailto` → intent `mail` (§4.3) |
| 25 | `page /` | `DEDENT` to level 0, closing `site`. `page` takes a route; `/` is the shortest legal one |
| 26 | `  hero split 3d scroll` | One variant, two modifiers. Two variants here would be hero-spec §11's `'center' and 'split' are both layouts` |
| 27–29 | `eyebrow` / `title` / `sub` | Type `string`. Quoted, so escaped at emit and never concatenated (CONVENTIONS §6) |
| 30 | `    cta "Reserve a pair" /reserve` | First of at most two CTAs; `max: 2` in the manifest produces hero-spec §11's third-CTA error |
| 31 | `    alt "Call the studio" tel:+…` | Scheme `tel` → intent `call`, phone icon, tap-to-call (buttons §1.2) |
| 32 | `    model ./assets/shoe.glb` | `path`, `ext: [".glb"]`, `maxBytes: 5242880`. Required by the `3d` modifier via manifest `requires` (ARCHITECTURE §4.1) |
| 33 | `    height 85` | `number`. `85` is a `BARE` at parse time and becomes a number only when typed (§1.6) |
| 34 | `    slot after ./custom/Ticker.tsx` | Slot name then path (PRD §6.6, ROADMAP M3). `before` and `after` are injection points every block has — the component renders beside the block; any other name must be a slot the block's manifest declares, and the component joins that slot's fills (AZ1218 otherwise) |
| 36 | `  feature grid 3` | `grid` is a `feature` variant; `3` is the positional consumed by the manifest's `arg` (§3.2). The parser sees two indistinguishable `BARE`s |
| 37 | `  gallery orbit` | `orbit` is a `gallery` variant, declared in `gallery/word.json` — not a global modifier. There is no global modifier list |
| 39–41 | `text` block | Two props; `body` is a `path` to markdown, not inline content — `.az` holds no markup (§6) |
| 43 | `  cta` | A block word alone on a line. Legal: zero atoms, zero arguments, no body |
| 44 | `  raw ./custom/Badge.tsx` | The escape hatch. Legal in a page body and inside a block (§3.3) |
| 46 | `page /login       # no nav …` | The `#` is preceded by whitespace and followed by a space → comment (§1.8 rule 2) |
| 47 | `  nav none` | Suppresses the inherited site nav (§5.2). `none` takes no other atoms |
| 48 | `    adapter hosted` | A **site-scoped** prop (`scope: "site"` in `auth`'s manifest): declared once under the site's `auth`, never per block — auth-block-spec §2, "one adapter per site". Checked file-wide, so a page's `auth login` is legitimately silent about it |

### 8.2 The same file, three ways to break it

| Broken line | Diagnostic |
|---|---|
| `	theme midnight` (tab indent) | `indent: tab character in leading whitespace — use spaces, 2 per level` |
| `   theme midnight` (3 spaces) | `indent: 3 spaces is not a multiple of 2 — use 2 spaces per level` |
| `hero split center` | `hero: 'split' and 'center' are both layouts — pick one` |

---

## 9. Conformance checklist

A parser conforms when all of these hold. Each is a fixture in `/fixtures`
(CONVENTIONS §9).

- [ ] Every diagnostic in this document has a fixture that triggers it
- [ ] A file with 20 distinct errors reports 20 diagnostics, not 1
- [ ] A tab in leading whitespace fails; a tab between tokens does not
- [ ] A blank line inside a block does not close it
- [ ] A comment line at column 3 inside a level-1 block is silently ignored
- [ ] `title "Item #4"` keeps the `#`; `page / # x` drops it
- [ ] `alt "Go" #pricing` keeps the `#`, and the value types as `url`
- [ ] `model ../x.glb` fails before any filesystem access
- [ ] A page-level `nav` replaces the site-level one with no property merge
- [ ] Parsing the same file twice yields byte-identical ASTs, positions included
- [ ] The AST round-trips: `format(parse(src))` is stable under a second pass
