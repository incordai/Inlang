# Data — tables, API, admin and data in blocks

**Status** approved 2026-10-05 (§16) · **D1 built 2026-10-05** — what was
built differently, and what the real databases showed, is §18 · **D2 (admin)
built 2026-10-05**, §18.3 · D3–D4 not built · Extends backend-spec.md and
auth-block-spec §3.4

The owner's goal: **a few words in the `.az` file give a ready backend with an
API.** The author declares tables; the build gives database tables and
migrations, a safe REST API, a typed client, an admin area, and lists that the
existing blocks can show. Nothing here adds a block — the eleven-block cap
stays. `data` is a structure keyword like `backend`, and the admin area is
generated pages.

Bracketed tags such as [R5] point to the research sources in §17, the only
section that names outside products.

---

## 0. Grounding — what exists today

FACT, from the code as of commit `8add978`:

| Fact | Where |
|---|---|
| `backend` is a site-level structure keyword, two closed settings | `packages/core/src/link.ts:145`, `packages/core/src/backend.ts` |
| A site with `backend` must use `auth adapter azbackend` (AZ1507) | `packages/core/src/spec.ts:313` |
| One query interface over three engines; `?` placeholders only; values never spliced | `packages/backend/src/server/db.ts` |
| Pooler-safe rule: every query is ONE unnamed statement; no `SET`, locks, `LISTEN`, or multi-call transactions | `db.ts:96`, backend-spec §3.1 |
| Migrations are versioned per-engine SQL steps, applied on every start, no lock | `migrations.ts`, `db.ts:132` |
| Ids are random UUIDs; times are epoch ms in 64-bit integers; flags 0/1; MySQL tables `utf8mb4_bin` | `store.ts:74`, `migrations.ts` |
| Bodies: JSON objects only, 16 KB cap | `http.ts:21` |
| CORS allows `GET, POST` only; CSRF = allowed `Origin` + `x-az-request: 1` on POST | `http.ts:84`, `app.ts:438` |
| Every response `Cache-Control: no-store`, CORP `same-site` | `http.ts:70`, `http.ts:75` |
| Anything outside `/auth/` answers 404 today | `app.ts:431` |
| Errors are `{ error, field? }` from a closed code set; messages never reach the page | `app.ts` header, auth-spec §3 |
| `az migrate` already means "upgrade the .az grammar" | `packages/cli/src/migrate.ts` |
| Page routes are exact static paths; no route parameters | GRAMMAR §5.5 |
| `iso4217` checks only the shape of a currency code | `link.ts:131` |
| PRD §6.8 lists "CMS / content editing" and "e-commerce & checkout" as non-goals | PRD §6.8 |
| PRD principle 7: no actions, conditionals or variables in `.az` | PRD §5 |
| Max nesting depth 4 | GRAMMAR §2.5 |

Every design choice below is checked against these. Where a choice depends on
something not verified, it says so.

---

## 1. Goals and non-goals

**Goals (v1)**

1. Declare a table in a few lines; get tables, indexes and migrations on all
   three databases, with identical values on each.
2. A REST API with **deny-by-default** access rules from a small closed
   vocabulary, enforced **in the SQL statement**, never only in the page.
3. Bounded queries: allow-listed filters and sorts, a hard page-size cap,
   keyset pagination, escaped search.
4. Image fields with upload, type and size checks, served under the table's
   read rule.
5. Schema changes over time that **never lose data silently**: additive
   changes are automatic; drops, renames and type changes need an explicit
   command.
6. A typed client and an OpenAPI document, generated, deterministic.
7. A protected admin area: list, search, create, edit, delete, upload.
8. `gallery`, `feature` and `faq` can list rows from a table.
9. Everything reuses the server that exists: its session, CSRF, CORS, rate
   limiting, logging rules and env schema.

**Non-goals (v1)** — stated so they are refused, not drifted into:

- payments, carts, checkout (money is a field type, not a shop);
- many-to-many relations, nested writes, joins beyond one level;
- realtime updates; webhooks; scheduled jobs;
- teams, organisations, roles beyond "admin" — multi-tenancy;
- API keys for non-browser clients;
- arbitrary expressions in access rules (PRD principle 7);
- dynamic page routes (`/products/:id`) — the grammar has none (GRAMMAR §5.5);
- generic file uploads (only images in v1);
- rich text / HTML fields.

---

## 2. What the research says — and what we take from it

Each line: the lesson, its sources, and the decision it drives.

