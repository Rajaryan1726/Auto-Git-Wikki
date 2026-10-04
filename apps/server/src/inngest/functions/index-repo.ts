import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { NonRetriableError, RetryAfterError } from 'inngest';
import { db } from '../../db/client.js';
import { indexChunks, indexJobs, repositories, type IndexJobStats } from '../../db/schema.js';
import { chunkFile } from '../../indexing/chunker.js';
import { classifyIndexError } from '../../indexing/errors.js';
import { filterRepoFiles, looksLikeBinaryOrMinified } from '../../indexing/file-filter.js';
import { chunkPointId } from '../../indexing/point-id.js';
import { chunkTitle, formatDocument, providerForModel } from '../../services/embedding-format.js';
import { EmbeddingRateLimitError } from '../../services/embedding-errors.js';
import { embedSizing, embedderFor } from '../../services/embeddings.js';
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
import {
  claimPoints,
  collectionNameFor,
  deleteRepoPointsOutside,
  deleteStaleRepoPoints,
  ensureCollection,
  existingPointTexts,
  upsertPoints,
  type ChunkPayload,
} from '../../services/qdrant.js';
import { pruneWikiRunsOfOtherJobs, startWikiRun } from '../../services/wiki.js';
import { inngest } from '../client.js';
import { runWikiSteps } from './wiki.js';

export const INDEX_REQUESTED_EVENT = 'repo/index.requested';
export type IndexRequestedData = { jobId: string; repoId: string };
const eventDataSchema = z.object({ jobId: z.uuid(), repoId: z.uuid() });

/** Files per `index-batch-N` step: small enough to retry cheaply, large enough to be fast. */
export const FILES_PER_BATCH = 25;
const DOWNLOAD_CONCURRENCY = 5;
/*
 * Chunks per `embed-batch-N` step and per saved group come from the job's provider
 * (embedSizing): about one minute of budget, so a step never waits long in the throttle.
 */
/** Give up after this many rate-limit pauses in one job. */
const MAX_RATE_LIMIT_WAITS = 30;
/** Longer rate-limit waits than this fail the job instead of sleeping (e.g. daily quota). */
const MAX_EMBED_WAIT_MS = 15 * 60_000;

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
    if (decision.action === 'retry_at') {
      throw new RetryAfterError(decision.message, decision.retryAt);
    }
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

type EmbedStepResult =
  | {
      status: 'ok';
      embedded: number;
      reused: number;
      remaining: number;
      calls: number;
      rateLimited: number;
    }
  | {
      status: 'rate_limited';
      retryAt: string;
      quotaIds: string[];
      embedded: number;
      reused: number;
      calls: number;
      rateLimited: number;
    };

/** Stops a step whose job was cancelled or failed meanwhile (never touch its points). */
async function assertJobRunning(jobId: string): Promise<void> {
  const [job] = await db
    .select({ status: indexJobs.status })
    .from(indexJobs)
    .where(eq(indexJobs.id, jobId))
    .limit(1);
  if (job?.status !== 'running') {
    throw new NonRetriableError('The index job is no longer running.');
  }
}

/**
 * Embeds the next pending chunks of a job and upserts them to Qdrant. Points that already
 * exist with identical text (same repo + commit + path + line, from an earlier or failed
 * job) are reused without calling Gemini. Progress is saved per group, so a rate limit
 * midway keeps everything already done.
 */
