import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { NonRetriableError, RetryAfterError } from 'inngest';
import { db } from '../../db/client.js';
import { indexJobs, repositories } from '../../db/schema.js';
import { chunkFile } from '../../indexing/chunker.js';
import { classifyIndexError } from '../../indexing/errors.js';
import { filterRepoFiles, looksLikeBinaryOrMinified } from '../../indexing/file-filter.js';
import { mapWithConcurrency, type GithubFetch } from '../../services/github-api.js';
import { checkRepoPresence } from '../../services/github-repos.js';
import {
  RepoAccessLostError,
  fetchBlobText,
  listTree,
  resolveRepoHead,
} from '../../services/github-index.js';
import { githubFetch } from '../../services/github-token.js';
import { failJob, setFilesDone, setJobStep } from '../../services/index-jobs.js';
import { inngest } from '../client.js';

export const INDEX_REQUESTED_EVENT = 'repo/index.requested';
export type IndexRequestedData = { jobId: string; repoId: string };
const eventDataSchema = z.object({ jobId: z.uuid(), repoId: z.uuid() });

/** Files per `index-batch-N` step: small enough to retry cheaply, large enough to be fast. */
export const FILES_PER_BATCH = 25;
const DOWNLOAD_CONCURRENCY = 5;

/**
 * A GitHub client for one step. A fresh one is built inside every step so tokens are
 * fetched (and refreshed) on demand and never end up in memoized step output.
 */
function githubFor(userId: string): GithubFetch {
  return (path, init) => githubFetch(userId, path, init);
}

/** Runs step logic, turning errors into Inngest's retry / no-retry signals. */
async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const decision = classifyIndexError(err);
    if (decision.action === 'fail') throw new NonRetriableError(decision.message, { cause: err });
    if (decision.action === 'retry_at')
      throw new RetryAfterError(decision.message, decision.retryAt);
    throw err;
  }
}

async function loadJob(jobId: string) {
  const [row] = await db
    .select({
      job: indexJobs,
      repo: {
        id: repositories.id,
        userId: repositories.userId,
        githubRepoId: repositories.githubRepoId,
      },
    })
    .from(indexJobs)
    .innerJoin(repositories, eq(repositories.id, indexJobs.repoId))
    .where(eq(indexJobs.id, jobId))
    .limit(1);
  return row ?? null;
}

