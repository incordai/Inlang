/**
 * @az runtime cover-sizes
 * Purpose: a cover-cropped image's `sizes`, widened by its file's aspect over its box's (gallery-spec §7 rule 3).
 * Spec: docs/gallery-block-spec.md §7 rule 3
 * Exports: coverSizes, COVER_ATTR
 * Edit guide: keep pure (no DOM, no imports); never wider than the largest file; a box as wide as the file changes nothing.
 * Tests: packages/target-web/test/image-srcset.test.ts, packages/overlay/test/rows.test.ts
 */

/**
 * One function, two callers: the build (target-web image-srcset.ts), for a
 * file it has read, and the rows runtime (rows.ts), for a row's image,
 * whose size arrives with the row. Copied into a generated project beside
 * the rows runtime; imports nothing.
 *
 * `sizes` says how wide the BOX is; an image drawn with `object-fit: cover`
 * in a box of another shape is drawn wider than the box when the file is
 * wider than the box. The word states the box in its cover hint:
 *   - a ratio `w / h` (`4 / 3`): the box's aspect, exact. Each clause is
 *     widened by max(1, fileAspect / boxAspect);
 *   - a height in vh (`85vh`): an upper bound of the box's height. The image
 *     is drawn at least the box's width and the height × fileAspect, so each
 *     clause becomes max(<clause>, <height × fileAspect>).
 * A widened length never exceeds the largest file in the srcset: at that
 * width the browser picks the largest anyway, and the value stays readable.
 */

/** The attribute a word marks a cover crop with: its box, as a ratio or a height (above). */
export const COVER_ATTR = 'data-az-cover';

/**
 * Lengths are rounded up to whole units so the browser never picks too
 * small a file; a product that floating point leaves a hair over a whole
 * number (120.00000000000001) is that number, not the next.
 */
const ROUNDING_SLACK = 1e-9;
const up = (n: number): number => Math.ceil(n - ROUNDING_SLACK);

/** One term of a length: `50vw`, `720px`, `128vh`. */
interface Term { readonly value: number; readonly unit: 'vw' | 'vh' | 'px' }

const TERM = /^(\d+(?:\.\d+)?)(vw|vh|px)$/;
const BELOW = /^\(width < (\d+(?:\.\d+)?)px\)$/;
const RATIO = /^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/;
const HEIGHT = /^(\d+(?:\.\d+)?)vh$/;

const term = (text: string, sizes: string): Term => {
  const m = TERM.exec(text.trim());
  if (!m) throw new Error(`image-srcset: can't widen the length '${text}' in sizes '${sizes}' — a word's cover hint needs vw, vh or px terms`);
  return { value: Number(m[1]), unit: m[2] as Term['unit'] };
};

const show = (t: Term): string => `${t.value}${t.unit}`;
const minOf = (terms: readonly Term[]): string => (terms.length === 1 ? show(terms[0]) : `min(${terms.map(show).join(', ')})`);

/** `text` split at the separator wherever it is outside parentheses. */
function topLevel(text: string, separator: ',' | ' '): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') depth--;
    else if (text[i] === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** A clause's length as the terms of a min(): `50vw`, or `min(34vw, 480px)`. */
function terms(length: string, sizes: string): Term[] {
  const inner = /^min\((.*)\)$/.exec(length);
  return inner ? topLevel(inner[1], ',').map((t) => term(t, sizes)) : [term(length, sizes)];
}

/** The most a term can be, px, in a clause that holds below `below` px wide (Infinity when unknown). */
const most = (t: Term, below: number | undefined): number =>
  t.unit === 'px' ? t.value : t.unit === 'vw' && below !== undefined ? (t.value * below) / 100 : Infinity;

/** `terms`, never more than `largest` px: the cap is added only where a term could pass it. */
function capped(scaled: readonly Term[], below: number | undefined, largest: number): Term[] {
  if (Math.min(...scaled.map((t) => most(t, below))) <= largest) return [...scaled];
  return [...scaled.filter((t) => t.unit !== 'px'), { value: largest, unit: 'px' }];
}

/**
 * gallery-spec §7 rule 3: `sizes` widened for a cover crop. `cover` is the
 * word's hint (a box ratio or a box height in vh), `aspect` the file's
 * width / height, `largest` the widest file in its srcset, px. A box at
 * least as wide as the file (by ratio) leaves `sizes` exactly as it was.
 */
export function coverSizes(sizes: string, cover: string, aspect: number, largest: number): string {
  const ratio = RATIO.exec(cover.trim());
  const height = HEIGHT.exec(cover.trim());
  const box = ratio ? Number(ratio[1]) / Number(ratio[2]) : NaN;
  if (!(box > 0 && Number.isFinite(box)) && !height) {
    throw new Error(`image-srcset: the cover hint '${cover}' is neither a box ratio (4 / 3) nor a box height (85vh)`);
  }
  const factor = aspect / box;
  if (ratio && factor <= 1) return sizes;
  const drawn: Term | undefined = height ? { value: up(Number(height[1]) * aspect), unit: 'vh' } : undefined;
  return topLevel(sizes, ',').map((clause) => {
    const parts = topLevel(clause, ' ');
    const length = parts[parts.length - 1];
    const condition = parts.slice(0, -1).join(' ');
    const below = BELOW.exec(condition);
    const bound = below ? Number(below[1]) : undefined;
    const widened = drawn
      ? `max(${length}, ${minOf(capped([drawn], bound, largest))})`
      : minOf(capped(terms(length, sizes).map((t) => ({ value: up(t.value * factor), unit: t.unit })), bound, largest));
    return condition === '' ? widened : `${condition} ${widened}`;
  }).join(', ');
}
