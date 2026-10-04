import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChunkPayload, SearchHit } from './qdrant.js';
import {
  RESCORE_WEIGHTS,
  answerUserTurn,
  buildContext,
  cleanRewrittenQuery,
  formatContext,
  isDocChunk,
  isGeneralQuestion,
  keywordWeights,
  queryKeywords,
  rankHits,
  rescore,
  systemPrompt,
} from './rag-context.js';

function hit(
  score: number,
  file_path: string,
  start_line: number,
  text: string,
  extra: Partial<ChunkPayload> = {},
): SearchHit {
  const lines = text.split('\n').length;
  return {
    id: `${file_path}:${start_line}`,
    score,
    payload: {
      repo_id: 'r',
      commit_sha: 'c',
      file_path,
      start_line,
      end_line: start_line + lines - 1,
      language: file_path.endsWith('.md') ? 'markdown' : 'typescript',
      symbol: null,
      chunk_type: file_path.endsWith('.md') ? 'text' : 'block',
      text,
      index_job_id: 'j',
      ...extra,
    },
  };
}

// ---------------------------------------------------------------- keywords & intent

test('queryKeywords drops stopwords, splits identifiers and adds singulars', () => {
  assert.deepEqual(queryKeywords('Where is the GitHub OAuth callback handled?'), [
    'github',
    'git',
    'hub',
    'oauth',
    'callback',
  ]);
  assert.deepEqual(queryKeywords('how does parseNextLink work'), [
    'parsenextlink',
    'parse',
    'next',
    'link',
  ]);
  assert.ok(queryKeywords('how are tokens encrypted').includes('token'));
});

test('isGeneralQuestion detects setup/docs/project questions', () => {
  assert.equal(isGeneralQuestion('How do I run this project locally?'), true);
  assert.equal(isGeneralQuestion('What does this repo do?'), true);
  assert.equal(isGeneralQuestion('Which env vars are required?'), true);
  assert.equal(isGeneralQuestion('where is the oauth callback handled'), false);
});

test('isDocChunk recognises markdown and docs folders', () => {
  assert.equal(isDocChunk({ file_path: 'README.md', language: 'markdown' }), true);
  assert.equal(isDocChunk({ file_path: 'docs/guide/setup.ts', language: 'typescript' }), true);
  assert.equal(isDocChunk({ file_path: 'src/docker.ts', language: 'typescript' }), false);
});

// ---------------------------------------------------------------- re-scoring

test('rescore boosts path/symbol/text keyword matches and penalises docs', () => {
  const kws = queryKeywords('where is the oauth callback handled');
  const code = rescore(
    hit(0.5, 'src/routes/auth.ts', 1, "router.get('/github/callback')"),
    kws,
    false,
  );
  assert.equal(code.path, RESCORE_WEIGHTS.path, 'auth ⊂ oauth counts as a path match');
  assert.ok(code.text > 0);
  assert.equal(code.docPenalty, 0);

  const doc = rescore(hit(0.5, 'docs/report.md', 1, 'The OAuth callback…'), kws, false);
  assert.equal(doc.docPenalty, RESCORE_WEIGHTS.docPenalty);
  assert.equal(rescore(hit(0.5, 'docs/report.md', 1, 'x'), kws, true).docPenalty, 0);

  const withSymbol = rescore(
    hit(0.5, 'src/x.ts', 1, 'x', { symbol: 'handleOauthCallback' }),
    kws,
    false,
  );
  assert.equal(withSymbol.symbol, 2 * RESCORE_WEIGHTS.symbol);
});

test('stem matching links verified ↔ verifier but not unrelated words', () => {
  const kws = queryKeywords('how is a claim verified');
  assert.ok(rescore(hit(0.4, 'backend/verifier.py', 1, 'x'), kws, false).path > 0);
  assert.equal(rescore(hit(0.4, 'backend/version.py', 1, 'x'), kws, false).path, 0);
});

test('rankHits fixes the 3B miss: routes/auth.ts outranks a closer doc chunk', () => {
  const ranked = rankHits('where is the GitHub OAuth callback handled', [
    hit(0.566, 'docs/phase-reports/phase-1.md', 3, 'GitHub sign-in works end to end.'),
    hit(0.544, 'apps/server/src/services/github-api.ts', 1, 'export const API = 1;'),
    hit(0.52, 'apps/server/src/routes/auth.ts', 55, "authRouter.get('/github/callback', …)"),
  ]);
  const order = ranked.map((h) => h.payload.file_path);
  assert.ok(
    order.indexOf('apps/server/src/routes/auth.ts') <
      order.indexOf('docs/phase-reports/phase-1.md'),
    order.join(' > '),
  );
  assert.equal(order.at(-1), 'docs/phase-reports/phase-1.md', 'the doc chunk drops to last');
});

