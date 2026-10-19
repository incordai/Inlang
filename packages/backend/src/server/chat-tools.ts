/**
 * @az server chat-tools
 * Purpose: the operator's data tools — a `from tool` request POSTed to its declared URL, the reply bounded and checked row by row, aggregated for the page; never shown to the model.
 * Spec: docs/chat-block-spec.md §21.2 (§21.2.2–§21.2.5)
 * Exports: CallOutcome, callTool, toolCacheKey, createTools, Tools,
 *   ToolsOptions, probeTools, ToolProbe
 * Edit guide: fetch only, no SDK, no vendor names; the URL is the operator's, never the model's — the model's words are typed values
 *   in a JSON body; no redirect is followed; one bound for the request and the body; one row wrong and the whole reply is refused;
 *   a log line names the tool, an outcome, a time and a count — never a parameter, a value or the key.
 * Tests: packages/backend/test/chat-tools.test.ts, packages/backend/test/chat-route.test.ts
 */

/**
 * The model may ask for live figures from the operator's own endpoints
 * (chat-block-spec §21.2, Q17). What it writes is a request the answer
 * parser already checked against the declaration (chat-rich.ts): a declared
 * tool's name, declared parameters, values of their types in their bounds,
 * and one of the closed aggregates. Here that request is
 *
 *   1. answered from the cache when the same tool and parameters were
 *      called in the last 60 s;
 *   2. otherwise counted against the address's tool allowance, and POSTed
 *      as `{ "<param>": value, … }` to the URL in `.env` — with the bearer
 *      key when one is set — under the tool's timeout, redirects refused;
 *   3. read only from a `200` with `content-type: application/json`,
 *      through outbound.ts's capped reader (256 KB), as a JSON array of at
 *      most 200 rows, each exactly the declared fields, each value its type —
 *      one row wrong and the whole reply is refused;
 *   4. aggregated by the server's own code (count, sum, avg, min, max, by a
 *      text or date field; or the rows' columns) into the figures a chart,
 *      table or stat shows.
 *
 * Whatever goes wrong, the component becomes the fixed "These figures could
 * not be loaded." note; the answer goes on. A tool's rows go only to the
 * page: nothing here is ever added to what the model reads, in this answer
 * or the next, so text an endpoint returns can at most be a table cell.
 *
 * Copied into a generated server with a chat; imports only its siblings and the answer checker (#chat-answer).
 */

import { createRateLimits, type Windows } from './chat-limits.ts';
import type { ToolAnswer, ToolRequest, ToolsRun } from '#chat-answer/chat-rich.ts';
import { paramsProblem, type ChatRate, type ChatTool } from './env.ts';
import type { ChatToolShape } from '#chat-answer/tool-shape.ts';
import { aggregateTool, TOOL_RESULT, toolMinute, toolRows, type ToolRow } from '#chat-answer/tool-rows.ts';
import { BodyTooLarge, readCapped } from './outbound.ts';

/** A call's outcome: the rows, or why not — a fixed word and at most an HTTP status, safe to log. */
export type CallOutcome = { readonly ok: true; readonly rows: readonly ToolRow[] } | { readonly ok: false; readonly why: string };

type Fetch = typeof fetch;

/**
 * POST `args` to the tool's URL and read its rows. One bound — the tool's
 * timeout — for the request, the status and the body's last byte; `signal`
 * aborts it too (the visitor left). Never throws.
 */
export async function callTool(tool: ChatTool, args: Readonly<Record<string, string | number | boolean>>, signal: AbortSignal, fetchImpl: Fetch = (...a) => fetch(...a)): Promise<CallOutcome> {
  // The parser checked every value; the body is checked again here, where it is sent.
  if (paramsProblem(tool.params, args) !== null) return { ok: false, why: 'params' };
  const deadline = AbortSignal.timeout(tool.timeoutMs);
  const both = AbortSignal.any([deadline, signal]);
  const late = () => (deadline.aborted ? 'timeout' : 'aborted');
  let response: Response;
  try {
    response = await fetchImpl(tool.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(tool.key ? { authorization: `Bearer ${tool.key}` } : {}),
      },
      body: JSON.stringify(args),
      signal: both,
      redirect: 'error',
    });
  } catch (e) {
    if (both.aborted) return { ok: false, why: late() };
    // fetch refuses a redirect with `redirect: 'error'` as a TypeError whose cause says so.
    const cause = (e as { cause?: { message?: unknown } } | null)?.cause?.message;
    return { ok: false, why: typeof cause === 'string' && /redirect/i.test(cause) ? 'redirect' : 'network' };
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, why: `status ${response.status}` };
  }
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, why: 'type' };
  }
  let body: string;
  try {
    body = await readCapped(response, TOOL_RESULT.bytes);
  } catch (e) {
    if (e instanceof BodyTooLarge) return { ok: false, why: 'too_large' };
    return { ok: false, why: both.aborted ? late() : 'network' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, why: 'malformed' };
  }
  const rows = toolRows(tool.fields, parsed);
  return rows === null ? { ok: false, why: 'shape' } : { ok: true, rows };
}