async function embedPendingChunks(ctx: {
  jobId: string;
  repoId: string;
  commitSha: string;
  model: string;
  dims: number;
  collection: string;
}): Promise<EmbedStepResult> {
  await assertJobRunning(ctx.jobId);
  const sizing = embedSizing(ctx.model);
  const provider = providerForModel(ctx.model);
  const pending = await db
    .select()
    .from(indexChunks)
    .where(and(eq(indexChunks.jobId, ctx.jobId), isNull(indexChunks.embeddedAt)))
    .orderBy(asc(indexChunks.id))
    .limit(sizing.stepSize);

  const embedder = embedderFor(ctx.model, ctx.dims);
  const stats = () => ({ calls: embedder.stats.calls, rateLimited: embedder.stats.rateLimited });
  let embedded = 0;
  let reused = 0;

  const markDone = async (group: typeof pending) => {
    await db
      .update(indexChunks)
      .set({ embeddedAt: new Date() })
      .where(
        inArray(
          indexChunks.id,
          group.map((c) => c.id),
        ),
      );
    await db
      .update(indexJobs)
      .set({ embeddedChunks: sql`${indexJobs.embeddedChunks} + ${group.length}` })
      .where(eq(indexJobs.id, ctx.jobId));
  };

  // Reuse: same collection means same model + dims, and identical text means same vector.
  const existing = await existingPointTexts(
    ctx.collection,
    pending.map((c) => c.pointId),
  );
  const reusable = pending.filter((c) => existing.get(c.pointId) === c.text);
  if (reusable.length) {
    await claimPoints(
      ctx.collection,
      reusable.map((c) => c.pointId),
      ctx.jobId,
    );
    await markDone(reusable);
    reused = reusable.length;
  }
  const toEmbed = pending.filter((c) => existing.get(c.pointId) !== c.text);

  const groups: (typeof pending)[] = [];
  for (let i = 0; i < toEmbed.length; i += sizing.batchSize) {
    groups.push(toEmbed.slice(i, i + sizing.batchSize));
  }
  const results = await Promise.allSettled(
    groups.map(async (group) => {
      const vectors = await embedder.embedDocuments(
        group.map((c) => formatDocument(c.text, chunkTitle(c.filePath, c.symbol), provider)),
      );
      await upsertPoints(
        ctx.collection,
        group.map((c, i) => ({
          id: c.pointId,
          vector: vectors[i]!,
          payload: {
            repo_id: ctx.repoId,
            commit_sha: ctx.commitSha,
            file_path: c.filePath,
            start_line: c.startLine,
            end_line: c.endLine,
            language: c.language,
            symbol: c.symbol,
            chunk_type: c.chunkType as ChunkPayload['chunk_type'],
            text: c.text,
            index_job_id: ctx.jobId,
          },
        })),
      );
      await markDone(group);
      embedded += group.length;
    }),
  );
  const failures = results.flatMap((r) => (r.status === 'rejected' ? [r.reason as unknown] : []));
  const limited = failures.find(
    (e): e is EmbeddingRateLimitError => e instanceof EmbeddingRateLimitError,
  );
  const other = failures.find((e) => !(e instanceof EmbeddingRateLimitError));
  if (other) throw other;
  if (limited) {
    return {
      status: 'rate_limited',
      retryAt: limited.retryAt.toISOString(),
      quotaIds: limited.quotaIds,
      embedded,
      reused,
      ...stats(),
    };
  }

  const [left] = await db
    .select({ n: count() })
    .from(indexChunks)
    .where(and(eq(indexChunks.jobId, ctx.jobId), isNull(indexChunks.embeddedAt)));
  return { status: 'ok', embedded, reused, remaining: left?.n ?? 0, ...stats() };
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
      const startedAt = row.job.startedAt ?? new Date();
      await db
        .update(indexJobs)
        .set({ status: 'running', startedAt, currentStep: 'queued' })
        .where(eq(indexJobs.id, jobId));
      // The model is fixed for the whole job (stored at creation), never re-read from env.
      const collection = collectionNameFor(row.job.embeddingModel, row.job.embeddingDims);
      await ensureCollection(collection, row.job.embeddingDims);
      return {
        repoId: row.repo.id,
        userId: row.repo.userId,
        githubRepoId: row.repo.githubRepoId,
        model: row.job.embeddingModel,
        dims: row.job.embeddingDims,
        collection,
        startedAt: startedAt.toISOString(),
      };
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

    // ---- Processing files: fetch + chunk, staged in index_chunks ----
    const batches = Math.ceil(listing.files.length / FILES_PER_BATCH);
    let skippedFiles = 0;
    for (let i = 0; i < batches; i++) {
      const batch = listing.files.slice(i * FILES_PER_BATCH, (i + 1) * FILES_PER_BATCH);
      const result = await step.run(`index-batch-${i}`, () =>
        guarded(async () => {
          await setJobStep(jobId, 'process_files');
          const fetchGh = githubFor(ctx.userId);
          const perFile = await mapWithConcurrency(batch, DOWNLOAD_CONCURRENCY, async (file) => {
            const blob = await fetchBlobText(fetchGh, head.fullName, file.sha);
            if (blob.kind === 'missing') return { missing: true, skipped: true, chunks: [] };
            if (blob.kind === 'binary' || looksLikeBinaryOrMinified(blob.text)) {
              return { missing: false, skipped: true, chunks: [] };
            }
            const chunks = await chunkFile(file.path, blob.text);
            return { missing: false, skipped: false, chunks: chunks.map((c) => ({ ...c, file })) };
          });

          // A missing blob may mean the whole repo disappeared mid-job.
          if (perFile.some((f) => f.missing)) {
            const presence = await checkRepoPresence(fetchGh, ctx.githubRepoId);
            if (presence === 'gone') throw new RepoAccessLostError();
          }

          const rows = perFile.flatMap((f) =>
            f.chunks.map((c) => ({
              jobId,
              pointId: chunkPointId(ctx.repoId, head.commitSha, c.file.path, c.startLine),
              filePath: c.file.path,
              startLine: c.startLine,
              endLine: c.endLine,
              language: c.language,
              symbol: c.symbol,
              chunkType: c.chunkType,
              text: c.text,
            })),
          );
          // Idempotent on retry: (job_id, point_id) is unique.
          for (let r = 0; r < rows.length; r += 500) {
            await db
              .insert(indexChunks)
              .values(rows.slice(r, r + 500))
              .onConflictDoNothing();
          }
          await setFilesDone(jobId, Math.min(listing.files.length, (i + 1) * FILES_PER_BATCH));
          const skipped = perFile.filter((f) => f.skipped).length;
          console.log(
            `[index] job ${jobId} batch ${i + 1}/${batches}: ${batch.length} files, ${rows.length} chunks` +
              (skipped ? `, ${skipped} skipped` : ''),
          );
          return { chunks: rows.length, skipped };
        }),
      );
      skippedFiles += result.skipped;
    }

    const chunksTotal = await step.run('count-chunks', async () => {
      const [row] = await db
        .select({ n: count() })
        .from(indexChunks)
        .where(eq(indexChunks.jobId, jobId));
      const total = row?.n ?? 0;
      await db
        .update(indexJobs)
        .set({ chunksTotal: total, currentStep: 'embed' })
        .where(eq(indexJobs.id, jobId));
      return total;
    });

    // ---- Embedding & saving ----
    const usage = { embedCalls: 0, reusedChunks: 0, rateLimitHits: 0, rateLimitWaitMs: 0 };
    let waits = 0;
    for (let n = 0; ; n++) {
      const result = await step.run(`embed-batch-${n}`, () =>
        guarded(() => embedPendingChunks({ ...ctx, jobId, commitSha: head.commitSha })),
      );
      usage.embedCalls += result.calls;
      usage.reusedChunks += result.reused;
      usage.rateLimitHits += result.rateLimited;
      if (result.status === 'rate_limited') {
        if (++waits > MAX_RATE_LIMIT_WAITS) {
          throw new NonRetriableError(
            'The embedding provider kept rate-limiting requests. Try again later or lower its *_EMBED_MAX_RPM.',
          );
        }
        const waitMs = Math.max(1000, new Date(result.retryAt).getTime() - Date.now());
        if (waitMs > MAX_EMBED_WAIT_MS) {
          // E.g. a daily quota: fail clearly. Saved vectors are reused when the user retries.
          const hours = Math.max(1, Math.round(waitMs / 3_600_000));
          throw new NonRetriableError(
            `Embedding quota exhausted (${result.quotaIds.join(', ') || 'rate limit'}); ` +
              `it resets in about ${hours} h. Chunks embedded so far are kept and reused when you retry.`,
          );
        }
        usage.rateLimitWaitMs += waitMs;
        console.warn(
          `[index] job ${jobId}: embedding rate-limited, sleeping ${Math.ceil(waitMs / 1000)}s`,
        );
        await step.sleep(`embed-rate-limit-wait-${n}`, waitMs);
        continue;
      }
      if (result.remaining === 0) break;
    }

    // ---- Remove this repo's points that this job did not write (old commits) ----
    const removed = await step.run('cleanup-old-points', async () => {
      await assertJobRunning(jobId);
      const stale = await deleteStaleRepoPoints(ctx.collection, ctx.repoId, jobId);
      // Vectors of an earlier embedding model live in another collection; drop them too.
      const otherModels = await deleteRepoPointsOutside(ctx.repoId, ctx.collection);
      return stale + otherModels;
    });

    // ---- Generating wiki: a failure here never fails the index (chat keeps working) ----
    let wiki: { status: 'done' | 'failed' | 'skipped'; error: string | null } = {
      status: 'skipped',
      error: null,
    };
    try {
      const { runId } = await step.run('wiki-start', async () => {
        await assertJobRunning(jobId);
        await setJobStep(jobId, 'wiki');
        const { run } = await startWikiRun(ctx.repoId, jobId, 'index');
        return { runId: run.id };
      });
      wiki = await runWikiSteps(step, runId);
    } catch (err) {
      wiki = { status: 'failed', error: err instanceof Error ? err.message : String(err) };
      console.warn(
        `[index] job ${jobId}: wiki step failed, finishing the index anyway: ${wiki.error}`,
      );
    }

    await step.run('finalize', async () => {
      await assertJobRunning(jobId);
      await setJobStep(jobId, 'finalize');
      const stats: IndexJobStats = {
        ...usage,
        skippedFiles,
        durationMs: Date.now() - new Date(ctx.startedAt).getTime(),
      };
      await db.transaction(async (tx) => {
        await tx
          .update(indexJobs)
          .set({ status: 'done', finishedAt: new Date(), filesDone: listing.files.length, stats })
          .where(and(eq(indexJobs.id, jobId), eq(indexJobs.status, 'running')));
        await tx
          .update(repositories)
          .set({ lastIndexedJobId: jobId })
          .where(eq(repositories.id, ctx.repoId));
        await tx.delete(indexChunks).where(eq(indexChunks.jobId, jobId));
      });
      // The wiki of earlier index jobs is no longer shown; drop it.
      await pruneWikiRunsOfOtherJobs(ctx.repoId, jobId);
      console.log(
        `[index] job ${jobId} done: ${listing.files.length} files, ${chunksTotal} chunks embedded, ` +
          `${usage.reusedChunks} reused, ${usage.embedCalls} embed calls, ${usage.rateLimitHits} rate limits, ` +
          `${removed} old points removed, wiki ${wiki.status}`,
      );
    });

    return {
      commitSha: head.commitSha,
      chunks: chunksTotal,
      ...usage,
      removedPoints: removed,
      wiki,
    };
  },
);
