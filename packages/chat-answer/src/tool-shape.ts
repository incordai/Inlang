/**
 * @az module tool-shape
 * Purpose: what the answer checker knows of an operator's data tool — its parameters' types and bounds, its fields — and the one check of a parameter's value.
 * Spec: docs/chat-block-spec.md §21.2.2, §21.2.3
 * Exports: ToolParamType, ToolFieldType, ToolParam, ChatToolShape, isDay, paramValueOk
 * Edit guide: pure, no imports; never a tool's URL or key — those stay with whoever calls the tool.
 * Tests: packages/chat-answer/test/checker.test.ts, packages/backend/test/chat-tools.test.ts
 */

/**
 * A tool (`from tool <name> …`, chat-block-spec §21.2) as the answer checker
 * sees it: a name, typed parameters, the fields its rows hold, the label its
 * figures carry. The model only names a declared tool and writes typed
 * values; this file holds the rule those values are checked by, which the
 * server also applies to an operator's sample and to every call's body, so
 * there is one rule.
 *
 * Moved here from the server's env.ts, which declares tools from `.env` and
 * imports these types and checks.
 */

export type ToolParamType = 'int' | 'number' | 'bool' | 'date' | 'enum' | 'text';
export type ToolFieldType = 'text' | 'number' | 'date' | 'bool';

/** One declared parameter: bounds for int, number and date; values for enum; a length for text. */
export interface ToolParam {
  readonly type: ToolParamType;
  readonly min: number | string | null;
  readonly max: number | string | null;
  readonly values: readonly string[] | null;
  readonly maxLength: number;
  readonly required: boolean;
}

/** What the answer parser and the model know of a tool: never its URL or key. */
export interface ChatToolShape {
  readonly name: string;
  readonly params: Readonly<Record<string, ToolParam>>;
  readonly fields: Readonly<Record<string, ToolFieldType>>;
  readonly label: string;
  readonly about: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar day written `YYYY-MM-DD`. */
export function isDay(v: unknown): v is string {
  if (typeof v !== 'string' || !DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Whether `v`, a JSON value, is a value `p` takes — the one check for a sample and for every call's body. */
export function paramValueOk(p: ToolParam, v: unknown): boolean {
  switch (p.type) {
    case 'int':
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > 1e15) return false;
      if (p.type === 'int' && !Number.isInteger(v)) return false;
      return (p.min === null || v >= (p.min as number)) && (p.max === null || v <= (p.max as number));
    case 'bool': return typeof v === 'boolean';
    case 'date': return isDay(v) && (p.min === null || v >= (p.min as string)) && (p.max === null || v <= (p.max as string));
    case 'enum': return typeof v === 'string' && (p.values ?? []).includes(v);
    case 'text': return typeof v === 'string' && v.trim() !== '' && [...v].length <= p.maxLength;
  }
}
