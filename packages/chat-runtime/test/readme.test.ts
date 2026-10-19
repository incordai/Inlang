/**
 * The package README's example is real: shown exactly, and printing what the
 * README says it prints (chat-answer's readme-example.ts).
 */

import { exampleChecks } from '../../chat-answer/test/readme-example.ts';

exampleChecks(new URL('../README.md', import.meta.url), new URL('../examples/ask-in-node.ts', import.meta.url));
