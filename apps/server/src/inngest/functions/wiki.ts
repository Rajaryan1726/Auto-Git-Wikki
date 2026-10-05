import { NonRetriableError, type GetStepTools } from 'inngest';
import { z } from 'zod';
import {
  failRun,
  finishRun,
  generateOutline,
  generatePage,
  loadRunCtx,
  type PageResult,
  type WikiRunCtx,
} from '../../services/wiki.js';
import { inngest } from '../client.js';

import { moduleLogger } from '../../lib/logger.js';

const log = moduleLogger('wiki');

export const WIKI_REGENERATE_EVENT = 'repo/wiki.regenerate.requested';
export type WikiRegenerateData = { runId: string; repoId: string };
const eventDataSchema = z.object({ runId: z.uuid(), repoId: z.uuid() });

/** Pages generated in parallel (each is its own step). */
const PAGE_CONCURRENCY = 3;

type StepTools = GetStepTools<typeof inngest>;

async function requireRun(runId: string): Promise<WikiRunCtx> {
  const ctx = await loadRunCtx(runId);
  if (!ctx) throw new NonRetriableError('The wiki run is no longer running (superseded?).');
  return ctx;
}

function message(err: unknown): string {
  const e = err as { message?: string; cause?: { message?: string } };
  return (e?.cause?.message ?? e?.message ?? String(err)).slice(0, 500);
}

/**
 * The wiki steps, shared by the end of `index-repo` and by `regenerate-wiki`:
 * `wiki-outline` → `wiki-page-<slug>` (a few in parallel) → `wiki-finish`. Never throws:
 * a permanent failure marks the run failed and is returned, so the caller (indexing) can
 * still finish and the repo stays searchable.
 */
export async function runWikiSteps(
  step: StepTools,
  runId: string,
): Promise<{ status: 'done' | 'failed'; error: string | null }> {
  try {
    const planned = await step.run('wiki-outline', async () =>
      generateOutline(await requireRun(runId)),
    );

    const pages: PageResult[] = [];
    const failures: { slug: string; error: string }[] = [];
    const list = planned.outline.pages;
    for (let i = 0; i < list.length; i += PAGE_CONCURRENCY) {
      const group = list.slice(i, i + PAGE_CONCURRENCY);
      const settled = await Promise.allSettled(
        group.map((page) =>
          step.run(`wiki-page-${page.slug}`, async () =>
            generatePage(await requireRun(runId), planned.outline, page, planned.files),
          ),
        ),
      );
      settled.forEach((r, j) => {
        if (r.status === 'fulfilled') pages.push(r.value);
        else failures.push({ slug: group[j]!.slug, error: message(r.reason) });
      });
    }

    const finished = await step.run('wiki-finish', () =>
      finishRun(runId, { outline: planned.stats, pages, failures }),
    );
    return { status: finished.status, error: finished.error };
  } catch (err) {
    const error = message(err);
    await step.run('wiki-failed', () => failRun(runId, `Wiki generation failed: ${error}`));
    log.warn(`[wiki] run ${runId} failed: ${error}`);
    return { status: 'failed', error };
  }
}

/** POST /api/repos/:id/wiki/regenerate: a new wiki for the last successful index, no re-embedding. */
export const regenerateWiki = inngest.createFunction(
  {
    id: 'regenerate-wiki',
    triggers: [{ event: WIKI_REGENERATE_EVENT }],
    retries: 3,
    concurrency: [{ key: 'event.data.repoId', limit: 1 }],
    onFailure: async ({ event, error }) => {
      const parsed = eventDataSchema.safeParse(event.data.event.data);
      if (parsed.success)
        await failRun(parsed.data.runId, error.message || 'Wiki generation failed.');
    },
  },
  async ({ event, step }) => {
    const parsed = eventDataSchema.safeParse(event.data);
    if (!parsed.success) throw new NonRetriableError('Invalid wiki event payload.');
    return runWikiSteps(step, parsed.data.runId);
  },
);
