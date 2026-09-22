/**
 * Preload that makes every network path in this process throw.
 *
 * Used with `node --import` so `az build` runs as if the machine were
 * offline — ROADMAP M1: the build succeeds with network disabled. Any
 * attempt is also written to stderr, so a caught-and-ignored call is still
 * visible to the test.
 */
import net from 'node:net';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

const refuse = (what) => () => {
  process.stderr.write(`NETWORK ATTEMPT: ${what}\n`);
  throw new Error(`network disabled: ${what}`);
};

net.Socket.prototype.connect = refuse('net.Socket.connect');
net.connect = refuse('net.connect');
net.createConnection = refuse('net.createConnection');
dns.lookup = refuse('dns.lookup');
dns.resolve = refuse('dns.resolve');
dns.promises.lookup = refuse('dns.promises.lookup');
http.request = refuse('http.request');
http.get = refuse('http.get');
https.request = refuse('https.request');
https.get = refuse('https.get');
globalThis.fetch = refuse('fetch');
