/**
 * The token benchmark (docs/token-benchmark.md): every representation of a
 * site comes from the one Spec its source compiles to, and the benchmark
 * runs end to end on a small corpus. The numbers are not pinned — only that
 * the .az source is the smallest representation of the sites tested here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPRESENTATIONS, ROOT, WORDS, componentTree, corpus, loadCounters, measure, pagesOf, prerendered, representations, summarise,
} from './token-bench.mjs';

const CLI = join(ROOT, 'packages/cli/bin/az.js');
const SCRIPT = join(ROOT, 'scripts/token-benchmark.mjs');
/** A whole-corpus run takes a few seconds; two sites far less. */
const RUN_MS = 60_000;

const site = (name) => {
  const s = corpus().find((x) => x.name === name);
  assert.ok(s, `${name} is in the corpus`);
  return s;
};

/** Every block of a Spec, depth first: site-level ones, then each page's. */
function specBlocks(spec) {
  const out = [];
  const walk = (b) => { out.push(b); b.children.forEach(walk); };
  spec.site.inherited.forEach(walk);
  for (const p of spec.pages) p.blocks.forEach(walk);
  return out;
}

/** Every node of a component tree, depth first, that is a block (not Site or Page). */
function treeBlocks(tree) {
  const out = [];
  const walk = (n) => { if (n.type !== 'Site' && n.type !== 'Page') out.push(n); (n.children ?? []).forEach(walk); };
  walk(tree);
  return out;
}

test('corpus: every word preview, both fixtures, the combined and data sites, and the added sites', () => {
  const names = corpus().map((s) => s.name);
  for (const n of ['minimal', 'grammar-fixture', 'combined', 'data-e2e', 'ledger', 'harbour']) assert.ok(names.includes(n), n);
  const previews = readdirSync(WORDS, { withFileTypes: true }).filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(WORDS, d.name)).filter((f) => /^preview(\.[a-z0-9-]+)?\.az$/.test(f)));
  assert.equal(corpus().filter((s) => s.group === 'preview').length, previews.length);
  assert.equal(new Set(names).size, names.length, 'names are unique');
});

