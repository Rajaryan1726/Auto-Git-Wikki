import { and, desc, eq, ilike, inArray, isNotNull, or, sql, type SQL } from 'drizzle-orm';
import type { RepoFilter, RepoSummary } from '@autowiki/shared';
import { db } from '../db/client.js';
import { indexJobs, repositories } from '../db/schema.js';
import { deriveIndexStatus, type JobRow } from './repo-status.js';

type RepoRow = typeof repositories.$inferSelect;

const jobFields = {
  id: indexJobs.id,
  repoId: indexJobs.repoId,
  status: indexJobs.status,
  currentStep: indexJobs.currentStep,
  commitSha: indexJobs.commitSha,
  filesTotal: indexJobs.filesTotal,
  filesDone: indexJobs.filesDone,
  chunksTotal: indexJobs.chunksTotal,
  embeddedChunks: indexJobs.embeddedChunks,
  wikiPagesTotal: indexJobs.wikiPagesTotal,
  wikiPagesDone: indexJobs.wikiPagesDone,
  error: indexJobs.error,
  finishedAt: indexJobs.finishedAt,
  startedAt: indexJobs.startedAt,
  createdAt: indexJobs.createdAt,
};

/** Escapes LIKE wildcards so user input is matched literally. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function filterCondition(filter: RepoFilter): SQL | undefined {
  switch (filter) {
    case 'public':
      return eq(repositories.isPrivate, false);
    case 'private':
      return eq(repositories.isPrivate, true);
    case 'indexed':
      return isNotNull(repositories.lastIndexedJobId);
    case 'all':
      return undefined;
  }
}

async function withStatus(rows: RepoRow[]): Promise<RepoSummary[]> {
  if (rows.length === 0) return [];
  const repoIds = rows.map((r) => r.id);
  const lastIds = rows.map((r) => r.lastIndexedJobId).filter((id): id is string => id !== null);

  const [lastJobs, latestJobs] = await Promise.all([
    lastIds.length
      ? db.select(jobFields).from(indexJobs).where(inArray(indexJobs.id, lastIds))
      : Promise.resolve([]),
    db
      .selectDistinctOn([indexJobs.repoId], jobFields)
      .from(indexJobs)
      .where(inArray(indexJobs.repoId, repoIds))
      .orderBy(indexJobs.repoId, desc(indexJobs.createdAt)),
  ]);
  const lastById = new Map<string, JobRow>(lastJobs.map((j) => [j.id, j]));
  const latestByRepo = new Map<string, JobRow>(latestJobs.map((j) => [j.repoId, j]));

  return rows.map((r) => ({
    id: r.id,
    githubRepoId: r.githubRepoId,
    fullName: r.fullName,
    name: r.name,
    description: r.description,
    isPrivate: r.isPrivate,
    defaultBranch: r.defaultBranch,
    language: r.language,
    githubUpdatedAt: r.githubUpdatedAt?.toISOString() ?? null,
    githubPushedAt: r.githubPushedAt?.toISOString() ?? null,
    htmlUrl: `https://github.com/${r.fullName}`,
    status: deriveIndexStatus(
      r.lastIndexedJobId ? lastById.get(r.lastIndexedJobId) : null,
      latestByRepo.get(r.id),
      r.githubPushedAt,
    ),
  }));
}

export async function listReposForUser(
  userId: string,
  opts: { q?: string; filter: RepoFilter },
): Promise<RepoSummary[]> {
  const conditions: (SQL | undefined)[] = [
    eq(repositories.userId, userId),
    filterCondition(opts.filter),
  ];
  if (opts.q) {
    const pattern = `%${escapeLike(opts.q)}%`;
    conditions.push(or(ilike(repositories.name, pattern), ilike(repositories.fullName, pattern)));
  }
  const rows = await db
    .select()
    .from(repositories)
    .where(and(...conditions))
    .orderBy(
      sql`coalesce(${repositories.githubPushedAt}, ${repositories.githubUpdatedAt}) desc nulls last`,
      repositories.fullName,
    );
  return withStatus(rows);
}

/** Returns the repo only if it belongs to `userId`; null otherwise (callers answer 404). */
export async function getRepoForUser(userId: string, repoId: string): Promise<RepoSummary | null> {
  const rows = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, repoId), eq(repositories.userId, userId)))
    .limit(1);
  const [repo] = await withStatus(rows);
  return repo ?? null;
}
