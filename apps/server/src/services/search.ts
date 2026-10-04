import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { indexJobs, repositories } from '../db/schema.js';
import { HttpError } from '../lib/http-error.js';
import { formatCodeQuery, providerForModel } from './embedding-format.js';
import { embedderFor } from './embeddings.js';
import { isSearchableJob } from './index-jobs.js';
import { collectionNameFor, searchRepoPoints, type SearchHit } from './qdrant.js';

type JobRow = typeof indexJobs.$inferSelect;

async function lastIndexedJob(repoId: string): Promise<JobRow | null> {
  const [row] = await db
    .select({ job: indexJobs })
    .from(repositories)
    .innerJoin(indexJobs, eq(indexJobs.id, repositories.lastIndexedJobId))
    .where(eq(repositories.id, repoId))
    .limit(1);
  return row?.job && isSearchableJob(row.job) ? row.job : null;
}

/** A job of this repo whose chunks are all embedded (done, or running past embedding). */
async function embeddedJob(repoId: string, jobId: string): Promise<JobRow | null> {
  const [job] = await db
    .select()
    .from(indexJobs)
    .where(and(eq(indexJobs.id, jobId), eq(indexJobs.repoId, repoId)))
    .limit(1);
  if (!job || job.status === 'failed' || job.chunksTotal === null) return null;
  return job.embeddedChunks >= job.chunksTotal ? job : null;
}

export type RepoSearchResult = {
  hits: SearchHit[];
  commitSha: string;
  embeddingModel: string;
  collection: string;
};

/**
 * Semantic search over a repo's last successful index. The embedding model and Qdrant
 * collection always come from that job (never from the current env), so a model change
 * in .env can never mix vector spaces.
 *
 * `opts.jobId` searches one specific job of the repo instead, once all its chunks are
 * embedded: the wiki step runs before that job becomes the repo's last successful index.
 */
export async function searchRepo(
  repoId: string,
  query: string,
  limit = 8,
  opts: { jobId?: string } = {},
): Promise<RepoSearchResult> {
  const job = opts.jobId ? await embeddedJob(repoId, opts.jobId) : await lastIndexedJob(repoId);
  if (!job || !job.commitSha) {
    throw new HttpError(409, 'REPO_NOT_INDEXED', 'This repository has not been indexed yet.');
  }

  const collection = collectionNameFor(job.embeddingModel, job.embeddingDims);
  const vector = await embedderFor(job.embeddingModel, job.embeddingDims).embedQuery(
    formatCodeQuery(query, providerForModel(job.embeddingModel)),
  );
  const hits = await searchRepoPoints(
    collection,
    vector,
    { repoId, commitSha: job.commitSha },
    limit,
  );
  return { hits, commitSha: job.commitSha, embeddingModel: job.embeddingModel, collection };
}
