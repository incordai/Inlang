/**
 * @az module tools-text
 * Purpose: the operator's tools as the model is told them in a system text — names, typed parameters, fields and example lines — never a URL or a key.
 * Spec: docs/chat-block-spec.md §21.2.2, §8.3, §22.2
 * Exports: toolsText
 * Edit guide: generated from the checked declarations only; what the model may write here is what the answer checker reads (chat-rich.ts).
 * Tests: packages/backend/test/chat-tools.test.ts, packages/chat-instructions/test/instructions.test.ts
 */

/**
 * Moved here from the server's chat-tools.ts, which calls the tools; this
 * file only describes them. Part of the instructions package; imports only
 * the answer checker's tool shape (#chat-answer).
 */

import type { ChatToolShape, ToolParam } from '#chat-answer/tool-shape.ts';

/** A parameter as the model is told it: its type, its bounds or values, whether it is required. */
function paramText(name: string, p: ToolParam): string {
  const parts: string[] = [p.type === 'bool' ? 'yes or no' : p.type === 'date' ? 'a date, YYYY-MM-DD' : p.type === 'text' ? `text in double quotes, at most ${p.maxLength} characters` : p.type === 'int' ? 'a whole number' : p.type];
  if (p.type === 'enum') parts[0] = `one of ${(p.values ?? []).join(', ')}`;
  if (p.min !== null && p.max !== null) parts.push(`${p.min} to ${p.max}`);
  else if (p.min !== null) parts.push(`at least ${p.min}`);
  else if (p.max !== null) parts.push(`at most ${p.max}`);
  if (p.required) parts.push('required');
  return `${name} (${parts.join(', ')})`;
}

/** A value of `p` for an example line: its lower bound, its first value, or a placeholder of its type. */
function exampleValue(p: ToolParam): string {
  switch (p.type) {
    case 'int': case 'number': return String(p.min ?? 1);
    case 'date': return String(p.min ?? '2026-01-01');
    case 'bool': return 'yes';
    case 'enum': {
      const v = (p.values ?? ['a'])[0];
      return /^[A-Za-z0-9._-]+$/.test(v) ? v : JSON.stringify(v);
    }
    case 'text': return '"a value"';
  }
}

/**
 * The tools as the model is told them in the per-request system text
 * (§21.2.2, §8.3): generated from the validated declarations, so the build's
 * chat prompt files stay a function of the .az file. Never a URL, never a key.
 */
export function toolsText(shapes: readonly ChatToolShape[]): string {
  if (shapes.length === 0) return '';
  const lines = shapes.map((t) => {
    const params = Object.entries(t.params);
    return `- ${t.name}${t.about ? ` — ${t.about}` : ''} Parameters: ${params.length > 0 ? params.map(([n, p]) => paramText(n, p)).join(', ') : 'none'}. Each row: ${Object.entries(t.fields).map(([n, f]) => `${n} (${f})`).join(', ')}.`;
  });
  const first = shapes[0];
  const args = Object.entries(first.params).filter(([, p]) => p.required).map(([n, p]) => `${n} ${exampleValue(p)}`);
  const fields = Object.entries(first.fields);
  const num = fields.find(([, f]) => f === 'number')?.[0];
  const group = fields.find(([, f]) => f === 'text' || f === 'date')?.[0];
  const head = ['from tool', first.name, ...args].join(' ');
  const texts = fields.filter(([, f]) => f === 'text').map(([n]) => n);
  const examples = [
    ...(group ? [`chart bar "A title" ${head} ${num ? `sum ${num}` : 'count'} by ${group}`] : []),
    `table "A title" ${head} columns ${fields.slice(0, 3).map(([n]) => n).join(' ')}`,
    `stats\n  stat "A label" ${head} ${num ? `max ${num}` : 'count'}`,
    ...(texts.length > 0 ? [`cards ${head} title ${texts[0]}${texts.length > 1 ? ` text ${texts[1]}` : ''}`] : []),
  ];
  return [
    'The operator\'s tools a chart, table, stat or cards may take live figures "from tool" (the visitor sees them with their source; you never see what they answer, so never state their figures yourself):',
    ...lines,
    'Write the tool\'s name, then each parameter and its value, then what to show: count, or sum, avg, min or max of a number field, optionally "by" a text or date field (a chart needs "by"; a stat takes "by" only a date field, for the latest) — or, in a table, "columns" and up to 6 fields — or, in cards, "title" and a text field, then optionally "text" and a text field and "image" and a text field that holds a site image\'s key. At most 3 tool requests in one answer. For example:',
    ...examples,
  ].join('\n');
}
