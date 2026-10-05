/**
 * Per-user limits and the daily LLM token budget (Phase 6).
 *
 * - LLM usage is recorded per call in `llm_usage` (llm.ts reports it; see UsageContext).
 * - Daily counters and the budget reset at 00:00 UTC; the chat limit is a rolling hour.
 * - Checks run BEFORE new work starts (never mid-stream) and throw friendly 429 errors.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { and, count, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { LlmFeature, UsageResponse } from '@autowiki/shared';
import { db } from '../db/client.js';
import {
  chatMessages,
  chatThreads,
  indexJobs,
  llmUsage,
  repositories,
  wikiRuns,
} from '../db/schema.js';
import { env } from '../lib/env.js';
import { HttpError } from '../lib/http-error.js';
import { moduleLogger } from '../lib/logger.js';

const log = moduleLogger('usage');

export type UsageContext = { userId: string; feature: LlmFeature };

/**
 * Who is paying for the LLM calls made inside `fn` (memory engine calls, which have no
 * explicit request object). Explicit `GenerateRequest.usage` wins over this.
 */
const usageStore = new AsyncLocalStorage<UsageContext>();

export function withUsageContext<T>(ctx: UsageContext, fn: () => Promise<T>): Promise<T> {
  return usageStore.run(ctx, fn);
}

export function currentUsageContext(): UsageContext | undefined {
  return usageStore.getStore();
}

/** Records one model call's tokens. Best effort: a failed insert never fails the answer. */
export function recordUsage(
  ctx: UsageContext,
  model: string,
  usage: { inputTokens: number; outputTokens: number },
): void {
  db.insert(llmUsage)
    .values({
      userId: ctx.userId,
      feature: ctx.feature,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    })
    .catch((err: unknown) =>
      log.warn(
        { userId: ctx.userId, feature: ctx.feature, err: err instanceof Error ? err.message : err },
        'could not record LLM usage',
      ),
    );
}

// ---------------------------------------------------------------- time windows

export function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** "in 5 h 12 min" until the next UTC midnight. */
export function untilReset(now = new Date()): string {
  const ms = utcDayStart(now).getTime() + 86_400_000 - now.getTime();
  const h = Math.floor(ms / 3_600_000);
  const m = Math.ceil((ms % 3_600_000) / 60_000);
  return h > 0 ? `in ${h} h ${m} min` : `in ${m} min`;
}

// ---------------------------------------------------------------- counters

async function tokensToday(userId: string, dayStart: Date) {
  const rows = await db
    .select({
      feature: llmUsage.feature,
      tokens: sql<number>`coalesce(sum(${llmUsage.inputTokens} + ${llmUsage.outputTokens}), 0)::int`,
    })
    .from(llmUsage)
    .where(and(eq(llmUsage.userId, userId), gte(llmUsage.createdAt, dayStart)))
    .groupBy(llmUsage.feature);
  const byFeature: Record<LlmFeature, number> = { chat: 0, rewrite: 0, wiki: 0, memory: 0 };
  for (const r of rows) byFeature[r.feature] = Number(r.tokens);
  return { byFeature, used: Object.values(byFeature).reduce((a, b) => a + b, 0) };
}

async function countValue(q: Promise<{ n: number }[]>): Promise<number> {
  const [row] = await q;
  return Number(row?.n ?? 0);
}

/** Repos counted against the indexed-repo limit: indexed, or with an index running. */
async function indexedRepoIds(userId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: repositories.id })
    .from(repositories)
    .leftJoin(
      indexJobs,
      and(eq(indexJobs.repoId, repositories.id), inArray(indexJobs.status, ['queued', 'running'])),
    )
    .where(
      and(
        eq(repositories.userId, userId),
        or(isNotNull(repositories.lastIndexedJobId), isNotNull(indexJobs.id)),
      ),
    );
  return rows.map((r) => r.id);
}

