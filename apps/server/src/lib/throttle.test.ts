import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Throttle } from './throttle.js';

/** Fake clock: sleeping advances time instantly. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    get time() {
      return t;
    },
  };
}

test('allows maxPerMinute calls, then waits for the window to roll', async () => {
  const clock = fakeClock();
  const throttle = new Throttle({ maxPerMinute: 3, concurrency: 10, ...clock });
  const startTimes: number[] = [];
  for (let i = 0; i < 5; i++)
    await throttle.run({ requests: 1, tokens: 1 }, async () => void startTimes.push(clock.time));
  assert.deepEqual(startTimes, [0, 0, 0, 60_000, 60_000]);
});

test('batches are weighted by item count (Gemini meters per item)', async () => {
  const clock = fakeClock();
  const throttle = new Throttle({ maxPerMinute: 100, concurrency: 1, ...clock });
  const startTimes: number[] = [];
  for (const requests of [60, 30, 60, 50]) {
    await throttle.run({ requests, tokens: 1 }, async () => void startTimes.push(clock.time));
  }
  // 60 + 30 fit; another 60 would make 150 > 100, so it waits for the minute to roll.
  assert.deepEqual(startTimes, [0, 0, 60_000, 120_000]);
});

test('token budget delays calls that would exceed it', async () => {
  const clock = fakeClock();
  const throttle = new Throttle({
    maxPerMinute: 100,
    concurrency: 1,
    maxTokensPerMinute: 1000,
    ...clock,
  });
  const startTimes: number[] = [];
  for (const tokens of [600, 300, 200]) {
    await throttle.run({ requests: 1, tokens }, async () => void startTimes.push(clock.time));
  }
  assert.deepEqual(startTimes, [0, 0, 60_000]);
});

test('an oversized request still runs on an empty window', async () => {
  const clock = fakeClock();
  const throttle = new Throttle({
    maxPerMinute: 10,
    concurrency: 1,
    maxTokensPerMinute: 100,
    ...clock,
  });
  let ran = false;
  await throttle.run({ requests: 1, tokens: 5000 }, async () => {
    ran = true;
  });
  assert.equal(ran, true);
});

test('pauseUntil holds every caller until the pause ends', async () => {
  const clock = fakeClock();
  const throttle = new Throttle({ maxPerMinute: 100, concurrency: 5, ...clock });
  throttle.pauseUntil(30_000);
  let startedAt = -1;
  await throttle.run({ requests: 1, tokens: 1 }, async () => {
    startedAt = clock.time;
  });
  assert.equal(startedAt, 30_000);
});

test('concurrency limit is respected', async () => {
  const throttle = new Throttle({ maxPerMinute: 1000, concurrency: 2 });
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 8 }, () =>
      throttle.run({ requests: 1, tokens: 1 }, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    ),
  );
  assert.equal(peak, 2);
});

test('a failing call releases its slot', async () => {
  const throttle = new Throttle({ maxPerMinute: 1000, concurrency: 1 });
  await assert.rejects(
    throttle.run({ requests: 1, tokens: 1 }, async () => Promise.reject(new Error('boom'))),
  );
  assert.equal(await throttle.run({ requests: 1, tokens: 1 }, async () => 'ok'), 'ok');
});
