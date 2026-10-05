/**
 * Wiki generation (Phase 5): outline → one page per outline entry, saved to wiki_pages
 * under a wiki run. Retrieval reuses the chat path (searchRepo → rankHits → buildContext);
 * generation goes through llm.ts (primary model, fallback, circuit breaker). The Inngest
 * steps that call these live in inngest/functions/wiki.ts.
 */
import { and, count, desc, eq, lt, ne } from 'drizzle-orm';
import type { WikiPage, WikiPageSummary, WikiStatus } from '@autowiki/shared';
import { db } from '../db/client.js';
import {
  indexJobs,
  repositories,
  wikiPages,
  wikiRuns,
  type SourceRef,
  type WikiPageMeta,
  type WikiRunStats,
} from '../db/schema.js';
import { isSearchableJob } from './index-jobs.js';
import { generateText, type ChatTurn, type TokenUsage } from './llm.js';
import { collectionNameFor, fileChunks, listIndexedFiles } from './qdrant.js';
import { CANDIDATE_POOL, buildContext, rankHits } from './rag-context.js';
import { searchRepo } from './search.js';
import {
  OUTLINE_SYSTEM_PROMPT,
  badPathsRetryTurn,
  cleanPageMarkdown,
  excerptFromChunks,
  extractPathMentions,
  findUnknownPaths,
  formatFileTree,
  mergeSourceRefs,
  orderPages,
  outlineRetryTurn,
  outlineUserTurn,
  pageSystemPrompt,
  pageUserTurn,
  parseJsonObject,
  pickManifests,
  pickReadme,
  unlinkPaths,
  validateOutline,
  type Excerpt,
  type OutlinePage,
  type WikiOutline,
} from './wiki-content.js';

import { moduleLogger } from '../lib/logger.js';

const log = moduleLogger('wiki');

type RunRow = typeof wikiRuns.$inferSelect;
type JobRow = typeof indexJobs.$inferSelect;

/** A run that has not finished after this long is considered dead (worker stopped). */
const STALE_RUN_MS = 60 * 60_000;
const OUTLINE_TREE_CHARS = 20_000;
const PAGE_TREE_CHARS = 8_000;
const MAX_EXCERPT_FILES = 5;
const OUTLINE_MAX_TOKENS = 8_000;
const PAGE_MAX_TOKENS = 10_000;

export type WikiRunCtx = {
  runId: string;
  repoId: string;
  /** The repo owner: pays for the wiki's LLM calls (llm_usage, daily budget). */
  userId: string;
  jobId: string;
  trigger: 'index' | 'regenerate';
  repoFullName: string;
  description: string | null;
  commitSha: string;
  collection: string;
};

// ---------------------------------------------------------------- runs

/** Fails runs that stopped making progress so a new one can start. */
async function expireStaleRuns(repoId: string): Promise<void> {
  await db
    .update(wikiRuns)
    .set({
      status: 'failed',
      error: 'Wiki generation stopped responding (is the Inngest worker running?).',
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(wikiRuns.repoId, repoId),
        eq(wikiRuns.status, 'running'),
        lt(wikiRuns.startedAt, new Date(Date.now() - STALE_RUN_MS)),
      ),
    );
}

