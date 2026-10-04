import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { indexJobs, repositories } from '../db/schema.js';
import { HttpError } from '../lib/http-error.js';
import { formatCodeQuery, providerForModel } from './embedding-format.js';
import { embedderFor } from './embeddings.js';
import { isSearchableJob } from './index-jobs.js';
import { collectionNameFor, searchRepoPoints, type SearchHit } from './qdrant.js';

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
 */
export async function searchRepo(
  repoId: string,
  query: string,
  limit = 8,
): Promise<RepoSearchResult> {
  const [row] = await db
    .select({ job: indexJobs })
    .from(repositories)
    .innerJoin(indexJobs, eq(indexJobs.id, repositories.lastIndexedJobId))
    .where(eq(repositories.id, repoId))
    .limit(1);
  const job = row?.job;
  if (!job || !isSearchableJob(job) || !job.commitSha) {
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
