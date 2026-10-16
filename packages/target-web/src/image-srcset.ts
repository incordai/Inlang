/**
 * @az module image-srcset
 * Purpose: writes srcset on every <img> whose word asked for one (a `sizes` hint) and whose file the build resized.
 * Spec: docs/gallery-block-spec.md §7 rule 3
 * Exports: srcsetImages, srcsetWidths, SRCSET_WIDTHS, Resize, Variant; coverSizes and COVER_ATTR from overlay runtime cover-sizes.ts
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
 *     exactly what it was before this rule existed;
 *   - an image a `from` row fills in (its `src` a row marker) keeps its
 *     `sizes` and its cover hint and gets no srcset here: the server makes
 *     its widths at upload and the rows runtime writes them (data-spec §8).
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
 * The maths is coverSizes (overlay runtime cover-sizes.ts), shared with the
 * rows runtime, which widens a row's image from its stored size. The hint is
 * removed here, except on a row's image, whose file only the rows runtime
 * sees; it removes the hint from each image it fills.
 */

import { isFromMark, type EmittedNode } from '../../core/src/emit-contract.ts';
import { COVER_ATTR, coverSizes } from '../../overlay/src/runtime/cover-sizes.ts';
import type { SizeOf } from './image-dims.ts';

export { COVER_ATTR, coverSizes };

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

/** The img with its srcset, or with its `sizes` removed when it gets none. */
function srcsetImg(
  node: EmittedNode, srcs: ReadonlyMap<string, string>, sizeOf: SizeOf | undefined, resize: Resize | undefined,
): EmittedNode {
  const { [COVER_ATTR]: cover, ...attrs } = node.attrs ?? {};
  if (attrs.sizes === undefined) return cover === undefined ? node : { ...node, attrs };
  const src = attrs.src;
  // A `from` row's image (data-spec §8, §10): its file is the server's, so
  // its srcset is the rows runtime's to write from the row, and its cover
  // widening too, from the row's stored size; the `sizes` and the hint stay for it.
  if (src !== undefined && isFromMark(src)) return node;
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