export async function runningWikiRun(repoId: string): Promise<RunRow | null> {
  const [run] = await db
    .select()
    .from(wikiRuns)
    .where(and(eq(wikiRuns.repoId, repoId), eq(wikiRuns.status, 'running')))
    .limit(1);
  return run ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

/**
 * Starts a wiki run for an index job. One run per repo at a time (partial unique index):
 * a regenerate request while one is running gets the running one back; the end of a new
 * index supersedes (fails) a regeneration of the previous index.
 */
export async function startWikiRun(
  repoId: string,
  jobId: string,
  trigger: 'index' | 'regenerate',
): Promise<{ run: RunRow; created: boolean }> {
  await expireStaleRuns(repoId);
  if (trigger === 'index') {
    await db
      .update(wikiRuns)
      .set({ status: 'failed', error: 'Superseded by a new index.', finishedAt: new Date() })
      .where(and(eq(wikiRuns.repoId, repoId), eq(wikiRuns.status, 'running')));
    await db
      .update(indexJobs)
      .set({ wikiPagesTotal: null, wikiPagesDone: 0 })
      .where(eq(indexJobs.id, jobId));
  } else {
    const existing = await runningWikiRun(repoId);
    if (existing) return { run: existing, created: false };
  }
  try {
    const [run] = await db
      .insert(wikiRuns)
      .values({ repoId, indexJobId: jobId, trigger })
      .returning();
    return { run: run!, created: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const existing = await runningWikiRun(repoId);
      if (existing) return { run: existing, created: false };
    }
    throw err;
  }
}

/** Context for a run that is still running; null if it finished, failed or was superseded. */
export async function loadRunCtx(runId: string): Promise<WikiRunCtx | null> {
  const [row] = await db
    .select({ run: wikiRuns, job: indexJobs, repo: repositories })
    .from(wikiRuns)
    .innerJoin(indexJobs, eq(indexJobs.id, wikiRuns.indexJobId))
    .innerJoin(repositories, eq(repositories.id, wikiRuns.repoId))
    .where(eq(wikiRuns.id, runId))
    .limit(1);
  if (!row || row.run.status !== 'running' || !row.job.commitSha) return null;
  return {
    runId,
    repoId: row.repo.id,
    userId: row.repo.userId,
    jobId: row.job.id,
    trigger: row.run.trigger,
    repoFullName: row.repo.fullName,
    description: row.repo.description,
    commitSha: row.job.commitSha,
    collection: collectionNameFor(row.job.embeddingModel, row.job.embeddingDims),
  };
}

export async function failRun(runId: string, message: string): Promise<void> {
  await db
    .update(wikiRuns)
    .set({ status: 'failed', error: message.slice(0, 1000), finishedAt: new Date() })
    .where(and(eq(wikiRuns.id, runId), eq(wikiRuns.status, 'running')));
}

/** After an index finishes: drop wiki runs of the repo's earlier index jobs. */
export async function pruneWikiRunsOfOtherJobs(repoId: string, keepJobId: string): Promise<void> {
  await db
    .delete(wikiRuns)
    .where(
      and(
        eq(wikiRuns.repoId, repoId),
        ne(wikiRuns.indexJobId, keepJobId),
        ne(wikiRuns.status, 'running'),
      ),
    );
}

// ---------------------------------------------------------------- outline

export type OutlineStats = {
  model: string;
  attempts: number;
  ms: number;
  usage: TokenUsage | null;
  droppedFiles: number;
};

function addUsage(a: TokenUsage | null, b: TokenUsage | null): TokenUsage | null {
  if (!a) return b;
  if (!b) return a;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/**
 * Builds and validates the outline from the indexed file list, README and manifests.
 * An invalid reply is retried once with the validation errors.
 */
export async function generateOutline(
  ctx: WikiRunCtx,
): Promise<{ outline: WikiOutline; files: string[]; stats: OutlineStats }> {
  const started = Date.now();
  const rc = { repoId: ctx.repoId, commitSha: ctx.commitSha };
  const files = await listIndexedFiles(ctx.collection, rc);
  if (files.length === 0) throw new Error('No indexed files were found for this commit.');

  const readmePath = pickReadme(files);
  const manifestPaths = pickManifests(files);
  const chunks = await fileChunks(
    ctx.collection,
    rc,
    [readmePath, ...manifestPaths].filter((p): p is string => p !== null),
  );
  const readme = readmePath ? excerptFromChunks(readmePath, chunks, 400, 6_000) : null;
  const manifests = manifestPaths
    .map((p) => excerptFromChunks(p, chunks, 120, 2_500))
    .filter((e): e is Excerpt => e !== null);

  const messages: ChatTurn[] = [
    {
      role: 'user',
      content: outlineUserTurn({
        repoFullName: ctx.repoFullName,
        description: ctx.description,
        fileTree: formatFileTree(files, OUTLINE_TREE_CHARS),
        readme,
        manifests,
      }),
    },
  ];

  let usage: TokenUsage | null = null;
  let errors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const reply = await generateText({
      usage: { userId: ctx.userId, feature: 'wiki' },
      system: OUTLINE_SYSTEM_PROMPT,
      messages,
      json: true,
      maxOutputTokens: OUTLINE_MAX_TOKENS,
    });
    usage = addUsage(usage, reply.usage);
    let raw: unknown;
    try {
      raw = parseJsonObject(reply.text);
    } catch (err) {
      errors = [`The reply is not valid JSON: ${err instanceof Error ? err.message : String(err)}`];
    }
    if (raw !== undefined) {
      const result = validateOutline(raw, files);
      if (result.ok) {
        const stats: OutlineStats = {
          model: reply.model,
          attempts: attempt,
          ms: Date.now() - started,
          usage,
          droppedFiles: result.droppedFiles.length,
        };
        await saveOutline(ctx, result.outline);
        log.info(
          `[wiki] run ${ctx.runId} outline: ${result.outline.pages.length} pages by ${reply.model}` +
            ` (attempt ${attempt}, ${stats.ms} ms, ${fmtUsage(usage)}` +
            `${result.droppedFiles.length ? `, ${result.droppedFiles.length} unknown files dropped` : ''})`,
        );
        return { outline: result.outline, files, stats };
      }
      errors = result.errors;
    }
    log.warn(
      `[wiki] run ${ctx.runId} outline attempt ${attempt} invalid: ${errors.join('; ').slice(0, 300)}`,
    );
    messages.push(
      { role: 'assistant', content: reply.text.slice(0, 20_000) },
      { role: 'user', content: outlineRetryTurn(errors) },
    );
  }
  throw new Error(
    `The model returned an invalid wiki outline twice (${errors.slice(0, 3).join('; ')}).`,
  );
}

async function saveOutline(ctx: WikiRunCtx, outline: WikiOutline): Promise<void> {
  await db
    .update(wikiRuns)
    .set({ outline, pagesTotal: outline.pages.length, pagesDone: 0 })
    .where(eq(wikiRuns.id, ctx.runId));
  if (ctx.trigger === 'index') {
    await db
      .update(indexJobs)
      .set({ wikiPagesTotal: outline.pages.length, wikiPagesDone: 0 })
      .where(eq(indexJobs.id, ctx.jobId));
  }
}

function fmtUsage(u: TokenUsage | null): string {
  return u ? `${u.inputTokens} in / ${u.outputTokens} out tokens` : 'tokens n/a';
}

// ---------------------------------------------------------------- pages

export type PageResult = { slug: string } & WikiPageMeta;

/**
 * Writes one page: retrieval through the chat path, short excerpts of the page's files,
 * generation, then the hallucination check on file paths (one retry, then un-link).
 */
export async function generatePage(
  ctx: WikiRunCtx,
  outline: WikiOutline,
  page: OutlinePage,
  files: string[],
): Promise<PageResult> {
  const started = Date.now();
  const query = `${page.title}: ${page.purpose}`;
  const { hits } = await searchRepo(ctx.repoId, query, CANDIDATE_POOL, { jobId: ctx.jobId });
  const { blocks } = buildContext(rankHits(query, hits));

  const excerptPaths = page.files.slice(0, MAX_EXCERPT_FILES);
  const chunks = await fileChunks(
    ctx.collection,
    { repoId: ctx.repoId, commitSha: ctx.commitSha },
    excerptPaths,
  );
  const excerpts = excerptPaths
    .map((p) => excerptFromChunks(p, chunks, 80, 2_500))
    .filter((e): e is Excerpt => e !== null);

  const system = pageSystemPrompt(ctx.repoFullName, ctx.commitSha);
  const messages: ChatTurn[] = [
    {
      role: 'user',
      content: pageUserTurn({
        page,
        outline,
        fileTree: formatFileTree(files, PAGE_TREE_CHARS),
        blocks,
        excerpts,
      }),
    },
  ];

  const usage0 = { userId: ctx.userId, feature: 'wiki' as const };
  const first = await generateText({
    system,
    messages,
    maxOutputTokens: PAGE_MAX_TOKENS,
    usage: usage0,
  });
  let usage = first.usage;
  let model = first.model;
  const fallbackFrom = [...first.failedOrSkipped];
  let md = cleanPageMarkdown(first.text);
  if (!md) throw new Error(`The model returned an empty page for "${page.title}".`);

  const badFirst = findUnknownPaths(extractPathMentions(md), files);
  let remaining = badFirst;
  if (badFirst.length) {
    messages.push(
      { role: 'assistant', content: first.text },
      { role: 'user', content: badPathsRetryTurn(badFirst.map((b) => b.path)) },
    );
    const second = await generateText({
      system,
      messages,
      maxOutputTokens: PAGE_MAX_TOKENS,
      usage: usage0,
    });
    usage = addUsage(usage, second.usage);
    fallbackFrom.push(...second.failedOrSkipped);
    const retried = cleanPageMarkdown(second.text);
    if (retried) {
      md = retried;
      model = second.model;
    }
    remaining = findUnknownPaths(extractPathMentions(md), files);
    md = unlinkPaths(md, remaining);
  }

  const sourceFiles: SourceRef[] = mergeSourceRefs([
    ...blocks.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })),
    ...excerpts.map(({ path, startLine, endLine }) => ({ path, startLine, endLine })),
  ]);
  const meta: WikiPageMeta = {
    model,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    ms: Date.now() - started,
    fallbackFrom: [...new Set(fallbackFrom)],
    badPathsFirstDraft: badFirst.map((b) => b.path),
    removedPaths: remaining.map((b) => b.path),
  };

  await db
    .insert(wikiPages)
    .values({
      repoId: ctx.repoId,
      indexJobId: ctx.jobId,
      wikiRunId: ctx.runId,
      slug: page.slug,
      title: page.title,
      parentSlug: page.parentSlug,
      position: page.position,
      contentMd: md,
      sourceFiles,
      meta,
    })
    .onConflictDoUpdate({
      target: [wikiPages.wikiRunId, wikiPages.slug],
      set: { contentMd: md, sourceFiles, meta, title: page.title },
    });
  await updatePagesDone(ctx);

  log.info(
    `[wiki] run ${ctx.runId} page ${page.slug}: ${model}` +
      `${meta.fallbackFrom.length ? ` (after ${meta.fallbackFrom.join(', ')})` : ''}, ` +
      `${fmtUsage(usage)}, ${meta.ms} ms, ${blocks.length} blocks + ${excerpts.length} excerpts` +
      (badFirst.length
        ? `, bad paths ${badFirst.length} -> retry -> ${remaining.length} removed`
        : ''),
  );
  return { slug: page.slug, ...meta };
}

