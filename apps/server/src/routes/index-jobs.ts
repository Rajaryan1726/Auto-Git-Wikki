import { Router, type Request } from 'express';
import { z } from 'zod';
import type {
  ActiveIndexJobsResponse,
  IndexJobListResponse,
  IndexJobResponse,
} from '@autowiki/shared';
import { HttpError } from '../lib/http-error.js';
import { currentUser, requireAuth } from '../middleware/require-auth.js';
import {
  createIndexJob,
  expireStaleQueuedJobs,
  failJob,
  getJobForUser,
  listActiveJobsForUser,
  listJobsForRepo,
  serializeJob,
} from '../services/index-jobs.js';
import { getRepoForUser } from '../services/repos.js';
import { inngest } from '../inngest/client.js';
import { INDEX_REQUESTED_EVENT, type IndexRequestedData } from '../inngest/functions/index-repo.js';

const idSchema = z.uuid();

/** Repo id from the URL, only if it belongs to the signed-in user (404 otherwise). */
async function ownedRepoId(req: Request): Promise<string> {
  const id = idSchema.safeParse(req.params.id);
  const repo = id.success ? await getRepoForUser(currentUser(req).id, id.data) : null;
  if (!repo) throw new HttpError(404, 'REPO_NOT_FOUND', 'Repository not found');
  return repo.id;
}

/** /api/repos/:id/index and /api/repos/:id/index-jobs */
export const repoIndexRouter = Router({ mergeParams: true });
repoIndexRouter.use(requireAuth);

repoIndexRouter.post('/:id/index', async (req, res) => {
  const repoId = await ownedRepoId(req);
  const { job, created } = await createIndexJob(repoId);

  if (created) {
    try {
      const data: IndexRequestedData = { jobId: job.id, repoId };
      await inngest.send({ name: INDEX_REQUESTED_EVENT, data });
    } catch (err) {
      console.error(
        '[index] could not enqueue job:',
        err instanceof Error ? err.message : 'unknown error',
      );
      await failJob(job.id, 'Could not start indexing: the background worker is unavailable.');
      throw new HttpError(
        503,
        'WORKER_UNAVAILABLE',
        'Could not start indexing: the background worker is unavailable. Try again shortly.',
      );
    }
  }

  const body: IndexJobResponse = { job: serializeJob(job) };
  // 202: accepted and running in the background; 200 when a job was already active.
  res.status(created ? 202 : 200).json(body);
});

repoIndexRouter.get('/:id/index-jobs', async (req, res) => {
  const repoId = await ownedRepoId(req);
  const body: IndexJobListResponse = { jobs: (await listJobsForRepo(repoId)).map(serializeJob) };
  res.json(body);
});

/** /api/index-jobs */
export const indexJobsRouter = Router();
indexJobsRouter.use(requireAuth);

indexJobsRouter.get('/active', async (req, res) => {
  await expireStaleQueuedJobs();
  const body: ActiveIndexJobsResponse = { jobs: await listActiveJobsForUser(currentUser(req).id) };
  res.json(body);
});

indexJobsRouter.get('/:id', async (req, res) => {
  const id = idSchema.safeParse(req.params.id);
  const job = id.success ? await getJobForUser(currentUser(req).id, id.data) : null;
  if (!job) throw new HttpError(404, 'JOB_NOT_FOUND', 'Index job not found');
  if (job.status === 'queued') await expireStaleQueuedJobs(job.repoId);
  const fresh = job.status === 'queued' ? await getJobForUser(currentUser(req).id, job.id) : job;
  const body: IndexJobResponse = { job: serializeJob(fresh ?? job) };
  res.json(body);
});
