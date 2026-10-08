/**
 * A self-signed certificate for `localhost`, made at test time with
 * node:crypto alone — so a browser test can serve over https on loopback
 * without a dependency and without a key kept in the repository.
 *
 * node:crypto makes keys and signatures but has no certificate builder, so
 * the X.509 structure (RFC 5280) is written here in DER: a v3 certificate,
 * an ECDSA P-256 key signed with SHA-256, subject and issuer CN=localhost,
 * a subjectAltName for `localhost` and 127.0.0.1, valid from a minute ago
 * for a day. Browsers are told to accept it per context (they do not trust
 * it); Node's own clients can pass it as `ca`.
 */

import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

/** A DER length: short form under 128, else the long form. */
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const TAG = {
  integer: 0x02, bitString: 0x03, octetString: 0x04, oid: 0x06, utf8: 0x0c, utcTime: 0x17,
  sequence: 0x30, set: 0x31, explicit: 0xa0, sanDns: 0x82, sanIp: 0x87,
};

const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
const sequence = (...items) => tlv(TAG.sequence, Buffer.concat(items));
const set = (...items) => tlv(TAG.set, Buffer.concat(items));
/** An unsigned integer: a leading zero keeps a high first bit from reading as negative. */
const integer = (bytes) => tlv(TAG.integer, bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes);
const explicit = (n, body) => tlv(TAG.explicit | n, body);
/** UTCTime, YYMMDDHHMMSSZ — valid for dates before 2050 (RFC 5280 §4.1.2.5). */
const utcTime = (date) => tlv(TAG.utcTime, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`, 'ascii'));

/** An OBJECT IDENTIFIER from its dotted form: the first two arcs in one byte, the rest base 128. */
function oid(dotted) {
  const [first, second, ...rest] = dotted.split('.').map(Number);
  const out = [40 * first + second];
  for (const arc of rest) {
    const chunk = [arc % 128];
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift(0x80 | (v % 128));
    out.push(...chunk);
  }
  return tlv(TAG.oid, Buffer.from(out));
}

const OID = { ecdsaWithSha256: '1.2.840.10045.4.3.2', commonName: '2.5.4.3', subjectAltName: '2.5.29.17' };
const HOST = 'localhost';
const LOOPBACK = [127, 0, 0, 1];
/** Valid from a minute ago (a clock a little behind still accepts it) for a day — longer than any run. */
const BACKDATE_MS = 60_000;
const LIFETIME_MS = 24 * 60 * 60_000;
const SERIAL_BYTES = 16;

/** `{ key, cert }` as PEM, ready for `https.createServer`; a new key every call. */
export function selfSignedCert(now = Date.now()) {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  const name = sequence(set(sequence(oid(OID.commonName), tlv(TAG.utf8, Buffer.from(HOST, 'utf8')))));
  const altNames = sequence(tlv(TAG.sanDns, Buffer.from(HOST, 'ascii')), tlv(TAG.sanIp, Buffer.from(LOOPBACK)));
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))), // v3
    integer(randomBytes(SERIAL_BYTES)),
    algorithm,
    name,
    sequence(utcTime(new Date(now - BACKDATE_MS)), utcTime(new Date(now + LIFETIME_MS))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, sequence(sequence(oid(OID.subjectAltName), tlv(TAG.octetString, altNames)))),
  );
  // An ECDSA signature from node:crypto is already DER (r, s); a BIT STRING carries it with no unused bits.
  const signature = tlv(TAG.bitString, Buffer.concat([Buffer.from([0]), sign('sha256', tbs, privateKey)]));
  const der = sequence(tbs, algorithm, signature);
  const lines = der.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    cert: `-----BEGIN CERTIFICATE-----\n${lines}\n-----END CERTIFICATE-----\n`,
  };
}
