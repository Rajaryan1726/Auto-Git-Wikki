import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_QUERY_FORMAT,
  DOCUMENT_FORMAT,
  chunkTitle,
  formatCodeQuery,
  formatDocument,
} from './embedding-format.js';

test('formats match the documented gemini-embedding-2 strings exactly', () => {
  assert.equal(DOCUMENT_FORMAT, 'title: {title} | text: {content}');
  assert.equal(CODE_QUERY_FORMAT, 'task: code retrieval | query: {content}');
});

test('formatDocument puts the title and the untouched content in place', () => {
  const content = 'export function add(a, b) {\n  return a + b;\n}';
  assert.equal(
    formatDocument(content, 'src/math.ts (add)'),
    `title: src/math.ts (add) | text: ${content}`,
  );
});

test('formatDocument uses "title: none" when there is no title', () => {
  assert.equal(formatDocument('hello', null), 'title: none | text: hello');
  assert.equal(formatDocument('hello', '   '), 'title: none | text: hello');
});

test('titles are collapsed to one line', () => {
  assert.equal(formatDocument('x', 'a\n  b'), 'title: a b | text: x');
});

test('content containing format-like text or $ patterns is not altered', () => {
  const tricky = "const s = '$& {content} | text: {title}';";
  assert.equal(formatDocument(tricky, 't'), `title: t | text: ${tricky}`);
  assert.equal(
    formatCodeQuery('where is $1 used?'),
    'task: code retrieval | query: where is $1 used?',
  );
});

test('formatCodeQuery trims the question', () => {
  assert.equal(
    formatCodeQuery('  how is auth handled?  '),
    'task: code retrieval | query: how is auth handled?',
  );
});

test('chunkTitle includes the symbol when present', () => {
  assert.equal(chunkTitle('src/a.ts', 'Store.get'), 'src/a.ts (Store.get)');
  assert.equal(chunkTitle('README.md', null), 'README.md');
});

test('providerForModel maps model ids and rejects unknown ones', async () => {
  const { providerForModel } = await import('./embedding-format.js');
  assert.equal(providerForModel('gemini-embedding-2'), 'gemini');
  assert.equal(providerForModel('models/gemini-embedding-001'), 'gemini');
  assert.equal(providerForModel('text-embedding-3-small'), 'openai');
  assert.equal(providerForModel('text-embedding-3-large'), 'openai');
  assert.equal(providerForModel('text-embedding-ada-002'), 'openai');
  assert.throws(() => providerForModel('mystery-model'), /Unknown embedding model/);
});

test('OpenAI formats: path as first line for documents, raw query', () => {
  assert.equal(formatDocument('code', 'src/a.ts (f)', 'openai'), 'src/a.ts (f)\n\ncode');
  assert.equal(formatDocument('code', null, 'openai'), 'code');
  assert.equal(formatCodeQuery('  how does login work?  ', 'openai'), 'how does login work?');
  // Gemini formats are unchanged when the provider is explicit.
  assert.equal(formatCodeQuery('x', 'gemini'), 'task: code retrieval | query: x');
});
