/**
 * `pnpm bench:tokens [--json <file>] [site …]` — how many tokens describe one
 * site in .az, against the same site as Spec JSON, a component tree, the
 * pre-rendered body HTML and the generated App.tsx (docs/token-benchmark.md).
 *
 * Every site of the corpus is compiled and built in-process (`az build` into a
 * temporary directory; not the project's own Vite build, so no install and no
 * network), and each representation counted with every encoding in
 * scripts/lib/token-bench.mjs ENCODINGS and as characters. Prints one row per
 * site, then the median and worst-case ratios. Writes every number as JSON
 * to `--json <file>`, by default to the system temp directory; the output
 * holds no time or path, so two runs write the same bytes.
 *
 * Then the chat-prompt budget (docs/token-benchmark.md §8): what a chat model
 * is sent besides the conversation for the two chat fixtures, against
 * scripts/token-benchmark/chat-prompt-budget.json.
 *
 * Exits non-zero when a site does not compile, a named site is not in the
 * corpus, or a chat fixture's prompt is over its budget.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHARS_PER_TOKEN, ENCODINGS, PRIMARY_ENCODING, REPRESENTATIONS, corpus, loadCounters, measure, summarise,
} from './lib/token-bench.mjs';
import { ANSWER_FORMS, measureAnswers, measureChatInput } from './lib/answer-bench.mjs';
import { BUDGET_PATH, cacheLines, CHAT_PROMPT_TEXTS, measureChatPrompts, measureMatch, measureSelection, overBudget, readBudget, underBudget } from './lib/chat-prompt-bench.mjs';

/** The JSON's name when --json names no file: in a fresh private folder (mkdtemp), never at a name in the shared temp folder another account could guess and link elsewhere. */
const DEFAULT_JSON_NAME = 'az-token-benchmark.json';

/** Column headings, in REPRESENTATIONS order. */
const HEADINGS = { az: '.az', specMin: 'spec min', specPretty: 'spec pretty', tree: 'tree', html: 'html body', htmlShared: 'html shared', appTsx: 'App.tsx' };

function table(results, encoding) {
  const nameWidth = Math.max(4, ...results.map((r) => r.name.length));
  const cols = REPRESENTATIONS.map((rep) => HEADINGS[rep]);
  const width = Math.max(...cols.map((c) => c.length), 14);
  const cell = (s) => String(s).padStart(width);
  const lines = [`${'site'.padEnd(nameWidth)}  ${cols.map(cell).join('  ')}`];
  for (const r of results) {
    const az = r.reps.az.tokens[encoding];
    const cells = REPRESENTATIONS.map((rep) => {
      const t = r.reps[rep].tokens[encoding];
      return cell(rep === 'az' ? `${t}` : `${t} (${(t / az).toFixed(1)}x)`);
    });
    lines.push(`${r.name.padEnd(nameWidth)}  ${cells.join('  ')}`);
  }
  return lines.join('\n');
}

function summaryLines(s) {
  const lines = [`\n${s.encoding} tokens, as a multiple of the .az source's, over ${s.sites} sites:`];
  for (const rep of REPRESENTATIONS.filter((r) => r !== 'az')) {
    const x = s.ratios[rep];
    lines.push(`  ${HEADINGS[rep].padEnd(12)} median ${x.median}x   worst ${x.worst.ratio}x (${x.worst.site})   best ${x.best.ratio}x (${x.best.site})`);
  }
  lines.push('\ncorpus totals (tokens · characters · characters per token):');
  for (const rep of REPRESENTATIONS) {
    const t = s.totals[rep];
    lines.push(`  ${HEADINGS[rep].padEnd(12)} ${String(t.tokens).padStart(8)} · ${String(t.chars).padStart(8)} · ${t.charsPerToken}`);
  }
  lines.push(s.azNotSmallest.length === 0
    ? '\n.az is the smallest representation on every site.'
    : `\n.az is NOT the smallest on: ${s.azNotSmallest.map((x) => `${x.site} (${HEADINGS[x.representation]})`).join(', ')}`);
  return lines.join('\n');
}

