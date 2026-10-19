/**
 * The package README's examples are real: each shown exactly; they run in three browsers in scripts/chat-lib-e2e.mjs.
 */

import { browserExampleShown } from '../../chat-answer/test/readme-example.ts';

browserExampleShown(new URL('../README.md', import.meta.url), new URL('../examples/answer.ts', import.meta.url));
browserExampleShown(new URL('../README.md', import.meta.url), new URL('../examples/chat.ts', import.meta.url), 1);
