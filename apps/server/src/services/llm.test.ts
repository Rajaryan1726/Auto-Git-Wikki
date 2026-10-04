import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, formatSseEvent } from '@autowiki/shared';
import { LlmError, generateText, openStream, providerForGenModel } from './llm.js';

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
  assert.deepEqual(out, { text: 'Hello world', model: 'gemini-3.8-flash' });
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
