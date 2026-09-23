/**
 * az_explain and the descriptions in az_words, over the real stdio protocol.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const REPLY_TIMEOUT_MS = 20_000;

const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

async function tool(name: string, args: object) {
  const root = mkdtempSync(join(tmpdir(), 'az-explain-'));
  const child = spawn(process.execPath, [...process.execArgv, BIN, 'mcp', '--root', root], { stdio: 'pipe' });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => { out += c; });
  child.stdin.write(JSON.stringify(INIT) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  child.stdin.end();
  await new Promise<void>((done, fail) => {
    const t = setTimeout(() => { child.kill(); fail(new Error(`no exit; got:\n${out}`)); }, REPLY_TIMEOUT_MS);
    child.on('exit', () => { clearTimeout(t); done(); });
  });
  const reply = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply?.result, out);
  return reply.result as { isError: boolean; structuredContent?: any };
}

test('az_explain returns one line per term, in context', async () => {
  const r = await tool('az_explain', { terms: 'hero center height peek' });
  assert.equal(r.isError, false);
  const lines = r.structuredContent.lines as { term: string; kind: string; of: string; text: string }[];
  assert.deepEqual(lines.map((l) => `${l.kind}:${l.term}`), ['word:hero', 'variant:center', 'prop:height', 'value:peek']);
  for (const l of lines) assert.ok(l.text.length > 0 && l.text.length <= 60, l.text);
  assert.deepEqual(r.structuredContent.unknown, []);
});

test('az_explain names an unknown term and suggests the likely one', async () => {
  const r = await tool('az_explain', { terms: 'hero centre' });
  assert.deepEqual(r.structuredContent.unknown, [{ term: 'centre', suggestion: 'center' }]);
});

test('CONTROL: an empty term list is a tool error, not a crash', async () => {
  const r = await tool('az_explain', { terms: '  ' });
  assert.equal(r.isError, true);
});

test('az_words carries every word\'s ≤60-character descriptions', async () => {
  const r = await tool('az_words', {});
  const hero = (r.structuredContent.words as any[]).find((w) => w.name === 'hero');
  assert.ok(hero.description.length > 0 && hero.description.length <= 60);
  assert.equal(Object.keys(hero.descriptions.variants).length, hero.variants.length);
  assert.ok(hero.props.title.description);
});
