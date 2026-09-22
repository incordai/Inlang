/**
 * A8b probe, engine axis: does the seeded generator produce the same vertex
 * buffer in every browser engine?
 *
 * determinism.ts covers builds and runs inside one V8. The generator calls
 * Math.sin / Math.cos, and three's TubeGeometry derives normals and frames
 * from more of the same. IEEE-754 specifies + - * / and sqrt exactly, but
 * NOT the transcendental functions: each engine ships its own libm, and a
 * last-bit difference in one sin() changes the hash. This is the specific
 * way ASSUMPTIONS.md A8b could still be false, and only real engines can say.
 *
 * The generator is bundled once and the same bytes run in Node, Chromium,
 * Firefox and WebKit, so any difference is the engine's, not the build's.
 *
 * Run: pnpm test:engines   (needs: pnpm exec playwright install)
 */

import { build } from 'vite';
import { chromium, firefox, webkit, type BrowserType } from 'playwright';
import { fileURLToPath } from 'node:url';
import { buildStrands, disposeStrands } from '../src/geometry.ts';

const SEED = 0x415a;
const CONTROL_SEED = 0x415b;
const ENTRY = fileURLToPath(new URL('../src/geometry.ts', import.meta.url));
const GLOBAL = 'azGeometry';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
};

/** Bundle geometry.ts (with three) into one IIFE exposing window.azGeometry. */
async function bundle(): Promise<string> {
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      target: 'es2022',
      lib: { entry: ENTRY, name: GLOBAL, formats: ['iife'], fileName: () => 'geometry.js' },
    },
  });
  const outputs = Array.isArray(out) ? out : [out];
  for (const o of outputs) {
    if ('output' in o) {
      const chunk = o.output.find((f) => f.type === 'chunk');
      if (chunk && chunk.type === 'chunk') return chunk.code;
    }
  }
  throw new Error('cross-engine: vite produced no chunk for geometry.ts');
}

interface Sample { hash: string; control: string; vertexCount: number }

async function sampleIn(engine: BrowserType, code: string): Promise<Sample> {
  const browser = await engine.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><title>a8b</title>');
    await page.addScriptTag({ content: code });
    return await page.evaluate(([seed, control, name]) => {
      const g = (window as unknown as Record<string, {
        buildStrands: (p: { seed: number }) => { hash: string; vertexCount: number };
      }>)[name];
      const a = g.buildStrands({ seed });
      const b = g.buildStrands({ seed: control });
      return { hash: a.hash, control: b.hash, vertexCount: a.vertexCount };
    }, [SEED, CONTROL_SEED, GLOBAL] as const);
  } finally {
    await browser.close();
  }
}

console.log('\nA8b — seeded generator across engines\n');

const reference = buildStrands({ seed: SEED });
const referenceControl = buildStrands({ seed: CONTROL_SEED });
console.log(`  node (V8, in-process): ${reference.hash}, ${reference.vertexCount} vertices\n`);

const code = await bundle();
const engines: [string, BrowserType][] = [
  ['chromium (V8)', chromium],
  ['firefox (SpiderMonkey)', firefox],
  ['webkit (JavaScriptCore)', webkit],
];

for (const [label, engine] of engines) {
  const s = await sampleIn(engine, code);
  check(`${label}: vertex hash matches node`, s.hash === reference.hash, s.hash);
  check(`${label}: vertex count matches node`, s.vertexCount === reference.vertexCount,
        `${s.vertexCount} vertices`);
  // CONTROL: the bundled generator must respond to its seed inside the
  // engine, or a match above could come from a constant.
  check(`${label}: CONTROL a different seed changes the hash`,
        s.control !== s.hash && s.control === referenceControl.hash, s.control);
}

disposeStrands(reference);
disposeStrands(referenceControl);

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exitCode = failures === 0 ? 0 : 1;
