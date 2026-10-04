import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, isQuotaError, parseDelay, retryAfterMsFrom } from './circuit-breaker.js';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

test('breaker opens for the retry time and closes after it, logging both', () => {
  const c = clock();
  const logs: string[] = [];
  const b = new CircuitBreaker({ now: c.now, log: (m) => logs.push(m) });
  assert.equal(b.isOpen('gemini'), false);
  b.trip('gemini', 90_000, '429 quota');
  assert.equal(b.isOpen('gemini'), true);
  assert.equal(b.isOpen('openai'), false);
  c.advance(89_999);
  assert.equal(b.isOpen('gemini'), true);
  c.advance(1);
  assert.equal(b.isOpen('gemini'), false);
  assert.equal(logs.length, 2);
  assert.match(logs[0]!, /OPEN for gemini for 90s/);
  assert.match(logs[1]!, /CLOSED for gemini/);
});

test('open window is clamped to at least 60 s and at most 1 h', () => {
  const c = clock();
  const b = new CircuitBreaker({ now: c.now, log: () => {} });
  b.trip('a', null, 'no hint');
  b.trip('b', 5_000, 'short hint');
  b.trip('c', 24 * 3_600_000, 'daily quota');
  assert.equal(b.openUntilTime('a')!.getTime() - c.now(), 60_000);
  assert.equal(b.openUntilTime('b')!.getTime() - c.now(), 60_000);
  assert.equal(b.openUntilTime('c')!.getTime() - c.now(), 3_600_000);
});

test('tripping again keeps the later deadline and logs OPEN only once', () => {
  const c = clock();
  const logs: string[] = [];
  const b = new CircuitBreaker({ now: c.now, log: (m) => logs.push(m) });
  b.trip('gemini', 600_000, 'first');
  b.trip('gemini', 60_000, 'second, shorter');
  assert.equal(b.openUntilTime('gemini')!.getTime() - c.now(), 600_000);
  assert.equal(logs.length, 1);
});

test('succeed closes an open breaker', () => {
  const logs: string[] = [];
  const b = new CircuitBreaker({ log: (m) => logs.push(m) });
  b.succeed('gemini'); // not open: no log
  b.trip('gemini', 120_000, 'quota');
  b.succeed('gemini');
  assert.equal(b.isOpen('gemini'), false);
  assert.deepEqual(
    logs.map((l) => l.split(' ').slice(1, 4).join(' ')),
    ['circuit breaker OPEN', 'circuit breaker CLOSED'],
  );
});

test('retry hints: headers, Google RetryInfo and message text', () => {
  assert.equal(retryAfterMsFrom(new Headers({ 'retry-after': '30' }), null), 30_000);
  assert.equal(retryAfterMsFrom(new Headers({ 'retry-after-ms': '1500' }), null), 1500);
  assert.equal(
    retryAfterMsFrom(null, {
      error: {
        message: 'Quota exceeded',
        details: [{}, { retryDelay: '37s' }],
      },
    }),
    37_000,
  );
  assert.equal(retryAfterMsFrom(null, { error: { message: 'Please retry in 12.5s.' } }), 12_500);
  assert.equal(retryAfterMsFrom(null, { error: { message: 'Bad request' } }), null);
  assert.equal(parseDelay('200ms'), 200);
  assert.equal(parseDelay('2m'), 120_000);
  assert.equal(parseDelay('soon'), null);
});

test('only quota / rate-limit errors count', () => {
  assert.equal(isQuotaError(429, 'whatever'), true);
  assert.equal(isQuotaError(null, 'You exceeded your current quota, please check'), true);
  assert.equal(isQuotaError(400, 'API key not valid'), false);
  assert.equal(isQuotaError(503, 'This model is currently experiencing high demand'), false);
});
