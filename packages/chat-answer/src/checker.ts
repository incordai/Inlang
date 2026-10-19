/**
 * @az module checker
 * Purpose: the answer checker as one call — a model's streamed text in; prose, held and filled components out, and the answer's record and history at its end.
 * Spec: docs/chat-block-spec.md §5.3, §6.1, §19.16, §20.5, §20.7, §22.1
 * Exports: createAnswerChecker, AnswerChecker, AnswerRead, CheckerOptions, CheckerData, CheckerEvent, CheckerDone, SentEvent, ReadOptions, EVENTS_BYTES
 * Edit guide: nothing the model wrote leaves here but the parser's events; every cap the parser and the resolver hold stays theirs;
 *   no Node-only API (it runs in a browser and an app webview too).
 * Tests: packages/chat-answer/test/checker.test.ts, scripts/chat-lib-e2e.mjs, packages/backend/test/chat-attacks.test.ts
 */

/**
 * The checker is what the built-in chat server runs on every answer
 * (chat.ts), and what an app runs when it talks to a model itself
 * (chat-block-spec §22): the answer parser (chat-answer.ts) reads the
 * model's text as it streams; each rich component it passes is announced by
 * a `hold` naming only its kind, then resolved (chat-rich.ts resolveRich) —
 * its `from` figures asked of the data source, its tool request of the
 * app's tools, its places of the geocoder — before it is sent as one
 * `block`. The page never receives a byte the parser did not produce.
 *
 * The answer's events stay within EVENTS_BYTES, what one share may hold
 * (§20.7): a component past it is dropped whole and noted in the history,
 * like one whose figures could not be read. At the end, `done` carries the
 * record every cap was judged on, the history the model is sent back next
 * time (§19.16) — which a server tags so the page can return it — every
 * drop reason, and the events as sent, which a share tag covers.
 *
 * A cap the parser reaches (prose, components) ends the answer: `onCapped`
 * is called at once, so the caller stops the model before the rest is
 * resolved, and nothing more is read from the stream.
 */

import {
  ANSWER_WORDS, createAnswerParser, type AnswerBlock, type AnswerEvent, type AnswerPreset, type AnswerQuote, type AnswerRules, type AnswerWord,
  type DropReason,
} from './chat-answer.ts';
import { RICH_WORDS, resolveRich, utf8Bytes, type FiguresRun, type GeocodeRun, type RichBlock, type RichWord, type ToolsRun } from './chat-rich.ts';
import type { ChatToolShape } from './tool-shape.ts';

/** The events JSON of one answer, in UTF-8 bytes: what one share may hold (§20.7), so every answer can be shared whole. */
export const EVENTS_BYTES = 48 * 1024;

/** Who answers a rich component's requests; each is optional, and a component that needs a missing one is dropped or noted. */
export interface CheckerData {
  /** `from <table> …`: the data source's own reading of its public tables (§20.5). */
  readonly figures?: FiguresRun;
  /** `from tool <name> …`: one of the declared tools, called with the checked values (§21.2). */
  readonly tools?: ToolsRun;
  /** A map's `place`: the geocoder (§21.4.2). Its presence is what lets an answer write a place. */
  readonly geocode?: GeocodeRun;
}

/** What one chat's answers may show, quote, link to and ask (chat-block-spec §3.2, §5.3, §6.2). */
export interface CheckerOptions {
  /** The components an answer may hold — a chat's `show` (ANSWER_WORDS); anything else is dropped. */
  readonly components: readonly AnswerWord[];
  /** The only destinations a cta or a card's link may use, exactly as written. */
  readonly destinations?: readonly string[];
  /** The blocks an answer may quote with `show …`; none by default. */
  readonly quotes?: readonly AnswerQuote[];
  /** The image keys an image card may name; the renderer maps each key to its own image. None by default. */
  readonly images?: readonly string[];
  /** The chat's answer presets, which `use <name>` shows (§19.16). */
  readonly presets?: readonly AnswerPreset[];
  /** The declared tools a `from tool` may name: shapes only, never a URL or a key (§21.2). */
  readonly tools?: readonly ChatToolShape[];
  /** Who answers the components' requests. */
  readonly data?: CheckerData;
  /** The day figures are read on, `YYYY-MM-DD`, shown as their date; by default today in UTC. */
  readonly day?: string;
  /** The events' byte cap; at most EVENTS_BYTES, which is the default. */
  readonly eventsBytes?: number;
}

/** An event as the page receives it: prose, or a component ready to draw. */
export type SentEvent = { readonly type: 'text'; readonly s: string } | { readonly type: 'block'; readonly block: Record<string, unknown> };

/** The answer's end: its record, its history, why components went, and the events as sent. */
export interface CheckerDone {
  readonly type: 'done';
  /** A cap ended the answer before the model did. */
  readonly capped: boolean;
  /** Prose and each shown component's canonical lines — what every cap was judged on (§19.16). */
  readonly record: string;
  /** What the model is sent back next time: prose, a stand-in per component, a note per drop — never longer than ANSWER_LIMITS.record. */
  readonly history: string;
  /** Every component dropped, by reason, in order: the parser's, then the resolver's. Codes only, never text. */
  readonly dropped: readonly DropReason[];
  /** Every event sent, in order — what a share of this answer holds. */
  readonly events: readonly SentEvent[];
}

