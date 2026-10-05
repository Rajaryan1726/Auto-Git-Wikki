import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { decryptToken } from '../lib/crypto.js';
import { HttpError } from '../lib/http-error.js';
import { isExpired } from '../lib/token-expiry.js';
import { GithubOAuthError, refreshAccessToken, type GithubTokenSet } from './github-oauth.js';
import { tokenColumns } from './users.js';

import { moduleLogger } from '../lib/logger.js';

const log = moduleLogger('github-token');

const GITHUB_API = 'https://api.github.com';
/** Upper bound on waiting for another process's refresh to finish. */
const REFRESH_LOCK_TIMEOUT = '20s';

/**
 * Forgets a user's GitHub tokens after GitHub rejected them for good (app access revoked
 * or token deleted). Every later authenticated request then answers
 * GITHUB_REAUTH_REQUIRED and clears the session (requireAuth), from any route, including
 * after a background job (sync, indexing, wiki) was the one to notice.
 */
export async function markGithubAccessRevoked(userId: string): Promise<void> {
  await db
    .update(users)
    .set({
      githubAccessTokenEnc: null,
      githubTokenExpiresAt: null,
      githubRefreshTokenEnc: null,
      githubRefreshTokenExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));
  log.warn({ userId }, 'GitHub access revoked: tokens cleared, the user must sign in again');
}

export function reauthRequired(): HttpError {
  return new HttpError(
    401,
    'GITHUB_REAUTH_REQUIRED',
    'Your GitHub access expired or was revoked. Please sign in again.',
  );
}

const tokenFields = {
  accessEnc: users.githubAccessTokenEnc,
  accessExpiresAt: users.githubTokenExpiresAt,
  refreshEnc: users.githubRefreshTokenEnc,
  refreshExpiresAt: users.githubRefreshTokenExpiresAt,
};

export type GetTokenOptions = {
  /** A token that GitHub just rejected with 401; forces a refresh unless it was already replaced. */
  staleToken?: string;
};

export type RefreshFn = (refreshToken: string) => Promise<GithubTokenSet>;

/**
 * Builds the token service. GitHub refresh tokens are single-use, so a refresh is
 * serialised at two levels:
 *  - in-process: concurrent callers for one user share a single in-flight refresh;
 *  - cross-process: the refresh runs under `SELECT ... FOR UPDATE` on the user row and
 *    re-reads the token after acquiring the lock, so a second process that was waiting
 *    sees the already-refreshed token instead of reusing the spent refresh token.
 * `refresh` is injectable so tests can simulate GitHub; each instance has its own
 * in-flight map, which lets tests model separate server processes.
 */
export function createGithubTokenService(refresh: RefreshFn = refreshAccessToken) {
  const inflight = new Map<string, Promise<string>>();

  /**
   * Returns a usable GitHub access token for the user, refreshing it first when it is
   * expired (or when `staleToken` was rejected). Throws GITHUB_REAUTH_REQUIRED (401)
   * when there is no way to get a valid token without the user signing in again.
   */
  async function getGithubToken(userId: string, opts: GetTokenOptions = {}): Promise<string> {
    const [row] = await db.select(tokenFields).from(users).where(eq(users.id, userId)).limit(1);
    if (!row?.accessEnc) throw reauthRequired();

    const current = decryptToken(row.accessEnc);
    const mustRefresh =
      opts.staleToken !== undefined ? opts.staleToken === current : isExpired(row.accessExpiresAt);
    if (!mustRefresh) return current;

    return refreshOnce(userId, current);
  }

  function refreshOnce(userId: string, staleToken: string): Promise<string> {
    const existing = inflight.get(userId);
    if (existing) return existing;
    const promise = refreshLocked(userId, staleToken).finally(() => inflight.delete(userId));
    inflight.set(userId, promise);
    return promise;
  }

  function refreshLocked(userId: string, staleToken: string): Promise<string> {
    return db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local lock_timeout = '${REFRESH_LOCK_TIMEOUT}'`));
      const [row] = await tx
        .select(tokenFields)
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!row?.accessEnc) throw reauthRequired();

      // Re-read under the lock: if the token changed, another process already refreshed it.
      const current = decryptToken(row.accessEnc);
      if (current !== staleToken) return current;

      if (!row.refreshEnc || isExpired(row.refreshExpiresAt, Date.now(), 0)) {
        throw reauthRequired();
      }

      let tokens: GithubTokenSet;
      try {
        tokens = await refresh(decryptToken(row.refreshEnc));
      } catch (err) {
        if (err instanceof GithubOAuthError) {
          log.warn(`[github] token refresh failed for user ${userId}: ${err.code}`);
          throw reauthRequired();
        }
        throw err;
      }

      const columns = tokenColumns(tokens);
      // Keep the existing refresh token if GitHub did not rotate it.
      if (!tokens.refreshToken) {
        columns.githubRefreshTokenEnc = row.refreshEnc;
        columns.githubRefreshTokenExpiresAt = row.refreshExpiresAt;
      }
      await tx
        .update(users)
        .set({ ...columns, updatedAt: new Date() })
        .where(eq(users.id, userId));
      log.info(`[github] refreshed access token for user ${userId}`);
      return tokens.accessToken;
    });
  }

  /**
   * Calls the GitHub REST API as the user. On 401 it refreshes the token once and retries.
   * `path` is relative to https://api.github.com (e.g. `/user/repos`).
   */
  async function githubFetch(
    userId: string,
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    const send = (token: string) =>
      fetch(`${GITHUB_API}${path}`, {
        ...init,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'autowiki',
          ...init.headers,
          Authorization: `Bearer ${token}`,
        },
      });

    const token = await getGithubToken(userId);
    const res = await send(token);
    if (res.status !== 401) return res;

    let fresh: string;
    try {
      fresh = await getGithubToken(userId, { staleToken: token });
    } catch (err) {
      // GitHub rejected the token and it cannot be refreshed: access was revoked.
      if (err instanceof HttpError && err.code === 'GITHUB_REAUTH_REQUIRED') {
        await markGithubAccessRevoked(userId);
      }
      throw err;
    }
    const retried = await send(fresh);
    if (retried.status === 401) {
      await markGithubAccessRevoked(userId);
      throw reauthRequired();
    }
    return retried;
  }

  return { getGithubToken, githubFetch };
}

const defaultService = createGithubTokenService();

export const getGithubToken = defaultService.getGithubToken;
export const githubFetch = defaultService.githubFetch;
