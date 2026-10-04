/**
 * Shows a repo's wiki (outline, per-page model / tokens / time, hallucination-check counts)
 * or starts a regeneration through the same Inngest function as the API.
 *
 *   npm run dev:wiki -- <repoId|owner/repo>                 # outline + stats of the latest runs
 *   npm run dev:wiki -- <repoId|owner/repo> --regenerate    # new wiki for the last index
 *   npm run dev:wiki -- <repoId|owner/repo> --page <slug>   # print one page's markdown
 */
import { desc, eq, or } from 'drizzle-orm';
import { db, pool } from '../db/client.js';
import { repositories, wikiPages, wikiRuns } from '../db/schema.js';
import { inngest } from '../inngest/client.js';
import { WIKI_REGENERATE_EVENT } from '../inngest/functions/wiki.js';
import { startWikiRun, wikiJobFor } from '../services/wiki.js';
import type { WikiOutline } from '../services/wiki-content.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoArg = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--page');
  if (!repoArg) {
    console.error('Usage: npm run dev:wiki -- <repoId|owner/repo> [--regenerate] [--page <slug>]');
    process.exit(1);
  }
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
  if (!repo) throw new Error(`Repository not found: ${repoArg}`);

  if (args.includes('--regenerate')) {
    const job = await wikiJobFor(repo.id);
    if (!job) throw new Error('The repository has no successful index.');
    const { run, created } = await startWikiRun(repo.id, job.id, 'regenerate');
    if (created)
      await inngest.send({ name: WIKI_REGENERATE_EVENT, data: { runId: run.id, repoId: repo.id } });
    console.log(`${created ? 'Started' : 'Already running'}: wiki run ${run.id} for job ${job.id}`);
    return;
  }

  const slugIdx = args.indexOf('--page');
  const runs = await db
    .select()
    .from(wikiRuns)
    .where(eq(wikiRuns.repoId, repo.id))
    .orderBy(desc(wikiRuns.startedAt))
    .limit(3);
  if (runs.length === 0) {
    console.log(`${repo.fullName}: no wiki runs.`);
    return;
  }
  if (slugIdx >= 0) {
    const done = runs.find((r) => r.status === 'done') ?? runs[0]!;
    const all = await db.select().from(wikiPages).where(eq(wikiPages.wikiRunId, done.id));
    const wanted = all.find((p) => p.slug === args[slugIdx + 1]);
    console.log(wanted ? `# ${wanted.title}\n\n${wanted.contentMd}` : 'Page not found.');
    return;
  }

  for (const run of runs) {
    const ms = (run.finishedAt?.getTime() ?? Date.now()) - run.startedAt.getTime();
    console.log(
      `\n== run ${run.id} (${run.trigger}) ${run.status} — job ${run.indexJobId}, ` +
        `${run.pagesDone}/${run.pagesTotal ?? '?'} pages, ${Math.round(ms / 1000)} s` +
        (run.error ? `\n   error: ${run.error}` : ''),
    );
    if (Object.keys(run.stats).length) console.log(`   stats: ${JSON.stringify(run.stats)}`);
    const outline = run.outline as WikiOutline | null;
    if (!outline) continue;
    const pages = await db.select().from(wikiPages).where(eq(wikiPages.wikiRunId, run.id));
    for (const p of outline.pages) {
      const saved = pages.find((x) => x.slug === p.slug);
      const m = saved?.meta;
      console.log(
        `   ${p.parentSlug ? '    ' : ''}- ${p.title} (${p.slug}) files=[${p.files.join(', ')}]` +
          (m
            ? `\n   ${p.parentSlug ? '    ' : ''}    ${m.model}, ${m.inputTokens ?? '?'} in / ${m.outputTokens ?? '?'} out, ` +
              `${m.ms} ms, ${saved.contentMd.length} chars, bad paths ${m.badPathsFirstDraft.length}` +
              `${m.badPathsFirstDraft.length ? ` [${m.badPathsFirstDraft.join(', ')}]` : ''}` +
              ` -> removed ${m.removedPaths.length}${m.removedPaths.length ? ` [${m.removedPaths.join(', ')}]` : ''}`
            : '  (not saved)'),
      );
    }
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
