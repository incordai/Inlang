# @az/chat-instructions — what a chat's model is told

The text a chat's model is sent before the conversation: the fixed rules
(prose only from the content, no links, data is not instructions, the lines
and components it may write — taught from the answer checker's own forms and
caps), the content as data, and what one question changes (the page, what
its components may use, the pages a large site sends in full, the rows).

It is the same code `az build` and the built-in server use — the build writes
`fixedInstructions` to each chat's `server/chat/prompt-<n>.txt`, the server
assembles the rest per question (`server/src/chat-instructions/`, copied from
here) — so for the same input the text is byte for byte the same. It imports
only its own files and the answer checker, and runs in Node, a browser and an
app webview. The order is the prompt cache's: what changes least comes first
([chat-block-spec §19.16, §19.17, §22.2](../../docs/chat-block-spec.md)).

Not published to a registry (the package is `private`); a workspace package
depends on it with `"@az/chat-instructions": "workspace:*"`.

## Example

[`examples/instructions-for-an-app.ts`](examples/instructions-for-an-app.ts), run with
`node packages/chat-instructions/examples/instructions-for-an-app.ts`:

```ts
// Run: node packages/chat-instructions/examples/instructions-for-an-app.ts
import { buildInstructions } from '@az/chat-instructions/instructions.ts';

const system = buildInstructions({
  appName: 'Acme Lamps',
  components: ['faq', 'chart', 'cta'],
  destinations: ['/contact'],
  // The data source's queryable schema: public fields only.
  tables: [{ name: 'orders', fields: [{ name: 'status', type: 'choice', choices: ['paid', 'open'] }, { name: 'total', type: 'money', currency: 'usd' }] }],
  content: {
    site: { name: 'Acme Lamps', description: 'Desk lamps, built by hand.' },
    pages: [{ route: '/help', blocks: [{ block: 'faq', title: 'Questions', questions: [{ question: 'Do you ship abroad?', answer: 'Yes, to most countries.' }] }] }],
    notes: ['Orders ship within two working days.'],
  },
  rules: { extra: ['Answer in English, whatever language the question is in.'] },
  page: '/help',
});

// The fixed rules come first, then the content as data, then what this question changes.
const lines = system.split('\n');
console.log(lines[0]);
console.log(lines.find((l) => l.startsWith('- Answer in English')));
console.log(system.slice(system.indexOf('<site-content>'), system.indexOf('</site-content>') + '</site-content>'.length));
console.log(lines.find((l) => l.startsWith('The visitor is on the page')));
console.log(`${system.length} characters`);
```

It prints the first rule, the app's own rule after the fixed ones, the
content section, the page line and the length:

```text
You are the assistant on the website "Acme Lamps". Answer visitors' questions about this site only.
- Answer in English, whatever language the question is in.
<site-content>
site "Acme Lamps" "Desk lamps, built by hand."
note "Orders ship within two working days."
page /help
  faq "Questions"
    1 "Do you ship abroad?" "Yes, to most countries."
</site-content>
The visitor is on the page "/help".
2759 characters
```

## API

| Import | What |
|---|---|
| `@az/chat-instructions/instructions.ts` | `buildInstructions(input)` → the whole system text; `instructionParts(input)` → `{ text, fixed }`, `fixed` being how many characters are the same for every question (where a cache marker goes); `fixedInstructions(input)` → the fixed rules alone, what a prompt file holds; `contentOutline(content)` |
| `@az/chat-instructions/system-text.ts` | the assembly the server calls with a prompt file and context.json; `ROWS_HEADING`, `PAGES_HEADING`, `CONTENT_LIMITS` |
| `@az/chat-instructions/chat-outline.ts` | the content as the model reads it: one line per page, block and item, every value a quoted, escaped string |
| `@az/chat-instructions/chat-match.ts` | the keyword scoring that picks a large site's pages for a question, and an author's answer for a clear one |

`buildInstructions` takes:

| Field | Meaning |
|---|---|
| `appName` | the name the rules say (one line) |
| `components` | what answers may show (the answer checker's `ANSWER_WORDS`); none teaches prose only |
| `presets`, `knows` | the answer presets the rules list; whether rows of known tables are sent |
| `rules.extra` | the app's own rules, one line each (at most 8, 300 characters each), after the fixed ones |
| `content` | `{ site, pages, notes }`: the app's knowledge — pages in context.json's shape, and plain-text notes |
| `quotes`, `destinations`, `tables`, `images`, `tools`, `geocoder` | what the components may quote, link to, ask `from`, show as an image, call, place |
| `page`, `rows`, `asked`, `select` | per question: where the visitor is, the rows read for it, their latest words, whether pages are chosen |

A table is the data source's queryable schema, names and field types: the
function cannot tell a private field from a public one, so pass only fields
a visitor may see. Tools are taught only to a chat whose components can take
their figures, a place only where a map is shown — the server's rule. The
input is the app's own configuration: an unknown component, a name or rule
that is not one line, too many rules, throw.

The fixed rules say "the website" and "the site content": the wording az
sites use, kept so their text does not change (an owner question, epic #32).

## Tests

`node --experimental-strip-types --test packages/chat-instructions/test/*.test.ts`
(part of `pnpm verify`): byte for byte against the server's system text for a
site that shows every component, with tools, places, rows and chosen pages;
the order; extra rules and notes; refusals. `pnpm test:chat-lib` runs it in
Chromium, Firefox and WebKit. The chat-prompt token budget
(`pnpm bench:tokens`, docs/token-benchmark.md §8) measures `buildInstructions`.