for (const name of ['minimal', 'ledger']) {
  test(`${name}: every representation comes from the Spec \`az spec\` prints`, () => {
    const s = site(name);
    const r = representations(s);

    // specPretty is byte for byte what `az spec` prints for the same source.
    const dir = mkdtempSync(join(tmpdir(), 'az-token-bench-test-'));
    try {
      writeFileSync(join(dir, 'site.az'), s.source);
      const printed = execFileSync(process.execPath, [CLI, 'spec', join(dir, 'site.az')], {
        env: { ...process.env, AZ_WORDS: WORDS }, encoding: 'utf8', timeout: RUN_MS, stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(r.text.specPretty, printed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(JSON.parse(r.text.specMin), r.spec);
    assert.ok(!r.text.specMin.includes('\n'));

    // The tree holds the Spec's blocks in the Spec's order, with every positional value.
    const blocks = specBlocks(r.spec);
    const nodes = treeBlocks(JSON.parse(r.text.tree));
    assert.deepEqual(nodes.map((n) => n.type), blocks.map((b) => b.word));
    blocks.forEach((b, i) => assert.deepEqual(nodes[i].props?.args ?? [], b.args.map((a) => a.value), `${b.word} #${i} args`));
    const pages = JSON.parse(r.text.tree).children.filter((n) => n.type === 'Page');
    assert.deepEqual(pages.map((p) => p.props.route), r.spec.pages.map((p) => p.route));

    // The markup and App.tsx are the same pages, and carry what the Spec says.
    assert.deepEqual(pagesOf(r.text.appTsx).map((p) => p.route), r.spec.pages.map((p) => p.route));
    assert.deepEqual([...r.text.html.matchAll(/class="az-page" data-route="([^"]*)"/g)].map((m) => m[1]), r.spec.pages.map((p) => p.route));
    for (const b of blocks.filter((x) => typeof x.props.title === 'string')) {
      assert.ok(r.text.html.includes(prerendered(b.props.title)), `html holds the ${b.word} title "${b.props.title}"`);
    }
  });
}

test('componentTree: a value equal to its declared default is left out, any other kept', () => {
  const manifests = new Map([['hero', { variants: ['center', 'split'], props: { height: { type: 'enum', default: 'peek' }, title: { type: 'string' } } }]]);
  const block = (variant, props) => ({ word: 'hero', variant, modifiers: ['3d'], args: [], props, as: null, children: [] });
  const spec = {
    version: '1',
    site: { name: 'x', width: 'default', theme: 'midnight', accent: null, pattern: 'none', patternOrigin: 'top', fonts: {}, inherited: [], scoped: {} },
    pages: [{ route: '/', blocks: [block('center', { height: 'peek', title: 'A' }), block('split', { height: 'full', title: 'B' })] }],
  };
  assert.deepEqual(componentTree(spec, manifests), {
    type: 'Site',
    props: { name: 'x' },
    children: [{
      type: 'Page', props: { route: '/' },
      children: [
        { type: 'hero', props: { '3d': true, title: 'A' } },
        { type: 'hero', props: { variant: 'split', '3d': true, height: 'full', title: 'B' } },
      ],
    }],
  });
});

test('prerendered: the server renderer\'s spelling of booleans, void and raw-text elements, and adjacent text', () => {
  assert.equal(prerendered({ tag: 'input', attrs: { type: 'radio', checked: 'checked', autocomplete: 'off' } }), '<input type="radio" checked="" autoComplete="off"/>');
  assert.equal(prerendered({ tag: 'p', attrs: { hidden: '' }, children: ['a', 'b'] }), '<p>a<!-- -->b</p>');
  assert.equal(prerendered({ tag: 'script', attrs: { type: 'application/ld+json' }, children: ['{"a":"<b>"}'] }), '<script type="application/ld+json">{"a":"<b>"}</script>');
  assert.equal(prerendered({ tag: 'h1', children: ['Tom\'s "best" <shoes> & co'] }), '<h1>Tom&#x27;s &quot;best&quot; &lt;shoes&gt; &amp; co</h1>');
});

test('measure and summarise: a small corpus, every representation counted, .az the smallest', async () => {
  const { counters, provider } = await loadCounters();
  assert.match(provider, /@\d+\.\d+\.\d+$/);
  const results = ['minimal', 'faq', 'ledger'].map((n) => measure(site(n), counters));
  for (const r of results) {
    for (const rep of REPRESENTATIONS) {
      for (const n of Object.values(r.reps[rep].tokens)) assert.ok(n > 0, `${r.name} ${rep} has tokens`);
      assert.ok(r.reps[rep].chars > 0);
    }
  }
  assert.deepEqual(measure(site('minimal'), counters), results[0], 'two runs measure the same');
  const s = summarise(results);
  assert.deepEqual(s.azNotSmallest, [], '.az is the smallest representation of these sites');
  for (const rep of REPRESENTATIONS.filter((x) => x !== 'az')) assert.ok(s.ratios[rep].worst.ratio <= s.ratios[rep].median);
});

test('pnpm bench:tokens runs on named sites and writes the same JSON twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'az-token-bench-test-'));
  try {
    const run = (out) => execFileSync(process.execPath, [SCRIPT, 'minimal', 'faq', '--json', out], { encoding: 'utf8', timeout: RUN_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    const printed = run(join(dir, 'a.json'));
    run(join(dir, 'b.json'));
    assert.match(printed, /minimal/);
    const a = readFileSync(join(dir, 'a.json'), 'utf8');
    assert.equal(a, readFileSync(join(dir, 'b.json'), 'utf8'));
    assert.deepEqual(JSON.parse(a).sites.map((x) => x.name), ['minimal', 'faq']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
