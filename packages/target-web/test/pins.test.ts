/**
 * The emitted project's dependency pins match the verified table.
 *
 * stack-evaluation.md checked each version against the registry and recorded
 * it as VERIFIED. If the compiler emits a different number, one of the two is
 * wrong and nobody finds out until an install fails — or worse, succeeds with
 * something untested. This makes the document and the code the same fact.
 *
 * GLOBAL RULE 11 — never guess a version — as a test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile, formatDiagnostics, type Manifest } from '../../core/src/index.ts';
import { emitProject, PINS } from '../src/emit.ts';
import { WEB_EMITTERS } from '../../words/registry.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const doc = readFileSync(join(ROOT, 'docs/stack-evaluation.md'), 'utf8');

/**
 * Find a package's row in the tables and return its version if VERIFIED.
 *
 * Parsed by splitting on the table's own pipes rather than by building a
 * regex per package name: those names contain `/`, `@` and `-`, all of which
 * need escaping in a pattern, and getting that wrong fails as a lexer error
 * rather than as a wrong answer.
 */
function verifiedVersion(pkg: string): string | null {
  for (const raw of doc.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] is the empty string before the leading pipe.
    if (cells[1] !== '`' + pkg + '`') continue;
    // A package can appear in several tables (a decision record, the
    // verified list); only its VERIFIED row is a pin.
    if (!cells.slice(2).some((c) => c.includes('VERIFIED'))) continue;
    const version = cells[2];
    return version.startsWith('`') && version.endsWith('`')
      ? version.slice(1, -1)
      : null;
  }
  return null;
}

test('CONTROL: the table is readable and marks versions VERIFIED', () => {
  // If the table format changed, every lookup below would return null and the
  // comparisons would silently pass against nothing.
  assert.equal(verifiedVersion('react'), '19.2.8', 'react row not found or not VERIFIED');
  assert.equal(verifiedVersion('vite'), '8.2.2', 'vite row not found or not VERIFIED');
  assert.equal(verifiedVersion('nosuchpackage'), null, 'a missing package must read as null');
});

test('every emitted pin matches its VERIFIED row', () => {
  assert.equal(PINS.react, verifiedVersion('react'));
  assert.equal(PINS.vite, verifiedVersion('vite'));
  assert.equal(PINS.three, verifiedVersion('three'));
  assert.equal(PINS.typesReact, verifiedVersion('@types/react'));
  assert.equal(PINS.typesReactDom, verifiedVersion('@types/react-dom'));
  assert.equal(PINS.typesThree, verifiedVersion('@types/three'));
  // A map site's three (chat-block-spec §21.4, stack-evaluation §19).
  assert.equal(PINS.maplibre, verifiedVersion('maplibre-gl'));
  assert.equal(PINS.pmtiles, verifiedVersion('pmtiles'));
  assert.equal(PINS.basemaps, verifiedVersion('@protomaps/basemaps'));
});

test('a map site\'s packages are the versions this repo type-checks and tests the map runtime with', () => {
  // The overlay runtime's map module is type-checked, and the map fixture read, against the repository's own installs.
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { devDependencies?: Record<string, string> };
  assert.equal(PINS.maplibre, rootPkg.devDependencies?.['maplibre-gl']);
  assert.equal(PINS.pmtiles, rootPkg.devDependencies?.pmtiles);
  assert.equal(PINS.basemaps, rootPkg.devDependencies?.['@protomaps/basemaps']);
});

test('the type declarations a generated project pins are the ones this repo type-checks generated code with', () => {
  // generated-types.test.ts checks generated code against the repository's own
  // installed declarations; a generated project that pinned different ones
  // would be checked by its author against something this repo never ran.
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as
    { devDependencies?: Record<string, string> };
  assert.equal(PINS.typesReact, rootPkg.devDependencies?.['@types/react']);
  assert.equal(PINS.typesReactDom, rootPkg.devDependencies?.['@types/react-dom']);
  assert.equal(PINS.typesThree, rootPkg.devDependencies?.['@types/three']);
});

test('the generated package.json carries the type declarations: React\'s always, three\'s only with three', () => {
  const manifests = new Map<string, Manifest>();
  for (const n of readdirSync(join(ROOT, 'packages/words'))) {
    const at = join(ROOT, 'packages/words', n, 'word.json');
    if (!existsSync(at)) continue;
    const m = JSON.parse(readFileSync(at, 'utf8')) as Manifest;
    manifests.set(m.name, m);
  }
  const pkgOf = (source: string) => {
    const r = compile(source, { manifests });
    assert.ok(r.ok && r.spec, formatDiagnostics(r.diagnostics, 'site.az'));
    const file = emitProject(r.spec, { emitters: WEB_EMITTERS }).files.find((f) => f.path === 'package.json');
    assert.ok(file, 'no package.json emitted');
    return JSON.parse(file.content) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
  };
  const flat = pkgOf('az 1\nsite flat\npage /\n  hero split\n    title "Grown"\n');
  assert.deepEqual(flat.devDependencies, {
    '@types/react': PINS.typesReact, '@types/react-dom': PINS.typesReactDom, vite: PINS.vite, typescript: PINS.typescript,
  });
  assert.equal(flat.dependencies.three, undefined, 'CONTROL: this site must not use 3D');
  const depth = pkgOf('az 1\nsite depth\npage /\n  hero split 3d\n    title "Grown"\n    describe "Strands"\n');
  assert.equal(depth.dependencies.three, PINS.three, 'CONTROL: this site must use 3D');
  assert.deepEqual(depth.devDependencies, {
    '@types/react': PINS.typesReact, '@types/react-dom': PINS.typesReactDom, '@types/three': PINS.typesThree,
    vite: PINS.vite, typescript: PINS.typescript,
  });
});

test('typescript is pinned to the version this repo actually uses', () => {
  // stack-evaluation.md has no typescript row, so the repo's own devDependency
  // is the source of truth rather than a number invented here.
  const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as
    { devDependencies?: Record<string, string> };
  assert.equal(PINS.typescript, rootPkg.devDependencies?.typescript);
});

test('pins are EXACT — a range would break determinism', () => {
  for (const [name, version] of Object.entries(PINS)) {
    assert.match(version, /^[0-9]+\.[0-9]+\.[0-9]+$/,
      `${name} is '${version}' — a range lets two builds resolve differently`);
  }
});

test('text-spec §11: the text manifest pins exactly the markdown parser the compiler runs', () => {
  // The file is parsed at build by target-web, so its package.json is what
  // actually runs; the manifest carries the same pins for the gate to see.
  const pkg = JSON.parse(readFileSync(join(ROOT, 'packages/target-web/package.json'), 'utf8')) as
    { dependencies?: Record<string, string> };
  const text = JSON.parse(readFileSync(join(ROOT, 'packages/words/text/word.json'), 'utf8')) as
    { deps?: Record<string, string> };
  assert.deepEqual(text.deps, pkg.dependencies);
  // Each is recorded in stack-evaluation §13 at the same version.
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    assert.ok(doc.includes(`| \`${name}\` | \`${version}\` |`), `${name} ${version} has no stack-evaluation row`);
  }
});