/** Idempotent progress: the count of saved pages (safe when a page step is retried). */
async function updatePagesDone(ctx: WikiRunCtx): Promise<void> {
  const [row] = await db
    .select({ n: count() })
    .from(wikiPages)
    .where(eq(wikiPages.wikiRunId, ctx.runId));
  const done = row?.n ?? 0;
  await db.update(wikiRuns).set({ pagesDone: done }).where(eq(wikiRuns.id, ctx.runId));
  if (ctx.trigger === 'index') {
    await db.update(indexJobs).set({ wikiPagesDone: done }).where(eq(indexJobs.id, ctx.jobId));
  }
}

// ---------------------------------------------------------------- finish

export function aggregateStats(
  outline: OutlineStats,
  pages: PageResult[],
  failed: number,
  durationMs: number,
): WikiRunStats {
  const models: Record<string, number> = {};
  for (const p of pages) models[p.model] = (models[p.model] ?? 0) + 1;
  return {
    outlineModel: outline.model,
    outlineAttempts: outline.attempts,
    outlineMs: outline.ms,
    pagesGenerated: pages.length,
    pagesFailed: failed,
    inputTokens:
      (outline.usage?.inputTokens ?? 0) + pages.reduce((n, p) => n + (p.inputTokens ?? 0), 0),
    outputTokens:
      (outline.usage?.outputTokens ?? 0) + pages.reduce((n, p) => n + (p.outputTokens ?? 0), 0),
    pagesRetriedForPaths: pages.filter((p) => p.badPathsFirstDraft.length > 0).length,
    pagesWithRemovedPaths: pages.filter((p) => p.removedPaths.length > 0).length,
    removedPaths: pages.reduce((n, p) => n + p.removedPaths.length, 0),
    models,
    durationMs,
  };
}

