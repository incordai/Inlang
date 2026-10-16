/**
 * Share links in the page (chat-block-spec §20.7), the pure parts: a link's
 * fragment is a 128-bit id, and the delete link adds a 256-bit token —
 * anything else is no link; the fixed copy for each refusal; and the events
 * a share sends are merged exactly as the server merges them when it tags.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeText, readShareLink, shareProblem, SHARED_PATH } from '../src/runtime/chat-logic.ts';
import { mergeText as serverMerge } from '../../backend/src/server/chat-share.ts';
import { SHARED_ROUTE } from '../../core/src/chat.ts';

const ID = 'AbCdEfGhIjKlMnOpQrStUv';
const TOKEN = 'a'.repeat(43);

test('readShareLink: an id, or an id and the delete token — nothing else', () => {
  assert.deepEqual(readShareLink(`#${ID}`), { id: ID, token: null });
  assert.deepEqual(readShareLink(`#${ID}&${TOKEN}`), { id: ID, token: TOKEN });
  for (const bad of ['', '#', `${ID}`, `#${ID}x`, `#${ID.slice(1)}`, `#${ID}&short`, `#${ID}&${TOKEN}&x`, `#../${ID}`, `#${ID}?q=1`, '#<img src=x>']) {
    assert.equal(readShareLink(bad), null, bad);
  }
});

test('the page\'s shared route is the build\'s', () => {
  assert.equal(SHARED_PATH, SHARED_ROUTE);
});

test('shareProblem: fixed copy for each code, and one line for the rest', () => {
  assert.match(shareProblem('rate_limited'), /try again later/);
  assert.match(shareProblem('tampered'), /can no longer be shared/);
  assert.equal(shareProblem('<script>'), shareProblem('anything'));
});

test('mergeText: the page merges events exactly as the server does before tagging', () => {
  const events = [
    { type: 'text', s: 'Here ' }, { type: 'text', s: 'it is.' }, { type: 'block', block: { chart: { kind: 'bar' } } },
    { type: 'text', s: 'After.' }, { type: 'text', s: 'More.' },
  ];
  assert.deepEqual(mergeText(events), serverMerge(events));
  assert.equal(JSON.stringify(mergeText(events)), JSON.stringify(serverMerge(events)));
  assert.equal(mergeText(events).length, 3);
});
