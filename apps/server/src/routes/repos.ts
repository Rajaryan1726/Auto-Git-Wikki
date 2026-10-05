import { Router } from 'express';
import { z } from 'zod';
import {
  repoListQuerySchema,
  type DeletionReport,
  type RepoDetailResponse,
  type RepoListResponse,
  type RepoSyncResponse,
  type SyncSummary,
} from '@autowiki/shared';
import { HttpError } from '../lib/http-error.js';
import { currentUser, requireAuth } from '../middleware/require-auth.js';
import { githubFetch } from '../services/github-token.js';
import { syncUserRepos } from '../services/repo-sync.js';
import { deleteRepoData } from '../services/data-deletion.js';
import { getRepoForUser, listReposForUser } from '../services/repos.js';
import { getReposSyncedAt } from '../services/users.js';

export const reposRouter = Router();
reposRouter.use(requireAuth);

// One sync per user at a time; concurrent requests share the result.
const inflightSyncs = new Map<string, Promise<SyncSummary>>();

function syncOnce(userId: string): Promise<SyncSummary> {
  const existing = inflightSyncs.get(userId);
  if (existing) return existing;
  const promise = syncUserRepos(userId, {
    fetchGh: (path, init) => githubFetch(userId, path, init),
  }).finally(() => inflightSyncs.delete(userId));
  inflightSyncs.set(userId, promise);
  return promise;
}

reposRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const query = repoListQuerySchema.parse(req.query);

  // First login: the user has never been synced, so do it before answering.
  let syncedAt = await getReposSyncedAt(user.id);
  let autoSync: SyncSummary | null = null;
  if (!syncedAt) {
    autoSync = await syncOnce(user.id);
    syncedAt = new Date(autoSync.syncedAt);
  }

  const body: RepoListResponse = {
    repos: await listReposForUser(user.id, query),
    lastSyncedAt: syncedAt.toISOString(),
    autoSync,
  };
  res.json(body);
});

reposRouter.post('/sync', async (req, res) => {
  const user = currentUser(req);
  const summary = await syncOnce(user.id);
  const body: RepoSyncResponse = {
    repos: await listReposForUser(user.id, { filter: 'all' }),
    summary,
  };
  res.json(body);
});

const idSchema = z.uuid();

reposRouter.get('/:id', async (req, res) => {
  const user = currentUser(req);
  // A malformed id is answered like a missing one, so ids cannot be probed.
  const id = idSchema.safeParse(req.params.id);
  const repo = id.success ? await getRepoForUser(user.id, id.data) : null;
  if (!repo) throw new HttpError(404, 'REPO_NOT_FOUND', 'Repository not found');
  const body: RepoDetailResponse = { repo };
  res.json(body);
});

/**
 * Deletes everything derived from the repo (vectors, wiki, chats, index jobs); the repo
 * stays in the list as "Not indexed". Responds with before/after counts.
 */
reposRouter.delete('/:id/data', async (req, res) => {
  const user = currentUser(req);
  const id = idSchema.safeParse(req.params.id);
  const repo = id.success ? await getRepoForUser(user.id, id.data) : null;
  if (!repo) throw new HttpError(404, 'REPO_NOT_FOUND', 'Repository not found');
  const report: DeletionReport = await deleteRepoData(repo.id);
  res.json(report);
});
