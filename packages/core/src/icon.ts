/**
 * @az module icon
 * Purpose: `site icon` — which image format a file really is (PNG or SVG), from its first bytes, never its name.
 * Spec: docs/GRAMMAR.md §4.4 (site and page settings) · docs/PRD.md §6.1a
 * Exports: iconFormat, IconFormat, ICON_FORMATS, ICON_HEAD_BYTES
 * Edit guide: dependency-free and never throws; anything not certainly PNG or SVG is null. The link stage checks the
 *   extension, compile() the content (AZ1421), and the target sniffs again for the <link> type.
 * Tests: packages/core/test/head-settings.test.ts
 */

/** The formats a site icon may be, by the extension a host serves each as. */
export const ICON_FORMATS = {
  png: { ext: '.png', type: 'image/png' },
  svg: { ext: '.svg', type: 'image/svg+xml' },
} as const;

export type IconFormat = keyof typeof ICON_FORMATS;

/** How much of a file is read to find an SVG's root element past its prolog. */
export const ICON_HEAD_BYTES = 64 * 1024;

/** PNG's eight-byte signature, then the IHDR chunk that must come first (PNG §5.2, §11.2.2). */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_AT = 12;

function isPng(b: Uint8Array): boolean {
  if (b.length < IHDR_AT + 4) return false;
  if (!PNG_SIGNATURE.every((v, i) => b[i] === v)) return false;
  return String.fromCharCode(b[IHDR_AT], b[IHDR_AT + 1], b[IHDR_AT + 2], b[IHDR_AT + 3]) === 'IHDR';
}

/**
 * An SVG document: after a BOM and the prolog — XML declaration, processing
 * instructions, comments, a doctype with its internal subset — the root
 * element is `<svg`. Text that merely mentions svg, or HTML, is not one.
 */
function isSvg(b: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(0, ICON_HEAD_BYTES));
  const rest = head.replace(/^﻿/, '')
    .replace(/^(?:\s+|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^[>]*(?:\[[\s\S]*?\])?\s*>)*/i, '');
  return /^<svg[\s>/]/.test(rest);
}

/** The format the bytes are, or null when they are certainly neither PNG nor SVG. */
export function iconFormat(bytes: Uint8Array): IconFormat | null {
  if (isPng(bytes)) return 'png';
  if (isSvg(bytes)) return 'svg';
  return null;
}
