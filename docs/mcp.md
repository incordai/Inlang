# `az mcp` — the compiler as tools for an AI agent

`az mcp` serves the CLI's operations over the Model Context Protocol on
stdio, so an agent can write a site the same way a person does: read the word
catalogue, write a `.az` file, check it, build it.

```bash
az mcp --root path/to/project     # default root: the current directory
```

## Registering it with an MCP client

Most clients take a JSON entry naming the command to start. The exact file
and key vary by client; the shape is:

```json
{
  "mcpServers": {
    "az": {
      "command": "node",
      "args": ["/absolute/path/to/incord-lang/packages/cli/bin/az.js", "mcp", "--root", "/absolute/path/to/project"]
    }
  }
}
```

## Authoring order

The server's `instructions` (sent in the `initialize` result) tell the agent
to write a site in the order of [PRD §6.1a](PRD.md):

1. **Colour first** — `theme`, `accent` (one hue, or an allowed pair for a
   gradient) and `pattern`, chosen from the user's brand or mood. The agent
   calls `az_palette` or `az_explain "theme"` / `"theme accent"` for the
   choices, shows the user 2–3 options with their exact `.az` lines, and
   confirms one. Colours come only from the theme; there is no hex.
2. **Then the frame** — `site width` and `font`.
3. **Then sections** — `az_words` and `az_grammar` for the vocabulary, then
   `az_check`.

The text is `INSTRUCTIONS` in `packages/mcp/src/server.ts`; it is kept short
because every session pays for it. A site without a `theme` line builds with
`midnight` (no diagnostic: the bundled word previews are theme-less on
purpose, so the browser suites can render each one in every theme). The
server offers no MCP prompts.

## Tools

| Tool | Writes? | What it does |
|---|---|---|
| `az_explain {terms}` | no | the cheapest lookup: one ≤60-character line per term, in context — `"hero center"`, `"hero height peek"`, `"backend database postgres"`; unknown terms get a did-you-mean |
| `az_words` | no | the catalogue: every word's variants, modifiers, properties (type, values, default, required) and slots, each with its ≤60-character description |
| `az_word_docs {word}` | no | one word's README |
| `az_grammar` | no | GRAMMAR.md (also the resource `az://grammar`) |
| `az_check {file}` | no | diagnostics with code, severity, line, column |
| `az_spec {file}` | no | the resolved Spec, or null with diagnostics |
| `az_lint {wordsDir?}` | no | theme-token lint over word packs |
| `az_doctor {file?, out?}` | no | `az doctor`: each check's status, line and fix; `.env` key names only, never values; loads no module from the project |
| `az_audit {out?, online?}` | no | `az audit` on a build's output: each check's status, line and fix; a secret by file, offset and shape, never its value; the network only with `online: "true"` |
| `az_build {file, out?}` | **yes, and runs project code** | compile to a runnable project (default `.az-build`); the project's own words run, as in any build |
| `az_migrate {file}` | **yes, rewrites the file** | upgrade the file's grammar version when a step changes it |
| `az_eject {word}` | **yes, one-way** | copy a word into the project's `words/`; refuses if already there |
| `az_backend_init {serverDir}` | **yes** | the backend's `.env` (owner read/write only); returns the path, never the secret; never overwrites |

Tools that write carry `readOnlyHint: false`, so a client can ask before
running them. `az_build` and `az_migrate` also carry `destructiveHint: true`:
the first runs the project's code, the second rewrites the author's file.

## Safety model

- **Read-only tools never run the project's code.** A word the project owns
  (its `words/` folder) is code: its emitter runs when a build loads it. The
  read-only tools compile from manifests alone — plain JSON — so an agent can
  check and read a folder it does not trust without anything in it running.
  Only `az_build` loads the project's emitters, and it is marked destructive
  so the client asks first. Call it only on a project you trust.
- **One root.** Every path is resolved against `--root` and must stay inside
  it after symlinks are followed; a path that does not exist yet is judged by
  its nearest existing folder. `../x`, an absolute path elsewhere, and a
  symlink pointing out are all refused as tool errors. A root deleted while
  the server runs is a tool error too, never an unanswered request.
- **Same guards as the CLI.** The tools call the functions the commands run:
  a failed build writes nothing; a build never overwrites a file az did not
  generate, never writes through a symbolic link, and removes the files it
  generated before and no longer does; eject never overwrites; `.env` is
  never replaced.
- **A clean stream.** stdout carries protocol only. While the server runs,
  any other write to stdout — a project word's `console.log` during a build —
  goes to stderr instead.
- **Clear errors.** A missing file or a bad argument is a tool result with
  `isError`, worded for the agent. Internal failures are logged to stderr;
  the client sees "internal error".
- **No secrets out.** `az_backend_init` reports where it wrote, not what.
- **Edits to an ejected word need a restart.** Node cannot unload a module,
  so the server keeps the first version of an ejected emitter it built with;
  `az_eject`'s result says so.
- **stdio only.** No network listener is opened.

## Protocol

Newline-delimited JSON-RPC 2.0 (the MCP stdio transport). Supported
revisions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05; an unknown request
is answered with the newest. Methods: `initialize`, `ping`, `tools/list`,
`tools/call`, `resources/list`, `resources/read`. Batches are refused (removed
from the protocol in 2025-06-18).
