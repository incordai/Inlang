/**
 * @az module instructions
 * Purpose: what a chat's model is told, as one function an app calls in Node, a browser or an app webview — the same text the built-in server sends.
 * Spec: docs/chat-block-spec.md §8.3, §19.16, §19.17, §22.2
 * Exports: buildInstructions, instructionParts, fixedInstructions, contentOutline, InstructionsInput, InstructionContent, ContentPage, EXTRA_RULES_LIMITS
 * Edit guide: the order is the prompt cache's — fixed rules, then content, then what one question changes; for the same
 *   input the text is byte for byte what `az build` writes and the server sends (a test holds the two together).
 * Tests: packages/chat-instructions/test/instructions.test.ts, packages/backend/test/chat-context.test.ts
 */

/**
 * `az build` writes a chat's fixed rules to server/chat/prompt-<n>.txt
 * (fixedInstructions) and the site's pages to context.json; the server adds
 * the rest per question (system-text.ts). An app has no build: it calls
 * buildInstructions with the same pieces and gets the same whole text —
 *
 *   1. the fixed rules, then the app's own extra rules after them;
 *   2. the content, between `<site-content>` tags, as data: the app's pages
 *      in the shape context.json holds them (an outline, chat-outline.ts),
 *      and its plain-text notes, each a quoted line;
 *   3. what one question changes: the page the visitor is on, what its
 *      components may use (quotes, destinations, tables, images, tools,
 *      places), the pages a large site sends in full, the rows.
 *
 * A table is the data source's queryable schema — names and field types.
 * The function cannot tell a private field from a public one: an app passes
 * only the fields a visitor may see, as the build does.
 */

import { ANSWER_WORDS, type AnswerPreset, type AnswerQuote, type AnswerWord } from '#chat-answer/chat-answer.ts';
import type { ChatToolShape } from '#chat-answer/tool-shape.ts';
import { CHAT_PROMPT } from './chat-prompt.ts';
import { outlineString, siteOutline, type SiteOutline } from './chat-outline.ts';
import { systemText, usesTools, type InstructionImage, type InstructionTable, type SystemText } from './system-text.ts';

/** One page of the app's content, in context.json's shape: its route, its description, its blocks' public text. */
export interface ContentPage {
  readonly route: string;
  readonly description?: string;
  readonly blocks?: readonly Readonly<Record<string, unknown>>[];
}

/** The app's own knowledge: its name and description, its pages, and plain-text notes. */
export interface InstructionContent {
  readonly site?: { readonly name?: string; readonly description?: string };
  readonly pages?: readonly ContentPage[];
  readonly notes?: readonly string[];
}

/** What a chat is told: the fixed part (the chat), the content (the app), and what one question changes. */
export interface InstructionsInput {
  /** The site's or the app's name, as the rules say it. */
  readonly appName: string;
  /** The components this chat's answers may show (ANSWER_WORDS); none teaches prose only. */
  readonly components?: readonly AnswerWord[];
  /** The answer presets the rules list, by name and first line (§19.16). */
  readonly presets?: readonly AnswerPreset[];
  /** The chat is sent rows of tables it knows (§8.2): the rules say rows are data. */
  readonly knows?: boolean;
  /** App-specific rules, one line each, after the fixed ones. */
  readonly rules?: { readonly extra?: readonly string[] };
  readonly content?: InstructionContent;
  readonly quotes?: readonly AnswerQuote[];
  readonly destinations?: readonly string[];
  readonly tables?: readonly InstructionTable[];
  readonly images?: readonly InstructionImage[];
  readonly tools?: readonly ChatToolShape[];
  /** A map's `place` may be looked up (a geocoder is there). */
  readonly geocoder?: boolean;
  /** Per question: the page the visitor is on; absent, no page is named. */
  readonly page?: string;
  /** Per question: the rows of the tables the chat knows, one JSON object a line. */
  readonly rows?: string;
  /** Per question: the visitor's latest turns, newest first, which choose a large site's pages. */
  readonly asked?: readonly string[];
  /** Whether pages are chosen for the question; by default, past CONTENT_LIMITS.whole. */
  readonly select?: boolean;
}

/** An app's extra rules: a few lines, each a sentence — they are part of every request's cost. */
export const EXTRA_RULES_LIMITS = { rules: 8, chars: 300 } as const;

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The input checked: it is the app's own configuration, so a mistake in it throws rather than teaching the model something odd. */
function checked(input: InstructionsInput): void {
  if (typeof input.appName !== 'string' || input.appName.trim() === '' || CONTROL.test(input.appName)) {
    throw new TypeError('buildInstructions: appName must be one line of text');
  }
  for (const w of input.components ?? []) {
    if (!(ANSWER_WORDS as readonly string[]).includes(w)) throw new TypeError(`buildInstructions: '${w}' is not a component (${ANSWER_WORDS.join(', ')})`);
  }
  const extra = input.rules?.extra ?? [];
  if (extra.length > EXTRA_RULES_LIMITS.rules) throw new TypeError(`buildInstructions: at most ${EXTRA_RULES_LIMITS.rules} extra rules`);
  for (const r of extra) {
    if (typeof r !== 'string' || r.trim() === '' || r.length > EXTRA_RULES_LIMITS.chars || CONTROL.test(r)) {
      throw new TypeError(`buildInstructions: an extra rule is one line of at most ${EXTRA_RULES_LIMITS.chars} characters`);
    }
  }
}

/** The fixed rules alone: what `az build` writes to a chat's prompt file (after its generated line). */
export function fixedInstructions(input: Pick<InstructionsInput, 'appName' | 'components' | 'presets' | 'knows' | 'rules'>): string {
  checked(input);
  const words = ANSWER_WORDS.filter((w) => (input.components ?? []).includes(w));
  return CHAT_PROMPT(input.appName, words, input.knows === true, input.presets ?? [], (input.rules?.extra ?? []).map((r) => r.trim()));
}

/** The content as the model reads it: its pages' outline, and each note a quoted line after the site's own. */
export function contentOutline(content: InstructionContent = {}): SiteOutline {
  const outline = siteOutline({ site: content.site ?? {}, pages: content.pages ?? [] });
  const notes = (content.notes ?? []).map((n) => `note ${outlineString(n)}`);
  return { site: [outline.site, ...notes].filter((l) => l !== '').join('\n'), pages: outline.pages };
}

/** The whole system text one question is sent: the fixed rules, the content, then what the question changes. */
export function buildInstructions(input: InstructionsInput): string {
  return instructionParts(input).text;
}

/**
 * The system text with how many of its first characters are the same for
 * every question — where a model bridge whose wire shape caches only up to
 * a marker puts its marker (§19.19).
 */
export function instructionParts(input: InstructionsInput): SystemText {
  const show = input.components ?? [];
  // As the server's rules: tools only for a chat whose components can take their figures, a place only where a map is shown.
  const tools = usesTools(show) ? input.tools ?? [] : [];
  return systemText({
    fixed: fixedInstructions(input),
    outline: contentOutline(input.content),
    show,
    quotes: input.quotes ?? [],
    destinations: input.destinations ?? [],
    tables: input.tables ?? [],
    images: input.images ?? [],
    ...(tools.length > 0 ? { tools } : {}),
    geocoder: input.geocoder === true && show.includes('map'),
    ...(input.page !== undefined ? { page: input.page } : {}),
    rows: input.rows ?? '',
    asked: input.asked ?? [],
    ...(input.select !== undefined ? { select: input.select } : {}),
  });
}
