/**
 * az_palette over the real stdio protocol: the same choices as `az palette --json`.
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
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'az_palette', arguments: args } }) + '\n');
  child.stdin.end();
  await new Promise<void>((done, fail) => {
    const t = setTimeout(() => { child.kill(); fail(new Error(`no exit; got:\n${out}`)); }, REPLY_TIMEOUT_MS);
    child.on('exit', () => { clearTimeout(t); done(); });
  });
  const reply = out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.id === 1);
  assert.ok(reply?.result, out);
  return reply.result as { isError: boolean; structuredContent?: any; content: { text: string }[] };
}

test('az_palette returns every choice with its .az line — the same JSON az palette --json prints — and writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'az-mcp-palette-'));
  const r = await tool(root, {});
  assert.equal(r.isError, false);
  const cli = spawnSync(process.execPath, [...process.execArgv, BIN, 'palette', '--json'], { encoding: 'utf8', timeout: REPLY_TIMEOUT_MS });
  assert.equal(cli.status, 0, cli.stderr);
  assert.deepEqual(r.structuredContent, JSON.parse(cli.stdout));
  assert.ok(r.structuredContent.themes.length >= 6);
  assert.deepEqual(readdirSync(root), [], 'nothing written in the project');
});

test('az_palette filters by theme and hue', async () => {
  const r = await tool(mkdtempSync(join(tmpdir(), 'az-mcp-palette-')), { theme: 'petal', accent: 'teal' });
  assert.equal(r.isError, false);
  const [petal] = r.structuredContent.themes;
  assert.equal(petal.name, 'petal');
  assert.deepEqual(petal.accents, [{ name: 'teal', az: 'accent teal' }]);
  assert.ok(petal.pairs.every((p: { hues: string[] }) => p.hues[0] === 'teal'));
});

test('CONTROL: an unknown theme is a tool error naming the choices', async () => {
  const r = await tool(mkdtempSync(join(tmpdir(), 'az-mcp-palette-')), { theme: 'neon' });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /theme 'neon' is not one of midnight/);
});
