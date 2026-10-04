import { z } from 'zod';

export const repoFilters = ['all', 'public', 'private', 'indexed'] as const;
export type RepoFilter = (typeof repoFilters)[number];

export const repoListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  filter: z.enum(repoFilters).default('all'),
});
export type RepoListQuery = z.infer<typeof repoListQuerySchema>;

export const repoIndexStateSchema = z.enum(['not_indexed', 'indexing', 'indexed', 'failed']);
export type RepoIndexState = z.infer<typeof repoIndexStateSchema>;

export const repoIndexStatusSchema = z.object({
  state: repoIndexStateSchema,
  /** 0–100 while indexing. */
  progress: z.number().min(0).max(100).nullable(),
  /** Commit of the last successful index. */
  commitSha: z.string().nullable(),
  lastIndexedAt: z.string().nullable(),
  /** Error of the latest job when it failed. */
  error: z.string().nullable(),
});
export type RepoIndexStatus = z.infer<typeof repoIndexStatusSchema>;

export const repoSummarySchema = z.object({
  id: z.string(),
  githubRepoId: z.number(),
  fullName: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isPrivate: z.boolean(),
  defaultBranch: z.string().nullable(),
  language: z.string().nullable(),
  githubUpdatedAt: z.string().nullable(),
  githubPushedAt: z.string().nullable(),
  htmlUrl: z.string(),
  status: repoIndexStatusSchema,
});
export type RepoSummary = z.infer<typeof repoSummarySchema>;

export const skippedOrgReasonSchema = z.enum(['oauth_restricted', 'sso_required']);

export const syncSummarySchema = z.object({
  total: z.number(),
  added: z.number(),
  updated: z.number(),
  removed: z.number(),
  /** False when GitHub returned partial results, so removals were not applied. */
  removalsApplied: z.boolean(),
  skipped: z.object({
    /** Repos skipped because GitHub returned them in an unusable shape. */
    repos: z.number(),
    /** Organizations whose repos could not be read with this OAuth app. */
    orgs: z.array(z.object({ login: z.string().nullable(), reason: skippedOrgReasonSchema })),
    /** repos + orgs: anything non-zero shows the dashboard notice. */
    count: z.number(),
  }),
  /** Where the user (or an org owner) can grant AutoWiki access to organizations. */
  grantAccessUrl: z.string().nullable(),
  syncedAt: z.string(),
});
export type SyncSummary = z.infer<typeof syncSummarySchema>;

export const repoListResponseSchema = z.object({
  repos: z.array(repoSummarySchema),
  lastSyncedAt: z.string().nullable(),
  /** Present when this request ran the automatic first-login sync. */
  autoSync: syncSummarySchema.nullable(),
});
export type RepoListResponse = z.infer<typeof repoListResponseSchema>;

export const repoSyncResponseSchema = z.object({
  repos: z.array(repoSummarySchema),
  summary: syncSummarySchema,
});
export type RepoSyncResponse = z.infer<typeof repoSyncResponseSchema>;

export const repoDetailResponseSchema = z.object({ repo: repoSummarySchema });
export type RepoDetailResponse = z.infer<typeof repoDetailResponseSchema>;
