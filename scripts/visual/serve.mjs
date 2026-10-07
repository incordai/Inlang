/**
 * A minimal static file server for the visual gate — node:http only.
 *
 * One server, re-pointed at each site's dist/ in turn, because the emitted
 * pages link assets from the root (`/assets/...`) and so must be served at
 * `/`. Paths are resolved inside the root; anything escaping it is a 404.
 *
 * `{ compress: true }` gzips text responses for a client that accepts it, as
 * a static host does in production — for a check that measures transfer
 * (pnpm test:lighthouse). The default serves the bytes as they are.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.avif': 'image/avif', '.json': 'application/json', '.ico': 'image/x-icon',
};

/** The types a static host compresses: text, not already-compressed media. */
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.json']);

export async function startServer({ compress = false } = {}) {
  let root = null;
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const rel = path.endsWith('/') ? `${path}index.html` : path;
    const file = normalize(join(root ?? '', rel));
    if (!root || !(file === root || file.startsWith(root + sep))) {
      res.writeHead(404).end();
      return;
    }
    try {
      const body = await readFile(file);
      const headers = { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' };
      const gzip = compress && COMPRESSIBLE.has(extname(file)) && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
      if (gzip) Object.assign(headers, { 'content-encoding': 'gzip', vary: 'accept-encoding' });
      res.writeHead(200, headers).end(gzip ? gzipSync(body) : body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    serve: (dir) => { root = normalize(dir); },
    close: () => new Promise((done) => server.close(done)),
  };
}
