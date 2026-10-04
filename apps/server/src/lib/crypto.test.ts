import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptToken, encryptToken } from './crypto.js';

const key = randomBytes(32);

test('round-trips a token', () => {
  const token = 'ghu_exampleToken1234567890';
  const enc = encryptToken(token, key);
  assert.equal(decryptToken(enc, key), token);
});

test('round-trips empty and unicode strings', () => {
  for (const value of ['', 'tökén-✓-🔑']) {
    assert.equal(decryptToken(encryptToken(value, key), key), value);
  }
});

test('ciphertext does not contain the plaintext', () => {
  const token = 'ghu_plainTextShouldNotLeak';
  const enc = encryptToken(token, key);
  assert.ok(!enc.includes(token));
  assert.ok(enc.startsWith('v1:'));
});

test('uses a fresh IV each time', () => {
  const token = 'same-input';
  assert.notEqual(encryptToken(token, key), encryptToken(token, key));
});

test('rejects a wrong key', () => {
  const enc = encryptToken('secret', key);
  assert.throws(() => decryptToken(enc, randomBytes(32)));
});

test('rejects tampered ciphertext', () => {
  const enc = encryptToken('secret-value', key);
  const parts = enc.split(':');
  const data = Buffer.from(parts[3]!, 'base64url');
  data[0] = data[0]! ^ 0xff;
  parts[3] = data.toString('base64url');
  assert.throws(() => decryptToken(parts.join(':'), key));
});

test('rejects tampered auth tag', () => {
  const enc = encryptToken('secret-value', key);
  const parts = enc.split(':');
  const tag = Buffer.from(parts[2]!, 'base64url');
  tag[0] = tag[0]! ^ 0x01;
  parts[2] = tag.toString('base64url');
  assert.throws(() => decryptToken(parts.join(':'), key));
});

test('rejects malformed payloads', () => {
  for (const bad of ['', 'nope', 'v2:a:b:c', 'v1:a:b', 'v1:a:b:c:d']) {
    assert.throws(() => decryptToken(bad, key), /Malformed/);
  }
});

test('uses TOKEN_ENCRYPTION_KEY from the environment by default', () => {
  const previous = process.env.TOKEN_ENCRYPTION_KEY;
  process.env.TOKEN_ENCRYPTION_KEY = key.toString('base64');
  try {
    const enc = encryptToken('env-key');
    assert.equal(decryptToken(enc, key), 'env-key');
  } finally {
    process.env.TOKEN_ENCRYPTION_KEY = previous;
  }
});
