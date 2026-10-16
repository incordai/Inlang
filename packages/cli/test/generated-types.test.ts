/**
 * The generated client code type-checks as a whole (chat-block-spec §19.11):
 * every `src/` file `az build` writes — the admin pages, the data client, the
 * chat runtime and its copies, the auth adapter, the pages — under the
 * generated tsconfig.json, strict, with React's own types. Before this only
 * the data client was checked alone, so a type error in a generated `.tsx`
 * (an admin page comparing a table name with something no table is called)
 * reached sites unseen.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../src/az.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const WORDS = join(ROOT, 'packages/words');
const BIN = join(ROOT, 'packages/cli/bin/az.js');
const TSC = join(ROOT, 'node_modules/typescript/bin/tsc');
/** One type-check of a generated project; a hung compiler is killed. */
const TSC_MS = 120_000;

const HEAD = 'az 1\nsite studio\n  auth\n    adapter azbackend\n';
const BACKEND = (model: boolean) => `  backend\n    database sqlite\n    email smtp\n${model ? '    model default\n' : ''}`;
const DATA = `  data products
    name text required search
    blurb longtext
    price money usd required
    status choice draft live default draft
    featured flag
    at datetime
    photo image
    count number
    allow anyone read
    allow signedin create
    allow owner edit delete
`;
const PAGES = (chat: string) => `page /\n  hero center\n    title "Hi"\n${chat}page /login\n  auth login\n    alt "Create an account" /signup\npage /signup\n  auth signup\n    terms /terms\npage /terms\n  hero center\n    title "Terms"\n`;
const CHAT_ALL = '  chat panel\n    allow anyone\n    show chart table stats cards dashboard cta\n';

/** The sites whose generated code is checked: every combination that changes what src/ holds. */
const SITES: readonly { readonly name: string; readonly source: string; readonly data: boolean }[] = [
  { name: 'data, chat with every component, auth', source: `${HEAD}${BACKEND(true)}${DATA}${PAGES(CHAT_ALL)}`, data: true },
  { name: 'data and auth, no chat', source: `${HEAD}${BACKEND(false)}${DATA}${PAGES('')}`, data: true },
  { name: 'a chat float, no data', source: `${HEAD}${BACKEND(true)}  chat float\n    allow anyone\n    show cta\n${PAGES('')}`, data: false },
  { name: 'auth only, no backend', source: `az 1\nsite studio\n  auth\n    adapter session\n${PAGES('')}`, data: false },
];

/** `cmd` in `cwd`, bounded: its exit status and output. */
function run(cmd: string, args: readonly string[], cwd: string): Promise<{ status: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    const timer = setTimeout(() => child.kill('SIGKILL'), TSC_MS);
    child.on('close', (status) => { clearTimeout(timer); done({ status, out }); });
  });
}

/** A project for `source`, built by az as a user's would be; its folder. */
function built(source: string, data: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'az-types-'));
  const file = join(dir, 'site.az');
  writeFileSync(file, source, 'utf8');
  if (data) {
    const schema = spawnSync(process.execPath, [BIN, 'backend', 'schema', file], { encoding: 'utf8', env: { ...process.env, AZ_WORDS: WORDS } });
    assert.equal(schema.status, 0, schema.stderr);
  }
  const out = join(dir, 'out');
  const r = build({ source: file, outDir: out, wordsDir: WORDS, imageCache: null });
  assert.equal(r.ok, true, r.report);
  return out;
}

test('every generated src/ file type-checks under the generated tsconfig, strict, with React\'s types — four kinds of site', async () => {
  const projects = SITES.map((s) => ({ ...s, out: built(s.source, s.data) }));
  const checks = projects.map(async (p) => {
    const config = JSON.parse(readFileSync(join(p.out, 'tsconfig.json'), 'utf8').replace(/^\/\/[^\n]*\n|^\/\*[\s\S]*?\*\/\n?/, '')) as { compilerOptions: Record<string, unknown> };
    // The generated settings are the ones checked: strict, the real file names, the bundler's env types.
    assert.equal(config.compilerOptions.strict, true);
    assert.equal(config.compilerOptions.allowImportingTsExtensions, true);
    assert.deepEqual(config.compilerOptions.types, ['vite/client']);
    // React's types are the repository's devDependencies (@types/react, @types/react-dom, at the pinned React line), from its lockfile.
    const modules = join(p.out, 'node_modules');
    mkdirSync(join(modules, 'vite'), { recursive: true });
    symlinkSync(join(ROOT, 'node_modules/@types'), join(modules, '@types'), 'dir');
    // The bundler is not installed here: its client declarations this code reads — `import.meta.env` and a
    // stylesheet import — stand in for it, stricter than its own (an env value is a string or nothing).
    writeFileSync(join(modules, 'vite/package.json'), JSON.stringify({ name: 'vite', version: '0.0.0-types-only' }));
    writeFileSync(join(modules, 'vite/client.d.ts'), [
      'interface ImportMetaEnv { readonly [key: string]: string | undefined }',
      'interface ImportMeta { readonly env: ImportMetaEnv }',
      "declare module '*.css' {}",
      '',
    ].join('\n'));
    const r = await run(process.execPath, [TSC, '--noEmit', '-p', 'tsconfig.json'], p.out);
    return { name: p.name, ...r };
  });
  for (const r of await Promise.all(checks)) assert.equal(r.status, 0, `${r.name}:\n${r.out}`);
});
