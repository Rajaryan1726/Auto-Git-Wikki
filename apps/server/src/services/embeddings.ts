import { z } from 'zod';
import { env } from '../lib/env.js';
import { Throttle } from '../lib/throttle.js';
import { providerForModel, type EmbeddingProvider } from './embedding-format.js';

/**
 * Embeddings over the providers' REST APIs (Gemini, OpenAI). The provider is derived from
 * the model id, so a job or query always uses the provider of the model it was built with.
 * - Callers pre-format text with services/embedding-format.ts (Gemini never gets task_type).
 * - One vector per input; every vector is checked for the expected dimension and normalized.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_RETRY_MS = 60_000;
/**
 * A 429 pauses every embedding call in this process, but never for longer than this.
 * Longer waits (e.g. a daily quota) are decided per job instead of freezing everyone.
 */
const MAX_SHARED_PAUSE_MS = 2 * 60_000;

import { EmbeddingFatalError, EmbeddingRateLimitError } from './embedding-errors.js';

import { moduleLogger } from '../lib/logger.js';

const log = moduleLogger('embeddings');

export { EmbeddingFatalError, EmbeddingRateLimitError };

export function l2normalize(vector: number[]): number[] {
  let sum = 0;
  for (const x of vector) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Cannot normalize a zero vector');
  return vector.map((x) => x / norm);
}

/** Rough token estimate for the throttle's tokens-per-minute budget. */
export function estimateTokens(texts: string[]): number {
  return Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);
}

const errorBodySchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        status: z.string().optional(),
        details: z.array(z.record(z.string(), z.unknown())).optional(),
      })
      .optional(),
  })
  .loose();

