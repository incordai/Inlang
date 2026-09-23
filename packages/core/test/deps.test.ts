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
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s*['"]([^'"]+)['"]/g)) {
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

const PACKAGES = ['core', 'target-web', 'cli', 'overlay', 'auth-runtime', 'scene-runtime', 'backend', 'mcp'];

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

test('the backend server imports only its siblings and node built-ins — it is copied whole into server/src', () => {
  const server = sources('packages/backend').filter((f) => f.includes(`${sep}server${sep}`));
  assert.ok(server.length > 5, 'CONTROL: the server sources are found');
  for (const file of server) {
    for (const spec of importsOf(file)) {
      assert.ok(spec.startsWith('./') || spec.startsWith('node:'), `backend server imports '${spec}' — only siblings and node:*`);
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
  for (const pkg of ['core', 'target-web', 'overlay', 'auth-runtime', 'scene-runtime', 'backend']) {
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
