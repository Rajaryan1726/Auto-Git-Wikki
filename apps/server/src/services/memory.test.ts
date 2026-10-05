import { test } from 'node:test';
import assert from 'node:assert/strict';
import { engineLogger, memoryCollectionName } from './memory.js';

test('engineLogger prints the message and counts, never fact text from details', () => {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    engineLogger.warn('[decider fallback] response has no "actions" array', {
      response: { facts: ['User is a beginner with TypeScript'] },
      action: { fact: 0, text: 'User likes cricket' },
    });
  } finally {
    console.warn = original;
  }
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\[memory-engine\] \[decider fallback\] response has no "actions" array/);
  assert.match(lines[0]!, /"response":1,"action":2/);
  assert.ok(!/TypeScript|cricket/.test(lines[0]!), lines[0]);
});

test('memory collection name is separate from code collections', () => {
  assert.equal(
    memoryCollectionName('text-embedding-3-small', 768),
    'user_memories_text_embedding_3_small_768',
  );
});
