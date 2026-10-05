import { z } from 'zod';

export const llmFeatureSchema = z.enum(['chat', 'rewrite', 'wiki', 'memory']);
export type LlmFeature = z.infer<typeof llmFeatureSchema>;

const counterSchema = z.object({ used: z.number(), limit: z.number() });

/** Today's usage vs the per-user limits (daily counters reset at 00:00 UTC). */
export const usageResponseSchema = z.object({
  /** Start of the current usage day (UTC midnight) and when it resets. */
  dayStart: z.string(),
  resetsAt: z.string(),
  tokens: z.object({
    used: z.number(),
    budget: z.number(),
    byFeature: z.record(llmFeatureSchema, z.number()),
  }),
  limits: z.object({
    indexedRepos: counterSchema,
    indexJobsToday: counterSchema,
    wikiRegenerationsToday: counterSchema,
    chatMessagesLastHour: counterSchema,
    maxRepoFiles: z.number(),
  }),
});
export type UsageResponse = z.infer<typeof usageResponseSchema>;

/** Counts of the data before and after a deletion (Postgres rows and Qdrant points). */
export const deletionReportSchema = z.object({
  before: z.record(z.string(), z.number()),
  after: z.record(z.string(), z.number()),
});
export type DeletionReport = z.infer<typeof deletionReportSchema>;
