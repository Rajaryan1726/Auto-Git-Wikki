import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import type { ActiveIndexJob, IndexJob } from '@autowiki/shared';
import { db } from '../db/client.js';
import { indexJobs, repositories } from '../db/schema.js';
import { env } from '../lib/env.js';
import { describeSteps, jobProgress, stepLabel, type IndexStepId } from './index-steps.js';

type JobRow = typeof indexJobs.$inferSelect;

/** A queued job the worker never picked up (e.g. Inngest dev server not running). */
const STALE_QUEUED_MS = 10 * 60 * 1000;

export function serializeJob(job: JobRow): IndexJob {
  return {
    id: job.id,
    repoId: job.repoId,
    status: job.status,
    currentStep: job.currentStep,
    currentStepLabel: stepLabel(job.currentStep),
    commitSha: job.commitSha,
    embeddingModel: job.embeddingModel,
    filesTotal: job.filesTotal,
    filesDone: job.filesDone,
    progress: jobProgress(job),
    error: job.error,
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    steps: describeSteps(job),
  };
}

/** Fails jobs stuck in `queued` so the repo is not blocked forever. */
export async function expireStaleQueuedJobs(repoId?: string): Promise<void> {
  const cutoff = new Date(Date.now() - STALE_QUEUED_MS);
  await db
    .update(indexJobs)
    .set({
      status: 'failed',
      error:
        'The indexing job never started. Make sure the Inngest worker is running (npm run inngest:dev), then retry.',
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(indexJobs.status, 'queued'),
        lt(indexJobs.createdAt, cutoff),
        repoId ? eq(indexJobs.repoId, repoId) : undefined,
      ),
    );
}

export async function findActiveJob(repoId: string): Promise<JobRow | null> {
  const [job] = await db
    .select()
    .from(indexJobs)
    .where(and(eq(indexJobs.repoId, repoId), inArray(indexJobs.status, ['queued', 'running'])))
    .limit(1);
  return job ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } })?.code;
  const causeCode = (err as { cause?: { code?: string } })?.cause?.code;
  return code === '23505' || causeCode === '23505';
}

/**
 * Creates a queued job unless one is already active. Concurrent requests are safe: the
 * partial unique index allows one active job per repo, and the loser gets the winner.
 */
export async function createIndexJob(repoId: string): Promise<{ job: JobRow; created: boolean }> {
  await expireStaleQueuedJobs(repoId);
  const existing = await findActiveJob(repoId);
  if (existing) return { job: existing, created: false };
  try {
    const [job] = await db
      .insert(indexJobs)
      .values({
        repoId,
        status: 'queued',
        currentStep: 'queued' satisfies IndexStepId,
        embeddingModel: env.EMBEDDING_MODEL,
      })
      .returning();
    return { job: job!, created: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const winner = await findActiveJob(repoId);
      if (winner) return { job: winner, created: false };
    }
    throw err;
  }
}

/** Job with its repo, only if the repo belongs to `userId`. */
export async function getJobForUser(userId: string, jobId: string): Promise<JobRow | null> {
  const [row] = await db
    .select({ job: indexJobs })
    .from(indexJobs)
    .innerJoin(repositories, eq(repositories.id, indexJobs.repoId))
    .where(and(eq(indexJobs.id, jobId), eq(repositories.userId, userId)))
    .limit(1);
  return row?.job ?? null;
}

export async function listJobsForRepo(repoId: string, limit = 50): Promise<JobRow[]> {
  await expireStaleQueuedJobs(repoId);
  return db
    .select()
    .from(indexJobs)
    .where(eq(indexJobs.repoId, repoId))
    .orderBy(desc(indexJobs.createdAt))
    .limit(limit);
}

export async function listActiveJobsForUser(userId: string): Promise<ActiveIndexJob[]> {
  const rows = await db
    .select({
      job: indexJobs,
      repo: { id: repositories.id, name: repositories.name, fullName: repositories.fullName },
    })
    .from(indexJobs)
    .innerJoin(repositories, eq(repositories.id, indexJobs.repoId))
    .where(and(eq(repositories.userId, userId), inArray(indexJobs.status, ['queued', 'running'])))
    .orderBy(indexJobs.createdAt);
  return rows.map(({ job, repo }) => ({ ...serializeJob(job), repo }));
}

// ---- updates used by the Inngest pipeline ----

export async function setJobStep(jobId: string, step: IndexStepId): Promise<void> {
  await db.update(indexJobs).set({ currentStep: step }).where(eq(indexJobs.id, jobId));
}

/** Monotonic, so a retried batch step can never move progress backwards or double count. */
export async function setFilesDone(jobId: string, filesDone: number): Promise<void> {
  await db
    .update(indexJobs)
    .set({ filesDone: sql`greatest(${indexJobs.filesDone}, ${filesDone})` })
    .where(eq(indexJobs.id, jobId));
}

export async function failJob(jobId: string, message: string): Promise<void> {
  await db
    .update(indexJobs)
    .set({ status: 'failed', error: message.slice(0, 1000), finishedAt: new Date() })
    .where(and(eq(indexJobs.id, jobId), inArray(indexJobs.status, ['queued', 'running'])));
}
