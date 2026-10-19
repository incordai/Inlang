/**
 * @az server chat-sse
 * Purpose: server-sent-event framing both ways: a bounded line reader for a model's stream, and the writer for the page's.
 * Spec: docs/backend-spec.md §5 (docs/chat-block-spec.md §4.2, §4.3)
 * Exports: createSseReader, sseEvent, SseEvent, SseLimitError, SSE_LINE_MAX
 * Edit guide: linear in the bytes read; a line past the cap throws, never grows; one JSON object per data line written.
 * Tests: packages/backend/test/chat-sse.test.ts
 */

/**
 * Server-sent events, by hand (chat-block-spec §4.3: the format is a few dozen
 * lines and no package is worth its supply chain). The READER takes a
 * model's response body as byte chunks split anywhere — inside a line,
 * inside a UTF-8 sequence — and hands out whole events; the WRITER frames
 * the closed set of events the page receives.
 *
 * Copied into a generated server; imports nothing.
 */

/** The longest line read from a model's stream; one delta is a few hundred bytes. */
export const SSE_LINE_MAX = 64 * 1024;

export class SseLimitError extends Error {}

/** One dispatched event: its `event:` name ('message' when none) and its `data:` lines joined by \n. */
export interface SseEvent { readonly event: string; readonly data: string }

/**
 * A reader: `push` bytes, get the events they completed; `end` flushes the
 * last one if the stream stopped without its blank line. A line longer than
 * `lineMax` (bytes, counted before decoding) throws SseLimitError.
 */
export function createSseReader(lineMax: number = SSE_LINE_MAX) {
  // `stream: true` keeps a split UTF-8 sequence until its rest arrives.
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let line = '';
  let lineBytes = 0;
  let pendingCr = false;
  let event = '';
  let data: string[] = [];
  let hasData = false;

  const take = (raw: string, out: SseEvent[]) => {
    if (raw === '') {
      if (hasData) out.push({ event: event || 'message', data: data.join('\n') });
      event = '';
      data = [];
      hasData = false;
      return;
    }
    if (raw.startsWith(':')) return;
    const colon = raw.indexOf(':');
    const field = colon < 0 ? raw : raw.slice(0, colon);
    let value = colon < 0 ? '' : raw.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') { data.push(value); hasData = true; }
    else if (field === 'event') event = value;
  };

  const feed = (text: string, out: SseEvent[]) => {
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      // \r\n is one line end: a \n directly after a \r (this chunk or the
      // last one's final byte) ends nothing.
      const partner = c === 10 && pendingCr && i === start && line === '';
      line += text.slice(start, i);
      start = i + 1;
      pendingCr = c === 13;
      if (partner) continue;
      take(line, out);
      line = '';
    }
    if (start < text.length) {
      pendingCr = false;
      line += text.slice(start);
    }
  };

  return {
    push(bytes: Uint8Array): SseEvent[] {
      const out: SseEvent[] = [];
      // Bytes since the last line end, counted on the raw input so the cap
      // holds before any decoding work is spent on a hostile line.
      let since = lineBytes;
      for (const b of bytes) {
        if (b === 10 || b === 13) since = 0;
        else if (++since > lineMax) throw new SseLimitError('line too long');
      }
      lineBytes = since;
      feed(decoder.decode(bytes, { stream: true }), out);
      return out;
    },
    end(): SseEvent[] {
      const out: SseEvent[] = [];
      feed(decoder.decode(), out);
      if (line !== '') take(line, out);
      line = '';
      take('', out);
      return out;
    },
  };
}

/** One event as the page receives it: a name from the closed set and one JSON object. */
export function sseEvent(name: 'text' | 'block' | 'hold' | 'done' | 'error', data: Record<string, unknown>): string {
  // JSON.stringify writes no raw newline, so the object stays one data line.
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}
