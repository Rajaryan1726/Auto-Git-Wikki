import { z } from 'zod';
import type { TreeEntry } from '../indexing/file-filter.js';
import { ensureGithubOk, rateLimitError, type GithubFetch } from './github-api.js';

/** The repository is gone or this user can no longer read it. Never worth retrying. */
export class RepoAccessLostError extends Error {
  constructor() {
    super('The repository was deleted or AutoWiki lost access to it.');
    this.name = 'RepoAccessLostError';
  }
}

export class RepoEmptyError extends Error {
  constructor() {
    super('The repository is empty. Push a commit, then index it again.');
    this.name = 'RepoEmptyError';
  }
}

function isAccessLost(res: Response): boolean {
  return res.status === 404 || res.status === 410 || (res.status === 403 && !rateLimitError(res));
}

const repoSchema = z.object({ full_name: z.string(), default_branch: z.string().nullable() });

export type RepoHead = { fullName: string; defaultBranch: string; commitSha: string };

/**
 * Looks the repo up by its stable GitHub id (survives renames and transfers) and resolves
 * the latest commit on its default branch.
 */
export async function resolveRepoHead(
  fetchGh: GithubFetch,
  githubRepoId: number,
): Promise<RepoHead> {
  const repoRes = await fetchGh(`/repositories/${githubRepoId}`);
  if (isAccessLost(repoRes)) throw new RepoAccessLostError();
  ensureGithubOk(repoRes, 'get repository');
  const repo = repoSchema.parse(await repoRes.json());
  if (!repo.default_branch) throw new RepoEmptyError();

  const commitRes = await fetchGh(
    `/repos/${repo.full_name}/commits/${encodeURIComponent(repo.default_branch)}`,
    { headers: { Accept: 'application/vnd.github.sha' } },
  );
  if (commitRes.status === 409) throw new RepoEmptyError(); // "Git Repository is empty."
  if (isAccessLost(commitRes)) throw new RepoAccessLostError();
  ensureGithubOk(commitRes, 'resolve latest commit');
  const commitSha = (await commitRes.text()).trim();
  if (!/^[0-9a-f]{40}$/i.test(commitSha)) throw new Error('GitHub returned an invalid commit sha');
  return { fullName: repo.full_name, defaultBranch: repo.default_branch, commitSha };
}

const treeSchema = z.object({
  truncated: z.boolean().optional(),
  tree: z.array(
    z.object({
      path: z.string(),
      type: z.string(),
      sha: z.string(),
      size: z.number().optional(),
    }),
  ),
});

/** Every entry of the commit's tree. GitHub truncates very large trees (~100k entries). */
export async function listTree(
  fetchGh: GithubFetch,
  fullName: string,
  commitSha: string,
): Promise<{ entries: TreeEntry[]; truncated: boolean }> {
  const res = await fetchGh(`/repos/${fullName}/git/trees/${commitSha}?recursive=1`);
  if (isAccessLost(res)) throw new RepoAccessLostError();
  ensureGithubOk(res, 'list files');
  const data = treeSchema.parse(await res.json());
  return { entries: data.tree, truncated: data.truncated ?? false };
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

export type BlobResult =
  | { kind: 'text'; text: string }
  | { kind: 'binary' }
  /** The blob is missing but the repo is still there; skip the file. */
  | { kind: 'missing' };

/** Downloads one file by blob sha (immutable, so retries always see the same content). */
export async function fetchBlobText(
  fetchGh: GithubFetch,
  fullName: string,
  blobSha: string,
): Promise<BlobResult> {
  const res = await fetchGh(`/repos/${fullName}/git/blobs/${blobSha}`, {
    headers: { Accept: 'application/vnd.github.raw+json' },
  });
  if (res.status === 404 || res.status === 403) {
    const limited = rateLimitError(res);
    if (limited) throw limited;
    return { kind: 'missing' }; // caller confirms whether the whole repo is gone
  }
  ensureGithubOk(res, 'download file');
  try {
    return { kind: 'text', text: utf8.decode(await res.arrayBuffer()) };
  } catch {
    return { kind: 'binary' };
  }
}
