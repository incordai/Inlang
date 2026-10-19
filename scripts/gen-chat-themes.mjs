/**
 * Regenerate packages/chat-render/themes/ — the chat panel's templates and
 * stylesheet for each theme, from the chat word and the target's stylesheet
 * compiler (scripts/lib/chat-themes.mjs, chat-block-spec §22.3).
 *
 *     node scripts/gen-chat-themes.mjs
 *
 * Run it after a change to the chat word, a theme or the stylesheet
 * compiler; `pnpm verify` fails while the committed files are stale.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chatThemeFiles } from './lib/chat-themes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
for (const f of chatThemeFiles()) {
  mkdirSync(dirname(join(ROOT, f.path)), { recursive: true });
  writeFileSync(join(ROOT, f.path), f.content);
  console.log(`wrote ${f.path} (${f.content.length} characters)`);
}
