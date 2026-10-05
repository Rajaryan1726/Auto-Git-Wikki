import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNextLink, rateLimitError } from './github-api.js';
import { listUserRepos, parseGithubRepo, parseSsoPartialOrgs } from './github-repos.js';
import { deriveIndexStatus, isStale, type JobRow } from './repo-status.js';

function json(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
}

const repo = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  name: `repo-${id}`,
  full_name: `me/repo-${id}`,
  description: null,
  private: id % 2 === 0,
  default_branch: 'main',
  language: 'TypeScript',
  updated_at: '2026-01-01T00:00:00Z',
  pushed_at: '2026-01-02T00:00:00Z',
  ...extra,
});

test('parseNextLink extracts the next page as a relative path', () => {
  const link =
    '<https://api.github.com/user/repos?page=2&per_page=100>; rel="next", ' +
    '<https://api.github.com/user/repos?page=5&per_page=100>; rel="last"';
  assert.equal(parseNextLink(link), '/user/repos?page=2&per_page=100');
  assert.equal(parseNextLink('<https://api.github.com/x?page=1>; rel="prev"'), null);
  assert.equal(parseNextLink(null), null);
  assert.equal(parseNextLink('<https://evil.example/x?page=2>; rel="next"'), null);
});

test('rateLimitError detects primary and secondary limits only', () => {
  const now = 1_000_000_000_000;
  const primary = rateLimitError(
    new Response('', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 600) },
    }),
    now,
  );
  assert.equal(primary?.status, 429);
  assert.equal(primary?.code, 'GITHUB_RATE_LIMITED');
  assert.match(primary!.message, /10 minutes/);

  const secondary = rateLimitError(
    new Response('', { status: 429, headers: { 'retry-after': '30' } }),
  );
  assert.match(secondary!.message, /1 minute\./);

  assert.equal(rateLimitError(new Response('', { status: 403 })), null);
  assert.equal(rateLimitError(new Response('', { status: 200 })), null);
});

test('parseGithubRepo maps fields and rejects malformed items', () => {
  const parsed = parseGithubRepo(repo(7, { description: 'hello' }));
  assert.deepEqual(parsed, {
    githubRepoId: 7,
    name: 'repo-7',
    fullName: 'me/repo-7',
    description: 'hello',
    isPrivate: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    githubUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    githubPushedAt: new Date('2026-01-02T00:00:00Z'),
  });
  assert.equal(parseGithubRepo({ id: 'nope' }), null);
  assert.equal(parseGithubRepo(repo(8, { pushed_at: null }))?.githubPushedAt, null);
});

test('parseSsoPartialOrgs reads organization ids', () => {
  assert.deepEqual(parseSsoPartialOrgs('partial-results; organizations=21955855,20582480'), [
    '21955855',
    '20582480',
  ]);
  assert.deepEqual(parseSsoPartialOrgs('required; url=https://github.com/...'), []);
  assert.deepEqual(parseSsoPartialOrgs(null), []);
});

test('listUserRepos follows pagination, dedupes and counts invalid items', async () => {
  const calls: string[] = [];
  const result = await listUserRepos(async (path) => {
    calls.push(path);
    if (!path.includes('page=2')) {
      return json([repo(1), repo(2), { broken: true }], {
        headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
      });
    }
    return json([repo(2), repo(3)]);
  });
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /affiliation=owner,collaborator,organization_member/);
  assert.match(calls[0]!, /per_page=100/);
  assert.deepEqual(
    result.repos.map((r) => r.githubRepoId),
    [1, 2, 3],
  );
  assert.equal(result.invalidCount, 1);
  assert.equal(result.complete, true);
});

test('listUserRepos throws when a later page fails or is rate limited', async () => {
  const firstPage = () =>
    json([repo(1)], {
      headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' },
    });

  await assert.rejects(
    listUserRepos(async (p) => (p.includes('page=2') ? json({}, { status: 500 }) : firstPage())),
    { code: 'GITHUB_API_ERROR' },
  );
  await assert.rejects(
    listUserRepos(async (p) =>
      p.includes('page=2')
        ? json(
            {},
            {
              status: 403,
              headers: {
                'x-ratelimit-remaining': '0',
                'x-ratelimit-reset': String(Date.now() / 1000 + 60),
              },
            },
          )
        : firstPage(),
    ),
    { code: 'GITHUB_RATE_LIMITED' },
  );
});

const job = (over: Partial<JobRow>): JobRow => ({
  id: 'job-1',
  currentStep: 'finalize',
  chunksTotal: 10,
  embeddedChunks: 10,
  wikiPagesTotal: null,
  wikiPagesDone: 0,
  status: 'done',
  commitSha: 'abc1234',
  filesTotal: 10,
  filesDone: 10,
  error: null,
  finishedAt: new Date('2026-02-01T00:00:00Z'),
  startedAt: new Date('2026-01-31T23:50:00Z'),
  createdAt: new Date('2026-01-31T23:49:00Z'),
  ...over,
});

test('isStale: pushed after the last successful index started', () => {
  const indexed = job({});
  assert.equal(isStale(new Date('2026-02-02T00:00:00Z'), indexed), true);
  assert.equal(isStale(new Date('2026-01-31T23:00:00Z'), indexed), false);
  assert.equal(isStale(null, indexed), false);
  assert.equal(isStale(new Date('2026-02-02T00:00:00Z'), null), false);
  // Falls back to createdAt for a job that never recorded startedAt.
  assert.equal(isStale(new Date('2026-01-31T23:49:30Z'), job({ startedAt: null })), true);
  const status = deriveIndexStatus(indexed, indexed, new Date('2026-02-02T00:00:00Z'));
  assert.equal(status.stale, true);
  assert.equal(deriveIndexStatus(indexed, indexed).stale, false);
});

test('deriveIndexStatus covers every state', () => {
  assert.equal(deriveIndexStatus(null, null).state, 'not_indexed');

  const indexed = deriveIndexStatus(job({}), job({}));
  assert.equal(indexed.state, 'indexed');
  assert.equal(indexed.commitSha, 'abc1234');

  const running = deriveIndexStatus(
    job({}),
    job({ status: 'running', currentStep: 'process_files', filesDone: 3 }),
  );
  assert.equal(running.state, 'indexing');
  assert.equal(running.progress, 13); // 5% before files + 30% of the 25% file share
  assert.equal(running.commitSha, 'abc1234'); // previous good index still reported
  assert.equal(running.activeJobId, 'job-1');
  assert.equal(indexed.activeJobId, null);
  assert.equal(indexed.latestJobId, 'job-1');

  // Legacy 3A job (no chunks_total) never counts as indexed.
  assert.equal(
    deriveIndexStatus(job({ chunksTotal: null }), job({ chunksTotal: null })).state,
    'not_indexed',
  );

  const queued = deriveIndexStatus(
    null,
    job({ status: 'queued', currentStep: 'queued', filesTotal: 0, filesDone: 0 }),
  );
  assert.deepEqual([queued.state, queued.progress], ['indexing', 0]);

  const failed = deriveIndexStatus(null, job({ status: 'failed', error: 'boom' }));
  assert.deepEqual([failed.state, failed.error], ['failed', 'boom']);
});
