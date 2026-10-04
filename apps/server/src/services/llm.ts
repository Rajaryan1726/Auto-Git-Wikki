import { createSseParser } from '@autowiki/shared';
import { env } from '../lib/env.js';

/**
 * Text generation over the providers' REST streaming APIs.
 *   Gemini: models/{model}:streamGenerateContent?alt=sse
 *   OpenAI: /v1/responses with stream: true (response.output_text.delta events)
 * The provider follows the model id. `openStream` tries the primary model and, if it fails
 * before producing any text (quota, 429, 5xx, bad key, network), the fallback model.
 */

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

export type GenerateRequest = {
  system: string;
  messages: ChatTurn[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly model: string,
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

async function errorText(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `HTTP ${res.status}`;
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
        },
      }),
    },
  );
  if (!res.ok) throw new LlmError(await errorText(res), res.status, model);

  const parser = createSseParser();
  for await (const chunk of readChunks(res)) {
    for (const msg of parser.feed(chunk)) {
      const data = JSON.parse(msg.data) as {
        error?: { message?: string; code?: number };
        candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
      };
      if (data.error) {
        throw new LlmError(
          data.error.message ?? 'Gemini stream error',
          data.error.code ?? null,
          model,
        );
      }
      for (const part of data.candidates?.[0]?.content?.parts ?? []) {
        if (part.text && !part.thought) yield part.text;
      }
    }
  }
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
    }),
  });
  if (!res.ok) throw new LlmError(await errorText(res), res.status, model);

  const parser = createSseParser();
  for await (const chunk of readChunks(res)) {
    for (const msg of parser.feed(chunk)) {
      const data = JSON.parse(msg.data) as {
        type?: string;
        delta?: string;
        message?: string;
        response?: { error?: { message?: string } };
      };
      if (data.type === 'response.output_text.delta' && data.delta) yield data.delta;
      else if (data.type === 'response.failed' || data.type === 'error') {
        throw new LlmError(
          data.response?.error?.message ?? data.message ?? 'OpenAI stream error',
          null,
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
  stream: AsyncGenerator<string>;
};

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
  for (const model of models) {
    const gen = streamText(model, req, fetchImpl);
    try {
      const first = await gen.next();
      async function* rest(): AsyncGenerator<string> {
        if (!first.done) yield first.value;
        yield* gen;
      }
      return { model, failures, stream: rest() };
    } catch (err) {
      if (req.signal?.aborted) throw err;
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
  | { type: 'model'; model: string; failures: OpenedStream['failures'] }
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
    yield { type: 'model', model: opened.model, failures: opened.failures };
    try {
      for await (const text of opened.stream) yield { type: 'token', text };
      return;
    } catch (err) {
      if (req.signal?.aborted) throw err;
      remaining = remaining.slice(remaining.indexOf(opened.model) + 1);
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[llm] ${opened.model} failed mid-stream: ${reason.slice(0, 200)}`);
      if (remaining.length === 0) throw err;
      yield { type: 'reset', failedModel: opened.model, reason };
    }
  }
}

/** Non-streaming convenience (query rewriting): collects the full text, with fallback. */
export async function generateText(
  req: GenerateRequest,
  models?: string[],
  fetchImpl: FetchLike = fetch,
): Promise<{ text: string; model: string }> {
  let text = '';
  let model = '';
  for await (const e of resilientStream(req, models, fetchImpl)) {
    if (e.type === 'model') model = e.model;
    else if (e.type === 'token') text += e.text;
    else text = '';
  }
  return { text, model };
}
