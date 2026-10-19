/**
 * The history tag (chat-answer history-tag.ts): the Web Crypto tagger an
 * app or a sidecar uses gives exactly the tag the built-in server gives
 * (node:crypto over the same message and label), so a conversation moves
 * between them; a tag checks only for its own conversation, position and
 * text, and anything that is not a tag is refused without an error.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { base64url, fromBase64url, HISTORY_KEY_LABEL, tagMessage, webCryptoTags } from '../src/history-tag.ts';
import { checkTag, historyKey, tagTurn } from '../../backend/src/server/chat-text.ts';

const SECRET = new Uint8Array(randomBytes(32));
const CONVERSATION = 'abcdefghijklmnop0123';

test('the Web Crypto tag is the server\'s tag, byte for byte', async () => {
  const tags = await webCryptoTags(SECRET);
  const key = historyKey(Buffer.from(SECRET));
  for (const [index, text] of [[1, 'Hello.'], [3, 'Two lines\nof history'], [41, '']] as const) {
    const tag = await tags.tag(CONVERSATION, index, text);
    assert.equal(tag, tagTurn(key, CONVERSATION, index, text));
    assert.ok(checkTag(key, CONVERSATION, index, text, tag), 'the server accepts the app\'s tag');
    assert.ok(await tags.check(CONVERSATION, index, text, tagTurn(key, CONVERSATION, index, text)), 'the app accepts the server\'s tag');
  }
});

test('CONTROL: the tag is HMAC-SHA-256 under a key one step from the secret, over the conversation, the position and the text', async () => {
  const key = createHmac('sha256', SECRET).update(HISTORY_KEY_LABEL).digest();
  const want = createHmac('sha256', key).update(`${CONVERSATION}\n7\nAn answer`).digest('base64url');
  assert.equal(tagMessage(CONVERSATION, 7, 'An answer'), `${CONVERSATION}\n7\nAn answer`);
  assert.equal(await (await webCryptoTags(SECRET)).tag(CONVERSATION, 7, 'An answer'), want);
  // Never the secret's own digest.
  assert.notEqual(want, createHmac('sha256', SECRET).update(`${CONVERSATION}\n7\nAn answer`).digest('base64url'));
});

test('a tag checks for its own answer only: another text, position, conversation or secret is refused', async () => {
  const tags = await webCryptoTags(SECRET);
  const tag = await tags.tag(CONVERSATION, 1, 'Hello.');
  assert.equal(await tags.check(CONVERSATION, 1, 'Hello.', tag), true);
  assert.equal(await tags.check(CONVERSATION, 1, 'Hello!', tag), false);
  assert.equal(await tags.check(CONVERSATION, 3, 'Hello.', tag), false);
  assert.equal(await tags.check('qrstuvwxyzabcdef0123', 1, 'Hello.', tag), false);
  assert.equal(await (await webCryptoTags(new Uint8Array(randomBytes(32)))).check(CONVERSATION, 1, 'Hello.', tag), false);
});

test('anything that is not a tag is false, never an error', async () => {
  const tags = await webCryptoTags(SECRET);
  const tag = await tags.tag(CONVERSATION, 1, 'Hello.');
  for (const bad of [undefined, null, 42, {}, '', 'not base64!', tag.slice(0, -2), `${tag}AA`, `${tag}=`, 'A']) {
    assert.equal(await tags.check(CONVERSATION, 1, 'Hello.', bad), false, String(bad));
  }
});

test('base64url round-trips every byte, unpadded, and refuses what is not base64url', () => {
  const all = new Uint8Array(256).map((_, i) => i);
  for (const n of [0, 1, 2, 3, 31, 32, 256]) {
    const bytes = all.slice(0, n);
    const s = base64url(bytes);
    assert.equal(s, Buffer.from(bytes).toString('base64url'));
    assert.deepEqual(fromBase64url(s), bytes);
  }
  for (const bad of ['a+b', 'a/b', 'ab=', 'A', 'ab cd']) assert.equal(fromBase64url(bad), null, bad);
});