/**
 * Completes a run: `done` if every page was written, otherwise `failed` with the first
 * error. A successful regeneration replaces the repo's other runs (and their pages).
 */
export async function finishRun(
  runId: string,
  input: {
    outline: OutlineStats;
    pages: PageResult[];
    failures: { slug: string; error: string }[];
  },
): Promise<{ status: 'done' | 'failed'; error: string | null; stats: WikiRunStats }> {
  const [run] = await db.select().from(wikiRuns).where(eq(wikiRuns.id, runId)).limit(1);
  if (!run) throw new Error('The wiki run no longer exists.');
  const stats = aggregateStats(
    input.outline,
    input.pages,
    input.failures.length,
    Date.now() - run.startedAt.getTime(),
  );
  const failed = input.failures.length > 0;
  const error = failed
    ? `${input.failures.length} of ${input.failures.length + input.pages.length} pages failed ` +
      `(first: ${input.failures[0]!.slug}: ${input.failures[0]!.error})`.slice(0, 900)
    : null;
  await db
    .update(wikiRuns)
    .set({ status: failed ? 'failed' : 'done', error, stats, finishedAt: new Date() })
    .where(and(eq(wikiRuns.id, runId), eq(wikiRuns.status, 'running')));
  if (!failed && run.trigger === 'regenerate') {
    await db
      .delete(wikiRuns)
      .where(
        and(
          eq(wikiRuns.repoId, run.repoId),
          ne(wikiRuns.id, runId),
          ne(wikiRuns.status, 'running'),
        ),
      );
  }
  // Per wiki run: pages, tokens, time, models, hallucination-check counts.
  log[failed ? 'warn' : 'info'](
    {
      runId,
      repoId: run.repoId,
      status: failed ? 'failed' : 'done',
      pages: stats.pagesGenerated,
      pagesFailed: stats.pagesFailed,
      durationMs: stats.durationMs,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      models: stats.models,
      outlineModel: stats.outlineModel,
      pagesRetriedForPaths: stats.pagesRetriedForPaths,
      pagesWithRemovedPaths: stats.pagesWithRemovedPaths,
      ...(error ? { error } : {}),
    },
    'wiki run finished',
  );
  return { status: failed ? 'failed' : 'done', error, stats };
}