/** One cache entry per tool and parameters, whatever the order the model wrote them in. */
export const toolCacheKey = (req: ToolRequest): string =>
  JSON.stringify([req.tool, Object.keys(req.args).sort().map((k) => [k, req.args[k]])]);

export interface ToolsOptions {
  readonly tools: readonly ChatTool[];
  /** AZ_CHAT_TOOL_CALLS_PER_ADDRESS. */
  readonly perAddress: ChatRate;
  /** The rate-limit windows every instance shares (chat-limits.ts): a call counts against its address on all of them. */
  readonly windows: Windows;
  readonly fetch?: Fetch;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
}

export interface Tools {
  /** What the parser and the model know of each tool: never a URL or a key. */
  readonly shapes: readonly ChatToolShape[];
  /** The tool runner for one answer: calls counted against `address`; `signal` aborts them (the visitor left). */
  forAnswer(address: string, signal: AbortSignal): ToolsRun;
}

export function createTools(o: ToolsOptions): Tools {
  const now = o.now ?? Date.now;
  const log = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const fetchImpl: Fetch = o.fetch ?? ((...a) => fetch(...a));
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const limits = createRateLimits(o.windows, 'tool', o.perAddress, {});
  /** 60 s per (tool, parameters), least recently used out past 200 (§21.2.4): the checked rows, and when they were read. */
  const cache = new Map<string, { at: number; rows: readonly ToolRow[] }>();
  const shapes = o.tools.map(({ name, params, fields, label, about }): ChatToolShape => ({ name, params, fields, label, about }));

  async function rowsFor(tool: ChatTool, req: ToolRequest, address: string, signal: AbortSignal): Promise<{ at: number; rows: readonly ToolRow[] } | null> {
    const key = toolCacheKey(req);
    const hit = cache.get(key);
    if (hit && now() - hit.at < TOOL_RESULT.cacheMs) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    // Only a call costs the operator: a cached reply is not counted against the address.
    if (!(await limits.take(address, null))) {
      log(`chat: tool ${tool.name} limited 0ms 0 rows`);
      return null;
    }
    const started = now();
    const r = await callTool(tool, req.args, signal, fetchImpl);
    // The tool, the outcome, the time, the count — never a parameter, a value or the key.
    log(`chat: tool ${tool.name} ${r.ok ? 'ok' : r.why} ${now() - started}ms ${r.ok ? r.rows.length : 0} rows`);
    if (!r.ok) return null;
    const entry = { at: now(), rows: r.rows };
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > TOOL_RESULT.cacheEntries) cache.delete(cache.keys().next().value as string);
    return entry;
  }

  return {
    shapes,
    forAnswer(address, signal) {
      return async (req, cap): Promise<ToolAnswer | 'unavailable'> => {
        const tool = byName.get(req.tool);
        // The parser names only declared tools; one that is not is never called.
        if (!tool) return 'unavailable';
        const got = await rowsFor(tool, req, address, signal);
        if (!got) return 'unavailable';
        const result = aggregateTool(got.rows, req.shape, tool.fields, cap);
        return result === null ? 'unavailable' : { result, source: tool.label, at: toolMinute(got.at) };
      };
    },
  };
}

/** One tool as az backend probe called it: the outcome (`ok`, `no_sample`, or why not), the time, the rows. */
export interface ToolProbe { readonly tool: string; readonly outcome: string; readonly ms: number; readonly rows: number }

/**
 * az backend probe (§21.2.7): each tool called once with its
 * AZ_CHAT_TOOL_<NAME>_SAMPLE — or with no parameters when it requires none —
 * one after another, each under its own timeout. Outcomes only.
 */
export async function probeTools(tools: readonly ChatTool[], o: { readonly fetch?: Fetch; readonly now?: () => number } = {}): Promise<ToolProbe[]> {
  const now = o.now ?? Date.now;
  const out: ToolProbe[] = [];
  for (const t of tools) {
    const args = t.sample ?? (Object.values(t.params).some((p) => p.required) ? null : {});
    if (args === null) { out.push({ tool: t.name, outcome: 'no_sample', ms: 0, rows: 0 }); continue; }
    const started = now();
    const r = await callTool(t, args, new AbortController().signal, o.fetch);
    out.push({ tool: t.name, outcome: r.ok ? 'ok' : r.why, ms: now() - started, rows: r.ok ? r.rows.length : 0 });
  }
  return out;
}
