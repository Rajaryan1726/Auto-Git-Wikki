/**
 * Prints the chunks for one file so chunking can be sanity-checked.
 *
 *   npm run dev:chunks -- <repoId> <filePath> [--ref <branch|sha>] [--text]
 *   npm run dev:chunks -- local <pathOnDisk> [--text]
 *
 * <repoId> is the AutoWiki repository id (uuid) or its full name (owner/repo). The file is
 * fetched from GitHub as the repo's owner, at the default branch unless --ref is given.
 */
import { readFile } from 'node:fs/promises';
import { and, eq, or } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { repositories } from '../db/schema.js';
import { chunkFile, type Chunk } from '../indexing/chunker.js';
import { githubFetch } from '../services/github-token.js';

function usage(): never {
  console.error(
    'Usage:\n' +
      '  npm run dev:chunks -- <repoId|owner/repo> <filePath> [--ref <branch|sha>] [--text]\n' +
      '  npm run dev:chunks -- local <pathOnDisk> [--text]',
  );
  process.exit(1);
}

async function fetchFromGithub(repoArg: string, filePath: string, ref?: string): Promise<string> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(repoArg);
  const [repo] = await db
    .select()
    .from(repositories)
    .where(
      isUuid
        ? eq(repositories.id, repoArg)
        : or(eq(repositories.fullName, repoArg), and(eq(repositories.name, repoArg))),
    )
    .limit(1);
  if (!repo) throw new Error(`Repository not found in the database: ${repoArg}`);

  const at = ref ?? repo.defaultBranch ?? 'HEAD';
  const path = filePath.split('/').map(encodeURIComponent).join('/');
  const res = await githubFetch(
    repo.userId,
    `/repos/${repo.fullName}/contents/${path}?ref=${encodeURIComponent(at)}`,
    { headers: { Accept: 'application/vnd.github.raw+json' } },
  );
  if (res.status === 404)
    throw new Error(`File not found on GitHub: ${repo.fullName}/${filePath}@${at}`);
  if (!res.ok) throw new Error(`GitHub returned ${res.status} for ${filePath}`);
  console.log(`# ${repo.fullName} @ ${at} : ${filePath}`);
  return res.text();
}

function printChunks(chunks: Chunk[], showText: boolean): void {
  const rows = chunks.map((c, i) => ({
    '#': i + 1,
    lines: `${c.startLine}-${c.endLine}`,
    n: c.endLine - c.startLine + 1,
    type: c.chunkType,
    symbol: c.symbol ?? '',
    chars: c.text.length,
  }));
  console.log(`language: ${chunks[0]?.language ?? '-'} | chunks: ${chunks.length}`);
  console.table(rows);
  if (showText) {
    for (const c of chunks) {
      console.log(`\n----- ${c.startLine}-${c.endLine} ${c.chunkType} ${c.symbol ?? ''} -----`);
      console.log(c.text);
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const showText = args.includes('--text');
  const refIndex = args.indexOf('--ref');
  const ref = refIndex >= 0 ? args[refIndex + 1] : undefined;
  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--ref');
  const [repoArg, filePath] = positional;
  if (!repoArg || !filePath) usage();

  const content =
    repoArg === 'local'
      ? await readFile(filePath, 'utf8')
      : await fetchFromGithub(repoArg, filePath, ref);
  printChunks(await chunkFile(filePath, content), showText);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