| # | Lesson | Sources | Decision here |
|---|---|---|---|
| L1 | The safest systems ship rules **locked by default**: a missing rule means "admins only", and an empty rule means "public" — two different spellings for two very different outcomes | [R1] [R7] [R9] | No `allow` line = admin-only. There is no way to write "public" by accident: it is `allow anyone read`, spelled out |
| L2 | The most damaging incidents in this space are tables reachable without row rules — one class of generated apps exposed 170+ databases through a missing policy | [R5] [R8] [R23] | Rules are part of the table declaration and compiled into every statement; there is no table without a rule set and no "turn rules off" switch |
| L3 | "Any signed-in user" rules are a known trap — they grant every account access to every row | [R23] | `signedin` may read and create, never edit or delete; edit/delete is `owner` only |
| L4 | Rules work best as **row filters**: the rule is added to the query's WHERE, so a denied row is simply not found | [R1] [R5] [R9] | Owner checks are `AND owner = ?` inside the one statement. Denied = `404 not_found`, the same as absent — no existence oracle |
| L5 | Create and update need a separate "what may the new row look like" check (USING vs WITH CHECK; column presets) | [R5] [R9] | `owner` is **set by the server** from the session on create and is never writable through the API; `locked` fields are admin-only |
| L6 | Mass assignment is the classic generated-API flaw (a 2012 key-to-repository takeover); frameworks answered with explicit allow-lists | [R17] [R18] [R20] | The body allow-list is the declared fields minus system/locked fields; **any other key is refused (400)**, not silently dropped |
| L7 | Guessable ids + missing per-object checks = BOLA, the top API risk | [R19] | Random UUIDs (as the auth tables already use) **and** the rule in every statement; random ids alone are never the control |
| L8 | Unbounded queries: one tool returns "all rows" for `limit=-1`; another has no row cap by default | [R7] [R10] [R21] | Default 20, max 100, not configurable from the request; no "all" value |
| L9 | Offset pagination degrades with depth and drifts when rows are inserted | [R26] | Keyset (`after` cursor) only |
| L10 | Rich filter languages are an injection and performance surface | [R1] [R6] [R10] | A tiny filter grammar: `field=value`, `field.lt/lte/gt/gte`, `field.in` — only on allow-listed fields, never on private fields, values always bound |
| L11 | Unfiltered UPDATE/DELETE is a known foot-gun of auto-APIs | [R6] | The public API has no bulk update or delete — one row per request, by id |
| L12 | Rename detection is guesswork; one popular tool turns a rename into drop + add and warns about data loss | [R14] | Renames are never inferred; they are an explicit command |
| L13 | MySQL cannot roll back DDL; SQLite can only add/rename/drop columns in place and cannot add a UNIQUE column | [R15] [R24] | One DDL statement per recorded sub-step, resumable; unique is added as a separate `CREATE UNIQUE INDEX`; type changes are refused in v1 |
| L14 | Exact money needs exact storage; SQLite has no exact decimal | [R13] [R25] | `money` = 64-bit integer of minor units, like our epoch-ms times |
| L15 | Uploads: allow-list types, don't trust Content-Type, generate names, cap size, store apart, re-encode images | [R22] [R21] | §8; re-encoding needs a dependency decision (§16, Q6) |
| L16 | Auto-admin is for **trusted** staff, not the public front end | [R16] | Admin is allow-listed verified accounts; every admin write is audited |
| L17 | Realtime subscriptions must re-apply the list/view rule per subscriber | [R4] | Deferred; noted as a requirement for later |
| L18 | Types-only clients generated from an OpenAPI document cost nothing at runtime | [R28] | We emit our own small typed client **and** `openapi.json`, so others can generate theirs |
| L19 | Standard error documents exist, but warn against leaking detail | [R27] | We keep our `{ error, field? }` shape (the site's adapters already speak it) |

---

## 3. The owner's sketch — evaluated

```
data products
  name   text required
  price  money
  stock  number
  photo  image
  access anyone reads, signed-in owners edit
```

What is right: one line per field, the type second, modifiers after — it
reads like the rest of the language, and it fits the depth cap.

What has to change:

| Problem | Why | Fix |
|---|---|---|
| `access anyone reads, signed-in owners edit` | a sentence with commas is a second grammar; one bad word hides the whole rule; `signed-in` is not a word (GRAMMAR §1.4, AZ1104 shape) | one rule per line: `allow <who> <action…>` |
| `money` without a currency | the amount 1999 means nothing without it; the minor-unit exponent depends on it | `price money usd` |
| `number` | whole or fractional? | `number` is whole; fractional numbers are an open question (§16, Q9) |
| the owner is implicit | who "owns" a row must be unambiguous | every table has a server-set `owner` system column (§4.4) |
| where the block lives | `data` must sit where `backend` sits | directly under `site` (§4.1) |

---

## 4. The grammar

### 4.1 Placement

```
az 1
site shop
  auth
    adapter azbackend
  backend
    database postgres
    email    smtp

  data products
    name     text     required search
    blurb    longtext search
    price    money    usd required
    stock    number   default 0 locked
    photo    image
    category ref      categories
    status   choice   draft live sold
    allow anyone   read
    allow signedin create
    allow owner    edit delete

  data categories
    name     text     required unique
    allow anyone read
```

- `data <name>` is a **site-level structure keyword** (added to
  `STRUCTURE`, `link.ts:145`). Not a block; renders nothing; outside the cap.
- It requires `backend` (which already requires `auth adapter azbackend`).
- Depth: `site` 0 → `data` 1 → field/rule 2. Two spare levels.
- Every field and rule is **one line**. No line continuation, no commas.

### 4.2 Productions (link stage; the parse grammar is unchanged)

```ebnf
data-decl   = "data" , table , NEWLINE , INDENT , { data-member } , DEDENT ;
data-member = field | rule ;

field       = fieldname , type , { type-arg } , { modifier } , NEWLINE ;
rule        = "allow" , who , action , { action } , NEWLINE ;

table       = BARE matching word-name, 2–30 chars, not reserved (§4.6) ;
fieldname   = BARE matching word-name, 1–30 chars, not reserved (§4.6) ;

type        = "text" | "longtext" | "number" | "money" | "flag"
            | "date" | "datetime" | "email" | "url"
            | "choice" | "image" | "ref" ;
type-arg    = currency           (* money: one, required *)
            | value-name         (* choice: 2–30, distinct *)
            | table ;            (* ref: one, required *)

modifier    = "required" | "unique" | "index" | "search"
            | "private" | "locked"
            | "default" , default-value ;

who         = "anyone" | "signedin" | "owner" ;
action      = "read" | "create" | "edit" | "delete" ;
```

A `field` line's first token is the field name — the same "first token is
the word" rule as every statement. Field names and keywords never clash
because the keywords (`allow`) are reserved field names (§4.6).

### 4.3 Field types

| Type | Holds | sqlite | postgres | mysql | API value | Limits |
|---|---|---|---|---|---|---|
| `text` | one line | `TEXT` + `CHECK(length(x) <= 200)` | `VARCHAR(200)` | `VARCHAR(200)` | string | 1–200 chars after trim; no control chars |
| `longtext` | paragraphs, plain text | `TEXT` + check 10000 | `TEXT` | `TEXT` | string | ≤ 10 000 chars; `\n` allowed; no HTML rendering |
| `number` | whole number | `INTEGER` | `BIGINT` | `BIGINT` | number | `±(2^53 − 1)` (JS safe integer) |
| `money` | amount in minor units | `INTEGER` | `BIGINT` | `BIGINT` | number (minor units, e.g. 1999) | `0 … 2^53 − 1`; currency fixed per field |
| `flag` | on/off | `INTEGER` 0/1 | `SMALLINT` | `TINYINT` | boolean | default off |
| `date` | calendar day | `TEXT` | `CHAR(10)` | `CHAR(10)` | `"YYYY-MM-DD"` | a real date, 0001–9999 |
| `datetime` | instant | `INTEGER` | `BIGINT` | `BIGINT` | number (epoch ms) | as the auth tables |
| `email` | address | `TEXT` + check 254 | `VARCHAR(254)` | `VARCHAR(254)` | string | the server's existing `isEmail` |
| `url` | link | `TEXT` + check 2048 | `VARCHAR(2048)` | `VARCHAR(2048)` | string | `https:` (or `http:`) only; never indexed |
| `choice` | one of the listed values | `TEXT` + `CHECK(x IN …)` | `VARCHAR(63)` + `CHECK` | `VARCHAR(63)` + `CHECK` | string | value in the declared list |
| `image` | an uploaded image | `TEXT` key + `INTEGER` w/h | `VARCHAR(80)` + `INTEGER` ×2 | same | `{ url, width, height }` or null | §8 |
| `ref` | belongs-to another table | `TEXT REFERENCES … ` | `VARCHAR(36) REFERENCES …` | `VARCHAR(36)` + FK | string (id) | target row must exist; `ON DELETE RESTRICT` |

Why these mappings: they follow the existing rule "the three engines hold
identical values" (`migrations.ts` header). `date` as `YYYY-MM-DD` text sorts
correctly everywhere; `datetime` matches `created_at`. `money` as minor units
avoids SQLite's lack of an exact decimal [R13] [R25]. MySQL ≥ 8.0.16 enforces
`CHECK` (INFERENCE from vendor docs, to verify in the container test); the
server validates every value before the statement anyway, so the constraint
is a second line, not the first.

**Money.** `price money usd` — the currency is a `type-arg` checked against
ISO 4217. The minor-unit exponent (usd 2, jpy 0, bhd 3) comes from a
**committed table** (data, like the CLDR country list), because `iso4217`
today checks only the shape (`link.ts:131`) and reading the exponent from the
runtime's locale data would make two builds differ by Node version.

**Image** columns are a storage key plus width and height in companion
columns named `<field>__w` / `<field>__h` (a `__` cannot appear in an author's
name, so they never clash). Width and height let blocks reserve space and avoid
layout shift.

### 4.4 System columns — on every table, never declared

| Column | sqlite / postgres / mysql | Set by | In the API |
|---|---|---|---|
| `id` | `TEXT` / `VARCHAR(36)` primary key | server, `randomUUID()` | `id` |
| `owner` | `TEXT` / `VARCHAR(36)`, nullable, FK `az_users(id) ON DELETE CASCADE` | server, from the session on create; null when created signed out | **never the id** — `mine: true/false` for the caller; the owner's email for admins |
| `created` | 64-bit integer | server | `created` (epoch ms) |
| `updated` | 64-bit integer | server, every write | `updated` |

`owner` exists on every table, even one with no `owner` rule, so adding
`allow owner edit` later is not a schema change. Not exposing the owner's id
stops one account's rows being correlated across tables.

### 4.5 Modifiers

| Modifier | Meaning | Allowed on | Notes |
|---|---|---|---|
| `required` | must be present and non-empty on create; cannot be cleared | all but `flag` | adding `required` to an existing table needs `default` (§9) |
| `unique` | no two rows share the value | `text`, `email`, `number`, `date` | a `CREATE UNIQUE INDEX`; binary comparison on all three engines (`utf8mb4_bin` as today), so `A` ≠ `a` |
| `index` | build an index | sortable/filterable types | `ref`, `unique` and `created` are indexed automatically |
| `search` | included in `q=` search | `text`, `longtext`, `email` | at most 4 per table |
| `private` | readable only by the row's owner and admins; never filterable or searchable by others | all | for contact details on a public table |
| `locked` | only admins may set or change it; everyone else reads it | all but `ref` | e.g. `featured flag locked`, `stock number locked` |
| `default <v>` | value on create when absent | all but `image`, `ref` | typed like the field: `default 0`, `default "Untitled"`, `default draft`, `default on` |

### 4.6 Reserved names

- Field names: `id owner created updated allow mine` and any name ending a
  query operator (`lt lte gt gte in`) — a field named `in` would make
  `?x.in=` ambiguous only if allowed, so it is refused.
- Table names: `users sessions tokens accounts admin files auth data health`
  — they would read as the account system or collide with server paths. The
  diagnostic suggests `profiles` for `users`.
- SQL table names are `azd_<table>` and every identifier is quoted, so SQL
  keywords (`order`, `group`) are fine as author names.
- Limits: 20 tables per site, 30 fields per table — a wall to hit early, not
  late. Identifier lengths are bounded so `azd_<table>_<field>_idx` fits the
  63/64-byte limits of postgres and mysql.

### 4.7 Access rules

```
allow anyone   read             public list and detail
allow signedin read             any signed-in account reads every row
allow owner    read             a signed-in account reads its own rows
allow anyone   create           a signed-out visitor may add a row (forms, waitlists)
allow signedin create           a signed-in account may add a row; it becomes the owner
allow owner    edit delete      the owner may change or remove its own rows
```

**Semantics.**

- **Deny unless stated.** A table with no `allow` line is reachable only
  from the admin area (warning AZ1246 says so, it is legal — an inbox the
  public never reads is a real use).
- Rules **add up**: an action is allowed if any line grants it.
- Admins can do everything on every table, always, through the admin
  routes only (§11). Admin is not a `who`, so it cannot be granted or taken
  away in the file.
- The closed matrix — anything else is a compile error:

| who \ action | read | create | edit | delete |
|---|---|---|---|---|
| `anyone` | ✓ | ✓ (warning AZ1247: spam — rate-limited, moderate in admin) | ✗ AZ1241 | ✗ AZ1241 |
| `signedin` | ✓ | ✓ | ✗ AZ1242 | ✗ AZ1242 |
| `owner` | ✓ | ✗ AZ1243 (a row has no owner before it exists) | ✓ | ✓ |

- An `owner` rule needs owned rows: with `allow owner …` the table must not
  also say `allow anyone create` (anonymous rows would have no owner and be
  stuck) — AZ1244.

**Why this is not a conditional** (PRD principle 7). The file names *who* may
do *what*, from two closed lists. There are no expressions, comparisons or
field references — the compiler, not the author, writes the predicate. The
expression-based rule languages studied [R1] [R5] [R9] are exactly what this
avoids: a rule language is a second programming language, and the incidents
in L2/L3 are mistakes made in one.

**How each rule becomes SQL** (one statement each, pooler-safe):

| Request | Statement shape |
|---|---|
| list, `anyone`/`signedin` read | `SELECT <readable cols> FROM azd_t WHERE <filters> AND <keyset> ORDER BY … LIMIT n` |
| list, only `owner` read | the same `AND owner = ?` (session user); signed out → `401 signin_required` |
| get one | the list predicate `AND id = ?`; no row → `404 not_found` |
| create | `INSERT … (id, owner, created, updated, <allowed cols>) VALUES (?…)` — `owner` from the session, never the body |
| edit | `UPDATE azd_t SET <allowed cols>, updated = ? WHERE id = ? AND owner = ?` — 0 rows → `404 not_found` |
| delete | `DELETE FROM azd_t WHERE id = ? AND owner = ?` — 0 rows → `404 not_found` |

`<readable cols>` drops `private` fields unless the caller is the row's owner:
for a mixed list the server selects `CASE WHEN owner = ? THEN col END`, so
the column is null for everyone else — decided in SQL, not after the fact.

---

## 5. The REST API

All routes under `<AZ_BACKEND_PUBLIC_URL>/data/<table>`, JSON in and out.

| Method | Path | Body | Success |
|---|---|---|---|
| GET | `/data/<t>` | — | `200 { items: [...], next: "<cursor>" \| null }` |
| GET | `/data/<t>/<id>` | — | `200 { item }` |
| POST | `/data/<t>` | `{ field: value, … }` | `201 { item }` |
| PATCH | `/data/<t>/<id>` | some fields | `200 { item }` |
| DELETE | `/data/<t>/<id>` | — | `204` |
| PUT | `/data/<t>/<id>/<imagefield>` | the raw image bytes | `200 { item }` |
| DELETE | `/data/<t>/<id>/<imagefield>` | — | `200 { item }` (field cleared) |
| GET | `/data/<t>/<id>/<imagefield>` | — | the image (§8) |

An `item` is `{ id, created, updated, mine, …fields }`.

### 5.1 Query parameters — allow-listed, all of them

| Param | Form | Rules |
|---|---|---|
| `limit` | `1…100` | default 20; anything else is `400 bad_query` |
| `after` | opaque cursor from `next` | base64url of `[sortValue, id]`; shape-checked; values bound as parameters |
| `sort` | `field` or `-field` | only `created`, `updated`, or a **required** field of type `text number money date datetime choice`; one key, `id` is the tiebreak. Required-only because the three engines order NULLs differently, which would break keyset paging |
| `<field>` | `price=1999` | equality on `number money flag date datetime choice ref email`; `flag` is `on`/`off` (GRAMMAR §4.1 spelling) |
| `<field>.lt/.lte/.gt/.gte` | `price.gte=1000` | on `number money date datetime` |
| `<field>.in` | `status.in=draft,live` | up to 20 values; `choice`, `ref` |
| `q` | `q=chair` | 2–100 chars; `LOWER(col) LIKE LOWER(?) ESCAPE '\'` over `search` fields with `%` `_` `\` escaped; OR across fields |
| `mine` | `mine=1` | only rows the caller owns (signed in) |

- **Unknown parameter → `400 bad_query`** with `field`. Silently ignoring a
  misspelt filter returns the wrong rows and looks like it worked.
- A `private` field is never filterable, sortable or searchable by a caller
  who is not its owner — otherwise `email=x@y` is a yes/no oracle.
- No `total` count (a full count is an unbounded scan); the admin area gets
  one (§11).
- `LIMIT` is a validated integer 1–100. Implementation note (INFERENCE, to
  verify): one driver's prepared `LIMIT ?` is reported to reject numeric
  parameters; the integer, already range-checked, may be written into the
  statement text — it is never request text.
- Search: `LOWER` is ASCII-only on sqlite (INFERENCE from its docs — to
  verify), so `Ä`/`ä` match case-insensitively on postgres/mysql but not
  sqlite. Stated, not hidden. Full-text search is later.

### 5.2 Bodies

- `application/json` objects only; cap **64 KB** for `/data` (a full
  `longtext` in UTF-8 is up to 40 KB). Auth routes keep 16 KB.
- Allowed keys = the table's fields minus `locked` (non-admin) and minus
  system columns. **Any other key → `400 invalid` with that `field`** (L6).
- `null` clears an optional field; a `required` field cannot be cleared.
- `ref` values must be a UUID-shaped string; the FK rejects a missing target
  (`400 invalid`, `field`).

### 5.3 Errors — the closed `DataErrorCode` set

`{ error, field? }`, the same shape as auth (`app.ts`). The site maps codes
to copy; the server never writes a sentence meant for a person.

| Status | `error` | When |
|---|---|---|
| 400 | `invalid` | wrong type, bad value, unknown key (`field` set) |
| 400 | `required` | a required field missing or empty (`field`) |
| 400 | `too_long` | over the type's limit (`field`) |
| 400 | `bad_query` | unknown or malformed query parameter (`field` = param) |
| 401 | `signin_required` | the action needs a session and there is none |
| 403 | `forbidden` | signed in, but no rule grants this action on this table |
| 403 | `unknown` | CSRF/Origin refusal — unchanged from auth (`app.ts:438`) |
| 404 | `not_found` | no such row **or no readable/editable row** — same answer |
| 409 | `taken` | a unique field already holds the value (`field`) |
| 409 | `in_use` | delete refused: another table's `ref` points here |
| 413 | `too_large` | body or image over the cap |
| 415 | `unsupported_type` | image not one of the allowed formats |
| 429 | `rate_limited` | §5.5 |
| 500 | `unknown` | anything else; logged by class only |

### 5.4 CSRF, CORS, headers — reused, widened only where needed

- `/data` is a fetch route: allowed `Origin` always; `x-az-request: 1` on
  **every non-GET** (POST, PATCH, PUT, DELETE) — today only POST is checked
  (`app.ts:438`), the rule is extended, not copied.
- CORS for `/data` allows `GET, POST, PATCH, PUT, DELETE`; the auth routes
  keep `GET, POST` (`http.ts:84`). Exact origin, credentials, `Vary: Origin`,
  never `*`.
- All security headers as today (`no-store` included) except image responses
  (§8).
- The Origin check is CSRF protection for browsers, **not** access control:
  any non-browser client can send any Origin. The rules (§4.7) are the
  control. The docs say so, in those words, as auth-spec §4.1 does.

### 5.5 Rate limits

The existing limiter (`createLimiter`, per process, bounded keys):

| Bucket | Limit |
|---|---|
| reads per address | 600 / 10 min |
| writes per address | 60 / 10 min |
| `anyone create` per address, per table | 10 / hour |
| writes per account | 120 / 10 min |
| image uploads per account (or address) | 30 / hour |

Fixed in v1; env overrides later. Per-process, as backend-spec §5 states.

---

## 6. Migrations — the schema over time

### 6.1 The schema lock

The `.az` file says what the tables **are**; it cannot say how they got
there (a rename looks like a drop plus an add [R14]). So the history lives in
a generated, committed file beside the site: **`<site>.data.json`** — the
ordered steps and the schema each one produces.

```json
{ "steps": [
  { "version": 1, "ops": [{ "op": "createTable", "table": "products", "fields": [...] }] },
  { "version": 2, "ops": [{ "op": "addField", "table": "products", "field": { "name": "photo", "type": "image" } }] }
] }
```

- `az build` reads it. If the `.az` data does not equal the lock's final
  schema, the build **fails** (AZ1701) and names the command to run. A build
  never writes the lock: `az build` twice stays byte-identical, and a schema
  change is always a reviewed diff.
- The build turns the lock into per-dialect SQL steps in the generated server
  (`server/src/data-migrations.ts`), in the same shape as `migrations.ts`.

### 6.2 Commands

`az migrate` is taken (grammar upgrades), so the data commands live under
`az backend`, beside `init`:

| Command | Does |
|---|---|
| `az backend plan <file.az>` | prints the difference between the file and the lock, marking each change **safe** or **destructive**; writes nothing |
| `az backend schema <file.az>` | appends the safe changes as one new step; refuses if anything destructive is pending and lists the flags that would allow it |
| `… --rename products.title=name` | records a rename (column or table: `--rename products=items`) |
| `… --drop products.stock` | records a drop of that one field (or table) — named one at a time, never "all" |

**Safe (automatic):** new table; new optional field; new required field
**with** `default`; new index; `search`/`private`/`locked` changes (no SQL);
adding a value to a `choice`; adding an `allow` line.

**Destructive (explicit flag):** dropping a field or table; renaming;
removing a `choice` value (rows may hold it — refused while any row does);
adding `unique` (refused while duplicates exist — the server checks at apply
time and stops with the duplicate count, not the values).

**Refused in v1:** changing a field's type; making an existing field
`required` without `default`. The message says how: add a new field, copy in
the admin area, then `--drop` the old one. (SQLite needs a 12-step table
rebuild for type changes [R24]; one path that works on all three is better
than three paths that mostly work.)

### 6.3 Applying on the server

- A separate history table, `az_data_migrations (version, step, applied_at)`,
  so the auth schema and the data schema never share version numbers.
- **One DDL statement per recorded sub-step.** MySQL cannot roll DDL back
  [R15]; recording each statement lets a failed step resume where it stopped
  instead of being half-applied forever. Each statement runs alone — the
  pooler rule holds.
- **Safe steps apply on start**, like auth migrations today.
- **Destructive steps never apply on start.** The server refuses to start,
  naming the step, until the operator runs
  `node src/main.ts --migrate --confirm <version>` — after a backup, which
  the README's runbook states first. `az dev` applies them to `.az-dev/dev.db`
  automatically, printing what was dropped: the dev database is disposable.
- **Several instances starting at once** (FACT: `migrate()` takes no lock,
  `db.ts:132`; advisory locks are excluded by the pooler rule): each step is
  claimed by inserting its `(version, step)` row **before** running it — the
  primary key lets exactly one instance win; a loser waits (bounded, 30 s)
  and re-reads. The same fix should be applied to the auth migrations (scope
  note, not part of this work).

---

## 7. The typed client and the API document

Generated by `az build`, deterministic:

- **`src/data/client.ts`** in the site — one type per table (`Product`,
  `ProductInput`, `ProductQuery`) and `list / get / create / update / remove /
  upload / clear` per table, over `fetch` with `credentials: "include"` and
  `x-az-request: 1`, reading `AZ_PUBLIC_BACKEND_URL` exactly as the auth
  adapter does. Results are `{ ok: true, … } | { ok: false, code, field? }`
  with `DataErrorCode` — the auth adapter's convention. No dependency.
- **`server/openapi.json`** — OpenAPI 3.1 for every table route, query
  parameter, body and error, so any other client can be generated from it
  [R28]. Keys sorted; no timestamps.

The typed client is what the blocks (§10) and the admin pages (§11) use, and
what a `raw` component uses when the author needs more than a block gives.

---

## 8. Images

**Accepted:** JPEG, PNG, WebP, AVIF — decided by the file's **magic bytes**,
never the request's `Content-Type` or a filename [R22]. SVG is refused (it
can carry script). GIF later, if asked.

**Limits:** 5 MB (`AZ_UPLOAD_MAX_MB`, max 20); width and height read from
the header, each ≤ 8000 px and ≤ 40 megapixels — a small file can decode to
gigabytes. Streamed to a temporary file with the cap enforced while reading.

**Names:** a fresh `randomUUID()` + the detected extension. The author's file
name is never stored or used — no path traversal surface.

**Storage:** v1 is **local disk** (`AZ_FILES_DIR`, default `./data/files`,
outside anything served statically). Object storage behind an env switch is
later (§15) — it needs either a vetted dependency or a request-signing
implementation over Node's HMAC, a decision of its own.

**Serving:** `GET /data/<t>/<id>/<field>` applies the table's **read rule**
(and `private`) exactly like a row read. Response headers:

- `Content-Type` = the detected type; `X-Content-Type-Options: nosniff`;
  `Content-Disposition: inline`; `Content-Security-Policy: default-src 'none'; sandbox`;
- an `anyone`-readable, non-private image: `Cache-Control: public,
  max-age=31536000, immutable` (the key changes on every upload) and CORP
  `cross-origin`, so a site on another site can embed it;
- anything else: `Cache-Control: private, no-store`, CORP `same-site`.

**Replacing** an image writes the new file, updates the row (one statement),
then deletes the old file; a crash between leaves an orphan, swept by a
periodic job comparing the directory to the keys in use.

**Metadata.** Photos from phones carry location (EXIF GPS). Stripping it
properly means decoding and re-encoding [R22], which needs an image library —
vetted first (§16, Q6): `sharp` 0.35.5, decided 2026-10-06
(`docs/stack-evaluation.md` §14). Every upload is decoded under a loader
allow-list and re-encoded to WebP with no metadata; as built: §18.4.

---

## 9. Validation — where each rule is checked

| Rule | Compile time (`az check`) | Server (every request) | Database |
|---|---|---|---|
| types, lengths, choice values, email/url shape | defaults only | ✓ | `CHECK` (second line) |
| required | — | ✓ | `NOT NULL` where the column was created required |
| unique | — | catches the violation (`isUniqueViolation`, `db.ts`) → `409 taken` | unique index |
| ref target exists | — | FK error → `400 invalid` | FK |
| access rules | the matrix (§4.7) | in the statement | — |

---

## 10. Data in existing blocks — `from <table>`

### 10.1 Syntax

```
page /shop
  feature grid
    title "In the shop"
    from products
      title  name
      text   blurb
      media  photo
      sort   -created
      limit  6
      filter status live
      empty  "Nothing here yet — check back soon"
```

`from` is a block property with children: each child maps **a slot prop to a
field** (`title name` = the item's `title` comes from the field `name`), plus
four settings: `sort`, `limit`, `filter` (equality on a `choice` or `flag`
field, at most two lines — ids are random, so a `ref` cannot be written in
the file), `mine` (only the visitor's own rows), and `empty` (copy for no
rows). Depth: `page` 0 → block 1 → `from` 2 → mapping 3.

### 10.2 Which blocks

| Block | Slot | Mapping (← field types) | Required mappings |
|---|---|---|---|
| `gallery` | `image` | `src` ← image · `alt` ← text · `caption` ← text | `src`, `alt` (accessibility: AZ2106's rule, made an error here) |
| `feature` | `item` | `title` ← text · `text` ← text/longtext · `media` ← image | `title` |
| `faq` | `item` | label ← text (`question name`) · `text` ← longtext | both |

`pricing` is later (plans rarely live in a table, and money formatting per
plan needs its own design). `hero`, `cta`, `nav`, `footer`, `auth`, `scene`,
`text` take no `from`.

A block with `from` declares no static items of that slot (AZ1263). The
slot's `max` caps `limit` (feature 12, faq 12, gallery 100 here — the page
size cap). Count checks that the manifests run on static items (e.g. bento
3–7, orbit 4–16) run at **runtime** instead: below the minimum, `orbit` falls
back to `grid` and `bento` to `grid`; zero rows shows `empty`.

### 10.3 Build time vs runtime

The compiler never calls a network, and a build must be byte-identical (AGENTS
rules 1 and 7), so **live rows cannot be pre-rendered.** v1:

- The pre-rendered page holds the section's heading and a skeleton sized
  from `limit` and the block's layout (no layout shift), plus a `<noscript>`
  line.
- After hydration the block calls the typed client as the visitor — so the
  rule applies to *them*: an `owner read` table shows their rows, or, signed
  out, the `empty` copy and a sign-in link.
- Errors show one fixed line and a retry button. `rate_limited` and
  `network` map to copy like the auth form's.
- FAQ structured data is not emitted for a `from` faq (it is only useful
  pre-rendered); explicit `schema on` with `from` is warning AZ1265.

SEO consequence, stated: rows are not in the HTML. The later fix keeps the
build offline — `az backend snapshot <file.az>` (the CLI does things;
network allowed there) writes `./data/<table>.json`, committed; a build with a
snapshot pre-renders from it and the runtime refreshes (§15).

Compile-time checks: unknown table (AZ1260), unknown field (AZ1261), field
type does not fit the slot prop (AZ1262), static items alongside `from`
(AZ1263), `limit` over the slot cap (AZ1264), a `private` field mapped
(AZ1266 — it would be blank for everyone but its owner), and a table nobody
signed out can read on a page that is not `protect`ed (warning AZ1267 —
signed-out visitors will only ever see the empty state).

---

## 11. The admin area

**Generated pages, not a block.** With any `data` declared, the build adds
`/admin` (the table list) and `/admin/<table>` (rows, and an editor panel)
to the site. They use the theme tokens and the existing button and form
components; they are excluded from the sitemap and carry `noindex`. A `page
/admin` in the file is an error (AZ1268).

**Who is an admin.** Accounts whose **verified** email is listed in the
server's `AZ_ADMIN_EMAILS`. Not in the `.az` file: an address is personal
data and the list changes without a site rebuild. An unverified account with
a listed address is not an admin — otherwise anyone could sign up with the
owner's address and walk in (the claim logic of backend-spec §5 is what makes
"verified" meaningful). With the list empty, the admin routes answer 403 to
everyone.

**Server routes:** `/admin/data/<t>…`, the same shapes as §5 plus: `count`
in list responses, the owner's email on rows, `locked` fields writable,
`ORDER BY` on any indexed field. Rules are bypassed; **validation is not**.
Same CSRF/CORS; stricter limits (writes 300/10 min per account).

**Actions in v1:** list with search, sort, filter by `choice`/`flag`/`ref`;
create; edit; delete with a confirm step naming the row; upload/replace/clear
an image; follow a `ref` to the target row. **Not in v1:** bulk actions,
CSV import/export (export needs formula-injection escaping — later), schema
editing (the schema is the `.az` file).

**Audit.** Every admin write is a row in `az_data_audit` — admin id, table,
row id, action, time. **No values** (they may be personal data), matching the
log rule of backend-spec §5.

**The pages are UX, not security.** Anyone can load `/admin`'s JavaScript;
every request is checked on the server. The generated file says so in its
header, as the `Protected` wrapper does (auth-spec §5).

---

## 12. Diagnostics

New codes in free slots of the existing ranges (GRAMMAR §7.4), plus a new
range **AZ1700–AZ1749 for the data schema lock**, which GRAMMAR §7.4 gains as
a row.

| Code | Severity | Message (CONVENTIONS §5 form) |
|---|---|---|
| AZ1226 | error | `data: declared outside site — tables are site-level` |
| AZ1227 | error | `data: needs a backend — add at site level: backend / database sqlite / email smtp` |
| AZ1228 | error | `data: 'products' declared twice — merge them` |
| AZ1229 | error | `data products: 'users' is reserved — call it 'profiles'` (table) / `'id' is a system field — pick another name` (field) |
| AZ1230 | error | `data products: no fields — add one: name text required` |
| AZ1231 | error | `data products: 'colour' is not a type — use text, longtext, number, money, flag, date, datetime, email, url, choice, image or ref` |
| AZ1232 | error | `data products: 'price money' needs a currency — write: price money usd` |
| AZ1233 | error | `data products: 'status choice' needs 2 or more values — write: status choice draft live` |
| AZ1234 | error | `data products: 'category ref' needs a table — write: category ref categories` |
| AZ1235 | error | `data products: 'category' points at 'cats', which is not declared — declare: data cats` |
| AZ1236 | error | `data products: 'unique' does not apply to image — remove it` (any modifier on a type it does not fit) |
| AZ1237 | error | `data products: default 'ten' is not a number — write: default 10` |
| AZ1238 | error | `data products: 31 fields, max is 30 — split the table` / `21 tables, max is 20` |
| AZ1239 | error | `data products: 'name' declared twice — keep one` |
| AZ1240 | error | `data products: 'everyone' is not who — use anyone, signedin or owner` / `'update' is not an action — use read, create, edit or delete` |
| AZ1241 | error | `data products: anyone can't edit or delete — use: allow owner edit delete` |
| AZ1242 | error | `data products: every signed-in account editing every row is unsafe — use: allow owner edit delete` |
| AZ1243 | error | `data products: 'owner create' — a row has no owner until it exists; use: allow signedin create` |
| AZ1244 | error | `data products: rows made signed out have no owner, so 'owner' rules can't reach them — use: allow signedin create` |
| AZ1245 | error | `data products: 5 search fields, max is 4 — keep the ones people search` |
| AZ1246 | warning | `data products: no allow lines — only admins can see it; add: allow anyone read` |
| AZ1247 | warning | `data products: 'anyone create' takes rows from strangers — they are rate-limited; check them in /admin` |
| AZ1248 | warning | `data products: 'email' is readable by anyone — add 'private' unless it is meant to be public` |
| AZ1249 | error | `data products: 'name' is an address or key — data names are words` (secret-shaped value, reusing the guard) |
| AZ1260 | error | `feature: from 'prodcts' — no such table; did you mean 'products'?` |
| AZ1261 | error | `feature: from products — no field 'nmae'` |
| AZ1262 | error | `feature: 'media' needs an image field, 'name' is text` |
| AZ1263 | error | `feature: has items and 'from' — use one` |
| AZ1264 | error | `feature: limit 20, max is 12 for feature` |
| AZ1265 | warning | `faq: schema on has no effect with 'from' — rows load after the page` |
| AZ1266 | error | `gallery: 'caption' maps a private field — it would be blank for everyone but its owner` |
| AZ1267 | warning | `feature: signed-out visitors can't read 'orders' — protect this page or add: allow anyone read` |
| AZ1268 | error | `page: '/admin' is generated for data — use another route` |
| AZ1269 | error | `feature: filter 'colour' is not a choice or flag field of products` |
| AZ1415 | error | `data products: 'xyz' is not an ISO 4217 currency` (value typing; reuses the iso4217 table) |
| AZ1701 | error | `data: the file and products.data.json differ — run: az backend plan site.az, then az backend schema site.az` |
| AZ1702 | error | `data: dropping products.stock loses its data — add --drop products.stock to az backend schema` |
| AZ1703 | error | `data: products.title became name? renames are never guessed — add --rename products.title=name` |
| AZ1704 | error | `data: products.price changed type — add a new field, copy, then --drop the old one` |
| AZ1705 | error | `data: products.sku is now required with no default — add: default "…"` |
| AZ1706 | error | `data: products.data.json is edited by hand or damaged — restore it from version control` (hash check) |

Each code gets a fixture that triggers it (CONVENTIONS §9).

---

## 13. Security model

**Principles.** Deny by default. The rule lives in the statement. The server
sets every system value. Every limit is fixed by the server, never chosen by
the request. Nothing about another account (id, existence, private values)
can be inferred from an answer.

| Threat | Example | Defence | Test |
|---|---|---|---|
| SQL injection | `name=x'); DROP…` | values only as parameters (`db.ts`); identifiers only from the validated schema, quoted | hostile values stored literally on all three engines; tables survive |
| Filter / sort injection | `?sort=password_hash`, `?owner=…`, `?a.b.c=` | closed parameter allow-list per table; unknown = 400 | fuzz every param name/value class; nothing but 200/400 |
| BOLA / IDOR | PATCH someone else's row by id | `AND owner = ?` in the statement; random UUIDs | rule × actor × action matrix (§14) |
| Existence oracle | 403 vs 404 reveals a row exists | unreadable = absent = 404 | same body and status for absent vs foreign |
| Mass assignment | body sets `owner`, `id`, `created`, a `locked` field | allow-list; any other key → 400 | each forbidden key refused; row unchanged |
| Excessive exposure | owner ids, private emails in lists | `mine` instead of owner id; `private` nulled in SQL | public list never contains a private value or a user id |
| Private-field oracle | `?email=a@b` on a public table | private fields not filterable/searchable by non-owners | 400 |
| Unbounded queries | `limit=1000000`, deep offsets | limit ≤ 100; keyset only; no counts | 400; constant query plan depth (postgres `EXPLAIN` in container test) |
| Expensive search | `q=%%%%`, 10 KB `q` | 2–100 chars; wildcards escaped; ≤ 4 search fields | literal `%` matches only `%` |
| Spam / flooding | bot fills an `anyone create` table | per-address, per-table limits; admin moderation | 429 after the limit |
| Storage exhaustion | many large uploads | size cap while streaming; per-account upload limit; orphan sweep | 413 before the cap is exceeded on disk |
| Malicious images | SVG with script, HTML polyglot, decompression bomb | magic-byte allow-list, no SVG, pixel cap, `nosniff`, `sandbox` CSP | each sample refused or served inert |
| Path traversal | file name `../../x` | names are generated; author input never touches the path | — (no input reaches it; asserted) |
| Location leak | phone photo GPS | strip metadata (needs Q6) | GPS tag absent after upload |
| Stored XSS | `<script>` in a text field shown by a block or admin | text only, rendered by React (escaped); no HTML fields; `url` scheme allow-list | payload renders as text in all three browsers |
| Dangerous links | `url` field = `javascript:…` | `http:`/`https:` only after browser-style normalisation (the GRAMMAR §4.3 check, reused) | refused |
| CSRF | a form on another site posts to `/data` | Origin allow-list + `x-az-request` on every non-GET | foreign origin 403; missing header 403 for each method |
| CORS | another origin reads data with the visitor's cookie | exact origin, never `*` | preflight headers per method |
| Admin takeover | sign up unverified with the owner's address | admins = **verified** listed emails only | unverified listed account → 403 |
| Silent data loss | rename read as drop + add | renames/drops explicit; destructive steps never on start | refused without flag; refused without `--confirm` |
| Half-applied migration | MySQL fails mid-step | one statement per recorded sub-step; resume | kill mid-step, restart, completes |
| Concurrent migrators | two instances start together | claim row by primary key before running | two processes, one applies |
| Race on unique | two creates with the same value | unique index; violation → 409 | concurrent creates: one 201, one 409 (postgres, mysql) |
| Secret leakage | a connection string typed into `data` | the existing secret guard; no setting takes free text | AZ1249 |
| Log leakage | a value in an error log | route + error class only (backend-spec §5) | log scan after the browser run |
| Spreadsheet formulas | `=HYPERLINK(…)` exported | no export in v1; escaping required when added | — |

---

## 14. Testing plan

Same stack as today (`node --test`, Playwright, Docker for the real
databases). Nothing ships without the test for its row in §13.

**Unit — `pnpm test`**

- Link stage: one fixture per diagnostic in §12; the full rule matrix (§4.7)
  as a table-driven test.
- Schema diff: every change kind classified safe/destructive/refused; renames
  never inferred; lock hash detects hand edits.
- SQL generation: snapshots per dialect for each statement shape; every
  identifier quoted; no value in SQL text (a scanner asserts the only literal
  numbers are validated limits).
- Validators: each type's limits, boundaries ±1, control characters, `date`
  calendar validity, money range, URL schemes.
- Image sniffing: real samples and crafted headers (polyglots, truncated,
  oversize dimensions).
- Determinism: build twice, byte-identical client, `openapi.json`, migration
  files.

**Routes on SQLite in memory — `pnpm test`**

- **The authorization matrix**: for a generated set of tables covering every
  legal rule combination, every actor (signed out, owner, other account,
  admin, unverified listed admin) × every route — expected status and body
  from a small reference evaluator written separately from the SQL. The
  evaluator and the SQL must agree on every cell.
- Mass assignment, private-field nulling, `mine`, keyset paging across
  inserts (no duplicates, no gaps), limits, 429s, CSRF/CORS per method.

**Real databases — `pnpm test:backend-db`** (postgres 18.6, mysql 8.4.11, as
today)

- Every migration kind applied up from empty and from each previous version.
- MySQL killed mid-step → resume.
- Two server processes starting together → one applies each step.
- Concurrent unique creates; FK `in_use`; `CHECK` enforcement on mysql
  (verifies the INFERENCE in §4.3).
- NULL-free keyset ordering identical on all three engines; search case
  behaviour recorded per engine (verifies §5.1).

**Browser — a new `pnpm test:data`** (Chromium, Firefox, WebKit; the real
generated server, as `test:auth` does)

- `from` blocks: skeleton, rows, empty, error + retry; owner-only table
  signed in and out; no layout shift (skeleton height = rendered height).
- Admin: sign in as a listed verified account; create, edit, upload, delete;
  a non-admin gets 403 and the page says so; XSS payloads render as text.
- Uploads: GPS stripped (once Q6 is decided); SVG refused.

---

## 15. Phased delivery

| Phase | Ships | Exit check |
|---|---|---|
| **D1 — tables and API** | `data` grammar + §12 link codes; lock file + `az backend plan/schema`; migrations on start (safe) and `--migrate --confirm` (destructive); `/data` CRUD, filters, keyset, search; rules; typed client; `openapi.json`; `az dev` support | unit + routes + real-DB suites green; §13 rows without uploads/admin covered |
| **D2 — admin** | `/admin` pages; admin routes; `AZ_ADMIN_EMAILS`; audit table | browser suite admin cases |
| **D3 — images** | image type, upload/serve, disk storage, orphan sweep — **after Q6** | upload rows of §13 |
| **D4 — blocks** | `from` on gallery, feature, faq; AZ1260–1269 | browser suite block cases; visual snapshots of skeleton/empty/error |
| Later | object storage; `file` type (PDF, download-only); snapshot pre-render (`az backend snapshot`); `pricing` from data; a `visible <flag>` table property (rows hidden from the public until switched on); counts/aggregates; CSV import/export; realtime (in-process events, rule-checked per subscriber [R4]; the pooler rule excludes database notifications); many-to-many; API keys; teams; full-text search; image variants; env-tunable limits | each its own spec section first |

---

## 16. Owner decisions — 2026-10-05

**Decided:** the owner accepted every recommendation below ("yes all"), and
asked for the feature to be production-ready. Each row's recommendation is now
the decision; the table is kept as the record of what was weighed.


| # | Question | Recommendation |
|---|---|---|
| Q1 | PRD §6.8 lists "CMS / content editing" and "e-commerce & checkout" as non-goals. Tables + admin is a small CMS. Revise §6.8 the way §6.5 was revised for the backend? | **Yes** — record a dated decision: data tables and an admin area are in; checkout, payments and a page editor stay out |
| Q2 | `data` directly under `site`, or nested inside `backend`? | **Under `site`** — two spare depth levels, and it reads as content, not server config |
| Q3 | Admins from `AZ_ADMIN_EMAILS` (verified only), or an `admins` list in the `.az` file? | **Env** — addresses are personal data and change without a rebuild |
| Q4 | Allow `signedin edit/delete` (any account edits any row)? | **No in v1** — the L3 trap; teams later |
| Q5 | Public tables often need drafts. Add a `visible <flag-field>` table property (rows with it off are seen only by owner and admins)? | **Yes, but in the later phase** — a declared property, not a condition; design it once D1 is real |
| Q6 | Image re-encoding / metadata stripping needs an image library (a native-binary dependency; how it installs under `--ignore-scripts` is unverified). Vet one, or write a metadata-only stripper (no pixel decoding)? | **Vet a library first (Rule: vet every dependency)**, measured under our install flags; D3 waits on it. Do not ship uploads that keep GPS. **Done 2026-10-06:** `sharp` 0.35.5 vetted and approved (it loads under `--ignore-scripts`) — stack-evaluation §14 |
| Q7 | When an account is deleted (not built yet), its rows go (`CASCADE`) or stay ownerless? | **Cascade** — it matches the sessions table and erasure requests; admins can reassign first when that exists |
| Q8 | Should the API serve non-browser clients (apps, scripts) in v1? | **No** — browser-only like auth; API keys are a later spec |
| Q9 | Fractional numbers (ratings, weights)? | Add `decimal` later as a fixed-scale integer (e.g. `decimal 2`), same reason as `money`; floating point never |
| Q10 | Fixed text caps (200 / 10 000) or `text 80` per field? | **Fixed in v1** — fewer words; revisit with real files |
| Q11 | A build fails when the file and the lock differ, versus `az build` updating the lock itself? | **Fail** — the build stays byte-identical and read-only; schema changes are reviewed diffs |
| Q12 | Should `data` imply a default `backend` (sqlite + smtp) so the minimal file is shorter? | **No** — keep `backend` explicit; AZ1227 prints the exact lines to add |
| Q13 | Bot protection for `anyone create` beyond rate limits? | **Rate limits + admin moderation in v1**; the auth spec already rules out captcha in generated code |

---

## 18. D1 as built — deviations and findings (2026-10-05)

### 18.1 Where the build differs from this spec, and why

| § | Spec said | Built | Why |
|---|---|---|---|
| 4.3, 9 | `choice` has a `CHECK (x IN …)`; required columns `NOT NULL` | Neither in the database; the server checks every value before any statement. Length checks (SQLite) and VARCHAR caps stay | Both would have to change when a choice gains a value or a field stops being required, and SQLite cannot alter a constraint without rebuilding the table (§6.2's own reason). The caps never change |
| 4.3 | `url` is `VARCHAR(2048)` on MySQL | `TEXT` on MySQL | MySQL counts each VARCHAR's full width (×4 bytes) against a 65,535-byte row: seven url fields would fill a table. A url is never indexed, so TEXT costs nothing |
| 4.5 | `default` writes the column default | Defaults are applied by the server on insert; a field added (or made required) with a default fills existing rows with a parameterised `UPDATE … WHERE col IS NULL` | No value ever appears in DDL text — the "no value in SQL" scanner holds for every statement |
| 5.1 | `ESCAPE '\'` | `ESCAPE '!'` | A backslash inside a MySQL string literal is itself an escape character (default `sql_mode`); `!` means the same on all three engines |
| 6.1 | the lock holds "the schema each step produces" | The lock holds storage only: per field name, type, currency, choices, ref, required, unique, index — and a sha256 `digest` over its canonical steps | Rules, `search`, `private`, `locked` and `default` change no storage; locking them would make every rule edit a migration. The digest makes AZ1706 decidable |
| 6.2 | flags `--rename`, `--drop` | also `--unique t.f`, and `--drop t.f.value` for a removed choice value | §6.2 lists adding `unique` and removing a choice value as destructive "explicit flag" changes but names no flag for them. A new unique without its flag is a new code, AZ1707 |
| 6.1 | the build writes `server/src/data-migrations.ts` | It writes `server/data.json` (the tables, rules and every step's SQL units) and copies the `data-*.ts` modules only for a site with tables | Data, not code: `main.ts` reads it, and a site without tables gets exactly the files it got before |
| 6.3 | `az_data_migrations (version, step, applied_at)` | adds `claimed_at`; in-progress auth migrations are a negative `applied_at` in the existing table | Claim-before-run needs the claim time to take over a crashed instance's claim safely; the auth table's existing rows keep reading as applied |
| 4.5 | `locked` on any non-ref field | `locked required` needs a `default` (AZ1236) | Only admins set a locked field; with no default a new row could never be created |
| 4.2 | constraint and index names `azd_<table>_<field>_idx` | `azx_/azf_/azp_<version>_<n>`, numbered by the step that creates them | Name-derived names break when a table is renamed and a new table takes the old name (PostgreSQL index names are schema-wide, MySQL foreign-key names too) — found by the real-database run |

### 18.2 The inferences, settled on the engines (`pnpm test:backend-db`, `pnpm test`)

| Inference (§) | PostgreSQL 18.6 | MySQL 8.4.11 | SQLite 3.53.4 (node:sqlite) |
|---|---|---|---|
| `CHECK` is enforced (§4.3) | yes | **yes** (verified: a violating insert is refused) | yes |
| `LOWER` folds beyond ASCII (§5.1) | yes — `äbc` finds `ÄBC` | yes | **no** — `LOWER('ÄB')` is `Äb`; ASCII only, as inferred |
| a prepared `LIMIT ?` (§5.1) | accepted | **accepted** (mysql2 3.24.4 `execute`) — the inference was wrong for this version. The range-checked integer literal is kept anyway: one statement shape for all engines | accepted |
| `ON DELETE RESTRICT` error code (not in this spec) | `23001 restrict_violation`, **not** `23503` — deleting a referenced row was a 500 until fixed; now `409 in_use` | errno 1451 | `FOREIGN KEY constraint failed` |
| `DROP COLUMN` on an indexed column | drops the index with it | drops it | **refused** — the index is dropped first, in its own unit |
| the default list page plan | `Limit → Index Scan Backward using azx_…` on 5,000 rows, no sequential scan | — | — |

### 18.3 D2 — the admin area as built (2026-10-05)

Server: `/admin/data` (tables and row counts), `/admin/data/<t>[/<id>]` (the
§5 shapes plus `count` and `ownerEmail`), `/admin/audit` (newest first, keyset
on `(at, id)`, `limit`/`after` only) — `server/src/data-api.ts` `handleAdmin`.
Site: `/admin`, `/admin/<table>` — `src/data/admin.tsx`, `admin-values.ts`,
`admin` in `client.ts`, `.az-admin-*` in `theme.css`. AZ1268 in `spec.ts`.

| § | Spec said | Built | Why |
|---|---|---|---|
| 11 | `ORDER BY` on any indexed field | The same sort keys as the public list: `created`, `updated`, required fields of a sortable type | Keyset paging needs a non-null key — the engines order NULLs differently (§5.1); an optional indexed field would skip or repeat rows between pages |
| 11 | writes 300 / 10 min per account, "stricter" | An admin's writes count only against 300 / 10 min **per account**, not the public 60 per address; a refused admin write (not an admin) counts against the per-address limit; reads keep the per-address 600 | The public per-address cap would stop moderation at 60; accounting a refusal per address keeps probing the routes as bounded as public writes |
| 11 | audit row per admin write | Written after the write succeeds, outside a transaction (the pooler rule); an audit insert that fails answers 500 with the write applied | No cross-statement transactions anywhere in the server; recorded so an operator knows the one gap |
| 6.3 | — | `az_data_audit` is created by a system step, version 0, in `az_data_migrations` ahead of the site's steps; it is never reported as an applied site step | One claimed, resumable path for every data table, the audit included |
| 11 | admin = verified listed email | Decided before the table is looked up: a non-admin gets `403 forbidden` (signed out: `401`) for any `/admin/...` path, existing table or not; an admin gets `404` for an absent table | No table enumeration for non-admins (§13) |
| 11 | upload/replace/clear an image | Not built in D2 | Images are D3 (Q6) — built 2026-10-06, §18.4 |
| 11 | `AZ_ADMIN_EMAILS` | Listed in `.env.example` only for a site with tables; a malformed entry stops the server naming it; read at start (a change needs a restart) | Sites without tables keep their `.env.example` byte for byte |

Proved: `pnpm test` (`packages/backend/test/data-admin.test.ts` — every §13
admin row with a CONTROL; each guard removed in turn makes it fail;
`packages/target-web/test/data-admin.test.ts` — the page's value rules agree
with the server's checks), `pnpm test:backend-db` (admin list keyset walk and
count, owner join, private fields, unique and validation held, audit pages, no
value in the audit — PostgreSQL 18.6, MySQL 8.4.11), `pnpm test:data` (an
admin verified by a real sign-in link lists, searches, edits — refused with
the API's sentences — deletes by keyboard behind the named confirm, moderates
an anyone-create table, reads the audit; axe clean on each state; an unlisted
and a listed-but-unverified account are refused by page and server; Chromium
and Firefox signed in, WebKit the signed-out redirect only). The 28 `.az`
files built before and after D2: the 27 without a backend byte-identical; a
backend site without tables differs only in the shared server sources
`app.ts`, `env.ts`, `main.ts` (the admin edge and its key), as D1's did.

### 18.4 D3 — images as built (2026-10-06)

Server: `server/src/data-images.ts` (sniff, the decode/re-encode pipeline,
the queue, disk storage, the orphan sweep), the image routes in
`data-api.ts`, `readRaw`/`sendFile` in `http.ts`, the image edge in `app.ts`,
`AZ_FILES_DIR`/`AZ_UPLOAD_MAX_MB` in `env.ts`. Site: `upload`/`clear` in
`src/data/client.ts`, the image field in `src/data/admin.tsx`. The library:
`sharp` 0.35.5 (vetting: `docs/stack-evaluation.md` §14; backend-spec §9),
pinned in a generated `server/package.json` only when a table has an image
field.

| § | Spec said | Built | Why |
|---|---|---|---|
| 4.5 | `required` allowed on all but `flag` | Refused on `image` (AZ1236), as `default` already was | An image is uploaded to a row that exists (§5), so a create can never carry one; a required image could never be satisfied |
| 8 | name = UUID + the detected extension | `<uuid>.webp`, served as `image/webp` | Every upload is decoded and re-encoded to WebP; the stored file's type is WebP whatever came in |
| 8 | limits | Plus: stored at most 2048 px a side (fit inside, never enlarged); `AZ_UPLOAD_MAX_MB` a whole number 1–20 | The owner's directive for D3; a 40 MP original is not what a page needs |
| 8 | `public, immutable` for anyone-readable non-private images | The API's URL is `…/<field>?v=<uuid>`; only a request naming the **current** upload is public and immutable; a stale `v` is 404; the bare path is `private, no-store` | "The key changes on every upload" holds only if the URL carries it; without `v` an immutable cache would pin an old image forever |
| 5.4 | an allowed `Origin` on every `/data` request | Not on `GET /data/<t>/<id>/<field>` (and its admin twin): the read rule (and the admin check) answer it; CORS headers only for an allowed origin | An `<img>` sends no `Origin`; the read changes nothing; `private` images are `same-site` and never cached |
| 8 | "updates the row (one statement)" | One `UPDATE … WHERE <field> = <old key>` (compare-and-swap), retried at most 5 times; the old file is removed only after it succeeds | Two uploads at once can never remove each other's file; the row always names a file that exists |
| 8 | — | One image processed at a time, 8 waiting; beyond that `429 rate_limited` | Memory stays near one image's worth (measured below) however many uploads arrive |
| 8 | periodic sweep | Hourly; a file is removed only if no image column names it **and** it is over an hour old; stale temporaries in `AZ_FILES_DIR/.tmp` too | A file whose row is still being written is never swept |
| 5 | — | A JSON body never carries an image key, not even `null` (`400 invalid`); clearing is `DELETE …/<field>` | One way to change an image, so a file never outlives its key unnoticed |
| 11 | admin upload/replace/clear | `GET/PUT/DELETE /admin/data/<t>/<id>/<field>`, any row, `locked` included; audited as `edit`; counted in the 30 uploads an hour per account | The admin twin of the public route, as for rows |
| 5 | — | A server with image fields allows 120 s per request (15 s otherwise) | A 20 MB upload over a slow link needs longer than a JSON body |
| 10 | `media`/`src` from an image field | Not done: D4 refuses image mappings (AZ1214 in `core/src/from.ts`) and `gallery` has no rows shell yet | D4 landed while D3 was built and its worker is still changing those files; the mapping needs the rows runtime to read `{ url, width, height }` (follow-up) |

**Finding — CORP `same-site` and IP addresses.** Chromium treats two
IP-literal origins (`http://127.0.0.1:A` → `http://127.0.0.1:B`) as never
same-site under `Cross-Origin-Resource-Policy: same-site`, so a private image
is blocked there; Firefox allows it, and both allow `localhost:A` →
`localhost:B` (measured with a two-port probe in both). A site and server
addressed by name on one registrable domain — the deployment the README
describes — are unaffected; `pnpm test:data` now addresses both by name. A
site and server on different sites (`AZ_COOKIE_SAMESITE=none`) cannot show a
non-public image in an `<img>`; such a page can still `fetch` it with
credentials (CORS) and show the blob.

**Security, each with a test and a CONTROL** (`packages/backend/test/data-images.test.ts`,
`data-uploads.test.ts`): SVG, HTML, text, GIF and TIFF under an image name →
415; HEIC → 415; a HEIF file branded HEIC is refused by the sniff even though
the allowed loader would decode it; SVG, GIF and TIFF cannot decode in the
process at all (loader allow-list); header bombs (100 000², 60 000², 7000² =
49 MP, 8001 a side) → 413 in under a second, 8000 × 5000 accepted; a phone
JPEG with EXIF orientation, camera, GPS, XMP, an ICC profile and a script
comment is stored with none of them and rotated; a tagged PNG and a JPEG/HTML
polyglot stored clean; truncated and corrupt files → 415, nothing stored;
names only `<uuid>.webp`, every other key refused by `pathOf` (no traversal);
over the cap by `Content-Length` or while streaming (chunked) → 413, no file
left; another account's upload → 404 and nothing written; signed out → 401;
no edit rule → 403; `locked` → 400 except for an admin; no Origin or a
foreign one, or no `x-az-request`, on PUT/DELETE → 403; a private image →
404 for everyone but its owner and admins; 30 uploads an hour → 429. Each
guard removed in turn (17 of them) makes its test fail.

**Memory, measured** (fresh process, nine 24 MP JPEGs at once): through the
queue RSS grew +19 MB over ~160 MB (9.3 s); the same nine unqueued (CONTROL)
+100 MB (3.8 s). Vetting: one 24 MP photo fitted to 2048 in 478–514 ms, peak
RSS 148 MB.

Proved: `pnpm test` (above, plus DDL, openapi, emit, config, client and
admin-values tests), `pnpm test:backend-db` (three columns through create,
add, rename and drop; upload, two replacements at once leaving one file,
private reads, clear, delete, the sweep — PostgreSQL 18.6, MySQL 8.4.11),
`pnpm test:data` (Chromium and Firefox: a phone photo uploaded through the
typed client is shown by an `<img>` on the site's page from the server's
origin, stored without metadata, served with the §8 headers; renamed SVG and
another account refused; the admin editor uploads, previews, refuses an SVG
with the field's sentence and focus, replaces — the old URL 404 — and
removes; axe clean; no file outlives its row). The 28 `.az` files built
before and after D3: the 27 without a backend byte-identical; a backend site
without tables differs only in shared server sources; a site with tables but
no image field keeps `server/package.json`, `az.config.json`,
`.env.example`, `README.md`, `data.json` and `openapi.json` byte for byte.

---

## 17. Research sources

The only section that names outside products. Fetched 2026-10-05; contents
treated as data. "Search summary" marks a source read through a search
result rather than fetched directly.

| Tag | What it showed | Source |
|---|---|---|
| R1 | Five per-collection rules (list/view/create/update/delete); `null` = locked (superusers only, the default), `""` = public; rules double as record filters; filter operators and `@request.auth` | PocketBase — API rules and filters, https://pocketbase.io/docs/api-rules-and-filters/ |
| R2 | 13 field types (text, number, bool, email, url, editor, date, autodate, select, file, relation, json, geopoint); non-nullable zero defaults | PocketBase — Collections, https://pocketbase.io/docs/collections/ |
| R3 | Records REST shape: `/api/collections/{c}/records`, `page`/`perPage`/`sort`/`filter`/`expand`/`fields`/`skipTotal`; multipart uploads; error shape | PocketBase — Records API, https://pocketbase.io/docs/api-records/ |
| R4 | Realtime over server-sent events; collection subscriptions checked with the list rule, single records with the view rule | PocketBase — Realtime API, https://pocketbase.io/docs/api-realtime/ |
| R5 | Row-level security as an added WHERE; enabled with no policies = no access; USING vs WITH CHECK; owner pattern; index policy columns; tables created by SQL lack RLS until enabled | Supabase — Row Level Security, https://supabase.com/docs/guides/database/postgres/row-level-security |
| R6 | `?col=op.value` filtering, `order=`, `select=`; UPDATE/DELETE without filters warned against | PostgREST — Tables and views, https://docs.postgrest.org/en/stable/references/api/tables_views.html |
| R7 | `db-max-rows` default unlimited; anonymous access blocked when no anon role is set | PostgREST — Configuration, https://docs.postgrest.org/en/stable/references/configuration.html |
| R8 | CVE-2025-48757: generated apps shipped tables without row policies; unauthenticated read/write through the public key; 170+ apps; CVSS 9.3 | Search summary: https://mattpalmer.io/posts/2025/05/CVE-2025-48757/ · https://cvefeed.io/vuln/detail/CVE-2025-48757 |
| R9 | Permissions per role × table × operation: row filters, column allow-lists, column presets from session, row fetch limit | Hasura — Permissions, https://hasura.io/docs/2.0/auth/authorization/permissions/index/ |
| R10 | Global query params; default limit 100; `-1` returns all items unless a server max is configured | Search summary: Directus — Query parameters, https://directus.com/docs/guides/connect/query-parameters |
| R11 | Page/offset pagination, default 25, server-configured `defaultLimit`/`maxLimit` | Strapi — Sort & pagination, https://docs.strapi.io/cms/api/rest/sort-pagination |
| R12 | Public and Authenticated end-user roles; permissions ticked per action | Strapi — Users & Permissions, https://docs.strapi.io/cms/features/users-permissions |
| R13 | Scalar types and per-database mappings (Decimal, DateTime), `@unique`, `@default`, `@updatedAt`, relation `onDelete` | Prisma — Schema reference, https://www.prisma.io/docs/orm/reference/prisma-schema-reference |
| R14 | Edit migrations before applying; expand-and-contract; renames generated as drop + add with a data-loss warning (open request for interactive renames) | Prisma — Customizing migrations, https://www.prisma.io/docs/orm/prisma-migrate/workflows/customizing-migrations · https://github.com/prisma/prisma/issues/7790 |
| R15 | Change detection by replaying history; transactional DDL on postgres/sqlite, none on mysql; sqlite table-rebuild emulation | Django — Migrations, https://docs.djangoproject.com/en/5.2/topics/migrations/ |
| R16 | Auto admin from models; "trusted users", "not intended for building your entire front end around"; staff-only | Django — The admin site, https://docs.djangoproject.com/en/5.2/ref/contrib/admin/ |
| R17 | Strong parameters: attributes must be explicitly permitted before mass assignment | Rails — Action Controller overview, https://guides.rubyonrails.org/action_controller_overview.html |
| R18 | Mass assignment definition; the 2012 SSH-key-to-repository incident | Wikipedia — Mass assignment vulnerability, https://en.wikipedia.org/wiki/Mass_assignment_vulnerability |
| R19 | BOLA: per-object authorization in every function; random GUIDs; tests | OWASP API Security 2023 — API1, https://api-security.owasp.org/editions/2023/en/0xa1-broken-object-level-authorization |
| R20 | BOPLA: mass assignment + excessive exposure; cherry-pick returned properties; allow only client-updatable properties | OWASP API Security 2023 — API3, https://api-security.owasp.org/editions/2023/en/0xa3-broken-object-property-level-authorization |
| R21 | Unrestricted resource consumption: cap payload sizes, validate the records-per-page parameter, rate limit | OWASP API Security 2023 — API4, https://api-security.owasp.org/editions/2023/en/0xa4-unrestricted-resource-consumption |
| R22 | Upload defences: extension allow-list, distrust Content-Type, signature check, generated names, size limits, separate storage, re-encode images | OWASP — File Upload Cheat Sheet, https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html |
| R23 | Insecure rules: open access; `auth != null` grants every signed-in user; owner-only and mixed public/private patterns | Firebase — Avoid insecure rules, https://firebase.google.com/docs/rules/insecure-rules |
| R24 | sqlite ALTER limits: ADD COLUMN cannot be UNIQUE, NOT NULL needs a non-null default; DROP COLUMN restrictions; 12-step rebuild | SQLite — ALTER TABLE, https://www.sqlite.org/lang_altertable.html |
| R25 | `numeric` recommended for monetary amounts; bigint range | PostgreSQL — Numeric types, https://www.postgresql.org/docs/current/datatype-numeric.html |
| R26 | OFFSET does work proportional to depth and drifts on insert; keyset (seek) pagination | Use The Index, Luke — No offset, https://use-the-index-luke.com/no-offset |
| R27 | Problem-details error format; warning against leaking implementation detail | RFC 9457, https://www.rfc-editor.org/rfc/rfc9457.html |
| R28 | Runtime-free TypeScript types from OpenAPI 3.0/3.1, with a typed fetch client | openapi-typescript, https://openapi-ts.dev/introduction |
| R29 | `node:sqlite` is Stability 1.2 (release candidate); transactions via `exec`; named parameters | Node.js — SQLite, https://nodejs.org/api/sqlite.html |
| R30 | A common image library installs prebuilt binaries through optional dependencies; behaviour under `--ignore-scripts` needs checking | sharp — Installation, https://sharp.pixelplumbing.com/install |
