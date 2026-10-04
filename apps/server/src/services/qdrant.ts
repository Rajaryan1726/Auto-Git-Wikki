import { QdrantClient } from '@qdrant/js-client-rest';
import { env } from '../lib/env.js';

/** OpenAI is a text-generation fallback only, so embeddings always come from Gemini. */
const EMBEDDING_PROVIDER = 'gemini';

export const qdrant = new QdrantClient({
  url: env.QDRANT_URL,
  apiKey: env.QDRANT_API_KEY,
  checkCompatibility: false,
});

/** One collection per embedding model: `code_<provider>_<dims>`. */
export const codeCollectionName = `code_${EMBEDDING_PROVIDER}_${env.EMBEDDING_DIMS}`;

const PAYLOAD_INDEXES = ['repo_id', 'commit_sha'] as const;

export async function ensureCodeCollection(): Promise<void> {
  const { exists } = await qdrant.collectionExists(codeCollectionName);
  if (!exists) {
    await qdrant.createCollection(codeCollectionName, {
      vectors: { size: env.EMBEDDING_DIMS, distance: 'Cosine' },
    });
    console.log(`[qdrant] created collection ${codeCollectionName}`);
  }

  const info = await qdrant.getCollection(codeCollectionName);
  const existing = info.payload_schema ?? {};
  for (const field of PAYLOAD_INDEXES) {
    if (existing[field]) continue;
    await qdrant.createPayloadIndex(codeCollectionName, {
      field_name: field,
      field_schema: 'keyword',
      wait: true,
    });
    console.log(`[qdrant] created payload index ${codeCollectionName}.${field}`);
  }
}

/** Removes every vector belonging to a repo (all commits). */
export async function deleteRepoPoints(repoId: string): Promise<void> {
  await qdrant.delete(codeCollectionName, {
    wait: false,
    filter: { must: [{ key: 'repo_id', match: { value: repoId } }] },
  });
}

export async function pingQdrant(): Promise<void> {
  await qdrant.getCollections();
}
