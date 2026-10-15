/**
 * @az module preview-banner
 * Purpose: the "still writing" banner az dev puts on every page of a partial-file preview.
 * Spec: docs/partial-preview.md §4
 * Exports: PREVIEW_ATTR, bannerHtml, withBanner, previewSummary
 * Edit guide: every piece of diagnostic text goes through escapeHtml — it quotes the author's input; never used by az build.
 * Tests: packages/cli/test/preview.test.ts
 */

/**
 * A preview (core preview.ts) renders only the whole, valid blocks of a file
 * that does not compile yet. The page must say so, or the author reads a
 * cut-off site as the finished one. The banner sits outside the React root,
 * fixed in a corner and collapsed, so the site's own markup is untouched,
 * and it lists every error of the whole file with its line.
 */

import type { Diagnostic } from '../../core/src/index.ts';
import { escapeHtml } from '../../target-web/src/emit.ts';
import { LAYER, SPACE, TYPE_SIZE } from '../../theme/src/tokens.ts';

/** The attribute that marks the banner, for a test or a script to find it. */
export const PREVIEW_ATTR = 'data-az-preview';

const plural = (n: number) => `${n} problem${n === 1 ? '' : 's'}`;

/** What the banner and the terminal both say after "still writing — ". */
export function previewSummary(errors: number, cutLine: number): string {
  return `${plural(errors)} · preview stops before line ${cutLine}`;
}

const px = (n: number) => `${n}px`;

/**
 * Styled from the site's own theme: its colour and shadow variables (the
 * page loads theme.css) and the global space, type and layer tokens, so the
 * banner reads in either scheme and names no raw value (theme-spec §4). It
 * sits on the toast layer, above any modal the site opens.
 */
const BOX = [
  'position:fixed', `right:${px(SPACE[12])}`, `bottom:${px(SPACE[12])}`, `z-index:${LAYER.toast}`,
  `max-width:min(36rem,calc(100vw - ${px(SPACE[24])}))`, 'max-height:50vh', 'overflow:auto',
  'margin:0', `padding:${px(SPACE[8])} ${px(SPACE[12])}`,
  'background:var(--az-color-surface)', 'color:var(--az-color-text)',
  'border:1px solid var(--az-color-border-strong)', 'box-shadow:var(--az-shadow-md)',
  `font-size:${TYPE_SIZE.xs}`,
].join(';');
const LIST = `margin:${px(SPACE[4])} 0 0;padding-left:${px(SPACE[16])}`;

/**
 * The banner for a preview that stops before `cutLine`: the whole file's
 * errors, each `file:line:col CODE message`, all escaped.
 */
export function bannerHtml(diagnostics: readonly Diagnostic[], file: string, cutLine: number): string {
  const errors = diagnostics.filter((d) => d.severity === 'error');
  const summary = previewSummary(errors.length, cutLine);
  const items = errors
    .map((d) => `<li>${escapeHtml(`${file}:${d.pos.line}:${d.pos.col} ${d.code} ${d.message}`)}</li>`)
    .join('');
  return `<aside ${PREVIEW_ATTR} role="status" aria-label="az dev preview" style="${BOX}">`
    + `<details><summary>Still writing — ${escapeHtml(summary)}</summary>`
    + `<ol style="${LIST}">${items}</ol></details></aside>`;
}

/**
 * The emitted files with the banner on every page. The target emits HTML
 * for pages only (one per route), so every `.html` file is a page; the
 * banner goes last in its body, after the root and the module script.
 */
export function withBanner<T extends { path: string; content: string }>(files: readonly T[], banner: string): T[] {
  return files.map((f) => {
    if (!f.path.endsWith('.html')) return f;
    const at = f.content.lastIndexOf('</body>');
    if (at < 0) return f;
    return { ...f, content: `${f.content.slice(0, at)}  ${banner}\n  ${f.content.slice(at)}` };
  });
}
