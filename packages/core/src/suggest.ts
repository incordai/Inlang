/**
 * @az module suggest
 * Purpose: a did-you-mean for a mistyped name — the closest candidate, if it is a plausible typo.
 * Spec: docs/CONVENTIONS.md §5
 * Exports: closest
 * Edit guide: dependency-free, so any stage may import it without an import cycle.
 * Tests: packages/core/test/describe.test.ts, packages/core/test/from.test.ts
 */

/** Levenshtein distance, for a did-you-mean. */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

export function closest(term: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let score = Infinity;
  for (const c of candidates) {
    const d = distance(term, c);
    if (d < score) { score = d; best = c; }
  }
  // Only a plausible typo is suggested: at most a third of the term changed.
  return best !== null && score <= Math.max(1, Math.floor(term.length / 3)) ? best : null;
}
