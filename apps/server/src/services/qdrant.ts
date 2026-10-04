import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../lib/env.js';

export const qdrant = new QdrantClient({
  url: env.QDRANT_URL,
  apiKey: env.QDRANT_API_KEY,
  checkCompatibility: false,
});

const COLLECTION_PREFIX = 'code_';

/**
 * One collection per embedding model + dimension: `code_<sanitized model id>_<dims>`,
 * e.g. gemini-embedding-2 @ 768 -> `code_gemini_embedding_2_768`. Vectors from different
 * models are never comparable, so they must never share a collection.
 */
export function collectionNameFor(model: string, dims: number): string {
  const slug = model
    .toLowerCase()
    .replace(/^models\//, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${COLLECTION_PREFIX}${slug}_${dims}`;
}

/** Collection for new jobs (the env model). Queries use the repo's job model instead. */
export const defaultCollectionName = collectionNameFor(env.EMBEDDING_MODEL, env.EMBEDDING_DIMS);

/** Payload fields we filter on. `index_job_id` lets cleanup keep exactly the new job's points. */
const PAYLOAD_INDEXES = ['repo_id', 'commit_sha', 'index_job_id'] as const;

export type ChunkPayload = {
  repo_id: string;
  commit_sha: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  symbol: string | null;
  chunk_type: 'function' | 'class' | 'block' | 'text';
  text: string;
  /** Not in the base CLAUDE.md payload list; added for exact cleanup of old points. */
  index_job_id: string;
};

const ensured = new Set<string>();

/** Creates the collection (cosine) and payload indexes if missing. Idempotent. */
export async function ensureCollection(name: string, dims: number): Promise<void> {
  if (ensured.has(name)) return;
  const { exists } = await qdrant.collectionExists(name);
  if (!exists) {
    try {
      await qdrant.createCollection(name, { vectors: { size: dims, distance: 'Cosine' } });
      console.log(`[qdrant] created collection ${name}`);
    } catch (err) {
      // Another process may have created it at the same moment.
      if (!(await qdrant.collectionExists(name)).exists) throw err;
    }
  }
  const info = await qdrant.getCollection(name);
  const size = (info.config.params.vectors as { size?: number } | undefined)?.size;
  if (size !== undefined && size !== dims) {
    throw new Error(`Qdrant collection ${name} has ${size}-dim vectors, expected ${dims}`);
  }
  const existing = info.payload_schema ?? {};
  for (const field of PAYLOAD_INDEXES) {
    if (existing[field]) continue;
    await qdrant.createPayloadIndex(name, {
      field_name: field,
      field_schema: 'keyword',
      wait: true,
    });
    console.log(`[qdrant] created payload index ${name}.${field}`);
  }
  ensured.add(name);
}

export function ensureDefaultCollection(): Promise<void> {
  return ensureCollection(defaultCollectionName, env.EMBEDDING_DIMS);
}

export type ChunkPoint = { id: string; vector: number[]; payload: ChunkPayload };

/** Upserts points in batches; ids are deterministic, so retries overwrite instead of duplicating. */
export async function upsertPoints(collection: string, points: ChunkPoint[], batchSize = 100) {
  for (let i = 0; i < points.length; i += batchSize) {
    await qdrant.upsert(collection, { wait: true, points: points.slice(i, i + batchSize) });
  }
}

/**
 * Deletes this repo's points that the given job did not write (older commits, or the
 * same commit chunked differently). Run only after every batch of the job succeeded.
 */
export async function deleteStaleRepoPoints(
  collection: string,
  repoId: string,
  keepJobId: string,
): Promise<number> {
  const filter = {
    must: [{ key: 'repo_id', match: { value: repoId } }],
    must_not: [{ key: 'index_job_id', match: { value: keepJobId } }],
  };
  const { count } = await qdrant.count(collection, { filter, exact: true });
  if (count > 0) await qdrant.delete(collection, { wait: true, filter });
  return count;
}

/** Stored chunk text by point id, for points that already exist in the collection. */
export async function existingPointTexts(
  collection: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const points = await qdrant.retrieve(collection, {
    ids,
    with_payload: ['text'],
    with_vector: false,
  });
  return new Map(
    points.map((p) => [String(p.id), String((p.payload as { text?: unknown } | null)?.text ?? '')]),
  );
}

/** Re-labels existing points as written by `jobId`, so cleanup keeps them. */
export async function claimPoints(collection: string, ids: string[], jobId: string): Promise<void> {
  if (ids.length === 0) return;
  await qdrant.setPayload(collection, {
    payload: { index_job_id: jobId },
    points: ids,
    wait: true,
  });
}

export async function countRepoPoints(collection: string, repoId: string, jobId?: string) {
  const must = [{ key: 'repo_id', match: { value: repoId } }];
  if (jobId) must.push({ key: 'index_job_id', match: { value: jobId } });
  const { count } = await qdrant.count(collection, { filter: { must }, exact: true });
  return count;
}

export type SearchHit = { id: string; score: number; payload: ChunkPayload };

export async function searchRepoPoints(
  collection: string,
  vector: number[],
  filter: { repoId: string; commitSha: string },
  limit: number,
): Promise<SearchHit[]> {
  const { points } = await qdrant.query(collection, {
    query: vector,
    limit,
    with_payload: true,
    filter: {
      must: [
        { key: 'repo_id', match: { value: filter.repoId } },
        { key: 'commit_sha', match: { value: filter.commitSha } },
      ],
    },
  });
  return points.map((h) => ({
    id: String(h.id),
    score: h.score,
    payload: h.payload as unknown as ChunkPayload,
  }));
}

/** Removes every vector of a repo, in every code collection (repo deleted from GitHub). */
export async function deleteRepoPoints(repoId: string): Promise<void> {
  const { collections } = await qdrant.getCollections();
  for (const { name } of collections) {
    if (!name.startsWith(COLLECTION_PREFIX)) continue;
    await qdrant.delete(name, {
      wait: false,
      filter: { must: [{ key: 'repo_id', match: { value: repoId } }] },
    });
  }
}

/**
 * After a successful index into `keepCollection`, removes the repo's points from every other
 * code collection (e.g. vectors of a previous embedding model). Returns how many were removed.
 */
export async function deleteRepoPointsOutside(
  repoId: string,
  keepCollection: string,
): Promise<number> {
  const { collections } = await qdrant.getCollections();
  let removed = 0;
  const filter = { must: [{ key: 'repo_id', match: { value: repoId } }] };
  for (const { name } of collections) {
    if (!name.startsWith(COLLECTION_PREFIX) || name === keepCollection) continue;
    const { count } = await qdrant.count(name, { filter, exact: true });
    if (count > 0) {
      await qdrant.delete(name, { wait: true, filter });
      removed += count;
    }
  }
  return removed;
}

export async function pingQdrant(): Promise<void> {
  await qdrant.getCollections();
}