export async function getUsage(userId: string, now = new Date()): Promise<UsageResponse> {
  const dayStart = utcDayStart(now);
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const [tokens, indexed, jobsToday, regenToday, chatHour] = await Promise.all([
    tokensToday(userId, dayStart),
    indexedRepoIds(userId),
    countValue(
      db
        .select({ n: count() })
        .from(indexJobs)
        .innerJoin(repositories, eq(repositories.id, indexJobs.repoId))
        .where(and(eq(repositories.userId, userId), gte(indexJobs.createdAt, dayStart))),
    ),
    countValue(
      db
        .select({ n: count() })
        .from(wikiRuns)
        .innerJoin(repositories, eq(repositories.id, wikiRuns.repoId))
        .where(
          and(
            eq(repositories.userId, userId),
            eq(wikiRuns.trigger, 'regenerate'),
            gte(wikiRuns.startedAt, dayStart),
          ),
        ),
    ),
    countValue(
      db
        .select({ n: count() })
        .from(chatMessages)
        .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
        .where(
          and(
            eq(chatThreads.userId, userId),
            eq(chatMessages.role, 'user'),
            gte(chatMessages.createdAt, hourAgo),
          ),
        ),
    ),
  ]);
  return {
    dayStart: dayStart.toISOString(),
    resetsAt: new Date(dayStart.getTime() + 86_400_000).toISOString(),
    tokens: { ...tokens, budget: env.LLM_DAILY_TOKEN_BUDGET },
    limits: {
      indexedRepos: { used: indexed.length, limit: env.LIMIT_MAX_INDEXED_REPOS },
      indexJobsToday: { used: jobsToday, limit: env.LIMIT_INDEX_JOBS_PER_DAY },
      wikiRegenerationsToday: { used: regenToday, limit: env.LIMIT_WIKI_REGENERATIONS_PER_DAY },
      chatMessagesLastHour: { used: chatHour, limit: env.LIMIT_CHAT_MESSAGES_PER_HOUR },
      maxRepoFiles: env.LIMIT_MAX_REPO_FILES,
    },
  };
}

// ---------------------------------------------------------------- checks

function limitReached(message: string): HttpError {
  return new HttpError(429, 'LIMIT_REACHED', message);
}

export function budgetExhausted(now = new Date()): HttpError {
  return new HttpError(
    429,
    'AI_BUDGET_EXHAUSTED',
    `You have used today's AI budget (${env.LLM_DAILY_TOKEN_BUDGET.toLocaleString('en-US')} tokens). ` +
      `It resets ${untilReset(now)} (00:00 UTC). Indexed code, wikis and chat history stay available.`,
  );
}

/** True while the user still has AI budget left today. */
export async function hasBudget(userId: string, now = new Date()): Promise<boolean> {
  const { used } = await tokensToday(userId, utcDayStart(now));
  return used < env.LLM_DAILY_TOKEN_BUDGET;
}

/** Before a chat answer: hourly message limit + AI budget. */
export async function assertCanAsk(userId: string, now = new Date()): Promise<void> {
  const usage = await getUsage(userId, now);
  const c = usage.limits.chatMessagesLastHour;
  if (c.used >= c.limit) {
    throw limitReached(
      `You have sent ${c.limit} chat messages in the last hour, the current limit. Please try again in a few minutes.`,
    );
  }
  if (usage.tokens.used >= usage.tokens.budget) throw budgetExhausted(now);
}

/** Before an index job: indexed-repo limit (new repos only), daily jobs, AI budget (wiki). */
export async function assertCanIndex(
  userId: string,
  repoId: string,
  now = new Date(),
): Promise<void> {
  const usage = await getUsage(userId, now);
  const { indexedRepos, indexJobsToday } = usage.limits;
  const alreadyCounted = (await indexedRepoIds(userId)).includes(repoId);
  if (!alreadyCounted && indexedRepos.used >= indexedRepos.limit) {
    throw limitReached(
      `You can index up to ${indexedRepos.limit} repositories. Delete the data of a repository you no longer need (repository page → Delete repo data) to free a slot.`,
    );
  }
  if (indexJobsToday.used >= indexJobsToday.limit) {
    throw limitReached(
      `You have started ${indexJobsToday.limit} index jobs today, the daily limit. It resets ${untilReset(now)} (00:00 UTC).`,
    );
  }
  if (usage.tokens.used >= usage.tokens.budget) throw budgetExhausted(now);
}

/** Before a wiki regeneration: daily regenerations + AI budget. */
export async function assertCanRegenerate(userId: string, now = new Date()): Promise<void> {
  const usage = await getUsage(userId, now);
  const c = usage.limits.wikiRegenerationsToday;
  if (c.used >= c.limit) {
    throw limitReached(
      `You have regenerated ${c.limit} wikis today, the daily limit. It resets ${untilReset(now)} (00:00 UTC).`,
    );
  }
  if (usage.tokens.used >= usage.tokens.budget) throw budgetExhausted(now);
}
