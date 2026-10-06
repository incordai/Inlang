/**
 * @az module image-dims
 * Purpose: writes width/height on every emitted <img> whose file the build can read, so the browser reserves its box.
 * Spec: docs/gallery-block-spec.md §7
 * Exports: imageSizes, sizeImages, SizeOf
 * Edit guide: an author's own width/height are never replaced; an img whose height CSS fixes gets width auto, or the attribute would stretch it.
 * Tests: packages/target-web/test/image-dims.test.ts
 */

/**
 * Image dimensions on the page — gallery-block-spec §7 rule 1.
 *
 * Words emit `<img src>` through the asset sandbox and never see the file;
 * the target sees every page, so it adds the size here, once, for every
 * word: gallery images, feature media, hero/scene/gallery posters, cta
 * media, nav and footer logos, markdown images.
 *
 * Only an <img> whose `src` the sandbox resolved is sized (`sizeOf` knows
 * it); a row's URL from a table is filled in after the page and has no file
 * at build. CSS still decides the box: `width: 100%; height: auto` (the
 * reset) takes the attributes' ratio, and a `ratio` crop's `aspect-ratio`
 * overrides it — as §7 says it must.
 *
 * One case would go wrong without care: an img whose CSS fixes its HEIGHT
 * but not its width (a logo `height: 32px`). The width attribute is a CSS
 * width hint, so a 400px-wide file would be drawn 400×32. Such an img gets
 * `width: auto`, so the width follows the height through the ratio.
 */

import type { EmittedNode, StyleMap } from '../../core/src/emit-contract.ts';
import { imageSize, type ImageSize } from './image-size.ts';

/** The intrinsic size of an emitted `src`, or null when it has none the build can read. */
export type SizeOf = (src: string) => ImageSize | null;

const HEIGHT_KEYS = ['height', 'maxHeight', 'minHeight'];

/** A height the CSS fixes: anything but unset or `auto`/`none`. */
const fixesHeight = (style: StyleMap | undefined) =>
  !!style && HEIGHT_KEYS.some((k) => style[k] !== undefined && style[k] !== 'auto' && style[k] !== 'none');

/** The img's style maps: base, each breakpoint, each state. */
const styles = (n: EmittedNode): (StyleMap | undefined)[] =>
  [n.style, ...Object.values(n.below ?? {}), ...Object.values(n.states ?? {})];

function sizeImg(node: EmittedNode, sizeOf: SizeOf): EmittedNode {
  const attrs = node.attrs ?? {};
  if (attrs.width !== undefined || attrs.height !== undefined || attrs.src === undefined) return node;
  const size = sizeOf(attrs.src);
  if (!size) return node;
  const sized: EmittedNode = { ...node, attrs: { ...attrs, width: String(size.width), height: String(size.height) } };
  const widthless = node.style?.width === undefined;
  return widthless && styles(node).some(fixesHeight)
    ? { ...sized, style: { ...node.style, width: 'auto' } }
    : sized;
}

/**
 * The build's `sizeOf`: an emitted `src` → its project file → the size in
 * its header, read once per file. A file the build can read but whose size
 * it cannot is a warning — the image still ships, it may only shift the
 * page as it loads. A missing file is not this function's report: the asset
 * copy refuses it with its own error. Undefined without a reader.
 */
export function imageSizes(
  readBytes: ((projectPath: string) => Uint8Array | null) | undefined,
  srcs: ReadonlyMap<string, string>,
  warnings: string[],
): SizeOf | undefined {
  if (!readBytes) return undefined;
  const known = new Map<string, ImageSize | null>();
  return (src) => {
    const path = srcs.get(src);
    if (path === undefined) return null;
    if (known.has(path)) return known.get(path)!;
    const bytes = readBytes(path);
    const size = bytes === null ? null : imageSize(bytes);
    if (bytes !== null && size === null) {
      warnings.push(path.toLowerCase().endsWith('.svg')
        ? `image: './${path}' has no size the browser can use — give its <svg> a viewBox, or width and height in px`
        : `image: can't read the size of './${path}' — the page will shift as it loads; export it as WebP, AVIF, JPEG, PNG or GIF`);
    }
    known.set(path, size);
    return size;
  };
}

/** Every <img> in the tree with its file's width and height, where `sizeOf` knows them. */
export function sizeImages(node: EmittedNode, sizeOf: SizeOf): EmittedNode {
  const self = node.tag === 'img' ? sizeImg(node, sizeOf) : node;
  if (!self.children) return self;
  return { ...self, children: self.children.map((c) => (typeof c === 'string' ? c : sizeImages(c, sizeOf))) };
}
