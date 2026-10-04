import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, formatSseEvent } from '@autowiki/shared';
import {
  LlmError,
  generateText,
  generationBreaker,
  openStream,
  providerForGenModel,
  resilientStream,
} from './llm.js';

function sse(lines: string[], status = 200): Response {
  return new Response(lines.join(''), {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const geminiChunk = (text: string) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\n\n`;
const openaiDelta = (delta: string) =>
  `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`;

const req = { system: 's', messages: [{ role: 'user' as const, content: 'q' }] };

// The breaker is process-wide; every test starts with all providers available.
beforeEach(() => generationBreaker.reset());

test('formatSseEvent produces one event with JSON data', () => {
  assert.equal(
    formatSseEvent('token', { text: 'a\nb' }),
    'event: token\ndata: {"text":"a\\nb"}\n\n',
  );
});

test('createSseParser handles split chunks, CRLF, comments and default event', () => {
  const p = createSseParser();
  assert.deepEqual(p.feed('event: tok'), []);
  assert.deepEqual(p.feed('en\r\ndata: {"a":1}\r\n\r\n: keep-alive\n\ndata: x\n'), [
    { event: 'token', data: '{"a":1}' },
  ]);
  assert.deepEqual(p.feed('data: y\n\n'), [{ event: 'message', data: 'x\ny' }]);
});

test('providerForGenModel maps ids and rejects unknown ones', () => {
  assert.equal(providerForGenModel('gemini-3.8-flash'), 'gemini');
  assert.equal(providerForGenModel('gpt-6-luna'), 'openai');
  assert.equal(providerForGenModel('o4-mini'), 'openai');
  assert.throws(() => providerForGenModel('llama-3'));
});

test('Gemini stream yields text parts and skips thought parts', async () => {
  const fetchImpl = (async () =>
    sse([
      geminiChunk('Hello'),
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'secret', thought: true }] } }] })}\n\n`,
      geminiChunk(' world'),
    ])) as unknown as typeof fetch;
  const out = await generateText(req, ['gemini-3.8-flash'], fetchImpl);
  assert.deepEqual(out, {
    text: 'Hello world',
    model: 'gemini-3.8-flash',
    usage: null,
    failedOrSkipped: [],
  });
});

test('falls back to the next model when the primary fails before streaming', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    if (String(url).includes('generativelanguage')) {
      return Response.json({ error: { message: 'Quota exceeded' } }, { status: 429 });
    }
    return sse([openaiDelta('Fallback '), openaiDelta('answer')]);
  }) as unknown as typeof fetch;
  const opened = await openStream(req, ['gemini-3.8-flash', 'gpt-6-luna'], fetchImpl);
  assert.equal(opened.model, 'gpt-6-luna');
  assert.equal(opened.failures[0]!.model, 'gemini-3.8-flash');
  assert.match(opened.failures[0]!.message, /Quota exceeded/);
  let text = '';
  for await (const t of opened.stream) text += t;
  assert.equal(text, 'Fallback answer');
  assert.equal(calls.length, 2);
});

test('bad key (400) on the primary also falls back', async () => {
  const fetchImpl = (async (url: string) =>
    String(url).includes('generativelanguage')
      ? Response.json({ error: { message: 'API key not valid' } }, { status: 400 })
      : sse([openaiDelta('ok')])) as unknown as typeof fetch;
  const out = await generateText(req, ['gemini-3.8-flash', 'gpt-6-luna'], fetchImpl);
  assert.equal(out.model, 'gpt-6-luna');
});

