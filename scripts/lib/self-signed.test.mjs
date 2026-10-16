import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, createPublicKey } from 'node:crypto';
import { createServer, request } from 'node:https';
import { derInteger, selfSignedCert } from './self-signed.mjs';

test('selfSignedCert: a v3 certificate for localhost and 127.0.0.1, signed by its own key, valid now for a day', () => {
  const now = Date.now();
  const { key, cert } = selfSignedCert(now);
  const x = new X509Certificate(cert);
  assert.equal(x.subject, 'CN=localhost');
  assert.equal(x.issuer, 'CN=localhost');
  assert.equal(x.subjectAltName, 'DNS:localhost, IP Address:127.0.0.1');
  assert.equal(x.checkHost('localhost'), 'localhost');
  assert.equal(x.checkIP('127.0.0.1'), '127.0.0.1');
  assert.ok(x.verify(createPublicKey(key)), 'signed by the key it carries');
  assert.ok(Date.parse(x.validFrom) <= now && Date.parse(x.validTo) > now + 23 * 3600_000);
  // CONTROL: every call is a new key.
  assert.notEqual(selfSignedCert(now).key, key);
});

test('selfSignedCert: an https server with it answers a client that trusts it — and refuses one that does not', async () => {
  const tls = selfSignedCert();
  const server = createServer(tls, (_, res) => res.end('ok'));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  const get = (options) => new Promise((done) => {
    const req = request({ host: 'localhost', port, path: '/', timeout: 5_000, ...options }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => done(`${res.statusCode} ${body}`));
    });
    req.on('timeout', () => req.destroy(new Error('no answer after 5s')));
    req.on('error', (e) => done(e.code ?? e.message));
    req.end();
  });
  try {
    assert.equal(await get({ ca: tls.cert }), '200 ok');
    assert.equal(await get({}), 'DEPTH_ZERO_SELF_SIGNED_CERT');
  } finally {
    server.close();
  }
});

test('derInteger: the minimal DER form — leading zeros dropped, one kept before a high bit', () => {
  const hex = (bytes) => derInteger(Buffer.from(bytes)).toString('hex');
  assert.equal(hex([2]), '020102');
  assert.equal(hex([0x80]), '02020080');
  // A random serial that starts 0x00 then below 0x80 was written as is: OpenSSL refused it ("illegal padding").
  assert.equal(hex([0x00, 0x05, 0xff]), '020205ff');
  assert.equal(hex([0x00, 0x7f]), '02017f');
  assert.equal(hex([0x00, 0x00, 0x90]), '02020090');
  // Zero itself keeps its one byte.
  assert.equal(hex([0x00]), '020100');
});
