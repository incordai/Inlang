/**
 * The package README's example is real: shown exactly; it runs in three browsers in scripts/chat-lib-e2e.mjs.
 */

import { browserExampleShown } from '../../chat-answer/test/readme-example.ts';

browserExampleShown(new URL('../README.md', import.meta.url), new URL('../examples/answer.ts', import.meta.url));
