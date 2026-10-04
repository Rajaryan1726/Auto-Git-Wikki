/**
 * Concurrency tests for GitHub token refresh. Needs Postgres (`npm run infra:up`
 * and `npm run db:migrate`); skipped automatically when the database is unreachable.
 * GitHub is simulated with a fake that enforces single-use refresh tokens.
 */
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { db, pingDatabase, pool } from '../db/client.js';
import { users } from '../db/schema.js';
import { decryptToken, encryptToken } from '../lib/crypto.js';
import { GithubOAuthError, type GithubTokenSet } from './github-oauth.js';
import { createGithubTokenService } from './github-token.js';

const TEST_GITHUB_ID = -919191; // negative ids never collide with real GitHub users
const HOUR = 60 * 60 * 1000;

const dbAvailable = await pingDatabase().then(
  () => true,
  () => false,
);

/** Fake GitHub token endpoint: each refresh token works exactly once, like the real one. */
function fakeGithub(delayMs = 150) {
  const spent = new Set<string>();
  let generation = 0;
  const state = {
    calls: 0,
    badRefreshErrors: 0,
    refresh: async (refreshToken: string): Promise<GithubTokenSet> => {
      state.calls++;
      await sleep(delayMs); // widen the race window
      if (spent.has(refreshToken)) {
        state.badRefreshErrors++;
        throw new GithubOAuthError('bad_refresh_token', 'The refresh token passed is incorrect');
      }
      spent.add(refreshToken);
      generation++;
      return {
        accessToken: `access_gen${generation}`,
        accessTokenExpiresAt: new Date(Date.now() + 8 * HOUR),
        refreshToken: `refresh_gen${generation}`,
        refreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * HOUR),
      };
    },
  };
  return state;
}

describe(
  'GitHub token refresh concurrency',
  { skip: !dbAvailable && 'Postgres unavailable' },
  () => {
    let userId: string;

    before(async () => {
      await db.delete(users).where(eq(users.githubId, TEST_GITHUB_ID));
      const [row] = await db
        .insert(users)
        .values({ githubId: TEST_GITHUB_ID, username: 'concurrency-test-user' })
        .returning({ id: users.id });
      userId = row!.id;
    });

    beforeEach(async () => {
      // Expired access token with a valid, unused refresh token.
      await db
        .update(users)
        .set({
          githubAccessTokenEnc: encryptToken('access_gen0'),
          githubTokenExpiresAt: new Date(Date.now() - HOUR),
          githubRefreshTokenEnc: encryptToken('refresh_gen0'),
          githubRefreshTokenExpiresAt: new Date(Date.now() + 180 * 24 * HOUR),
        })
        .where(eq(users.id, userId));
    });

    after(async () => {
      if (userId) await db.delete(users).where(eq(users.id, userId));
      await pool.end();
    });

    async function storedTokens() {
      const [row] = await db.select().from(users).where(eq(users.id, userId));
      return {
        access: decryptToken(row!.githubAccessTokenEnc!),
        refresh: decryptToken(row!.githubRefreshTokenEnc!),
      };
    }

    test('parallel calls in one process trigger exactly one refresh', async () => {
      const github = fakeGithub();
      const service = createGithubTokenService(github.refresh);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => service.getGithubToken(userId)),
      );

      assert.equal(github.calls, 1);
      assert.equal(github.badRefreshErrors, 0);
      assert.deepEqual(new Set(results), new Set(['access_gen1']));
      assert.deepEqual(await storedTokens(), { access: 'access_gen1', refresh: 'refresh_gen1' });
    });

    test('parallel calls from separate processes are serialised by the row lock', async () => {
      const github = fakeGithub();
      // Separate service instances have separate in-flight maps, like separate processes.
      const processes = Array.from({ length: 5 }, () => createGithubTokenService(github.refresh));

      const results = await Promise.all(
        processes.flatMap((p) => [p.getGithubToken(userId), p.getGithubToken(userId)]),
      );

      assert.equal(github.calls, 1, 'only the first lock holder should call GitHub');
      assert.equal(github.badRefreshErrors, 0, 'a spent refresh token must never be reused');
      assert.deepEqual(new Set(results), new Set(['access_gen1']));
      assert.deepEqual(await storedTokens(), { access: 'access_gen1', refresh: 'refresh_gen1' });
    });

    test('concurrent 401 retries (staleToken) across processes refresh once', async () => {
      // Token not expired by time, but GitHub rejected it (e.g. revoked server-side).
      await db
        .update(users)
        .set({ githubTokenExpiresAt: new Date(Date.now() + HOUR) })
        .where(eq(users.id, userId));
      const github = fakeGithub();
      const a = createGithubTokenService(github.refresh);
      const b = createGithubTokenService(github.refresh);

      const results = await Promise.all([
        a.getGithubToken(userId, { staleToken: 'access_gen0' }),
        b.getGithubToken(userId, { staleToken: 'access_gen0' }),
        a.getGithubToken(userId, { staleToken: 'access_gen0' }),
        b.getGithubToken(userId, { staleToken: 'access_gen0' }),
      ]);

      assert.equal(github.calls, 1);
      assert.equal(github.badRefreshErrors, 0);
      assert.deepEqual(new Set(results), new Set(['access_gen1']));
    });

    test('a fresh token is reused afterwards without another refresh', async () => {
      const github = fakeGithub(0);
      const service = createGithubTokenService(github.refresh);

      assert.equal(await service.getGithubToken(userId), 'access_gen1');
      assert.equal(await service.getGithubToken(userId), 'access_gen1');
      assert.equal(github.calls, 1);
    });

    test('without locking the fake really does reject reuse (sanity check)', async () => {
      const github = fakeGithub(0);
      await github.refresh('refresh_gen0');
      await assert.rejects(github.refresh('refresh_gen0'), /incorrect/);
      assert.equal(github.badRefreshErrors, 1);
    });
  },
);