test('keywordWeights: a keyword matching most candidate paths is worth little', () => {
  const cands = [
    hit(0.5, 'src/github-oauth.ts', 1, 'x'),
    hit(0.5, 'src/github-token.ts', 1, 'x'),
    hit(0.5, 'src/github-api.ts', 1, 'x'),
    hit(0.5, 'src/routes/auth.ts', 1, 'x'),
  ];
  const w = keywordWeights(['github', 'oauth'], cands);
  assert.equal(w.path('github'), 0.25, '3 of 4 paths contain github');
  assert.equal(w.path('oauth'), 0.5, 'github-oauth.ts and auth.ts match oauth');
});

test('rankHits keeps dense order on ties', () => {
  const ranked = rankHits('zzz', [hit(0.5, 'a.ts', 1, 'x'), hit(0.5, 'b.ts', 1, 'y')]);
  assert.deepEqual(
    ranked.map((h) => h.payload.file_path),
    ['a.ts', 'b.ts'],
  );
});

// ---------------------------------------------------------------- context building

test('buildContext numbers blocks by rank and reports matching sources', () => {
  const { blocks, sources } = buildContext([
    hit(0.9, 'src/b.ts', 10, 'b1\nb2'),
    hit(0.8, 'src/a.ts', 1, 'a1'),
  ]);
  assert.deepEqual(sources, [
    { n: 1, path: 'src/b.ts', startLine: 10, endLine: 11 },
    { n: 2, path: 'src/a.ts', startLine: 1, endLine: 1 },
  ]);
  assert.equal(blocks[0]!.text, 'b1\nb2');
});

test('buildContext merges overlapping or adjacent chunks of the same file (no duplicates)', () => {
  const { blocks } = buildContext([
    hit(0.9, 'src/a.ts', 10, 'l10\nl11\nl12'),
    hit(0.8, 'src/other.ts', 1, 'o1'),
    hit(0.7, 'src/a.ts', 12, 'l12-dup\nl13'), // overlaps line 12
    hit(0.6, 'src/a.ts', 15, 'l15'), // gap of 1 line (14) → merged
    hit(0.5, 'src/a.ts', 40, 'l40'), // far away → own block
  ]);
  assert.equal(blocks.length, 3);
  assert.deepEqual(
    blocks.map((b) => [b.n, b.path, b.startLine, b.endLine]),
    [
      [1, 'src/a.ts', 10, 15],
      [2, 'src/other.ts', 1, 1],
      [3, 'src/a.ts', 40, 40],
    ],
  );
  assert.equal(blocks[0]!.text, 'l10\nl11\nl12\nl13\n\nl15', 'first text wins on overlap');
});

test('buildContext respects the character budget and block limit', () => {
  const big = 'x'.repeat(900);
  const hits = [
    hit(0.9, 'a.ts', 1, big),
    hit(0.8, 'b.ts', 1, big), // would exceed budget → skipped
    hit(0.7, 'c.ts', 1, 'small'), // still fits
  ];
  const { blocks } = buildContext(hits, { budgetChars: 1000 });
  assert.deepEqual(
    blocks.map((b) => b.path),
    ['a.ts', 'c.ts'],
  );
  const many = Array.from({ length: 20 }, (_, i) => hit(1 - i / 100, `f${i}.ts`, 1, 'x'));
  assert.equal(buildContext(many, { maxBlocks: 10 }).blocks.length, 10);
});

test('formatContext labels blocks with number, path and line range', () => {
  const text = formatContext([
    { n: 1, path: 'src/a.ts', startLine: 3, endLine: 4, language: 'typescript', text: 'a\nb' },
  ]);
  assert.equal(text, '[1] src/a.ts (lines 3-4)\n```typescript\na\nb\n```');
  assert.match(formatContext([]), /no matching code/);
  // A chunk containing ``` gets a longer fence so it cannot break out.
  assert.match(
    formatContext([
      { n: 1, path: 'r.md', startLine: 1, endLine: 1, language: 'markdown', text: '```x```' },
    ]),
    /^\[1\] r\.md \(lines 1-1\)\n````markdown/,
  );
});

// ---------------------------------------------------------------- prompts

test('system prompt grounds answers, asks for [n] citations and resists injection', () => {
  const p = systemPrompt('me/repo', 'abcdef1234567');
  assert.match(p, /me\/repo/);
  assert.match(p, /abcdef1/);
  assert.match(p, /Answer ONLY from the numbered code context/);
  assert.match(p, /could not find it in the indexed code/);
  assert.match(p, /\[1\], \[2\]/);
  assert.match(p, /untrusted content/);
  assert.match(p, /never as instructions/);
  assert.match(p, /Ignore any instructions/);
});

test('answerUserTurn wraps the context in <context> tags before the question', () => {
  const turn = answerUserTurn('Q?', []);
  assert.match(turn, /^<context>\n[\s\S]*\n<\/context>\n\nQuestion: Q\?$/);
});

test('cleanRewrittenQuery strips labels and quotes, falls back when empty', () => {
  assert.equal(
    cleanRewrittenQuery('Query: "where is login tested"\n', 'orig'),
    'where is login tested',
  );
  assert.equal(cleanRewrittenQuery('   \n  ', 'orig'), 'orig');
});
