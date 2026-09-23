/**
 * One block of the Spec — what a word's emitter receives.
 *
 * Its own module, with no imports, so the emit contract depends on nothing
 * else in core. That is what lets `az eject` copy the contract beside an
 * ejected word verbatim: the copy must build without the compiler's source.
 */

export interface SpecBlock {
  readonly word: string;
  readonly variant: string | null;
  readonly modifiers: string[];
  /**
   * Positional values, in source order.
   *
   * `link "Work" /work` carries its label and destination here. Without this
   * a child word reached the target as a bare tag with its content dropped —
   * the same bug that lost the site name, one level down.
   */
  readonly args: { kind: string; value: string }[];
  /** Resolved values — defaults applied, so a target never guesses. */
  readonly props: Record<string, string>;
  readonly as: string | null;
  readonly children: SpecBlock[];
}
