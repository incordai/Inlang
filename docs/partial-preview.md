# Partial preview — `az dev` while the file is still being written

An author, often an AI, writes a `.az` file top to bottom, and saves it many
times before it is finished. Each of those saves is a file that does not
compile yet: a section with no title, a string with no closing quote, a
footer that links to a page further down that is not written yet. Before
this, `az dev` rejected every such save and the page stayed blank until the
file was complete.

`az dev` now shows the **best valid preview of a partial file**: every
complete, valid block written so far, and a small banner saying the file is
still being written and listing its problems.

## 1. Only `az dev` recovers

| Command | A file with errors |
|---|---|
| `az build`, `az check`, `az spec`, MCP tools | fail exactly as before; nothing is written |
| `az dev` | renders the longest valid prefix (§2) with the banner (§4) |

The recovery is an option of the CLI's `build()` (`preview: true`) that only
`az dev`'s watch loop passes. A file that compiles is built by the same
strict path in both, so the files `az dev` writes for a complete file are
byte-identical to `az build`'s (tested: `pnpm test:dev`, `pnpm verify:build`).

## 2. The cut point

A **block start** is a line that begins a statement at column 0 (`site`,
`page`) or one level in (a section under a page, a block under `site`).
Blank and comment lines are not block starts. A prefix that ends just before
a block start holds only whole blocks.

Given a file that fails the strict compile, `compilePreview`
(packages/core/src/preview.ts):

1. collects the block starts, then
2. compiles the prefix that ends at each one, the longest first, and
3. renders the first prefix that compiles with no error.

So:

- **A trailing incomplete block is dropped.** The block at the end of the
  file is never in a prefix: until the next block starts, nothing says it is
  finished. A missing value, an indentation half-way through, an
  unterminated string or a line cut off mid-word all sit in that last block.
- **An error in the middle of the file** fails every prefix that contains
  it, so the preview shows everything before the block that holds it.
- **A half-parsed block never renders.** Every rendered block is one the
  compiler read in full and accepted; nothing is filled in or guessed.
- **A whole file that compiles is not a preview** — it is the strict build,
  with no banner.

## 3. Routes not written yet

A site is written top-down, but its `nav` and `footer` link forward to pages
further down. In a prefix those pages do not exist yet, and the strict
compile reports each link as `is not a page in this site` (AZ1215, and the
words' `childRoute` checks such as the footer's AZ2081). A prefix is
therefore compiled with **routes open**: a route is not required to be a page
of the prefix. Every other check runs as it does for `az build`, including
the data lock and the icon file. The banner still lists the unresolved link
from the whole file's diagnostics until the page is written.

A preview needs at least one page; before the first one is complete there is
nothing to show, and `az dev` reports the problems in the terminal as before.

## 4. The banner

Every page of a preview carries a banner fixed in a corner, outside the
React root, so the site's own markup is untouched:

- `Still writing — N problems · preview stops before line L`, and, opened,
  one line per error of the whole file: `site.az:line:col CODE message`;
- `role="status"`, collapsed by default, so it does not cover the page;
- every piece of diagnostic text is HTML-escaped — messages quote the
  author's input.

The terminal line says the same: `az: still writing — N problems · preview
stops before line L; first: site.az:line:col error CODE …`.

## 5. Saves in quick succession

An AI writing a file in chunks saves many times a second. The watch loop:

- **debounces** events (40 ms), so one save is one compile;
- **caps the wait** at 250 ms from the first unhandled event, so a stream of
  saves that never pauses still compiles at least four times a second
  instead of never;
- is **latest-wins**: a compile reads the file as it is when it runs, and at
  most one compile is pending, so a burst never queues a backlog;
- **bounds the search**: at most `PREVIEW_ATTEMPTS` (64) prefixes are
  compiled per save, starting at the block that holds the first error; a
  file whose last valid prefix is further back shows no preview.

A page that becomes complete adds an entry to the generated
`vite.config.ts` (its build input lists every page). Vite restarts its dev
server whenever its config changes, which dropped the open page's
connection and could leave a page that reloaded mid-restart blank. The dev
server therefore starts from `node_modules/.az-dev.vite.config.mjs`, which
imports the site's `vite.config.ts` once at start: the page list only
matters to `vite build`, and the dev server serves every page's HTML file
without it. The generated files themselves are unchanged.

## 6. Security

The preview is served by the same local dev server as before, on
`127.0.0.1` only. The banner is generated by the CLI into the dev output,
escapes all author text, and is never part of `az build`'s output.

## 7. Limits

- The preview is monotonic only over prefixes: as whole lines are added, the
  rendered blocks only grow. A complete file that compiles is rendered whole;
  if one more line then breaks its last block, that block is dropped from
  the preview until it is valid again.
- Routes are open in a preview (§3): a link to a page that is never written
  renders, and the banner lists it.
- A cut inside the `site` block falls back to the previous whole block; a
  prefix whose site has no page yet has no preview.
