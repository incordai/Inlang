/**
 * Currency formatting is pinned, because it is not really ours.
 *
 * pricing-block-spec §7.2 formats prices with `Intl.NumberFormat` at EMIT
 * time, so the output is a static string and byte-identical builds hold. What
 * §7.2 does not say is that `Intl` reads the ICU data bundled with the running
 * Node: a build on small-icu, or on a future ICU with revised locale data,
 * can produce different bytes from the same source. The determinism claim
 * therefore rests on something outside this repository.
 *
 * These tests pin the exact expected strings — including the U+00A0 that ICU
 * puts before the euro sign — so that an ICU change surfaces here, with an
 * explanation, instead of as an unexplained diff in someone's build output.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatPrice } from '../pricing/emit.web.ts';

test('ENVIRONMENT: this Node has the locale data the formatting assumes', () => {
  // Without full ICU, `de-DE` silently falls back to `en-US` and every
  // assertion below would be testing the fallback rather than the format.
  assert.equal(new Intl.NumberFormat('de-DE').resolvedOptions().locale, 'de-DE',
    'small-icu build: locale data is missing, so formatted prices will differ');
});

test('a numeric price is formatted for its currency and locale', () => {
  assert.equal(formatPrice('29', 'usd', 'en-US'), '$29.00');
  assert.equal(formatPrice('1299', 'usd', 'en-US'), '$1,299.00');
});

test('the locale decides separators and symbol POSITION, not just the symbol', () => {
  // ICU puts U+00A0 before the euro sign, not a plain space. Written as an
  // escape because the two are indistinguishable in source, and these
  // assertions turn on exactly that byte.
  assert.equal(formatPrice('29', 'eur', 'de-DE'), '29,00\u00A0€');
  assert.equal(formatPrice('1299', 'eur', 'de-DE'), '1.299,00\u00A0€');
});

test('a STRING price is left alone — §7.2', () => {
  // `monthly "Custom"` is a legal price and is exempt from the toggle,
  // rendering no currency symbol. Putting "$Custom" on a page would be worse
  // than not formatting at all.
  assert.equal(formatPrice('Custom', 'usd', 'en-US'), 'Custom');
  assert.equal(formatPrice('Talk to us', 'usd', 'en-US'), 'Talk to us');
});

test('an unknown-but-well-formed currency prints its code, and does not throw', () => {
  // Measured, not assumed: `Intl` accepts any three ASCII letters and falls
  // back to printing the code. It does NOT throw here, so nothing in the
  // emitter needs to catch this case — the price is still legible.
  //
  // The separator is U+00A0, written as an escape rather than pasted, because
  // a literal non-breaking space is indistinguishable from a plain one in the
  // source and this assertion turns on exactly that byte.
  assert.equal(formatPrice('29', 'zzz', 'en-US'), 'ZZZ\u00A029.00');
});

test('a MALFORMED currency or locale is caught, and never fails the build', () => {
  // This is what actually throws — a RangeError on anything that is not three
  // ASCII letters, and on an unparseable locale. One typo in one plan must not
  // take down the compile, so the value reaches the page unformatted.
  assert.equal(formatPrice('29', 'zz', 'en-US'), '29');
  assert.equal(formatPrice('29', 'usd', 'not a locale!!'), '29');
});

test('CONTROL: the fallback is not simply returning the input every time', () => {
  // Otherwise the tests above would pass against a formatPrice that formats
  // nothing at all.
  assert.notEqual(formatPrice('29', 'usd', 'en-US'), '29');
});

test('prices are never COMPUTED — PRD principle 7', () => {
  // §7.2: `monthly 29` and `annual 290` are independent declarations, and the
  // compiler must not grow a way to express "annual is monthly × 10".
  // formatPrice takes one value and changes only its presentation.
  assert.equal(formatPrice('290', 'usd', 'en-US'), '$290.00',
    'the annual figure is whatever was declared, formatted');
});
