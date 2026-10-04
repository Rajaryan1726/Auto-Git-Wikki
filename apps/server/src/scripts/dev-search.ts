/**
 * Semantic search over one indexed repo, for sanity-checking embeddings.
 *
 *   npm run dev:search -- <repoId|owner/repo> "<question>" [--k 5] [--text]
 *
 * Uses the repo's last successful index job (its model, dims and commit).
 */
import { eq, or } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { repositories } from '../db/schema.js';
import { searchRepo } from '../services/search.js';

function usage(): never {
  console.error('Usage: npm run dev:search -- <repoId|owner/repo> "<question>" [--k 5] [--text]');
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const kIndex = args.indexOf('--k');
  const k = kIndex >= 0 ? Number(args[kIndex + 1]) : 5;
  const showText = args.includes('--text');
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--k');
  const [repoArg, ...queryParts] = positional;
  const query = queryParts.join(' ').trim();
  if (!repoArg || !query || !Number.isInteger(k) || k < 1) usage();

  const isUuid = /^[0-9a-f-]{36}$/i.test(repoArg);
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      isUuid
        ? eq(repositories.id, repoArg)
        : or(eq(repositories.fullName, repoArg), eq(repositories.name, repoArg)),
    )
    .limit(1);
  if (!repo) throw new Error(`Repository not found in the database: ${repoArg}`);

  const started = Date.now();
  const result = await searchRepo(repo.id, query, k);
  console.log(
    `# ${repo.fullName} @ ${result.commitSha.slice(0, 7)} | ${result.embeddingModel} | ` +
      `${result.collection} | ${Date.now() - started} ms\n# query: ${query}`,
  );
  console.table(
    result.hits.map((h, i) => ({
      '#': i + 1,
      score: h.score.toFixed(4),
      location: `${h.payload.file_path}:${h.payload.start_line}-${h.payload.end_line}`,
      type: h.payload.chunk_type,
      symbol: h.payload.symbol ?? '',
    })),
  );
  if (showText) {
    for (const h of result.hits) {
      console.log(
        `\n----- ${h.payload.file_path}:${h.payload.start_line}-${h.payload.end_line} -----`,
      );
      console.log(h.payload.text);
    }
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
