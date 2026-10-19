/**
 * Dependency rules — ARCHITECTURE §2, "enforced, not advisory".
 *
 * These are the rules the whole design rests on. `core` knowing nothing is
 * what makes a second target possible and what makes a word a folder; if that
 * erodes, both die quietly and nothing else in the suite would notice.
 *
 * This lives in the test suite rather than only in CI config, because
 * VERIFICATION §1 is explicit: a check that exists only in CI will drift.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname — on Windows the latter yields '/D:/...'
// with a leading slash, and the repo root is three levels up from this file,
// not two. Both errors were caught by the CONTROL that asserts each package
// actually has sources, before any rule could pass on an empty list.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Every .ts/.tsx file under a package's src. */
function sources(pkg: string): string[] {
  const dir = join(ROOT, pkg, 'src');
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: string[];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const full = join(d, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** Import specifiers in a file, from both `import` and `export ... from`. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specs: string[] = [];
  // An import's names may span lines (`import {\n  a,\n} from './x.ts'`): the clause runs to `from` across newlines, never past a quote or a `;`.
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]/g)) {
    specs.push(m[1]);
  }
  for (const m of text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
}

/** Which package a relative specifier reaches into, if any. */
function crossPackage(spec: string): string | null {
  const m = spec.match(/(?:\.\.\/)+([a-z-]+)\//);
  return m ? m[1] : null;
}

const PACKAGES = ['core', 'target-web', 'cli', 'overlay', 'auth-runtime', 'scene-runtime', 'backend', 'mcp', 'chat-answer'];

/**
 * The chat packages (ARCHITECTURE §2, chat-block-spec §22) are imported by an
 * alias, `#<package>/<file>.ts`, which each importer's package.json maps: to
 * the workspace package here, to the copied folder in a generated server or
 * site. Which package may import which alias; every other `#` import fails.
 */
const ALIASES: Readonly<Record<string, readonly string[]>> = {
  backend: ['chat-answer'],
};

/** What is wrong with `pkg`'s alias imports (`#name/…`), as messages: an alias it may not use, or one its package.json does not map to that package. */
function aliasProblems(pkg: string, specs: readonly string[], manifest: { imports?: Record<string, string>; dependencies?: Record<string, string> }): string[] {
  const out: string[] = [];
  for (const spec of specs.filter((s) => s.startsWith('#'))) {
    const m = /^#([a-z-]+)\/[a-z0-9-]+\.ts$/.exec(spec);
    const name = m?.[1];
    if (!name || !(ALIASES[pkg] ?? []).includes(name)) { out.push(`${pkg} imports '${spec}' — not an alias it may use`); continue; }
    if (manifest.imports?.[`#${name}/*`] !== `@az/${name}/*` || manifest.dependencies?.[`@az/${name}`] !== 'workspace:*') {
      out.push(`${pkg}'s package.json does not map '#${name}/*' to the workspace package @az/${name}`);
    }
  }
  return out;
}

const manifestOf = (pkg: string) => JSON.parse(readFileSync(join(ROOT, 'packages', pkg, 'package.json'), 'utf8')) as { imports?: Record<string, string>; dependencies?: Record<string, string> };

test('every alias import is one its package may use, mapped to that workspace package — ARCHITECTURE §2', () => {
  for (const pkg of PACKAGES) {
    const specs = sources(`packages/${pkg}`).flatMap(importsOf);
    assert.deepEqual(aliasProblems(pkg, specs, manifestOf(pkg)), []);
  }
  for (const [pkg, names] of Object.entries(ALIASES)) {
    for (const name of names) assert.ok(existsSync(join(ROOT, 'packages', name, 'src')), `CONTROL: the aliased package ${name} exists`);
    assert.ok(sources(`packages/${pkg}`).flatMap(importsOf).some((s) => s.startsWith('#')), `CONTROL: ${pkg} really imports by alias`);
  }
});

test('CONTROL: the alias rule refuses an alias a package may not use and one its manifest does not map', () => {
  const ok = { imports: { '#chat-answer/*': '@az/chat-answer/*' }, dependencies: { '@az/chat-answer': 'workspace:*' } };
  assert.deepEqual(aliasProblems('backend', ['#chat-answer/checker.ts'], ok), []);
  assert.equal(aliasProblems('core', ['#chat-answer/checker.ts'], ok).length, 1, 'core may use no alias');
  assert.equal(aliasProblems('backend', ['#chat-answer/checker.ts'], {}).length, 1, 'an unmapped alias');
  assert.equal(aliasProblems('backend', ['#chat-answer/../core/src/x.ts'], ok).length, 1, 'an alias path that leaves the package');
});

test('the answer checker imports only its siblings — no node:*, no other package: it runs in a browser and an app webview (chat-block-spec §22)', () => {
  const files = sources('packages/chat-answer');
  assert.ok(files.length >= 6, 'CONTROL: the checker sources are found');
  assert.ok(importsOf(join(ROOT, 'packages/chat-answer/src/checker.ts')).includes('./chat-answer.ts'), 'CONTROL: its imports are read');
  for (const file of files) {
    for (const spec of importsOf(file)) {
      assert.ok(/^\.\/[a-z0-9-]+\.ts$/.test(spec), `chat-answer/${file.split(/[\\/]/).pop()} imports '${spec}' — only its own siblings`);
    }
  }
});

test('every package has sources to check — CONTROL', () => {
  // Without this, an empty glob would make every rule below pass vacuously.
  for (const p of PACKAGES) {
    assert.ok(sources(`packages/${p}`).length > 0, `no sources found for ${p}`);
  }
});

test('core imports NOTHING from another package — ARCHITECTURE §2', () => {
  for (const file of sources('packages/core')) {
    for (const spec of importsOf(file)) {
      const pkg = crossPackage(spec);
      assert.equal(pkg, null,
        `core/${file.split(/[\\/]/).pop()} imports from '${pkg}' (${spec})`);
    }
  }
});

test('core imports nothing network-capable or filesystem — §2, §1a', () => {
  // core runs in a browser (§1a), where neither exists.
  const banned = ['node:http', 'node:https', 'node:net', 'node:fs', 'node:path', 'undici'];
  for (const file of sources('packages/core')) {
    for (const spec of importsOf(file)) {
      assert.ok(!banned.includes(spec),
        `core/${file.split(/[\\/]/).pop()} imports ${spec}`);
    }
  }
});

test('CONTROL: the banned-import scan can actually fail', () => {
  // The rule above only means something if the detector fires on a real hit.
  const cliFiles = sources('packages/cli');
  const anyFsImport = cliFiles.some((f) => importsOf(f).includes('node:fs'));
  assert.ok(anyFsImport,
    'cli should import node:fs — if it does not, the scan is not reading imports');
});

test('a target imports only core — never a word, never the cli', () => {
  for (const file of sources('packages/target-web')) {
    for (const spec of importsOf(file)) {
      const pkg = crossPackage(spec);
      if (pkg === null) continue;
      assert.ok(['core', 'theme', 'overlay'].includes(pkg),
        `target-web imports '${pkg}' — targets may use core, theme and overlay only`);
    }
  }
});

test('overlay imports only theme — ARCHITECTURE §2', () => {
  for (const file of sources('packages/overlay')) {
    for (const spec of importsOf(file)) {
      const pkg = crossPackage(spec);
      assert.ok(pkg === null || pkg === 'theme', `overlay imports '${pkg}' (${spec}) — overlay → theme only`);
    }
  }
});

test('auth-runtime imports nothing outside itself — it is copied whole into a site (M4)', () => {
  for (const file of sources('packages/auth-runtime')) {
    for (const spec of importsOf(file)) {
      assert.equal(crossPackage(spec), null, `auth-runtime imports '${spec}' — it must stand alone`);
      assert.ok(spec.startsWith('./'), `auth-runtime imports '${spec}' — only its own siblings`);
    }
  }
});

test('scene-runtime imports only itself and three — it is copied whole into a 3D site', () => {
  for (const file of sources('packages/scene-runtime')) {
    if (!file.includes(`${sep}src${sep}`)) continue;
    for (const spec of importsOf(file)) {
      assert.ok(spec.startsWith('./') || spec === 'three' || spec.startsWith('three/examples/jsm/'),
        `scene-runtime imports '${spec}' — only its own siblings and three`);
    }
  }
});

test('CONTROL: the scene-runtime rule reads real imports', () => {
  const stage = sources('packages/scene-runtime').find((f) => f.endsWith('stage.ts'));
  assert.ok(stage && importsOf(stage).includes('three'), 'stage.ts imports three');
});

test('the backend server imports only its siblings, node built-ins and the chat packages copied beside it — it is copied whole into server/src', () => {
  const server = sources('packages/backend').filter((f) => f.includes(`${sep}server${sep}`));
  assert.ok(server.length > 5, 'CONTROL: the server sources are found');
  for (const file of server) {
    for (const spec of importsOf(file)) {
      assert.ok(spec.startsWith('./') || spec.startsWith('node:') || ALIASES.backend.some((a) => spec.startsWith(`#${a}/`)),
        `backend server imports '${spec}' — only siblings, node:* and ${ALIASES.backend.map((a) => `#${a}/`).join(', ')}`);
    }
  }
});

test('the backend package reaches core only for types and data, never a target or a word', () => {
  for (const file of sources('packages/backend')) {
    for (const spec of importsOf(file)) {
      const pkg = crossPackage(spec);
      assert.ok(pkg === null || pkg === 'core', `backend imports from ${pkg} (${spec})`);
    }
  }
});

test('the secret scanner imports nothing — it is copied whole into every site (§4)', () => {
  const file = join(ROOT, 'packages/core/src/secrets.ts');
  assert.deepEqual(importsOf(file), []);
});

test('the output walk imports only node built-ins — it is copied whole into every site beside the scanner (§4)', () => {
  const specs = importsOf(join(ROOT, 'packages/cli/src/shipped.ts'));
  assert.ok(specs.length > 0, 'CONTROL: its imports are read');
  for (const spec of specs) assert.ok(spec.startsWith('node:'), `shipped.ts imports '${spec}' — only node:*`);
});

test('the page policy imports only node:crypto and the page scanner, which imports only its table, which imports nothing — all three are copied whole into every site (§2 B)', () => {
  assert.deepEqual(importsOf(join(ROOT, 'packages/target-web/src/csp.ts')).sort(), ['./html-scan.ts', 'node:crypto']);
  assert.deepEqual(importsOf(join(ROOT, 'packages/target-web/src/html-scan.ts')), ['./named-references.ts']);
  assert.deepEqual(importsOf(join(ROOT, 'packages/target-web/src/named-references.ts')), []);
});

test('mcp imports only its siblings and node built-ins — the CLI injects every operation', () => {
  const files = sources('packages/mcp');
  assert.ok(files.length >= 3, 'CONTROL: the mcp sources are found');
  for (const file of files) {
    for (const spec of importsOf(file)) {
      assert.ok(spec.startsWith('./') || spec.startsWith('node:'), `mcp imports '${spec}' — only siblings and node:*`);
    }
  }
});

test('nothing imports from cli — ARCHITECTURE §2', () => {
  for (const pkg of ['core', 'target-web', 'overlay', 'auth-runtime', 'scene-runtime', 'backend', 'chat-answer']) {
    for (const file of sources(`packages/${pkg}`)) {
      for (const spec of importsOf(file)) {
        assert.ok(crossPackage(spec) !== 'cli', `${pkg} imports from cli (${spec})`);
      }
    }
  }
});

test('no word imports another word — ARCHITECTURE §2', () => {
  const wordsRoot = join(ROOT, 'packages/words');
  let checked = 0;
  for (const word of readdirSync(wordsRoot)) {
    const dir = join(wordsRoot, word);
    if (!statSync(dir).isDirectory()) continue;
    // CONVENTIONS §3: a word IS its manifest. A directory without one is not
    // a word, and treating every subdirectory as one broke the compiler once.
    if (!existsSync(join(dir, 'word.json'))) continue;
    for (const f of readdirSync(dir)) {
      if (!/\.tsx?$/.test(f)) continue;
      checked++;
      for (const spec of importsOf(join(dir, f))) {
        assert.ok(crossPackage(spec) !== 'words', `${word} imports another word (${spec})`);
      }
    }
  }
  // Emitters exist now, so this is real coverage rather than a vacuous pass.
  // Asserting a non-zero count keeps it that way: if emitters were ever moved
  // or renamed, this would fail rather than silently check nothing.
  assert.ok(checked > 0, 'no emitter sources were scanned — the walk found nothing');
});

test('every manifest pins deps exactly — CONVENTIONS §7', () => {
  const wordsRoot = join(ROOT, 'packages/words');
  let seen = 0;
  for (const word of readdirSync(wordsRoot)) {
    const file = join(wordsRoot, word, 'word.json');
    if (!existsSync(file)) continue;
    const m = JSON.parse(readFileSync(file, 'utf8')) as { deps?: Record<string, string> };
    for (const [name, version] of Object.entries(m.deps ?? {})) {
      seen++;
      assert.ok(/^\d+\.\d+\.\d+$/.test(version),
        `${word}: ${name} is pinned '${version}' — exact versions only, no ^ or ~ or latest`);
    }
  }
  assert.ok(seen > 0, 'at least one manifest must declare a dep, or this proves nothing');
});
