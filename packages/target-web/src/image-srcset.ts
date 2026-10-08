/**
 * @az module image-srcset
 * Purpose: writes srcset on every <img> whose word asked for one (a `sizes` hint) and whose file the build resized.
 * Spec: docs/gallery-block-spec.md §7 rule 3
 * Exports: srcsetImages, srcsetWidths, coverSizes, SRCSET_WIDTHS, COVER_ATTR, Resize, Variant
 * Edit guide: never upscale; a `sizes` with no srcset is removed; without a resizer the output is exactly as before;
 *   a cover hint (COVER_ATTR) widens each clause by the file's aspect over the box's, never past the largest file.
 * Tests: packages/target-web/test/image-srcset.test.ts
 */

/**
 * Responsive images — gallery-block-spec §7 rule 3.
 *
 * A word knows its layout, so a word that wants responsive images puts a
 * `sizes` value on its <img> — how wide the image is drawn at each viewport
 * (the gallery derives it from its columns). The target sees the files, so
 * it asks the build's resizer for the fixed widths below and writes `srcset`
 * beside that `sizes`. The original stays the `src`, and `width`/`height`
 * (rule 1) stay the original's.
 *
 * Rules:
 *   - only widths narrower than the original are asked for: never upscaled;
 *   - the original is the widest candidate while it is no wider than the
 *     largest fixed width — past that the largest variant tops the set and
 *     the original is only the fallback for a browser without srcset;
 *   - a width the resizer did not ship (its variant was larger than the
 *     original) is left out; when that is the widest asked for, the
 *     original is a candidate whatever its width, standing in for it;
 *   - no resizer (the playground, unit tests), a file the build cannot read
 *     or resize, or an original no wider than the smallest width: no srcset,
 *     and the `sizes` is removed — it means nothing alone, so the page is
 *     exactly what it was before this rule existed.
 *
 * Cover crops. `sizes` says how wide the BOX is; an image drawn with
 * `object-fit: cover` in a box of another shape is drawn wider than the box
 * when the file is wider than the box (a wide poster in a tall header). The
 * word knows the box, the target knows the file, so a word marks such an
 * image with COVER_ATTR, whose value states the box in every clause:
 *   - a ratio `w / h` (`4 / 3`): the box's aspect, exact. Each clause is
 *     widened by max(1, fileAspect / boxAspect);
 *   - a height in vh (`85vh`): an upper bound of the box's height. The image
 *     is drawn at least the box's width and the height × fileAspect, so each
 *     clause becomes max(<clause>, <height × fileAspect>).
 * A widened length never exceeds the largest file in the srcset: at that
 * width the browser picks the largest anyway, and the value stays readable.
 * The hint is always removed; it means nothing in the page.
 */

import type { EmittedNode } from '../../core/src/emit-contract.ts';
import type { SizeOf } from './image-dims.ts';

/** §7 rule 3: the widths generated at build, px. */
export const SRCSET_WIDTHS: readonly number[] = [480, 768, 1200, 1800];

/** One resized copy: its root-relative URL and its width, px. */
export interface Variant {
  readonly url: string;
  readonly width: number;
}

/**
 * The build's resizer: the project file at `projectPath` resized to each of
 * `widths`, in that order — or to some of them, in that order, where a
 * variant would be larger than the file itself — or null when it cannot be
 * (a format that is not resized, a file that does not decode). The caller
 * owns the files.
 */
export type Resize = (projectPath: string, widths: readonly number[]) => readonly Variant[] | null;

/** The fixed widths a file `width` px wide is resized to: only narrower ones. */
export const srcsetWidths = (width: number): number[] => SRCSET_WIDTHS.filter((w) => w < width);

/** The largest fixed width: an original up to it is a candidate itself. */
const LARGEST = Math.max(...SRCSET_WIDTHS);

/** The attribute a word marks a cover crop with: its box, as a ratio or a height (see above). */
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

/** The img with its srcset, or with its `sizes` removed when it gets none. */
function srcsetImg(
  node: EmittedNode, srcs: ReadonlyMap<string, string>, sizeOf: SizeOf | undefined, resize: Resize | undefined,
): EmittedNode {
  const { [COVER_ATTR]: cover, ...attrs } = node.attrs ?? {};
  if (attrs.sizes === undefined) return cover === undefined ? node : { ...node, attrs };
  const src = attrs.src;
  const path = src === undefined ? undefined : srcs.get(src);
  const size = src === undefined || !sizeOf ? null : sizeOf(src);
  const widths = size ? srcsetWidths(size.width) : [];
  const variants = resize && path !== undefined && widths.length > 0 ? resize(path, widths) : null;
  // Some of the widths asked for, in their order: a variant larger than its source is not shipped.
  const usable = variants !== null && variants.length > 0 &&
    variants.map((v) => v.width).join() === widths.filter((w) => variants.some((v) => v.width === w)).join();
  if (!usable || !size || src === undefined) {
    return { ...node, attrs: Object.fromEntries(Object.entries(attrs).filter(([name]) => name !== 'sizes')) };
  }
  // The original stands in for a dropped widest variant, past LARGEST too.
  const own = size.width <= LARGEST || variants[variants.length - 1].width !== widths[widths.length - 1];
  const candidates = [
    ...variants.map((v) => `${v.url} ${v.width}w`),
    ...(own ? [`${src} ${size.width}w`] : []),
  ];
  const largest = own ? size.width : variants[variants.length - 1].width;
  const sizes = cover === undefined ? attrs.sizes : coverSizes(attrs.sizes, cover, size.width / size.height, largest);
  return { ...node, attrs: { ...attrs, sizes, srcset: candidates.join(', ') } };
}

/**
 * Every <img> in the tree that carries a `sizes` hint, with its srcset —
 * or without the hint, where there is no srcset to go with it. `srcs` maps
 * an emitted `src` to its project file; `sizeOf` gives the original's size.
 */
export function srcsetImages(
  node: EmittedNode, srcs: ReadonlyMap<string, string>, sizeOf: SizeOf | undefined, resize: Resize | undefined,
): EmittedNode {
  const self = node.tag === 'img' ? srcsetImg(node, srcs, sizeOf, resize) : node;
  if (!self.children) return self;
  return { ...self, children: self.children.map((c) => (typeof c === 'string' ? c : srcsetImages(c, srcs, sizeOf, resize))) };
}