test('when every model fails, a combined LlmError is thrown', async () => {
  const fetchImpl = (async () =>
    Response.json({ error: { message: 'boom' } }, { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(openStream(req, ['gemini-3.8-flash', 'gpt-6-luna'], fetchImpl), (err) => {
    assert.ok(err instanceof LlmError);
    assert.match(err.message, /All generation models failed/);
    return true;
  });
});

test('an OpenAI response.failed event surfaces as an error', async () => {
  const fetchImpl = (async () =>
    sse([
      `data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'model overloaded' } } })}\n\n`,
    ])) as unknown as typeof fetch;
  await assert.rejects(
    generateText(req, ['gpt-6-luna'], fetchImpl),
    /All generation models failed/,
  );
});

test('a mid-answer failure resets and restarts with the fallback model', async () => {
  const fetchImpl = (async (url: string) =>
    String(url).includes('generativelanguage')
      ? sse([
          geminiChunk('Partial '),
          `data: ${JSON.stringify({ error: { message: 'This model is currently experiencing high demand.', code: 503 } })}\n\n`,
        ])
      : sse([openaiDelta('Full '), openaiDelta('answer')])) as unknown as typeof fetch;
  const events = [];
  for await (const e of resilientStream(req, ['gemini-3.8-flash', 'gpt-6-luna'], fetchImpl)) {
    events.push(
      e.type === 'token' ? `token:${e.text}` : e.type === 'model' ? `model:${e.model}` : 'reset',
    );
  }
  assert.deepEqual(events, [
    'model:gemini-3.8-flash',
    'token:Partial ',
    'reset',
    'model:gpt-6-luna',
    'token:Full ',
    'token:answer',
  ]);
  // generateText drops the partial text after a reset.
  assert.deepEqual(await generateText(req, ['gemini-3.8-flash', 'gpt-6-luna'], fetchImpl), {
    text: 'Full answer',
    model: 'gpt-6-luna',
    usage: null,
    failedOrSkipped: ['gemini-3.8-flash'],
  });
});

test('a mid-answer failure on the last model is thrown', async () => {
  const fetchImpl = (async () =>
    sse([
      openaiDelta('x'),
      `data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'boom' } } })}\n\n`,
    ])) as unknown as typeof fetch;
  await assert.rejects(async () => {
    for await (const _e of resilientStream(req, ['gpt-6-luna'], fetchImpl)) void _e;
  }, /boom/);
});

test('circuit breaker: after a Gemini 429, requests go straight to the fallback', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url).includes('generativelanguage') ? 'gemini' : 'openai');
    if (String(url).includes('generativelanguage')) {
      return Response.json(
        {
          error: {
            code: 429,
            message: 'You exceeded your current quota.',
            details: [{ retryDelay: '120s' }],
          },
        },
        { status: 429 },
      );
    }
    return sse([openaiDelta('ok')]);
  }) as unknown as typeof fetch;
  const models = ['gemini-3.8-flash', 'gpt-6-luna'];

  const first = await generateText(req, models, fetchImpl);
  assert.equal(first.model, 'gpt-6-luna');
  assert.deepEqual(calls, ['gemini', 'openai']);
  assert.equal(generationBreaker.isOpen('gemini'), true);

  calls.length = 0;
  const second = await generateText(req, models, fetchImpl);
  assert.equal(second.model, 'gpt-6-luna');
  assert.deepEqual(calls, ['openai'], 'no Gemini call while the breaker is open');
  assert.deepEqual(second.failedOrSkipped, ['gemini-3.8-flash']);
});

test('circuit breaker: a non-quota error (bad key) does not open it', async () => {
  const fetchImpl = (async (url: string) =>
    String(url).includes('generativelanguage')
      ? Response.json({ error: { message: 'API key not valid' } }, { status: 400 })
      : sse([openaiDelta('ok')])) as unknown as typeof fetch;
  await generateText(req, ['gemini-3.8-flash', 'gpt-6-luna'], fetchImpl);
  assert.equal(generationBreaker.isOpen('gemini'), false);
});

test('circuit breaker: when every provider is open, they are still tried', async () => {
  generationBreaker.trip('gemini', 120_000, 'test');
  generationBreaker.trip('openai', 120_000, 'test');
  const fetchImpl = (async () => sse([geminiChunk('hi')])) as unknown as typeof fetch;
  const out = await generateText(req, ['gemini-3.8-flash', 'gpt-6-luna'], fetchImpl);
  assert.equal(out.model, 'gemini-3.8-flash');
  assert.equal(generationBreaker.isOpen('gemini'), false, 'success closes it');
});

test('token usage is reported for Gemini and OpenAI', async () => {
  const gemini = (async () =>
    sse([
      geminiChunk('a'),
      `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'b' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 } })}\n\n`,
    ])) as unknown as typeof fetch;
  const g = await generateText(req, ['gemini-3.8-flash'], gemini);
  assert.deepEqual(g.usage, { inputTokens: 100, outputTokens: 25 });

  const openai = (async () =>
    sse([
      openaiDelta('x'),
      `data: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 50, output_tokens: 7 } } })}\n\n`,
    ])) as unknown as typeof fetch;
  const o = await generateText(req, ['gpt-6-luna'], openai);
  assert.deepEqual(o.usage, { inputTokens: 50, outputTokens: 7 });
});

test('OpenAI json mode adds the word "json" to the input when it is missing', async () => {
  const { openAIInput } = await import('./llm.js');
  const msgs = [{ role: 'user' as const, content: 'Conversation: hi' }];
  assert.match(
    openAIInput({ system: 'Return JSON', messages: msgs, json: true }).at(-1)!.content,
    /JSON object/,
  );
  assert.equal(openAIInput({ system: 's', messages: msgs }).at(-1)!.content, 'Conversation: hi');
  const hasIt = [{ role: 'user' as const, content: 'give me json' }];
  assert.equal(
    openAIInput({ system: 's', messages: hasIt, json: true })[0]!.content,
    'give me json',
  );
});
