/**
 * The chat renderer imports only its own files (chat-block-spec §22.3): it is
 * copied whole into a site's src/az/chat-render/ and bundled into an app. The
 * map's library module is the one file that imports packages — exactly the
 * three a map site pins, the library's worker file by URL and its
 * stylesheet — and is reached only by chat-map-draw.ts's dynamic import, so
 * a page without a map never loads it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAP_LIBRARY_IMPORTS = ['maplibre-gl', 'pmtiles', '@protomaps/basemaps', 'maplibre-gl/dist/maplibre-gl-worker.mjs?url', 'maplibre-gl/dist/maplibre-gl.css'];
const DIR = fileURLToPath(new URL('../src/', import.meta.url));

test('the renderer imports only its siblings; the map library module, only the three pinned packages', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  assert.ok(files.length >= 16, 'CONTROL: the sources are found');
  for (const f of files) {
    const src = readFileSync(join(DIR, f), 'utf8');
    const imports = [...src.matchAll(/(?:from\s+|^import\s+)['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    for (const m of imports) {
      if (f === 'chat-map-gl.ts' && MAP_LIBRARY_IMPORTS.includes(m)) continue;
      assert.match(m, /^\.\/[a-z-]+\.ts$/, `${f} imports '${m}'`);
    }
    // A dynamic import is a sibling too: chat-map-draw.ts's of the library module, the only one.
    for (const m of src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      assert.equal(`${f} → ${m[1]}`, 'chat-map-draw.ts → ./chat-map-gl.ts', 'the one dynamic import');
    }
  }
  const lib = readFileSync(join(DIR, 'chat-map-gl.ts'), 'utf8');
  assert.deepEqual([...lib.matchAll(/(?:from\s+|^import\s+)['"]([^'./][^'"]*)['"]/gm)].map((m) => m[1]).sort(), [...MAP_LIBRARY_IMPORTS].sort(), 'CONTROL: the map module imports exactly these');
});