/** The answer-format table: tokens per form, each as a multiple of the .az subset's; then what a chat model is sent besides the conversation. */
function answerLines(answers, chatInput, encoding) {
  const nameWidth = Math.max(...answers.map((a) => a.name.length));
  const lines = [`\nchat answers, ${encoding} tokens (.az subset · JSON · markdown · as history, what each later question pays again):`];
  for (const a of answers) {
    const az = a.forms.az.tokens[encoding];
    const cell = (f) => `${a.forms[f].tokens[encoding]} (${(a.forms[f].tokens[encoding] / az).toFixed(2)}x)`;
    const history = a.history ? `${a.history.tokens[encoding]} (${(a.history.tokens[encoding] / az).toFixed(2)}x)` : '—';
    lines.push(`  ${a.name.padEnd(nameWidth)}  ${String(az).padStart(5)}  ${cell('json').padStart(13)}  ${cell('markdown').padStart(13)}  ${history.padStart(13)}`);
  }
  const allowed = answers.filter((a) => a.quotable);
  const total = (f) => allowed.reduce((n, a) => n + a.forms[f].tokens[encoding], 0);
  const chars = (f) => allowed.reduce((n, a) => n + a.forms[f].chars, 0);
  const history = allowed.reduce((n, a) => n + a.history.tokens[encoding], 0);
  lines.push(`  answers an answer may hold, together: .az ${total('az')} · JSON ${total('json')} (${(total('json') / total('az')).toFixed(2)}x) · markdown ${total('markdown')} (${(total('markdown') / total('az')).toFixed(2)}x) · as history ${history} (${(history / total('az')).toFixed(2)}x)`);
  lines.push(`  characters per token: .az ${(chars('az') / total('az')).toFixed(2)} · JSON ${(chars('json') / total('json')).toFixed(2)} · markdown ${(chars('markdown') / total('markdown')).toFixed(2)} (the server estimates 3 when a provider reports none)`);
  lines.push(`\nwhat the chat e2e site's model is sent besides the conversation, ${encoding} tokens:`);
  for (const [name, c] of Object.entries(chatInput)) lines.push(`  ${name.padEnd(8)} ${String(c.tokens[encoding]).padStart(6)} tokens · ${c.chars} characters · ${(c.chars / c.tokens[encoding]).toFixed(2)} per token`);
  return lines.join('\n');
}

/** The large fixture's questions (chat-block-spec §19.17): the average system text with the pages chosen and with the site whole. */
function selectionLines(s, encoding) {
  const cut = 1 - s.average.chosen[encoding] / s.average.whole[encoding];
  return [
    `\nthe large fixture (40 pages), the system text per question, ${encoding} tokens, the average of ${s.questions} questions:`,
    `  the pages each question needs in full, the rest as summaries  ${s.average.chosen[encoding]}`,
    `  every page in full                                           ${s.average.whole[encoding]}  (${Math.round(cut * 100)}% less with the choice)`,
    `  the page that answers sent in full: ${s.questions - s.missed.length} of ${s.questions}${s.missed.length > 0 ? ` — not for: ${s.missed.join(' · ')}` : ''}`,
  ].join('\n');
}

/** The matcher's corpus (chat-block-spec §19.17): the share answered without the model, and whether any wrongly. */
function matchLines(m) {
  return [
    `\nthe topic matcher's corpus (${m.questions} questions): answered without the model ${m.answered} (${Math.round((m.answered / m.questions) * 100)}%), rightly ${m.right}`,
    `  of the ${m.site} the site's own answers can answer: ${m.found}${m.wrong.length > 0 ? ` — WRONG: ${m.wrong.join(' · ')}` : ''}`,
  ].join('\n');
}

