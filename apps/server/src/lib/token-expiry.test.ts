import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExpired } from './token-expiry.js';

const now = 1_000_000_000;

test('null expiry never expires', () => {
  assert.equal(isExpired(null, now), false);
});

test('future expiry outside the skew is valid', () => {
  assert.equal(isExpired(new Date(now + 60 * 60 * 1000), now), false);
});

test('expiry inside the 5 minute skew counts as expired', () => {
  assert.equal(isExpired(new Date(now + 60 * 1000), now), true);
});

test('zero skew compares exactly', () => {
  assert.equal(isExpired(new Date(now - 1), now, 0), true);
  assert.equal(isExpired(new Date(now + 1), now, 0), false);
});
