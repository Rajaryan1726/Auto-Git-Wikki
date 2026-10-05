import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Throttle } from '../lib/throttle.js';
import {
  EmbeddingFatalError,
  EmbeddingRateLimitError,
  createGeminiEmbedder,
  createOpenAIEmbedder,
  parseOpenAIDuration,
  l2normalize,
  retryDelayMs,
} from './embeddings.js';

const DIMS = 4;

type Call = { url: string; body: { requests?: { content: { parts: { text: string }[] } }[] } };

function fakeFetch(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), body: JSON.parse(String(init?.body)) as Call['body'] };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

function embedder(fetchImpl: typeof fetch, batchSize = 2) {
  return createGeminiEmbedder({
    model: 'gemini-embedding-2',
    dims: DIMS,
    apiKey: 'test-key',
    throttle: new Throttle({ maxPerMinute: 1000, concurrency: 2 }),
    batchSize,
    fetchImpl,
  });
}

const vec = (seed: number) => [seed, 0, 0, 0];

test('l2normalize returns a unit vector and rejects zero vectors', () => {
  const v = l2normalize([3, 4]);
  assert.deepEqual(v, [0.6, 0.8]);
  assert.throws(() => l2normalize([0, 0]));
});

test('embedDocuments batches requests, keeps order and never sends task_type', async () => {
  const { impl, calls } = fakeFetch((call) =>
    Response.json({
      embeddings: call.body.requests!.map((r) => ({
        values: vec(Number(r.content.parts[0]!.text)),
      })),
    }),
  );
  const out = await embedder(impl).embedDocuments(['1', '2', '3', '4', '5']);
  assert.equal(calls.length, 3, '5 texts in batches of 2');
  assert.ok(calls.every((c) => c.url.endsWith('/models/gemini-embedding-2:batchEmbedContents')));
  assert.ok(!JSON.stringify(calls).includes('taskType'));
  assert.ok(!JSON.stringify(calls).includes('task_type'));
  assert.ok(JSON.stringify(calls[0]!.body).includes('"outputDimensionality":4'));
  assert.deepEqual(
    out.map((v) => v[0]),
    [1, 1, 1, 1, 1],
    'normalized, in input order',
  );
});

test('batches never exceed the per-minute item budget', async () => {
  const { impl, calls } = fakeFetch((call) =>
    Response.json({ embeddings: call.body.requests!.map(() => ({ values: vec(1) })) }),
  );
  const e = createGeminiEmbedder({
    model: 'gemini-embedding-2',
    dims: DIMS,
    apiKey: 'k',
    throttle: new Throttle({ maxPerMinute: 10_000, concurrency: 2 }),
    batchSize: 100,
    maxItemsPerMinute: 40,
    fetchImpl: impl,
  });
  await e.embedDocuments(Array.from({ length: 90 }, (_, i) => String(i)));
  assert.deepEqual(
    calls.map((c) => c.body.requests!.length),
    [40, 40, 10],
  );
});

test('a batch answer with the wrong count or dimension is rejected', async () => {
  const short = fakeFetch(() => Response.json({ embeddings: [{ values: vec(1) }] }));
  await assert.rejects(embedder(short.impl).embedDocuments(['a', 'b']), /1 embeddings for 2/);

  const wrongDims = fakeFetch(() => Response.json({ embeddings: [{ values: [1, 2] }] }));
  await assert.rejects(embedder(wrongDims.impl).embedDocuments(['a']), /Expected 4-dim/);
});

test('429 becomes EmbeddingRateLimitError using RetryInfo.retryDelay', async () => {
  const { impl } = fakeFetch(() =>
    Response.json(
      {
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'Quota exceeded',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }],
        },
      },
      { status: 429 },
    ),
  );
  const e = embedder(impl);
  const before = Date.now();
  await assert.rejects(e.embedQuery('q'), (err: unknown) => {
    assert.ok(err instanceof EmbeddingRateLimitError);
    const wait = err.retryAt.getTime() - before;
    assert.ok(wait >= 36_000 && wait <= 39_000, String(wait));
    return true;
  });
  assert.equal(e.stats.rateLimited, 1);
});

test('retryDelayMs prefers the Retry-After header and has a default', () => {
  assert.equal(retryDelayMs(new Headers({ 'retry-after': '12' }), null), 12_000);
  assert.equal(retryDelayMs(new Headers(), { error: { details: [{ retryDelay: '1.5s' }] } }), 1500);
  assert.equal(retryDelayMs(new Headers(), {}), 60_000);
});

test('bad key / bad request are fatal; missing key fails before any call', async () => {
  const forbidden = fakeFetch(() =>
    Response.json({ error: { message: 'API key not valid' } }, { status: 400 }),
  );
  await assert.rejects(embedder(forbidden.impl).embedQuery('q'), EmbeddingFatalError);

  const noKey = createGeminiEmbedder({
    model: 'm',
    dims: DIMS,
    apiKey: undefined,
    throttle: new Throttle({ maxPerMinute: 10, concurrency: 1 }),
    batchSize: 10,
    fetchImpl: (() => {
      throw new Error('should not be called');
    }) as unknown as typeof fetch,
  });
  await assert.rejects(noKey.embedQuery('q'), /GEMINI_API_KEY is not set/);
});

