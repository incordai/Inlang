/**
 * A credential written into the .az file — auth-block-spec §4 rule 3, §11.
 *
 * Credentials are environment configuration, never site description: a key
 * in the source file is committed, pushed and forked with it. Every value
 * of every statement is checked, not only auth's, because a key pasted into
 * any property is committed just the same.
 */

import type { Diagnostic } from './lex.ts';
import type { Statement } from './parse.ts';
import { isSecretLiteral } from './secrets.ts';

export function secretLiterals(body: readonly Statement[]): Diagnostic[] {
  const found: Diagnostic[] = [];
  const walk = (statements: readonly Statement[], parent: string | null) => {
    for (const s of statements) {
      for (const arg of s.args) {
        if (!isSecretLiteral(arg.value)) continue;
        found.push({
          code: 'AZ1411',
          severity: 'error',
          pos: arg.pos,
          message: `${parent ?? s.word}: a key literal in '${s.word}' would be committed to source control — `
            + 'move it to an environment variable',
        });
      }
      walk(s.children, s.word);
    }
  };
  walk(body, null);
  return found;
}
