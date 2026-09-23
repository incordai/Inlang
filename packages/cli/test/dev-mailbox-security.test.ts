/**
 * The dev mailbox holds live reset and sign-in links. A page on another site
 * that rebinds its own name to 127.0.0.1 must not read them, and a request
 * line the URL parser rejects must not stop it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { request } from 'node:http';
import { startMailbox } from '../src/dev-backend.ts';
import { freePort } from '../src/serve.ts';

/** A GET with a chosen Host header — fetch will not send one. */
const get = (port: number, path: string, host: string) => new Promise<number>((done, fail) => {
  const r = request({ host: '127.0.0.1', port, path, headers: { host } }, (res) => { res.resume(); done(res.statusCode ?? 0); });
  r.on('error', fail);
  r.end();
});

const raw = (port: number, target: string) => new Promise<string>((done, fail) => {
  const s = connect(port, '127.0.0.1', () => s.end(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
  let out = '';
  s.on('data', (c) => { out += c; });
  s.on('end', () => done(out));
  s.on('error', fail);
});

test('SECURITY dev mailbox: reads under another host name (DNS rebinding) are refused', async () => {
  const port = await freePort(0);
  const mailbox = await startMailbox(port, () => {});
  try {
    assert.equal(await get(port, '/messages.json', 'rebound.example:80'), 403);
    assert.equal(await get(port, '/', `rebound.example:${port}`), 403);
    assert.equal(await get(port, '/messages.json', `127.0.0.1:${port}`), 200, 'CONTROL: the printed address works');
  } finally { await mailbox.close(); }
});

test('SECURITY dev mailbox: `GET //` is answered 400 and the mailbox keeps serving', async () => {
  const port = await freePort(0);
  const mailbox = await startMailbox(port, () => {});
  try {
    assert.match(await raw(port, '//'), /^HTTP\/1\.1 400 /);
    assert.equal(await get(port, '/', `127.0.0.1:${port}`), 200, 'CONTROL: still up');
  } finally { await mailbox.close(); }
});