export type CheckerEvent =
  | SentEvent
  /** A rich component is being resolved: its kind only, so the page can show a placeholder of its shape (issue #28). */
  | { readonly type: 'hold'; readonly word: RichWord }
  | CheckerDone;

export interface ReadOptions {
  /** Called the moment a cap ends the answer, before the rest is resolved: stop the model. */
  readonly onCapped?: () => void;
}

/**
 * One answer being read: its events, `done` last — and, while it is read or
 * after its stream failed, the record and drops so far (what an answer that
 * never finished still cost and lost).
 */
export interface AnswerRead extends AsyncIterable<CheckerEvent> {
  readonly record: string;
  readonly dropped: readonly DropReason[];
}

export interface AnswerChecker {
  /** One answer: the model's text pieces in, as they stream; the page's events out. A stream that throws ends it with no `done`, rethrown. */
  read(chunks: AsyncIterable<string>, options?: ReadOptions): AnswerRead;
}

const isRich = (b: AnswerBlock): b is RichBlock => (RICH_WORDS as readonly string[]).some((w) => Object.hasOwn(b, w));

/** Today's day in UTC, `YYYY-MM-DD`. */
const utcToday = (): string => new Date().toISOString().slice(0, 10);

/**
 * A checker for one chat's answers. `options` is the app's own
 * configuration, never the model's: a component name it does not know is a
 * mistake, so it throws rather than letting nothing through by surprise.
 */
export function createAnswerChecker(options: CheckerOptions): AnswerChecker {
  for (const w of options.components) {
    if (!(ANSWER_WORDS as readonly string[]).includes(w)) throw new TypeError(`createAnswerChecker: '${w}' is not a component (${ANSWER_WORDS.join(', ')})`);
  }
  const cap = Math.min(options.eventsBytes ?? EVENTS_BYTES, EVENTS_BYTES);
  const data = options.data ?? {};
  const images = options.images ?? [];
  const rules: AnswerRules = {
    show: options.components,
    quotes: options.quotes ?? [],
    destinations: options.destinations ?? [],
    images,
    tools: options.tools ?? [],
    presets: options.presets ?? [],
    // A place may be written only where a map may be shown and someone can look it up.
    geocoder: data.geocode !== undefined && options.components.includes('map'),
  };
  return {
    read(chunks, o = {}) {
      const parser = createAnswerParser(rules);
      const day = options.day ?? utcToday();
      const sent: SentEvent[] = [];
      const resolvedDrops: DropReason[] = [];
      /** The components the parser passed that were then dropped whole: the history notes them instead (§19.16). */
      const lost = new Map<AnswerBlock, DropReason>();
      let bytes = 0;
      /** The parser's events in order, each rich component announced and resolved first; within the byte cap. */
      async function* write(events: readonly AnswerEvent[]): AsyncGenerator<CheckerEvent, void, undefined> {
        for (const e of events) {
          let out: SentEvent;
          if (e.type === 'text') out = e;
          else if (isRich(e.block)) {
            const word = RICH_WORDS.find((w) => Object.hasOwn(e.block, w));
            if (word) yield { type: 'hold', word };
            const r = await resolveRich(e.block, data.figures ?? null, day, data.tools ?? null, images, (why) => resolvedDrops.push(why), data.geocode ?? null);
            if (r === null) { resolvedDrops.push('figures'); lost.set(e.block, 'figures'); continue; }
            out = { type: 'block', block: r };
          } else out = { type: 'block', block: e.block as unknown as Record<string, unknown> };
          const size = utf8Bytes(JSON.stringify(out));
          if (bytes + size > cap) {
            if (e.type === 'block') { resolvedDrops.push('too_long'); lost.set(e.block, 'too_long'); }
            continue;
          }
          bytes += size;
          sent.push(out);
          yield out;
        }
      }
      async function* events(): AsyncGenerator<CheckerEvent, void, undefined> {
        let capped = false;
        for await (const text of chunks) {
          if (text === '') continue;
          yield* write(parser.push(text));
          if (parser.ended) {
            capped = true;
            o.onCapped?.();
            break;
          }
        }
        // The last line and any component still open, once the answer is whole.
        yield* write(parser.end());
        yield { type: 'done', capped, record: parser.record, history: parser.history(lost), dropped: [...parser.dropped, ...resolvedDrops], events: sent };
      }
      // One stream, read once: a second loop over the same answer continues it, never starts it again.
      const iterator = events();
      return {
        [Symbol.asyncIterator]: () => iterator,
        get record() { return parser.record; },
        get dropped() { return [...parser.dropped, ...resolvedDrops]; },
      };
    },
  };
}
