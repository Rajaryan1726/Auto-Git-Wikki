import { and, eq, inArray, sql } from 'drizzle-orm';
import type { SyncSummary } from '@autowiki/shared';
import { db } from '../db/client.js';
import { repositories, users } from '../db/schema.js';
import { env } from '../lib/env.js';
import { mapWithConcurrency, type GithubFetch } from './github-api.js';
import {
  checkRepoPresence,
  findRestrictedOrgs,
  listUserRepos,
  type GithubRepo,
  type SkippedOrg,
} from './github-repos.js';
import { deleteRepoPoints } from './qdrant.js';

const UPSERT_CHUNK = 200;

export type RepoSyncDeps = {
  fetchGh: GithubFetch;
  /** Injected so tests can skip Qdrant. */
  deletePoints?: (repoId: string) => Promise<void>;
};

function grantAccessUrl(): string | null {
  return env.GITHUB_CLIENT_ID
    ? `https://github.com/settings/connections/applications/${env.GITHUB_CLIENT_ID}`
    : null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function mergeSkippedOrgs(
  restricted: SkippedOrg[],
  ssoOrgIds: string[],
): SyncSummary['skipped']['orgs'] {
  const known = new Set(restricted.map((o) => String(o.id)));
  const orgs = restricted.map(({ login, reason }) => ({ login, reason }));
  for (const id of ssoOrgIds) {
    if (!known.has(id)) orgs.push({ login: null, reason: 'sso_required' });
  }
  return orgs;
}

/**
 * Syncs the user's GitHub repos into `repositories`.
 * - Upserts by (user_id, github_repo_id); only rows whose fields changed are updated.
 * - Removes repos GitHub no longer returns, but ONLY when the paginated fetch completed
 *   and was not SSO-partial, and only after confirming each one is gone by id.
 * - Organizations that block the OAuth app never fail the sync; they are reported.
 */
export async function syncUserRepos(userId: string, deps: RepoSyncDeps): Promise<SyncSummary> {
  const { fetchGh, deletePoints = deleteRepoPoints } = deps;

  // Throws (and changes nothing) if any page fails.
  const list = await listUserRepos(fetchGh);
  const restrictedOrgs = await findRestrictedOrgs(fetchGh);

  const existing = await db
    .select({ id: repositories.id, githubRepoId: repositories.githubRepoId })
    .from(repositories)
    .where(eq(repositories.userId, userId));
  const seen = new Set(list.repos.map((r) => r.githubRepoId));
  const missing = existing.filter((r) => !seen.has(r.githubRepoId));

  const removalsApplied = list.complete && list.ssoOrgIds.length === 0;
  let toDelete: string[] = [];
  if (removalsApplied && missing.length > 0) {
    const presence = await mapWithConcurrency(missing, 5, (r) =>
      checkRepoPresence(fetchGh, r.githubRepoId),
    );
    toDelete = missing.filter((_, i) => presence[i] === 'gone').map((r) => r.id);
  }

  const now = new Date();
  const { added, updated } = await db.transaction(async (tx) => {
    let added = 0;
    let updated = 0;
    for (const part of chunk<GithubRepo>(list.repos, UPSERT_CHUNK)) {
      const rows = await tx
        .insert(repositories)
        .values(part.map((r) => ({ userId, ...r })))
        .onConflictDoUpdate({
          target: [repositories.userId, repositories.githubRepoId],
          set: {
            fullName: sql`excluded.full_name`,
            name: sql`excluded.name`,
            description: sql`excluded.description`,
            isPrivate: sql`excluded.is_private`,
            defaultBranch: sql`excluded.default_branch`,
            language: sql`excluded.language`,
            githubUpdatedAt: sql`excluded.github_updated_at`,
            githubPushedAt: sql`excluded.github_pushed_at`,
            updatedAt: now,
          },
          // Leave unchanged rows alone so updated_at reflects real changes.
          setWhere: sql`(${repositories.fullName}, ${repositories.name}, ${repositories.description},
            ${repositories.isPrivate}, ${repositories.defaultBranch}, ${repositories.language},
            ${repositories.githubUpdatedAt}, ${repositories.githubPushedAt})
            is distinct from (excluded.full_name, excluded.name, excluded.description,
            excluded.is_private, excluded.default_branch, excluded.language,
            excluded.github_updated_at, excluded.github_pushed_at)`,
        })
        // xmax = 0 means the row was inserted rather than updated.
        .returning({ inserted: sql<boolean>`(xmax = 0)` });
      for (const row of rows) {
        if (row.inserted) added++;
        else updated++;
      }
    }
    if (toDelete.length > 0) {
      await tx
        .delete(repositories)
        .where(and(eq(repositories.userId, userId), inArray(repositories.id, toDelete)));
    }
    await tx.update(users).set({ reposSyncedAt: now }).where(eq(users.id, userId));
    return { added, updated };
  });

  // Vector cleanup is best effort; orphaned points are filtered by repo_id anyway.
  for (const repoId of toDelete) {
    await deletePoints(repoId).catch((err: unknown) =>
      console.warn(
        `[qdrant] could not delete points for repo ${repoId}:`,
        err instanceof Error ? err.message : err,
      ),
    );
  }

  const orgs = mergeSkippedOrgs(restrictedOrgs, list.ssoOrgIds);
  const summary: SyncSummary = {
    total: list.repos.length,
    added,
    updated,
    removed: toDelete.length,
    removalsApplied,
    skipped: { repos: list.invalidCount, orgs, count: list.invalidCount + orgs.length },
    grantAccessUrl: grantAccessUrl(),
    syncedAt: now.toISOString(),
  };
  console.log(
    `[sync] user ${userId}: ${summary.total} repos (+${added} ~${updated} -${summary.removed})` +
      (summary.skipped.count ? `, skipped ${summary.skipped.count}` : '') +
      (removalsApplied ? '' : ', removals skipped (partial fetch)'),
  );
  return summary;
}
