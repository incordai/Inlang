/**
 * @az runtime row-image
 * Purpose: a table row's image as a page may draw it — its copies, its srcset, and the one rule for a URL a row holds.
 * Spec: docs/data-spec.md §8, §13 (dangerous links); docs/chat-block-spec.md §20.6
 * Exports: RowImage, RowVariant, rowSrcset, safeUrl
 * Edit guide: keep pure (no DOM); a URL that is not http(s) is no URL; a srcset the server did not send whole is no srcset.
 * Tests: packages/overlay/test/rows.test.ts, packages/chat-render/test/chat-figures.test.ts
 */

/**
 * Shared by a `from` block's runtime (overlay rows-logic.ts) and a chat's
 * image cards (chat-figures.ts), so a row's image follows one rule wherever
 * it is drawn. Moved here from rows-logic.ts. Imports nothing.
 */

/** A row image's narrower copy (data-spec §8). */
export interface RowVariant { readonly url: string; readonly width: number }

/** A row's image, as rowImage reads it. */
export interface RowImage {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly variants: readonly RowVariant[];
}

/**
 * A row image's `srcset` (gallery-spec §7 rule 3, data-spec §8): each copy,
 * then the image itself at its width — or null, and the <img> keeps its
 * `src` alone, when it has no copy (an image stored before copies), its
 * width is unknown, or any copy is not a safe URL narrower than the one
 * before it would allow. Never part of one: a set the server did not send
 * whole is no set.
 */
export function rowSrcset(image: RowImage, base: string): string | null {
  if (image.variants.length === 0 || image.width === 0) return null;
  const own = safeUrl(image.url, base);
  if (own === null) return null;
  const candidates: string[] = [];
  let last = 0;
  for (const v of image.variants) {
    const url = safeUrl(v.url, base);
    if (url === null || v.width <= last || v.width >= image.width) return null;
    candidates.push(`${url} ${v.width}w`);
    last = v.width;
  }
  return [...candidates, `${own} ${image.width}w`].join(', ');
}

/**
 * A URL from a row, allowed only as http(s) — data-spec §13 "dangerous
 * links", the GRAMMAR §4.3 rule applied at runtime. The URL parser does the
 * browser's own normalisation first (case, tabs and newlines, leading
 * spaces), so `JaVa\tscript:` is seen as what the browser would follow. A
 * relative value resolves against the page, so it stays on the site. An
 * empty value is no URL: resolved, it would be the page itself, and an image
 * of the page is a request for the page's HTML.
 */
export function safeUrl(value: string, base: string): string | null {
  if (value.trim() === '') return null;
  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}
