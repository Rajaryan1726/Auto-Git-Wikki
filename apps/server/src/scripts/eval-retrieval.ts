/**
 * Retrieval eval over a fixed set of queries with expected files.
 *
 *   npm run eval:retrieval [-- --set path/to/set.json] [--mode dense|rescored|both] [--verbose]
 *
 * For each query: take the repo's top candidates (same search path as chat), rank them
 * (dense only, or dense + re-scoring), and find the rank of the first expected file.
 * Reports hit@3 and MRR@10 (a miss beyond rank 10 scores 0).
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { eq, or } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { repositories } from '../db/schema.js';
import { CANDIDATE_POOL, rankHits } from '../services/rag-context.js';
import { searchRepo } from '../services/search.js';

type Case = { repo: string; query: string; expected: string[] };
type Mode = 'dense' | 'rescored';

const DEFAULT_SET = fileURLToPath(new URL('../../eval/retrieval-set.json', import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function repoId(name: string): Promise<string> {
  const [row] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(or(eq(repositories.fullName, name), eq(repositories.name, name)))
    .limit(1);
  if (!row) throw new Error(`Repository not in the database: ${name}`);
  return row.id;
}

function firstHitRank(paths: string[], expected: string[]): number | null {
  const i = paths.findIndex((p) => expected.includes(p));
  return i === -1 ? null : i + 1;
}

async function main(): Promise<void> {
  const set = JSON.parse(await readFile(arg('set') ?? DEFAULT_SET, 'utf8')) as { cases: Case[] };
  const modeArg = arg('mode') ?? 'both';
  const modes: Mode[] = modeArg === 'both' ? ['dense', 'rescored'] : [modeArg as Mode];
  const verbose = process.argv.includes('--verbose');
  const ranks: Record<Mode, (number | null)[]> = { dense: [], rescored: [] };

  for (const c of set.cases) {
    const id = await repoId(c.repo);
    const { hits } = await searchRepo(id, c.query, CANDIDATE_POOL);
    const line: string[] = [];
    for (const mode of modes) {
      const ordered = mode === 'dense' ? hits : rankHits(c.query, hits);
      // Rank by file: the first time each file appears.
      const files = [...new Set(ordered.map((h) => h.payload.file_path))];
      const rank = firstHitRank(files.slice(0, 10), c.expected);
      ranks[mode].push(rank);
      line.push(`${mode}=${rank ?? '-'}`);
      if (verbose) console.log(`    ${mode} top3: ${files.slice(0, 3).join(' | ')}`);
    }
    console.log(`${line.join('  ').padEnd(24)} ${c.repo.split('/')[1]}: ${c.query}`);
  }

  console.log('');
  for (const mode of modes) {
    const r = ranks[mode];
    const hit3 = r.filter((x) => x !== null && x <= 3).length / r.length;
    const mrr = r.reduce<number>((s, x) => s + (x ? 1 / x : 0), 0) / r.length;
    console.log(
      `${mode.padEnd(9)} hit@3 = ${(hit3 * 100).toFixed(1)}%  MRR@10 = ${mrr.toFixed(3)}  (n = ${r.length})`,
    );
  }
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
