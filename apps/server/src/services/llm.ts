import { createSseParser } from '@autowiki/shared';
import { env } from '../lib/env.js';
import { CircuitBreaker, isQuotaError, retryAfterMsFrom } from './circuit-breaker.js';

/**
 * Text generation over the providers' REST streaming APIs.
 *   Gemini: models/{model}:streamGenerateContent?alt=sse
 *   OpenAI: /v1/responses with stream: true (response.output_text.delta events)
 * The provider follows the model id. `openStream` tries the primary model and, if it fails
 * before producing any text (quota, 429, 5xx, bad key, network), the fallback model.
 * A quota / rate-limit error opens that provider's circuit breaker: until its retry time
 * (60 s – 1 h) requests skip it and go straight to the next model.
 */

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export type TokenUsage = { inputTokens: number; outputTokens: number };

export type GenerateRequest = {
  system: string;
  messages: ChatTurn[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Ask the provider for a JSON object (Gemini responseMimeType, OpenAI json_object). */
  json?: boolean;
  /** Called once per model attempt with the provider-reported token usage, if any. */
  onUsage?: (usage: TokenUsage, model: string) => void;
};

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly model: string,
    /** Provider retry hint for rate-limit errors, in ms. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

export type GenProvider = 'gemini' | 'openai';

export function providerForGenModel(model: string): GenProvider {
  if (/^gemini-/.test(model)) return 'gemini';
  if (/^(gpt-|o\d)/.test(model)) return 'openai';
  throw new Error(`Unknown generation model "${model}": cannot tell which provider serves it.`);
}

type FetchLike = typeof fetch;

/** Shared by every generation call in this process (chat, query rewrite, wiki). */
export const generationBreaker = new CircuitBreaker();

type ErrorBody = { error?: { message?: string; details?: { retryDelay?: string }[] } };

async function httpError(res: Response, model: string): Promise<LlmError> {
  const body = (await res.json().catch(() => null)) as ErrorBody | null;
  return new LlmError(
    body?.error?.message ?? `HTTP ${res.status}`,
    res.status,
    model,
    retryAfterMsFrom(res.headers, body),
  );
}

/** Reads a fetch body as text chunks. */
async function* readChunks(res: Response): AsyncGenerator<string> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

async function* streamGemini(
  model: string,
  req: GenerateRequest,
  fetchImpl: FetchLike,
): AsyncGenerator<string> {
  if (!env.GEMINI_API_KEY) throw new LlmError('GEMINI_API_KEY is not set', null, model);
  const res = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
    {
      method: 'POST',
      signal: req.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: req.messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: req.maxOutputTokens ?? 4096,
          thinkingConfig: { thinkingLevel: 'low' },
          ...(req.json ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    },
  );
  if (!res.ok) throw await httpError(res, model);

  const parser = createSseParser();
  let usage: TokenUsage | null = null;
  for await (const chunk of readChunks(res)) {
    for (const msg of parser.feed(chunk)) {
      const data = JSON.parse(msg.data) as {
        error?: { message?: string; code?: number; details?: { retryDelay?: string }[] };
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          thoughtsTokenCount?: number;
        };
      };
      if (data.error) {
        throw new LlmError(
          data.error.message ?? 'Gemini stream error',
          data.error.code ?? null,
          model,
          retryAfterMsFrom(null, data),
        );
      }
      // Cumulative: the last chunk carries the totals (thinking tokens are billed as output).
      if (data.usageMetadata) {
        const u = data.usageMetadata;
        usage = {
          inputTokens: u.promptTokenCount ?? 0,
          outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
        };
      }
      for (const part of data.candidates?.[0]?.content?.parts ?? []) {
        if (part.text && !part.thought) yield part.text;
      }
    }
  }
  if (usage) req.onUsage?.(usage, model);
}

