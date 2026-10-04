import { Router, type Request } from 'express';
import { z } from 'zod';
import { wikiSlugSchema, type WikiPageResponse, type WikiResponse } from '@autowiki/shared';
import { HttpError } from '../lib/http-error.js';
import { currentUser, requireAuth } from '../middleware/require-auth.js';
import { findActiveJob } from '../services/index-jobs.js';
import { getRepoForUser } from '../services/repos.js';
import {
  failRun,
  getWikiPage,
  getWikiState,
  listWikiPages,
  startWikiRun,
  wikiJobFor,
} from '../services/wiki.js';
import { inngest } from '../inngest/client.js';
import { WIKI_REGENERATE_EVENT, type WikiRegenerateData } from '../inngest/functions/wiki.js';

const idSchema = z.uuid();

async function ownedRepo(req: Request) {
  const id = idSchema.safeParse(req.params.id);
  const repo = id.success ? await getRepoForUser(currentUser(req).id, id.data) : null;
  if (!repo) throw new HttpError(404, 'REPO_NOT_FOUND', 'Repository not found');
  return repo;
}

async function wikiResponse(repoId: string): Promise<WikiResponse> {
  const { status, doneRun } = await getWikiState(repoId);
  return { wiki: status, pages: doneRun ? await listWikiPages(doneRun.id) : [] };
}

/** /api/repos/:id/wiki… */
export const repoWikiRouter = Router();
repoWikiRouter.use(requireAuth);

/** Page tree + generation state for the repo's last successful index. */
repoWikiRouter.get('/:id/wiki', async (req, res) => {
  const repo = await ownedRepo(req);
  res.json(await wikiResponse(repo.id));
});

/** Regenerates only the wiki of the last successful index (no re-embedding). */
repoWikiRouter.post('/:id/wiki/regenerate', async (req, res) => {
  const repo = await ownedRepo(req);
  const job = await wikiJobFor(repo.id);
  if (!job) {
    throw new HttpError(
      409,
      'REPO_NOT_INDEXED',
      'Index this repository before generating its wiki.',
    );
  }
  if (await findActiveJob(repo.id)) {
    throw new HttpError(
      409,
      'INDEX_IN_PROGRESS',
      'This repository is being indexed; its wiki is generated when indexing finishes.',
    );
  }
  const { run, created } = await startWikiRun(repo.id, job.id, 'regenerate');
  if (created) {
    try {
      const data: WikiRegenerateData = { runId: run.id, repoId: repo.id };
      await inngest.send({ name: WIKI_REGENERATE_EVENT, data });
    } catch (err) {
      console.error(
        '[wiki] could not enqueue regeneration:',
        err instanceof Error ? err.message : err,
      );
      await failRun(run.id, 'Could not start: the background worker is unavailable.');
      throw new HttpError(
        503,
        'WORKER_UNAVAILABLE',
        'Could not start wiki generation: the background worker is unavailable. Try again shortly.',
      );
    }
  }
  res.status(created ? 202 : 200).json(await wikiResponse(repo.id));
});

/** One page (markdown + sources) of the current wiki. */
repoWikiRouter.get('/:id/wiki/:slug', async (req, res) => {
  const repo = await ownedRepo(req);
  const slug = wikiSlugSchema.safeParse(req.params.slug);
  const { doneRun } = await getWikiState(repo.id);
  const page = slug.success && doneRun ? await getWikiPage(doneRun, slug.data) : null;
  if (!page) throw new HttpError(404, 'WIKI_PAGE_NOT_FOUND', 'Wiki page not found');
  const body: WikiPageResponse = { page };
  res.json(body);
});
