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
 * Exits non-zero when a site does not compile, or a named site is not in the corpus.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHARS_PER_TOKEN, ENCODINGS, PRIMARY_ENCODING, REPRESENTATIONS, corpus, loadCounters, measure, summarise,
} from './lib/token-bench.mjs';

const DEFAULT_JSON = join(tmpdir(), 'az-token-benchmark.json');

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

async function main(argv) {
  const args = [...argv];
  let jsonOut = DEFAULT_JSON;
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
  writeFileSync(jsonOut, `${JSON.stringify({
    tokenizer: provider, encodings: ENCODINGS, primary: PRIMARY_ENCODING, charsPerTokenApproximation: CHARS_PER_TOKEN,
    representations: REPRESENTATIONS, summaries, sites: results,
  }, null, 2)}\n`);
  console.log(`\nwrote ${jsonOut}`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
