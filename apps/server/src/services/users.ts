import { eq, sql } from 'drizzle-orm';
import type { AuthUser } from '@autowiki/shared';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { encryptToken } from '../lib/crypto.js';
import type { GithubTokenSet, GithubUser } from './github-oauth.js';

/** Column values for storing a token set; tokens are always encrypted at rest. */
export function tokenColumns(tokens: GithubTokenSet) {
  return {
    githubAccessTokenEnc: encryptToken(tokens.accessToken),
    githubTokenExpiresAt: tokens.accessTokenExpiresAt,
    githubRefreshTokenEnc: tokens.refreshToken ? encryptToken(tokens.refreshToken) : null,
    githubRefreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
  };
}

export async function upsertGithubUser(
  githubUser: GithubUser,
  tokens: GithubTokenSet,
): Promise<AuthUser> {
  const profile = {
    username: githubUser.login,
    avatarUrl: githubUser.avatar_url ?? null,
    ...tokenColumns(tokens),
  };
  const [row] = await db
    .insert(users)
    .values({ githubId: githubUser.id, ...profile })
    .onConflictDoUpdate({ target: users.githubId, set: { ...profile, updatedAt: new Date() } })
    .returning({ id: users.id, username: users.username, avatarUrl: users.avatarUrl });
  if (!row) throw new Error('User upsert returned no row');
  return row;
}

export async function getReposSyncedAt(userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ reposSyncedAt: users.reposSyncedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.reposSyncedAt ?? null;
}

export async function findAuthUserById(id: string): Promise<AuthUser | null> {
  const row = await findSessionUser(id);
  return row ? { id: row.id, username: row.username, avatarUrl: row.avatarUrl } : null;
}

/** The session's user plus whether they still have a GitHub token (false once revoked). */
export async function findSessionUser(
  id: string,
): Promise<(AuthUser & { hasGithubAccess: boolean }) | null> {
  const [row] = await db
    .select({
      id: users.id,
      username: users.username,
      avatarUrl: users.avatarUrl,
      hasGithubAccess: sql<boolean>`${users.githubAccessTokenEnc} is not null`,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ?? null;
}
