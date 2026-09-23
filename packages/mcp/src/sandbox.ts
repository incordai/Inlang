/**
 * The project root, as a boundary.
 *
 * Every path a client sends is resolved against the root and must stay
 * inside it after symlinks are followed — the same rule the CLI applies to
 * assets (`locateAssets`). A path that does not exist yet (a build's output
 * folder) is judged by its nearest existing ancestor, so a symlinked parent
 * cannot smuggle a write outside the root either.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export class SandboxError extends Error {}

export interface Sandbox {
  readonly root: string;
  /** An absolute path inside the root; throws SandboxError otherwise. */
  readonly resolve: (path: string) => string;
}

export function sandbox(rootDir: string): Sandbox {
  let root: string;
  try {
    root = realpathSync(rootDir);
  } catch {
    throw new SandboxError(`the project root '${rootDir}' does not exist`);
  }
  const inside = (p: string) => p === root || p.startsWith(root + sep);

  return {
    root,
    resolve(path: string): string {
      if (typeof path !== 'string' || path.length === 0 || path.includes('\0')) {
        throw new SandboxError('path must be a non-empty string');
      }
      const lexical = resolve(root, path);
      if (!inside(lexical)) {
        throw new SandboxError(`'${path}' is outside the project root`);
      }
      // Follow symlinks through the deepest part that exists.
      let existing = lexical;
      while (!existsSync(existing)) {
        const up = dirname(existing);
        if (up === existing) break;
        existing = up;
      }
      const real = realpathSync(existing);
      if (!inside(real)) {
        throw new SandboxError(`'${path}' resolves outside the project root`);
      }
      const rest = relative(existing, lexical);
      return rest === '' ? real : resolve(real, rest);
    },
  };
}

/** A root-relative path for reporting back to the client. */
export const shown = (root: string, abs: string): string => {
  const r = relative(root, abs);
  return r === '' ? '.' : isAbsolute(r) ? abs : r.split(sep).join('/');
};
