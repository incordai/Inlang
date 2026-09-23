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

## Tools

| Tool | Writes? | What it does |
|---|---|---|
| `az_words` | no | the catalogue: every word's variants, modifiers, properties (type, values, default, required) and slots |
| `az_word_docs {word}` | no | one word's README |
| `az_grammar` | no | GRAMMAR.md (also the resource `az://grammar`) |
| `az_check {file}` | no | diagnostics with code, severity, line, column |
| `az_spec {file}` | no | the resolved Spec, or null with diagnostics |
| `az_lint {wordsDir?}` | no | theme-token lint over word packs |
| `az_build {file, out?}` | **yes** | compile to a runnable project (default `.az-build`) |
| `az_migrate {file}` | **yes** | upgrade the file's grammar version when a step changes it |
| `az_eject {word}` | **yes, one-way** | copy a word into the project's `words/`; refuses if already there |
| `az_backend_init {serverDir}` | **yes** | the backend's `.env` (owner read/write only); returns the path, never the secret; never overwrites |

Tools that write carry `readOnlyHint: false` in their annotations, so a
client can ask before running them.

## Safety model

- **One root.** Every path is resolved against `--root` and must stay inside
  it after symlinks are followed; a path that does not exist yet is judged by
  its nearest existing folder. `../x`, an absolute path elsewhere, and a
  symlink pointing out are all refused as tool errors.
- **Same guards as the CLI.** The tools call the functions the commands run:
  a failed build writes nothing, eject never overwrites, `.env` is never
  replaced.
- **No secrets out.** `az_backend_init` reports where it wrote, not what.
  Internal failures are logged to stderr; the client sees "internal error".
- **stdio only.** No network listener is opened.

## Protocol

Newline-delimited JSON-RPC 2.0 (the MCP stdio transport). Supported
revisions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05; an unknown request
is answered with the newest. Methods: `initialize`, `ping`, `tools/list`,
`tools/call`, `resources/list`, `resources/read`. Batches are refused (removed
from the protocol in 2025-06-18).