export const indexRepo = inngest.createFunction(
  {
    id: 'index-repo',
    triggers: [{ event: INDEX_REQUESTED_EVENT }],
    retries: 3,
    // One run per repo at a time (the DB also allows only one active job per repo).
    concurrency: [{ key: 'event.data.repoId', limit: 1 }],
    onFailure: async ({ event, error }) => {
      const parsed = eventDataSchema.safeParse(event.data.event.data);
      if (!parsed.success) return;
      const { jobId } = parsed.data;
      await failJob(jobId, error.message || 'Indexing failed.');
      console.warn(`[index] job ${jobId} failed: ${error.message}`);
    },
  },
  async ({ event, step }) => {
    const parsed = eventDataSchema.safeParse(event.data);
    if (!parsed.success) throw new NonRetriableError('Invalid index event payload.');
    const { jobId } = parsed.data;

    const ctx = await step.run('mark-running', async () => {
      const row = await loadJob(jobId);
      if (!row)
        throw new NonRetriableError('The index job no longer exists (repository removed?).');
      if (row.job.status === 'done' || row.job.status === 'failed') return null;
      await db
        .update(indexJobs)
        .set({
          status: 'running',
          startedAt: row.job.startedAt ?? new Date(),
          currentStep: 'queued',
        })
        .where(eq(indexJobs.id, jobId));
      return { repoId: row.repo.id, userId: row.repo.userId, githubRepoId: row.repo.githubRepoId };
    });
    if (!ctx) return { skipped: true };

    const head = await step.run('resolve-commit', () =>
      guarded(async () => {
        await setJobStep(jobId, 'resolve_commit');
        const head = await resolveRepoHead(githubFor(ctx.userId), ctx.githubRepoId);
        await db
          .update(indexJobs)
          .set({ commitSha: head.commitSha })
          .where(eq(indexJobs.id, jobId));
        // Keep the stored name in step with renames/transfers.
        await db
          .update(repositories)
          .set({ fullName: head.fullName, defaultBranch: head.defaultBranch })
          .where(eq(repositories.id, ctx.repoId));
        return { commitSha: head.commitSha, fullName: head.fullName };
      }),
    );

    const listing = await step.run('list-files', () =>
      guarded(async () => {
        await setJobStep(jobId, 'list_files');
        const tree = await listTree(githubFor(ctx.userId), head.fullName, head.commitSha);
        const { files, skipped, truncated } = filterRepoFiles(tree.entries);
        await db
          .update(indexJobs)
          .set({ filesTotal: files.length, filesDone: 0 })
          .where(eq(indexJobs.id, jobId));
        console.log(
          `[index] job ${jobId}: ${files.length} files to index` +
            ` (skipped ${JSON.stringify(skipped)}${truncated || tree.truncated ? ', list truncated' : ''})`,
        );
        return { files: files.map(({ path, sha }) => ({ path, sha })) };
      }),
    );

    const batches = Math.ceil(listing.files.length / FILES_PER_BATCH);
    const totals = { files: 0, chunks: 0, skipped: 0 };

    for (let i = 0; i < batches; i++) {
      const batch = listing.files.slice(i * FILES_PER_BATCH, (i + 1) * FILES_PER_BATCH);
      const result = await step.run(`index-batch-${i}`, () =>
        guarded(async () => {
          await setJobStep(jobId, 'process_files');
          const fetchGh = githubFor(ctx.userId);
          const perFile = await mapWithConcurrency(batch, DOWNLOAD_CONCURRENCY, async (file) => {
            const blob = await fetchBlobText(fetchGh, head.fullName, file.sha);
            if (blob.kind === 'missing') return { missing: true, chunks: 0 };
            if (blob.kind === 'binary' || looksLikeBinaryOrMinified(blob.text)) {
              return { missing: false, chunks: 0, skipped: true };
            }
            // 3A: chunk only. Embedding + Qdrant upsert arrive in Phase 3B.
            const chunks = await chunkFile(file.path, blob.text);
            return { missing: false, chunks: chunks.length, skipped: false };
          });

          // A missing blob may mean the whole repo disappeared mid-job.
          if (perFile.some((f) => f.missing)) {
            const presence = await checkRepoPresence(fetchGh, ctx.githubRepoId);
            if (presence === 'gone') throw new RepoAccessLostError();
          }

          const chunks = perFile.reduce((n, f) => n + f.chunks, 0);
          const skipped = perFile.filter((f) => f.missing || f.skipped).length;
          await setFilesDone(jobId, Math.min(listing.files.length, (i + 1) * FILES_PER_BATCH));
          console.log(
            `[index] job ${jobId} batch ${i + 1}/${batches}: ${batch.length} files, ${chunks} chunks` +
              (skipped ? `, ${skipped} skipped` : ''),
          );
          return { files: batch.length - skipped, chunks, skipped };
        }),
      );
      totals.files += result.files;
      totals.chunks += result.chunks;
      totals.skipped += result.skipped;
    }

    await step.run('finalize', async () => {
      await setJobStep(jobId, 'finalize');
      await db.transaction(async (tx) => {
        await tx
          .update(indexJobs)
          .set({ status: 'done', finishedAt: new Date(), filesDone: listing.files.length })
          .where(and(eq(indexJobs.id, jobId), eq(indexJobs.status, 'running')));
        await tx
          .update(repositories)
          .set({ lastIndexedJobId: jobId })
          .where(eq(repositories.id, ctx.repoId));
      });
      console.log(
        `[index] job ${jobId} done: ${totals.files} files, ${totals.chunks} chunks, ${totals.skipped} skipped`,
      );
    });

    return { commitSha: head.commitSha, ...totals };
  },
);
