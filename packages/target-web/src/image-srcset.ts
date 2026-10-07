/**
 * @az module image-srcset
 * Purpose: writes srcset on every <img> whose word asked for one (a `sizes` hint) and whose file the build resized.
 * Spec: docs/gallery-block-spec.md §7 rule 3
 * Exports: srcsetImages, srcsetWidths, SRCSET_WIDTHS, Resize, Variant
 * Edit guide: never upscale; a `sizes` with no srcset is removed; without a resizer the output is exactly as before.
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
 *   - no resizer (the playground, unit tests), a file the build cannot read
 *     or resize, or an original no wider than the smallest width: no srcset,
 *     and the `sizes` is removed — it means nothing alone, so the page is
 *     exactly what it was before this rule existed.
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
 * `widths`, in that order — or null when it cannot be (a format that is not
 * resized, a file that does not decode). The caller owns the files.
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
  const attrs = node.attrs ?? {};
  if (attrs.sizes === undefined) return node;
  const src = attrs.src;
  const path = src === undefined ? undefined : srcs.get(src);
  const size = src === undefined || !sizeOf ? null : sizeOf(src);
  const widths = size ? srcsetWidths(size.width) : [];
  const variants = resize && path !== undefined && widths.length > 0 ? resize(path, widths) : null;
  const usable = variants !== null && variants.length === widths.length && variants.every((v, i) => v.width === widths[i]);
  if (!usable || !size || src === undefined) {
    return { ...node, attrs: Object.fromEntries(Object.entries(attrs).filter(([name]) => name !== 'sizes')) };
  }
  const candidates = [
    ...variants.map((v) => `${v.url} ${v.width}w`),
    ...(size.width <= LARGEST ? [`${src} ${size.width}w`] : []),
  ];
  return { ...node, attrs: { ...attrs, srcset: candidates.join(', ') } };
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
