import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlidingWindowLimiter, rateLimit } from './rate-limit.js';
import { HttpError } from './http-error.js';
import { untilReset, utcDayStart } from '../services/usage.js';

test('sliding window allows `limit` hits per window per key, then reports the wait', () => {
  let t = 1_000_000;
  const l = new SlidingWindowLimiter(3, 60_000, () => t);
  assert.equal(l.hit('a').ok, true);
  t += 10_000;
  assert.equal(l.hit('a').ok, true);
  assert.equal(l.hit('a').remaining, 0);
  const denied = l.hit('a');
  assert.equal(denied.ok, false);
  assert.equal(denied.retryAfterMs, 50_000, 'oldest hit leaves the window in 50 s');
  assert.equal(l.hit('b').ok, true, 'keys are independent');
  t += 50_000;
  assert.equal(l.hit('a').ok, true, 'a slot is free again');
});

test('rateLimit middleware returns 429 RATE_LIMITED with Retry-After seconds', () => {
  const mw = rateLimit({ name: 't', limit: 1, key: () => 'k' });
  const errors: unknown[] = [];
  const next = (err?: unknown) => errors.push(err);
  mw({} as never, {} as never, next);
  mw({} as never, {} as never, next);
  assert.equal(errors[0], undefined);
  const err = errors[1];
  assert.ok(err instanceof HttpError);
  assert.equal(err.status, 429);
  assert.equal(err.code, 'RATE_LIMITED');
  assert.ok((err.retryAfterSeconds ?? 0) >= 59);
});

test('daily usage window is the UTC day', () => {
  const now = new Date('2026-10-05T18:30:00Z');
  assert.equal(utcDayStart(now).toISOString(), '2026-10-05T00:00:00.000Z');
  assert.equal(untilReset(now), 'in 5 h 30 min');
  assert.equal(untilReset(new Date('2026-10-05T23:50:00Z')), 'in 10 min');
});
