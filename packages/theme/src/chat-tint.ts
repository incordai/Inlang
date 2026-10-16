/**
 * @az module theme-chat-tint
 * Purpose: the chat's one derived surface — the visitor's message, a quiet tint of the accent over `surface`, proven, never hand-written.
 * Spec: docs/theme-spec.md §16 · docs/chat-block-spec.md §9 (the look) · docs/theme-spec.md §6 (floors)
 * Exports: CHAT_TOKENS, ChatToken, CHAT_TINT_PERCENT, CHAT_TINT_SEPARATION, CHAT_SURFACES, ChatTintUnavailable, chatTint, chatTokens, withChat
 * Edit guide: the numbers are named constants here and stated in theme-spec §16; change both together.
 *   A theme whose tint misses a floor THROWS — the build stops rather than ship a bubble under its floor.
 * Tests: packages/theme/test/chat-tint.test.ts, packages/theme/test/contrast.test.ts
 */

/**
 * A chat needs one surface the theme never had to choose: the visitor's own
 * words, told apart from the answer without a second loud colour. The rule:
 * the theme's accent mixed into its `surface` at CHAT_TINT_PERCENT, declared
 * the way `veil` is — a `color-mix()` of the two tokens, so it follows the
 * scheme with them — and proven here on the colour that mix paints.
 *
 * The tint must keep `text` at the body floor (4.5:1) and stay visibly apart
 * from `surface` (CHAT_TINT_SEPARATION), for every theme × accent × scheme;
 * a theme where it cannot is refused, the way an unreadable series is.
 */

import { CONTRAST_BODY, composite, contrastRatio, rgbOf, type Rgb } from './color.ts';
import { colorProperty } from './css.ts';
import type { ColorTokens, Scheme, Theme } from './tokens.ts';

export const CHAT_TOKENS = ['chat-visitor'] as const;
export type ChatToken = (typeof CHAT_TOKENS)[number];

/**
 * How much accent the visitor's message carries over `surface`, in percent.
 * Chosen by eye over the six themes in both schemes (chat-block-spec §9):
 * enough to tell the visitor's words from the answer at a glance, little
 * enough that no theme's accent floods the transcript.
 */
export const CHAT_TINT_PERCENT = 12;

/**
 * The least contrast the tint keeps against `surface`: not a reading floor
 * (the text has its own) but a "visibly a different surface" floor. Measured
 * on 2026-10-16 over every theme × accent × offered pair × scheme the closest
 * is 1.16 (volt's own accent, dark), so 1.1 refuses any change that would
 * make the bubble vanish into the answer's surface.
 */
export const CHAT_TINT_SEPARATION = 1.1;

/**
 * Where a chat draws an answer and its parts: the panel's own surface. The
 * chart series (series.ts) are proven 3:1 on these; a new answer surface
 * joins this list and the proof together.
 */
export const CHAT_SURFACES = ['surface'] as const;

/** Raised when the tint cannot hold its floors on a theme — the build stops. */
export class ChatTintUnavailable extends Error {}

/** The declared value: built on var(), so it follows whichever scheme declares the accent and the surface. */
const VISITOR_VALUE = `color-mix(in srgb, var(${colorProperty('accent')}) ${CHAT_TINT_PERCENT}%, var(${colorProperty('surface')}))`;

/** What the visitor's message is painted in on one scheme of `theme`: the accent over surface, as `color-mix(in srgb …)` mixes. */
export function chatTint(theme: Theme, scheme: Scheme): Rgb {
  const c = theme.color[scheme];
  return composite(rgbOf(c.accent), rgbOf(c.surface), CHAT_TINT_PERCENT / 100);
}

/** The chat's tokens for one scheme of `theme`, or throw. Deterministic. */
export function chatTokens(theme: Theme, scheme: Scheme): Record<ChatToken, string> {
  const c = theme.color[scheme];
  const tint = chatTint(theme, scheme);
  const text = contrastRatio(rgbOf(c.text), tint);
  if (text < CONTRAST_BODY) {
    throw new ChatTintUnavailable(`theme: text on chat-visitor is ${text}:1 on ${theme.name} ${scheme}, under ${CONTRAST_BODY}:1`);
  }
  const apart = contrastRatio(tint, rgbOf(c.surface));
  if (apart < CHAT_TINT_SEPARATION) {
    throw new ChatTintUnavailable(`theme: chat-visitor is ${apart}:1 from surface on ${theme.name} ${scheme}, under ${CHAT_TINT_SEPARATION}:1`);
  }
  return { 'chat-visitor': VISITOR_VALUE };
}

/** The theme with its chat tokens added in both schemes — only for a site with a chat. */
export function withChat(theme: Theme): Theme {
  const color = {} as Record<Scheme, ColorTokens>;
  for (const scheme of ['light', 'dark'] as const) {
    color[scheme] = { ...theme.color[scheme], ...chatTokens(theme, scheme) };
  }
  return { ...theme, color };
}