// ---------------------------------------------------------------- reads (API)

async function lastIndexedJob(repoId: string): Promise<{
  job: JobRow | null;
  pushedAt: Date | null;
}> {
  const [row] = await db
    .select({ job: indexJobs, pushedAt: repositories.githubPushedAt })
    .from(repositories)
    .leftJoin(indexJobs, eq(indexJobs.id, repositories.lastIndexedJobId))
    .where(eq(repositories.id, repoId))
    .limit(1);
  const job = row?.job && isSearchableJob(row.job) ? row.job : null;
  return { job, pushedAt: row?.pushedAt ?? null };
}

/** The repo's last successful index job (the one a regeneration works on), or null. */
export async function wikiJobFor(repoId: string): Promise<JobRow | null> {
  return (await lastIndexedJob(repoId)).job;
}

type WikiState = { status: WikiStatus; doneRun: RunRow | null };

export async function getWikiState(repoId: string): Promise<WikiState> {
  await expireStaleRuns(repoId);
  const { job, pushedAt } = await lastIndexedJob(repoId);
  if (!job) {
    return {
      doneRun: null,
      status: {
        state: 'none',
        indexJobId: null,
        commitSha: null,
        pagesTotal: null,
        pagesDone: 0,
        error: null,
        generatedAt: null,
        stale: false,
      },
    };
  }
  const runs = await db
    .select()
    .from(wikiRuns)
    .where(eq(wikiRuns.indexJobId, job.id))
    .orderBy(desc(wikiRuns.startedAt))
    .limit(10);
  const latest = runs[0] ?? null;
  const doneRun = runs.find((r) => r.status === 'done') ?? null;
  const shown = latest?.status === 'running' ? latest : (doneRun ?? latest);
  const indexedAt = job.startedAt ?? job.createdAt;
  return {
    doneRun,
    status: {
      state: latest ? (latest.status === 'running' ? 'generating' : latest.status) : 'none',
      indexJobId: job.id,
      commitSha: job.commitSha,
      pagesTotal: shown?.pagesTotal ?? null,
      pagesDone: shown?.pagesDone ?? 0,
      error: latest?.status === 'failed' ? latest.error : null,
      generatedAt: doneRun?.finishedAt?.toISOString() ?? null,
      stale: pushedAt !== null && pushedAt.getTime() > indexedAt.getTime(),
    },
  };
}

export async function listWikiPages(runId: string): Promise<WikiPageSummary[]> {
  const rows = await db
    .select({
      slug: wikiPages.slug,
      title: wikiPages.title,
      parentSlug: wikiPages.parentSlug,
      position: wikiPages.position,
    })
    .from(wikiPages)
    .where(eq(wikiPages.wikiRunId, runId));
  // Same flat tree order as the outline (parents by position, children after their parent).
  return orderPages(rows.map((r) => ({ ...r, purpose: '', files: [] }))).map(
    ({ slug, title, parentSlug, position }) => ({ slug, title, parentSlug, position }),
  );
}

export async function getWikiPage(run: RunRow, slug: string): Promise<WikiPage | null> {
  const [row] = await db
    .select({ page: wikiPages, commitSha: indexJobs.commitSha })
    .from(wikiPages)
    .innerJoin(indexJobs, eq(indexJobs.id, wikiPages.indexJobId))
    .where(and(eq(wikiPages.wikiRunId, run.id), eq(wikiPages.slug, slug)))
    .limit(1);
  if (!row || !row.commitSha) return null;
  const p = row.page;
  return {
    slug: p.slug,
    title: p.title,
    parentSlug: p.parentSlug,
    position: p.position,
    contentMd: p.contentMd,
    sources: p.sourceFiles,
    commitSha: row.commitSha,
    model: p.meta?.model ?? null,
    generatedAt: p.createdAt.toISOString(),
  };
}
