/**
 * Repo sync, listing and ownership against real Postgres with a simulated GitHub.
 * Needs `npm run infra:up` + `npm run db:migrate`; skipped when the DB is unreachable.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { eq, inArray } from 'drizzle-orm';
import { db, pingDatabase, pool } from '../db/client.js';
import { indexJobs, repositories, users } from '../db/schema.js';
import type { GithubFetch } from './github-api.js';
import { syncUserRepos } from './repo-sync.js';
import { getRepoForUser, listReposForUser } from './repos.js';

const dbAvailable = await pingDatabase().then(
  () => true,
  () => false,
);

const USER_A_GITHUB_ID = -717171;
const USER_B_GITHUB_ID = -727272;

type FakeRepo = { id: number; name: string; private: boolean; description?: string | null };

/** Minimal GitHub: paginated /user/repos, /user/orgs, org probes and /repositories/:id. */
function fakeGithub(opts: {
  repos: FakeRepo[];
  pageSize?: number;
  failPage?: number;
  ssoPartial?: boolean;
  orgs?: { id: number; login: string; probe: 'ok' | 'oauth_restricted' }[];
  /** Repos that still exist on GitHub even though the listing omitted them. */
  stillExists?: number[];
  extraItems?: unknown[];
}): GithubFetch & { calls: string[] } {
  const pageSize = opts.pageSize ?? 2;
  const calls: string[] = [];
  const toJson = (r: FakeRepo) => ({
    id: r.id,
    name: r.name,
    full_name: `someone/${r.name}`,
    description: r.description ?? null,
    private: r.private,
    default_branch: 'main',
    language: 'TypeScript',
    updated_at: '2026-03-01T00:00:00Z',
    pushed_at: `2026-03-${String((r.id % 27) + 1).padStart(2, '0')}T00:00:00Z`,
  });

  const fetchGh = (async (path: string) => {
    calls.push(path);
    const url = new URL(path, 'https://api.github.com');
    if (url.pathname === '/user/repos') {
      const page = Number(url.searchParams.get('page') ?? '1');
      if (page === opts.failPage) return new Response('{}', { status: 502 });
      const items: unknown[] = opts.repos.slice((page - 1) * pageSize, page * pageSize).map(toJson);
      if (page === 1 && opts.extraItems) items.push(...opts.extraItems);
      const headers: Record<string, string> = {};
      if (page * pageSize < opts.repos.length) {
        headers.link = `<https://api.github.com/user/repos?page=${page + 1}>; rel="next"`;
      }
      if (opts.ssoPartial) headers['x-github-sso'] = 'partial-results; organizations=999';
      return new Response(JSON.stringify(items), { status: 200, headers });
    }
    if (url.pathname === '/user/orgs') {
      return Response.json((opts.orgs ?? []).map(({ id, login }) => ({ id, login })));
    }
    const orgProbe = /^\/orgs\/([^/]+)\/repos$/.exec(url.pathname);
    if (orgProbe) {
      const org = opts.orgs?.find((o) => o.login === orgProbe[1]);
      return org?.probe === 'oauth_restricted'
        ? Response.json(
            {
              message:
                'Although you appear to have the correct authorization credentials, the org organization has enabled OAuth App access restrictions.',
            },
            { status: 403 },
          )
        : Response.json([]);
    }
    const byId = /^\/repositories\/(\d+)$/.exec(url.pathname);
    if (byId) {
      return opts.stillExists?.includes(Number(byId[1]))
        ? Response.json({ id: Number(byId[1]) })
        : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    return new Response('{}', { status: 404 });
  }) as GithubFetch & { calls: string[] };
  fetchGh.calls = calls;
  return fetchGh;
}

const noQdrant = async () => {};

describe('repo sync + listing', { skip: !dbAvailable && 'Postgres unavailable' }, () => {
  let userA: string;
  let userB: string;

  const base: FakeRepo[] = [
    { id: 1001, name: 'alpha-api', private: false },
    { id: 1002, name: 'beta-web', private: true },
    { id: 1003, name: 'gamma_tools', private: false },
    { id: 1004, name: 'delta-secret', private: true },
    { id: 1005, name: '100%-done', private: false },
  ];

  const sync = (fetchGh: GithubFetch) => syncUserRepos(userA, { fetchGh, deletePoints: noQdrant });
  const ids = async (userId = userA) =>
    (await db.select().from(repositories).where(eq(repositories.userId, userId)))
      .map((r) => r.githubRepoId)
      .sort();

  before(async () => {
    await db.delete(users).where(inArray(users.githubId, [USER_A_GITHUB_ID, USER_B_GITHUB_ID]));
    const rows = await db
      .insert(users)
      .values([
        { githubId: USER_A_GITHUB_ID, username: 'sync-test-a' },
        { githubId: USER_B_GITHUB_ID, username: 'sync-test-b' },
      ])
      .returning({ id: users.id, githubId: users.githubId });
    userA = rows.find((r) => r.githubId === USER_A_GITHUB_ID)!.id;
    userB = rows.find((r) => r.githubId === USER_B_GITHUB_ID)!.id;
  });

  beforeEach(async () => {
    await db.delete(repositories).where(inArray(repositories.userId, [userA, userB]));
  });

  after(async () => {
    await db.delete(users).where(inArray(users.githubId, [USER_A_GITHUB_ID, USER_B_GITHUB_ID]));
    await pool.end();
  });

  test('first sync inserts every page and records repos_synced_at', async () => {
    const summary = await sync(fakeGithub({ repos: base }));
    assert.equal(summary.total, 5);
    assert.equal(summary.added, 5);
    assert.equal(summary.updated, 0);
    assert.deepEqual(await ids(), [1001, 1002, 1003, 1004, 1005]);
    const [u] = await db.select().from(users).where(eq(users.id, userA));
    assert.ok(u!.reposSyncedAt);
    const [row] = await db.select().from(repositories).where(eq(repositories.githubRepoId, 1001));
    assert.ok(row!.githubPushedAt, 'pushed_at stored');
  });

  test('resync updates only changed rows and picks up new repos', async () => {
    await sync(fakeGithub({ repos: base }));
    const unchanged = await sync(fakeGithub({ repos: base }));
    assert.deepEqual([unchanged.added, unchanged.updated], [0, 0]);

    const changed = base.map((r) => (r.id === 1003 ? { ...r, description: 'now described' } : r));
    const summary = await sync(
      fakeGithub({ repos: [...changed, { id: 1006, name: 'brand-new', private: false }] }),
    );
    assert.deepEqual([summary.added, summary.updated], [1, 1]);
    assert.deepEqual(await ids(), [1001, 1002, 1003, 1004, 1005, 1006]);
  });

  test('repos gone from GitHub are removed after a complete fetch', async () => {
    await sync(fakeGithub({ repos: base }));
    const summary = await sync(fakeGithub({ repos: base.filter((r) => r.id !== 1002) }));
    assert.equal(summary.removed, 1);
    assert.equal(summary.removalsApplied, true);
    assert.deepEqual(await ids(), [1001, 1003, 1004, 1005]);
  });

  test('a repo missing from the listing but still on GitHub is kept', async () => {
    await sync(fakeGithub({ repos: base }));
    const summary = await sync(
      fakeGithub({ repos: base.filter((r) => r.id !== 1002), stillExists: [1002] }),
    );
    assert.equal(summary.removed, 0);
    assert.deepEqual(await ids(), [1001, 1002, 1003, 1004, 1005]);
  });

  test('a failed page aborts the sync and deletes nothing', async () => {
    await sync(fakeGithub({ repos: base }));
    const shrunk = base.slice(0, 1); // would remove 4 repos if applied
    await assert.rejects(sync(fakeGithub({ repos: [...shrunk, ...base.slice(1)], failPage: 2 })), {
      code: 'GITHUB_API_ERROR',
    });
    assert.deepEqual(await ids(), [1001, 1002, 1003, 1004, 1005]);
  });

  test('SSO partial results never delete and are reported as skipped', async () => {
    await sync(fakeGithub({ repos: base }));
    const summary = await sync(fakeGithub({ repos: base.slice(0, 2), ssoPartial: true }));
    assert.equal(summary.removalsApplied, false);
    assert.equal(summary.removed, 0);
    assert.deepEqual(summary.skipped.orgs, [{ login: null, reason: 'sso_required' }]);
    assert.deepEqual(await ids(), [1001, 1002, 1003, 1004, 1005]);
  });

  test('restricted orgs and malformed items are skipped, not fatal', async () => {
    const summary = await sync(
      fakeGithub({
        repos: base,
        orgs: [
          { id: 1, login: 'open-org', probe: 'ok' },
          { id: 2, login: 'locked-org', probe: 'oauth_restricted' },
        ],
        extraItems: [{ id: 'not-a-number' }],
      }),
    );
    assert.equal(summary.total, 5);
    assert.equal(summary.skipped.repos, 1);
    assert.deepEqual(summary.skipped.orgs, [{ login: 'locked-org', reason: 'oauth_restricted' }]);
    assert.equal(summary.skipped.count, 2);
  });

  test('search and the four filters run in SQL', async () => {
    await sync(fakeGithub({ repos: base }));
    const names = async (q: string | undefined, filter: 'all' | 'public' | 'private' | 'indexed') =>
      (await listReposForUser(userA, { q, filter })).map((r) => r.name).sort();

    assert.equal((await names(undefined, 'all')).length, 5);
    assert.deepEqual(await names(undefined, 'public'), ['100%-done', 'alpha-api', 'gamma_tools']);
    assert.deepEqual(await names(undefined, 'private'), ['beta-web', 'delta-secret']);
    assert.deepEqual(await names(undefined, 'indexed'), []);
    assert.deepEqual(await names('ALPHA', 'all'), ['alpha-api']);
    assert.deepEqual(await names('e', 'private'), ['beta-web', 'delta-secret']);
    // LIKE wildcards are literal
    assert.deepEqual(await names('%', 'all'), ['100%-done']);
    assert.deepEqual(await names('_', 'all'), ['gamma_tools']);

    // Mark one repo indexed and another with a running job.
    const [alpha] = await db.select().from(repositories).where(eq(repositories.githubRepoId, 1001));
    const [beta] = await db.select().from(repositories).where(eq(repositories.githubRepoId, 1002));
    const [doneJob] = await db
      .insert(indexJobs)
      .values({
        repoId: alpha!.id,
        status: 'done',
        commitSha: 'deadbeefcafe',
        embeddingModel: 'test',
        finishedAt: new Date(),
      })
      .returning();
    await db
      .update(repositories)
      .set({ lastIndexedJobId: doneJob!.id })
      .where(eq(repositories.id, alpha!.id));
    await db.insert(indexJobs).values({
      repoId: beta!.id,
      status: 'running',
      currentStep: 'process_files',
      embeddingModel: 'test',
      filesTotal: 8,
      filesDone: 2,
    });

    assert.deepEqual(await names(undefined, 'indexed'), ['alpha-api']);
    const all = await listReposForUser(userA, { filter: 'all' });
    const status = (n: string) => all.find((r) => r.name === n)!.status;
    assert.equal(status('alpha-api').state, 'indexed');
    assert.equal(status('alpha-api').commitSha, 'deadbeefcafe');
    assert.deepEqual([status('beta-web').state, status('beta-web').progress], ['indexing', 30]);
    assert.equal(status('gamma_tools').state, 'not_indexed');
  });

  test("a user cannot read another user's repo", async () => {
    await sync(fakeGithub({ repos: base }));
    const [repo] = await listReposForUser(userA, { filter: 'all' });
    assert.ok(await getRepoForUser(userA, repo!.id));
    assert.equal(await getRepoForUser(userB, repo!.id), null);
    assert.deepEqual(await listReposForUser(userB, { filter: 'all' }), []);
  });
});