test('embedQuery uses embedContent and normalizes', async () => {
  const { impl, calls } = fakeFetch(() => Response.json({ embedding: { values: [0, 2, 0, 0] } }));
  assert.deepEqual(
    await embedder(impl).embedQuery('task: code retrieval | query: x'),
    [0, 1, 0, 0],
  );
  assert.ok(calls[0]!.url.endsWith(':embedContent'));
});

// ---------------- OpenAI ----------------

type OpenAICall = {
  url: string;
  auth: string | null;
  body: { input: string[]; dimensions: number; model: string };
};

function openaiFetch(handler: (call: OpenAICall) => Response) {
  const calls: OpenAICall[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = {
      url: String(url),
      auth: headers.get('authorization'),
      body: JSON.parse(String(init?.body)) as OpenAICall['body'],
    };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { impl, calls };
}

function openai(fetchImpl: typeof fetch, batchSize = 2) {
  return createOpenAIEmbedder({
    model: 'text-embedding-3-small',
    dims: DIMS,
    apiKey: 'sk-test',
    throttle: new Throttle({ maxPerMinute: 1000, concurrency: 2 }),
    batchSize,
    fetchImpl,
  });
}

test('OpenAI: batches inputs, sends dimensions, reorders by index', async () => {
  const { impl, calls } = openaiFetch((call) =>
    Response.json({
      // Deliberately out of order; the client must sort by index.
      data: call.body.input.map((t, index) => ({ index, embedding: vec(Number(t)) })).reverse(),
    }),
  );
  const out = await openai(impl).embedDocuments(['1', '2', '3']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0]!.url, 'https://api.openai.com/v1/embeddings');
  assert.equal(calls[0]!.auth, 'Bearer sk-test');
  assert.equal(calls[0]!.body.dimensions, DIMS);
  assert.equal(calls[0]!.body.model, 'text-embedding-3-small');
  assert.deepEqual(out, [
    [1, 0, 0, 0],
    [1, 0, 0, 0],
    [1, 0, 0, 0],
  ]);
});

test('OpenAI: insufficient_quota is fatal, other 429s are rate limits', async () => {
  const quota = openaiFetch(() =>
    Response.json(
      { error: { code: 'insufficient_quota', message: 'You exceeded your quota' } },
      { status: 429 },
    ),
  );
  await assert.rejects(openai(quota.impl).embedQuery('q'), EmbeddingFatalError);

  const limited = openaiFetch(() =>
    Response.json(
      { error: { code: 'rate_limit_exceeded', message: 'Rate limit' } },
      {
        status: 429,
        headers: { 'x-ratelimit-reset-tokens': '6m0s', 'x-ratelimit-reset-requests': '20ms' },
      },
    ),
  );
  const before = Date.now();
  await assert.rejects(openai(limited.impl).embedQuery('q'), (err: unknown) => {
    assert.ok(err instanceof EmbeddingRateLimitError);
    const wait = err.retryAt.getTime() - before;
    assert.ok(wait >= 359_000 && wait <= 362_000, String(wait));
    return true;
  });
});

test('parseOpenAIDuration handles ms, s, m, h combinations', () => {
  assert.equal(parseOpenAIDuration('20ms'), 20);
  assert.equal(parseOpenAIDuration('1.5s'), 1500);
  assert.equal(parseOpenAIDuration('6m0s'), 360_000);
  assert.equal(parseOpenAIDuration('1h2m'), 3_720_000);
  assert.equal(parseOpenAIDuration(null), null);
  assert.equal(parseOpenAIDuration('soon'), null);
});

test('OpenAI: wrong dimension and missing key are rejected', async () => {
  const wrong = openaiFetch(() => Response.json({ data: [{ index: 0, embedding: [1, 2] }] }));
  await assert.rejects(openai(wrong.impl).embedQuery('q'), /Expected 4-dim/);
  const noKey = createOpenAIEmbedder({
    model: 'text-embedding-3-small',
    dims: DIMS,
    apiKey: undefined,
    throttle: new Throttle({ maxPerMinute: 10, concurrency: 1 }),
    batchSize: 10,
  });
  await assert.rejects(noKey.embedQuery('q'), /OPENAI_API_KEY is not set/);
});

test('memoizedQuery shares in-flight and recent results, never caches failures', async () => {
  const { memoizedQuery } = await import('./embeddings.js');
  let calls = 0;
  const compute = () => {
    calls++;
    return new Promise<number[]>((r) => setTimeout(() => r([1, 2]), 10));
  };
  const [a, b] = await Promise.all([memoizedQuery('k1', compute), memoizedQuery('k1', compute)]);
  assert.deepEqual(a, [1, 2]);
  assert.equal(a, b);
  assert.equal(calls, 1, 'concurrent callers share one request');
  await memoizedQuery('k1', compute);
  assert.equal(calls, 1, 'recent result reused');
  await memoizedQuery('k1', compute, Date.now() + 61_000);
  assert.equal(calls, 2, 'expired after the TTL');
  await assert.rejects(memoizedQuery('k2', () => Promise.reject(new Error('boom'))));
  assert.deepEqual(await memoizedQuery('k2', () => Promise.resolve([3])), [3]);
});