async function* streamOpenAI(
  model: string,
  req: GenerateRequest,
  fetchImpl: FetchLike,
): AsyncGenerator<string> {
  if (!env.OPENAI_API_KEY) throw new LlmError('OPENAI_API_KEY is not set', null, model);
  const res = await fetchImpl('https://api.openai.com/v1/responses', {
    method: 'POST',
    signal: req.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    // No temperature: newer reasoning models reject it.
    body: JSON.stringify({
      model,
      instructions: req.system,
      input: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      max_output_tokens: req.maxOutputTokens ?? 4096,
      ...(req.json ? { text: { format: { type: 'json_object' } } } : {}),
    }),
  });
  if (!res.ok) throw await httpError(res, model);

  const parser = createSseParser();
  for await (const chunk of readChunks(res)) {
    for (const msg of parser.feed(chunk)) {
      const data = JSON.parse(msg.data) as {
        type?: string;
        delta?: string;
        message?: string;
        code?: string;
        response?: {
          error?: { message?: string; code?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
        };
      };
      if (data.type === 'response.output_text.delta' && data.delta) yield data.delta;
      else if (data.type === 'response.completed' && data.response?.usage) {
        req.onUsage?.(
          {
            inputTokens: data.response.usage.input_tokens ?? 0,
            outputTokens: data.response.usage.output_tokens ?? 0,
          },
          model,
        );
      } else if (data.type === 'response.failed' || data.type === 'error') {
        const code = data.response?.error?.code ?? data.code;
        throw new LlmError(
          data.response?.error?.message ?? data.message ?? 'OpenAI stream error',
          code === 'rate_limit_exceeded' || code === 'insufficient_quota' ? 429 : null,
          model,
        );
      }
    }
  }
}

export function streamText(
  model: string,
  req: GenerateRequest,
  fetchImpl: FetchLike = fetch,
): AsyncGenerator<string> {
  return providerForGenModel(model) === 'gemini'
    ? streamGemini(model, req, fetchImpl)
    : streamOpenAI(model, req, fetchImpl);
}

export type OpenedStream = {
  model: string;
  /** Models that failed before this one, with their errors (for logging). */
  failures: { model: string; message: string }[];
  /** Models skipped without a call because their provider's circuit breaker is open. */
  skipped: string[];
  stream: AsyncGenerator<string>;
};

/** Opens the provider's breaker when the error is a quota / rate-limit error. */
function noteFailure(model: string, err: unknown): void {
  if (!(err instanceof LlmError)) return;
  if (isQuotaError(err.status, err.message)) {
    generationBreaker.trip(providerForGenModel(model), err.retryAfterMs, err.message);
  }
}

/**
 * Models in the order to try: those whose provider breaker is open are skipped. If every
 * provider is open, all are tried anyway (better a likely failure than no attempt).
 */
export function routeModels(models: string[]): { order: string[]; skipped: string[] } {
  const skipped = models.filter((m) => generationBreaker.isOpen(providerForGenModel(m)));
  if (skipped.length === models.length) return { order: models, skipped: [] };
  return { order: models.filter((m) => !skipped.includes(m)), skipped };
}

/**
 * Starts generation with the first model that produces text. A model that fails before
 * its first token is skipped (logged); once text has streamed there is no switching.
 */
export async function openStream(
  req: GenerateRequest,
  models: string[] = [env.GEN_MODEL_PRIMARY, env.GEN_MODEL_FALLBACK],
  fetchImpl: FetchLike = fetch,
): Promise<OpenedStream> {
  const failures: OpenedStream['failures'] = [];
  const { order, skipped } = routeModels(models);
  for (const model of order) {
    const gen = streamText(model, req, fetchImpl);
    try {
      const first = await gen.next();
      generationBreaker.succeed(providerForGenModel(model));
      async function* rest(): AsyncGenerator<string> {
        if (!first.done) yield first.value;
        yield* gen;
      }
      return { model, failures, skipped, stream: rest() };
    } catch (err) {
      if (req.signal?.aborted) throw err;
      noteFailure(model, err);
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof LlmError && err.status ? ` (${err.status})` : '';
      console.warn(`[llm] ${model} failed before streaming${status}: ${message.slice(0, 200)}`);
      failures.push({ model, message });
    }
  }
  const last = failures[failures.length - 1];
  throw new LlmError(
    `All generation models failed. Last error: ${last?.message ?? 'unknown'}`,
    null,
    last?.model ?? 'none',
  );
}

export type AnswerEvent =
  /** A model started producing text (sent again after a reset). */
  | { type: 'model'; model: string; failures: OpenedStream['failures']; skipped: string[] }
  | { type: 'token'; text: string }
  /** The model failed mid-answer; discard the text so far, the next model restarts. */
  | { type: 'reset'; failedModel: string; reason: string };

/**
 * Like openStream, but also survives a failure in the middle of an answer (e.g. Gemini
 * "high demand" after some tokens): it emits `reset` and restarts with the next model.
 */
export async function* resilientStream(
  req: GenerateRequest,
  models: string[] = [env.GEN_MODEL_PRIMARY, env.GEN_MODEL_FALLBACK],
  fetchImpl: FetchLike = fetch,
): AsyncGenerator<AnswerEvent> {
  let remaining = models;
  for (;;) {
    const opened = await openStream(req, remaining, fetchImpl); // throws if none can start
    yield {
      type: 'model',
      model: opened.model,
      failures: opened.failures,
      skipped: opened.skipped,
    };
    try {
      for await (const text of opened.stream) yield { type: 'token', text };
      return;
    } catch (err) {
      if (req.signal?.aborted) throw err;
      noteFailure(opened.model, err);
      remaining = remaining.slice(remaining.indexOf(opened.model) + 1);
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[llm] ${opened.model} failed mid-stream: ${reason.slice(0, 200)}`);
      if (remaining.length === 0) throw err;
      yield { type: 'reset', failedModel: opened.model, reason };
    }
  }
}

export type GeneratedText = {
  text: string;
  model: string;
  /** Summed over every attempt (a failed partial answer is billed too); null if unreported. */
  usage: TokenUsage | null;
  /** Models skipped (breaker open) or failed before the one that answered. */
  failedOrSkipped: string[];
};

/** Non-streaming convenience (query rewriting, wiki): collects the full text, with fallback. */
export async function generateText(
  req: GenerateRequest,
  models?: string[],
  fetchImpl: FetchLike = fetch,
): Promise<GeneratedText> {
  let text = '';
  let model = '';
  let usage: TokenUsage | null = null;
  const failedOrSkipped: string[] = [];
  const onUsage = (u: TokenUsage, m: string) => {
    usage = {
      inputTokens: (usage?.inputTokens ?? 0) + u.inputTokens,
      outputTokens: (usage?.outputTokens ?? 0) + u.outputTokens,
    };
    req.onUsage?.(u, m);
  };
  for await (const e of resilientStream({ ...req, onUsage }, models, fetchImpl)) {
    if (e.type === 'model') {
      model = e.model;
      failedOrSkipped.push(...e.skipped, ...e.failures.map((f) => f.model));
    } else if (e.type === 'token') text += e.text;
    else {
      failedOrSkipped.push(e.failedModel);
      text = '';
    }
  }
  return { text, model, usage, failedOrSkipped };
}
