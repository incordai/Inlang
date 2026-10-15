/**
 * az_prompt over the real stdio protocol: the same JSON as `az prompt --json`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const REPLY_TIMEOUT_MS = 30_000;

const INIT = { jsonrpc: '2.0', id: 0, method: 'initialize',
  params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } };

async function tool(root: string, args: object) {
  const child = spawn(process.execPath, [...process.execArgv, BIN, 'mcp', '--root', root], { stdio: 'pipe' });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c: string) => { out += c; });
  child.stdin.write(JSON.stringify(INIT) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'az_prompt', arguments: args } }) + '\n');
  child.stdin.end();
  await new Promise<void>((done, fail) => {
    const t = setTimeout(() => { child.kill(); fail(new Error(`no exit; got:\n${out}`)); }, REPLY_TIMEOUT_MS);
    child.on('exit', () => { clearTimeout(t); done(); });
  });
  const reply = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply?.result, out);
  return reply.result as { isError: boolean; structuredContent?: any; content: { text: string }[] };
}

const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [...process.execArgv, BIN, 'prompt', '--json', ...args], { encoding: 'utf8', timeout: REPLY_TIMEOUT_MS });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('az_prompt returns the prompt — the same JSON az prompt --json prints — and writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'az-mcp-prompt-'));
  const r = await tool(root, {});
  assert.equal(r.isError, false);
  assert.deepEqual(r.structuredContent, cli());
  assert.match(r.structuredContent.prompt, /^# Writing \.az files\n/);
  assert.deepEqual(readdirSync(root), [], 'nothing written in the project');
});

test('az_prompt takes words, compact and budget as az prompt does', async () => {
  const root = mkdtempSync(join(tmpdir(), 'az-mcp-prompt-'));
  assert.deepEqual((await tool(root, { words: 'hero,cta', compact: 'true' })).structuredContent, cli('--words', 'hero,cta', '--compact'));
  assert.deepEqual((await tool(root, { budget: '5000' })).structuredContent, cli('--budget', '5000'));
});

for (const [args, why] of [
  [{ words: 'heros' }, /'heros' is not a word .*did you mean 'hero'/],
  [{ budget: 'lots' }, /budget 'lots' is not a whole number/],
  [{ budget: '10' }, /the smallest prompt is \d+ tokens/],
  [{ compact: 'yes' }, /compact is "true" or "false"/],
] as const) {
  test(`CONTROL: az_prompt ${JSON.stringify(args)} is a tool error naming the fix`, async () => {
    const r = await tool(mkdtempSync(join(tmpdir(), 'az-mcp-prompt-')), args);
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, why);
  });
}