/** The chat-prompt table: each fixture's texts in every encoding, then what is over or under the budget. */
function chatPromptLines(measured, over, under) {
  const lines = ['\nchat prompt budget — what a chat model is sent besides the conversation (tokens per encoding · characters):'];
  for (const [fixture, texts] of Object.entries(measured)) {
    for (const name of CHAT_PROMPT_TEXTS) {
      const m = texts[name];
      lines.push(`  ${`${fixture} ${name}`.padEnd(16)} ${Object.entries(m.tokens).map(([e, n]) => `${e} ${String(n).padStart(5)}`).join('  ')}  · ${m.chars} characters`);
    }
  }
  if (over.length > 0) lines.push(`OVER the budget in ${BUDGET_PATH}:`, ...over.map((l) => `  ${l}`));
  else lines.push(`  within the budget in ${BUDGET_PATH}${under.length > 0 ? ` — under it by: ${under.join('; ')}` : ''}`);
  return lines.join('\n');
}

async function main(argv) {
  const args = [...argv];
  let jsonOut = null;
  const j = args.indexOf('--json');
  if (j >= 0) {
    if (!args[j + 1]) { console.error('token-benchmark: --json needs a file'); return 2; }
    jsonOut = args[j + 1];
    args.splice(j, 2);
  }
  const all = corpus();
  const unknown = args.filter((a) => !all.some((s) => s.name === a));
  if (unknown.length > 0) { console.error(`token-benchmark: not in the corpus: ${unknown.join(', ')}`); return 2; }
  const sites = args.length > 0 ? all.filter((s) => args.includes(s.name)) : all;

  const { counters, provider } = await loadCounters();
  const results = [];
  // One image cache for the run, so an image two sites share is resized once; removed after.
  const imageCache = mkdtempSync(join(tmpdir(), 'az-token-bench-images-'));
  try {
    for (const site of sites) results.push(measure(site, counters, { imageCache }));
  } catch (e) {
    console.error(`token-benchmark: ${e.message}`);
    return 1;
  } finally {
    rmSync(imageCache, { recursive: true, force: true });
  }
  const summaries = Object.fromEntries(ENCODINGS.map((e) => [e, summarise(results, e)]));
  console.log(`tokenizer: ${provider}, encoding ${PRIMARY_ENCODING} (${ENCODINGS.slice(1).join(', ')} in the JSON)\n`);
  console.log(table(results, PRIMARY_ENCODING));
  console.log(summaryLines(summaries[PRIMARY_ENCODING]));
  // Chat answers (docs/token-benchmark.md §7): the same answers in the .az subset, JSON and markdown.
  let answers;
  let chatInput;
  let chatPrompts;
  let selection;
  let match;
  let budget;
  try {
    answers = measureAnswers(counters);
    chatInput = measureChatInput(counters);
    chatPrompts = measureChatPrompts(counters);
    selection = measureSelection(counters);
    match = measureMatch();
    budget = readBudget();
  } catch (e) {
    console.error(`token-benchmark: ${e.message}`);
    return 1;
  }
  console.log(answerLines(answers, chatInput, PRIMARY_ENCODING));
  const over = overBudget(chatPrompts, budget);
  console.log(chatPromptLines(chatPrompts, over, underBudget(chatPrompts, budget)));
  console.log(selectionLines(selection, PRIMARY_ENCODING));
  console.log(`\neach fixture's fixed system text against the common prompt-cache minimum, ${PRIMARY_ENCODING}:\n${cacheLines(chatPrompts, PRIMARY_ENCODING).join('\n')}`);
  console.log(matchLines(match));
  jsonOut ??= join(mkdtempSync(join(tmpdir(), 'az-token-benchmark-')), DEFAULT_JSON_NAME);
  writeFileSync(jsonOut, `${JSON.stringify({
    tokenizer: provider, encodings: ENCODINGS, primary: PRIMARY_ENCODING, charsPerTokenApproximation: CHARS_PER_TOKEN,
    representations: REPRESENTATIONS, summaries, sites: results, answerForms: ANSWER_FORMS, answers, chatInput, chatPrompts, selection, match,
  }, null, 2)}\n`);
  console.log(`\nwrote ${jsonOut}`);
  return over.length > 0 ? 1 : 0;
}

process.exitCode = await main(process.argv.slice(2));