/** Milliseconds to wait after a 429, from Retry-After or google.rpc.RetryInfo.retryDelay. */
export function retryDelayMs(headers: Headers, body: unknown): number {
  const header = Number(headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const parsed = errorBodySchema.safeParse(body);
  for (const detail of parsed.success ? (parsed.data.error?.details ?? []) : []) {
    const delay = detail.retryDelay;
    if (typeof delay === 'string') {
      const seconds = Number.parseFloat(delay.replace(/s$/, ''));
      if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    }
  }
  return DEFAULT_RETRY_MS;
}

/** Quota ids from google.rpc.QuotaFailure, e.g. EmbedContentRequestsPerMinute...-FreeTier. */
export function quotaIds(body: unknown): string[] {
  const parsed = errorBodySchema.safeParse(body);
  const ids: string[] = [];
  for (const detail of parsed.success ? (parsed.data.error?.details ?? []) : []) {
    const violations = detail.violations;
    if (!Array.isArray(violations)) continue;
    for (const v of violations as { quotaId?: unknown }[]) {
      if (typeof v.quotaId === 'string') ids.push(v.quotaId);
    }
  }
  return ids;
}

function errorMessage(body: unknown, status: number): string {
  const parsed = errorBodySchema.safeParse(body);
  return (parsed.success && parsed.data.error?.message) || `HTTP ${status}`;
}

const batchResponseSchema = z.object({
  embeddings: z.array(z.object({ values: z.array(z.number()) })),
});
const singleResponseSchema = z.object({ embedding: z.object({ values: z.array(z.number()) }) });

export type EmbedderOptions = {
  model: string;
  dims: number;
  apiKey: string | undefined;
  throttle: Throttle;
  batchSize: number;
  /** Per-minute item budget; batches are never larger than this. */
  maxItemsPerMinute?: number;
  fetchImpl?: typeof fetch;
};

export type EmbedderStats = { calls: number; rateLimited: number };

export type Embedder = {
  /** Embeds pre-formatted documents; returns one normalized vector per input, in order. */
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** Embeds one pre-formatted query. */
  embedQuery(text: string): Promise<number[]>;
  readonly stats: EmbedderStats;
};

export function createGeminiEmbedder(opts: EmbedderOptions): Embedder {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stats: EmbedderStats = { calls: 0, rateLimited: 0 };
  const modelPath = `models/${opts.model}`;

  async function post(method: string, body: unknown, items: string[]): Promise<unknown> {
    if (!opts.apiKey) {
      throw new EmbeddingFatalError('GEMINI_API_KEY is not set, so embeddings cannot be created.');
    }
    const apiKey = opts.apiKey;
    // Gemini counts every embedded text against the per-minute quota, not every call.
    const cost = { requests: items.length, tokens: estimateTokens(items) };
    return opts.throttle.run(cost, async () => {
      stats.calls++;
      const res = await fetchImpl(`${API_BASE}/${modelPath}:${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
      });
      const json: unknown = await res.json().catch(() => null);
      if (res.status === 429) {
        stats.rateLimited++;
        const delay = retryDelayMs(res.headers, json);
        const retryAt = Date.now() + delay;
        const quotas = quotaIds(json);
        log.warn(
          `[embed] 429 from Gemini: retry in ${Math.ceil(delay / 1000)}s` +
            (quotas.length ? ` (quota: ${quotas.join(', ')})` : ''),
        );
        // Hold other callers in this process briefly; long waits are per job.
        opts.throttle.pauseUntil(Math.min(retryAt, Date.now() + MAX_SHARED_PAUSE_MS));
        throw new EmbeddingRateLimitError(new Date(retryAt), errorMessage(json, 429), quotas);
      }
      if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404) {
        throw new EmbeddingFatalError(
          `Gemini rejected the embedding request (${res.status}): ${errorMessage(json, res.status)}`,
        );
      }
      if (!res.ok) {
        throw new Error(`Gemini embedding request failed: ${errorMessage(json, res.status)}`);
      }
      return json;
    });
  }

  function checkVector(values: number[]): number[] {
    if (values.length !== opts.dims) {
      throw new Error(`Expected ${opts.dims}-dim embeddings, got ${values.length}`);
    }
    return l2normalize(values);
  }

  async function embedBatch(texts: string[]): Promise<number[][]> {
    const body = {
      requests: texts.map((text) => ({
        model: modelPath,
        content: { parts: [{ text }] },
        outputDimensionality: opts.dims,
      })),
    };
    const parsed = batchResponseSchema.parse(await post('batchEmbedContents', body, texts));
    if (parsed.embeddings.length !== texts.length) {
      throw new Error(
        `batchEmbedContents returned ${parsed.embeddings.length} embeddings for ${texts.length} inputs`,
      );
    }
    return parsed.embeddings.map((e) => checkVector(e.values));
  }

  return {
    stats,
    async embedDocuments(texts) {
      const batches: string[][] = [];
      // A batch must fit in the per-minute budget, or it could never be sent without a 429.
      const size = Math.max(1, Math.min(opts.batchSize, opts.maxItemsPerMinute ?? opts.batchSize));
      for (let i = 0; i < texts.length; i += size) batches.push(texts.slice(i, i + size));
      // The throttle bounds concurrency and rate; results keep input order.
      const results = await Promise.all(batches.map(embedBatch));
      return results.flat();
    },
    async embedQuery(text) {
      const body = {
        model: modelPath,
        content: { parts: [{ text }] },
        outputDimensionality: opts.dims,
      };
      const parsed = singleResponseSchema.parse(await post('embedContent', body, [text]));
      return checkVector(parsed.embedding.values);
    },
  };
}

// ---------------------------------------------------------------- OpenAI

const OPENAI_URL = 'https://api.openai.com/v1/embeddings';

const openaiResponseSchema = z.object({
  data: z.array(z.object({ index: z.number(), embedding: z.array(z.number()) })),
});

const openaiErrorSchema = z
  .object({
    error: z
      .object({
        message: z.string().optional(),
        code: z.string().nullish(),
        type: z.string().nullish(),
      })
      .optional(),
  })
  .loose();

/** Parses OpenAI durations such as "20ms", "1.5s", "6m0s". */
export function parseOpenAIDuration(value: string | null): number | null {
  if (!value) return null;
  let ms = 0;
  let matched = false;
  for (const [, num, unit] of value.matchAll(/([\d.]+)(ms|s|m|h)/g)) {
    matched = true;
    const n = Number.parseFloat(num!);
    ms += unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return matched ? Math.ceil(ms) : null;
}

/** Wait after an OpenAI 429: Retry-After, then the x-ratelimit-reset-* headers. */
export function openaiRetryDelayMs(headers: Headers): number {
  const retryAfter = Number(headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const resets = [
    parseOpenAIDuration(headers.get('x-ratelimit-reset-requests')),
    parseOpenAIDuration(headers.get('x-ratelimit-reset-tokens')),
  ].filter((v): v is number => v !== null);
  return resets.length ? Math.max(1000, ...resets) : DEFAULT_RETRY_MS;
}

export function createOpenAIEmbedder(opts: EmbedderOptions): Embedder {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stats: EmbedderStats = { calls: 0, rateLimited: 0 };

  async function embed(input: string[]): Promise<number[][]> {
    if (!opts.apiKey) {
      throw new EmbeddingFatalError('OPENAI_API_KEY is not set, so embeddings cannot be created.');
    }
    const apiKey = opts.apiKey;
    // OpenAI meters requests per call and tokens per text.
    const json = await opts.throttle.run(
      { requests: 1, tokens: estimateTokens(input) },
      async () => {
        stats.calls++;
        const res = await fetchImpl(OPENAI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: opts.model,
            input,
            dimensions: opts.dims,
            encoding_format: 'float',
          }),
        });
        const body: unknown = await res.json().catch(() => null);
        const err = openaiErrorSchema.safeParse(body);
        const message = (err.success && err.data.error?.message) || `HTTP ${res.status}`;
        if (res.status === 429) {
          // "insufficient_quota" means billing/credits, which waiting will not fix.
          if (err.success && err.data.error?.code === 'insufficient_quota') {
            throw new EmbeddingFatalError(`OpenAI quota exhausted (check billing): ${message}`);
          }
          stats.rateLimited++;
          const delay = openaiRetryDelayMs(res.headers);
          log.warn(`[embed] 429 from OpenAI: retry in ${Math.ceil(delay / 1000)}s`);
          opts.throttle.pauseUntil(Date.now() + Math.min(delay, MAX_SHARED_PAUSE_MS));
          throw new EmbeddingRateLimitError(new Date(Date.now() + delay), message, [
            'openai-rate-limit',
          ]);
        }
        if (res.status >= 400 && res.status < 500) {
          throw new EmbeddingFatalError(
            `OpenAI rejected the embedding request (${res.status}): ${message}`,
          );
        }
        if (!res.ok) throw new Error(`OpenAI embedding request failed: ${message}`);
        return body;
      },
    );
    const parsed = openaiResponseSchema.parse(json);
    if (parsed.data.length !== input.length) {
      throw new Error(
        `OpenAI returned ${parsed.data.length} embeddings for ${input.length} inputs`,
      );
    }
    return [...parsed.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => {
        if (d.embedding.length !== opts.dims) {
          throw new Error(`Expected ${opts.dims}-dim embeddings, got ${d.embedding.length}`);
        }
        return l2normalize(d.embedding);
      });
  }

  return {
    stats,
    async embedDocuments(texts) {
      const batches: string[][] = [];
      for (let i = 0; i < texts.length; i += opts.batchSize) {
        batches.push(texts.slice(i, i + opts.batchSize));
      }
      return (await Promise.all(batches.map(embed))).flat();
    },
    async embedQuery(text) {
      return (await embed([text]))[0]!;
    },
  };
}

// ---------------------------------------------------------------- per-provider setup

type ProviderSetup = {
  throttle: Throttle;
  apiKey: () => string | undefined;
  batchSize: number;
  /** Chunks handled per Inngest embed step: about one minute of budget. */
  stepSize: number;
  create: (opts: EmbedderOptions) => Embedder;
};

/** One throttle per provider per server process, shared by every job and query. */
const PROVIDERS: Record<EmbeddingProvider, ProviderSetup> = {
  gemini: {
    // Gemini meters per text: GEMINI_EMBED_MAX_RPM is texts per minute.
    throttle: new Throttle({
      maxPerMinute: env.GEMINI_EMBED_MAX_RPM,
      concurrency: env.EMBED_CONCURRENCY,
      maxTokensPerMinute: env.GEMINI_EMBED_MAX_TPM,
    }),
    apiKey: () => env.GEMINI_API_KEY,
    batchSize: Math.min(env.GEMINI_EMBED_BATCH_SIZE, env.GEMINI_EMBED_MAX_RPM),
    stepSize: env.GEMINI_EMBED_MAX_RPM,
    create: createGeminiEmbedder,
  },
  openai: {
    // OpenAI meters per call (RPM) and per token (TPM).
    throttle: new Throttle({
      maxPerMinute: env.OPENAI_EMBED_MAX_RPM,
      concurrency: env.EMBED_CONCURRENCY,
      maxTokensPerMinute: env.OPENAI_EMBED_MAX_TPM,
    }),
    apiKey: () => env.OPENAI_API_KEY,
    batchSize: env.OPENAI_EMBED_BATCH_SIZE,
    stepSize: env.OPENAI_EMBED_BATCH_SIZE * env.EMBED_CONCURRENCY,
    create: createOpenAIEmbedder,
  },
};

/** Batch/step sizes for a model's provider (used by the indexing pipeline). */
export function embedSizing(model: string): { batchSize: number; stepSize: number } {
  const p = PROVIDERS[providerForModel(model)];
  return { batchSize: p.batchSize, stepSize: p.stepSize };
}

/**
 * Short-lived memo of query embeddings: chat retrieval and the user-memory lookup embed the
 * same question at the same moment, so the second one reuses the first (in-flight
 * included) instead of paying for another API round trip. Keyed by the exact text sent.
 */
const QUERY_MEMO_TTL_MS = 60_000;
const QUERY_MEMO_MAX = 200;
const queryMemo = new Map<string, { at: number; vector: Promise<number[]> }>();

export function memoizedQuery(
  key: string,
  compute: () => Promise<number[]>,
  now = Date.now(),
): Promise<number[]> {
  const hit = queryMemo.get(key);
  if (hit && now - hit.at < QUERY_MEMO_TTL_MS) return hit.vector;
  const vector = compute();
  queryMemo.set(key, { at: now, vector });
  vector.catch(() => queryMemo.delete(key)); // never cache a failure
  if (queryMemo.size > QUERY_MEMO_MAX) queryMemo.delete(queryMemo.keys().next().value!);
  return vector;
}

/** Embedder for a specific model/dims (a job's or a repo's), never silently the env default. */
export function embedderFor(model: string, dims: number): Embedder {
  const p = PROVIDERS[providerForModel(model)];
  const embedder = p.create({
    model,
    dims,
    apiKey: p.apiKey(),
    throttle: p.throttle,
    batchSize: p.batchSize,
    maxItemsPerMinute: p.stepSize,
  });
  return {
    ...embedder,
    embedQuery: (text) =>
      memoizedQuery(`${model}|${dims}|${text}`, () => embedder.embedQuery(text)),
  };
}
