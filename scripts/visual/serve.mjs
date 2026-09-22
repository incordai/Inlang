/**
 * A minimal static file server for the visual gate — node:http only.
 *
 * One server, re-pointed at each site's dist/ in turn, because the emitted
 * pages link assets from the root (`/assets/...`) and so must be served at
 * `/`. Paths are resolved inside the root; anything escaping it is a 404.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.avif': 'image/avif', '.json': 'application/json', '.ico': 'image/x-icon',
};

export async function startServer() {
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
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
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
