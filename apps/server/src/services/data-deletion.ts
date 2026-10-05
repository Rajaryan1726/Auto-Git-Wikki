/**
 * Data management (Phase 6): delete everything derived from one repo, or everything
 * about a user. Each operation counts the data before, deletes it, and counts again, so
 * the caller (and the report) can show that nothing is left in Postgres or Qdrant.
 */
import { and, count, eq, inArray } from 'drizzle-orm';
import type { DeletionReport } from '@autowiki/shared';
import { db } from '../db/client.js';
import {
  chatMessages,
  chatThreads,
  indexChunks,
  indexJobs,
  llmUsage,
  repositories,
  users,
  wikiPages,
  wikiRuns,
} from '../db/schema.js';
import { HttpError } from '../lib/http-error.js';
import { moduleLogger } from '../lib/logger.js';
import { countMemories, deleteAllMemories } from './memory.js';
import { countRepoPointsEverywhere, deleteRepoPoints } from './qdrant.js';

const log = moduleLogger('data-deletion');

async function n(q: Promise<{ n: number }[]>): Promise<number> {
  const [row] = await q;
  return Number(row?.n ?? 0);
}

/** Rows and points that belong to these repos. */
async function repoCounts(repoIds: string[]) {
  if (repoIds.length === 0) {
    return {
      indexJobs: 0,
      indexChunks: 0,
      wikiRuns: 0,
      wikiPages: 0,
      chatThreads: 0,
      chatMessages: 0,
      qdrantCodePoints: 0,
    };
  }
  const [jobs, chunks, runs, pages, threads, messages] = await Promise.all([
    n(db.select({ n: count() }).from(indexJobs).where(inArray(indexJobs.repoId, repoIds))),
    n(
      db
        .select({ n: count() })
        .from(indexChunks)
        .innerJoin(indexJobs, eq(indexJobs.id, indexChunks.jobId))
        .where(inArray(indexJobs.repoId, repoIds)),
    ),
    n(db.select({ n: count() }).from(wikiRuns).where(inArray(wikiRuns.repoId, repoIds))),
    n(db.select({ n: count() }).from(wikiPages).where(inArray(wikiPages.repoId, repoIds))),
    n(db.select({ n: count() }).from(chatThreads).where(inArray(chatThreads.repoId, repoIds))),
    n(
      db
        .select({ n: count() })
        .from(chatMessages)
        .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
        .where(inArray(chatThreads.repoId, repoIds)),
    ),
  ]);
  let points = 0;
  for (const id of repoIds) points += await countRepoPointsEverywhere(id);
  return {
    indexJobs: jobs,
    indexChunks: chunks,
    wikiRuns: runs,
    wikiPages: pages,
    chatThreads: threads,
    chatMessages: messages,
    qdrantCodePoints: points,
  };
}

async function assertNothingRunning(repoIds: string[], what: string): Promise<void> {
  if (repoIds.length === 0) return;
  const [jobs, runs] = await Promise.all([
    n(
      db
        .select({ n: count() })
        .from(indexJobs)
        .where(
          and(inArray(indexJobs.repoId, repoIds), inArray(indexJobs.status, ['queued', 'running'])),
        ),
    ),
    n(
      db
        .select({ n: count() })
        .from(wikiRuns)
        .where(and(inArray(wikiRuns.repoId, repoIds), eq(wikiRuns.status, 'running'))),
    ),
  ]);
  if (jobs + runs > 0) {
    throw new HttpError(
      409,
      'WORK_IN_PROGRESS',
      `Indexing or wiki generation is still running. Wait for it to finish, then delete ${what}.`,
    );
  }
}

/**
 * Deletes a repo's derived data: Qdrant points (all code collections), wiki runs/pages,
 * chat threads/messages, index jobs and staging chunks. The repository row stays (it is
 * a GitHub listing, re-created by every sync anyway) and becomes "Not indexed".
 */
export async function deleteRepoData(repoId: string): Promise<DeletionReport> {
  await assertNothingRunning([repoId], "this repository's data");
  const before = await repoCounts([repoId]);

  await deleteRepoPoints(repoId);
  await db.transaction(async (tx) => {
    await tx
      .update(repositories)
      .set({ lastIndexedJobId: null })
      .where(eq(repositories.id, repoId));
    // Cascades: messages → threads; pages → runs; chunks / runs / pages → jobs.
    await tx.delete(chatThreads).where(eq(chatThreads.repoId, repoId));
    await tx.delete(wikiRuns).where(eq(wikiRuns.repoId, repoId));
    await tx.delete(indexJobs).where(eq(indexJobs.repoId, repoId));
  });

  const after = await repoCounts([repoId]);
  log.info({ repoId, before, after }, 'repo data deleted');
  return { before, after };
}

/**
 * Deletes a user and everything about them: code points of all their repos, their
 * memories (user_memories_* collection, history included), and every Postgres row
 * (repositories, jobs, wiki, chats, llm_usage and the user itself, via cascades).
 */
export async function deleteAccount(userId: string): Promise<DeletionReport> {
  const repoRows = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(eq(repositories.userId, userId));
  const repoIds = repoRows.map((r) => r.id);
  await assertNothingRunning(repoIds, 'your account');

  const accountCounts = async () => ({
    ...(await repoCounts(repoIds)),
    repositories: await n(
      db.select({ n: count() }).from(repositories).where(eq(repositories.userId, userId)),
    ),
    llmUsage: await n(db.select({ n: count() }).from(llmUsage).where(eq(llmUsage.userId, userId))),
    users: await n(db.select({ n: count() }).from(users).where(eq(users.id, userId))),
    qdrantMemories: await countMemories(userId),
  });
  const before = await accountCounts();

  for (const id of repoIds) await deleteRepoPoints(id);
  await deleteAllMemories(userId);
  // users → repositories → jobs/chunks/wiki/threads/messages, and llm_usage, all cascade.
  await db.delete(users).where(eq(users.id, userId));

  const after = await accountCounts();
  log.info({ userId, repos: repoIds.length, before, after }, 'account deleted');
  return { before, after };
}
