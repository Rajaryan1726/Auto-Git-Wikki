import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export type SourceRef = { path: string; startLine: number; endLine: number };

export type IndexJobStats = {
  embedCalls?: number;
  reusedChunks?: number;
  rateLimitHits?: number;
  rateLimitWaitMs?: number;
  skippedFiles?: number;
  durationMs?: number;
};

export const indexJobStatus = pgEnum('index_job_status', ['queued', 'running', 'done', 'failed']);
export const wikiRunStatus = pgEnum('wiki_run_status', ['running', 'done', 'failed']);

/** Aggregates of one wiki generation run (Phase 5). */
export type WikiRunStats = {
  outlineModel?: string;
  outlineAttempts?: number;
  outlineMs?: number;
  pagesGenerated?: number;
  pagesFailed?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Pages whose first draft contained unknown file paths (regenerated once). */
  pagesRetriedForPaths?: number;
  /** Pages where unknown paths remained after the retry and were un-linked. */
  pagesWithRemovedPaths?: number;
  removedPaths?: number;
  models?: Record<string, number>;
  durationMs?: number;
};

/** Per-page generation metadata. */
export type WikiPageMeta = {
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
  ms: number;
  /** Models skipped (breaker open) or failed before `model` answered. */
  fallbackFrom: string[];
  /** Unknown paths in the first draft (triggered one retry). */
  badPathsFirstDraft: string[];
  /** Unknown paths still present after the retry; their backticks/links were removed. */
  removedPaths: string[];
};
export const chatRole = pgEnum('chat_role', ['user', 'assistant']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  githubId: bigint('github_id', { mode: 'number' }).notNull().unique(),
  username: text('username').notNull(),
  avatarUrl: text('avatar_url'),
  githubAccessTokenEnc: text('github_access_token_enc'),
  // Set when the OAuth app issues expiring user tokens; null means the token never expires.
  githubTokenExpiresAt: timestamp('github_token_expires_at', { withTimezone: true }),
  githubRefreshTokenEnc: text('github_refresh_token_enc'),
  githubRefreshTokenExpiresAt: timestamp('github_refresh_token_expires_at', {
    withTimezone: true,
  }),
  // Null until the first successful repo sync; used to auto-sync on first login.
  reposSyncedAt: timestamp('repos_synced_at', { withTimezone: true }),
  // User memory (Phase 4.5): when false, nothing is extracted or retrieved.
  memoryEnabled: boolean('memory_enabled').notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const repositories = pgTable(
  'repositories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    githubRepoId: bigint('github_repo_id', { mode: 'number' }).notNull(),
    fullName: text('full_name').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isPrivate: boolean('is_private').notNull().default(false),
    defaultBranch: text('default_branch'),
    language: text('language'),
    githubUpdatedAt: timestamp('github_updated_at', { withTimezone: true }),
    // Last push to any branch; unlike updated_at it ignores stars and settings edits.
    githubPushedAt: timestamp('github_pushed_at', { withTimezone: true }),
    lastIndexedJobId: uuid('last_indexed_job_id').references((): AnyPgColumn => indexJobs.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('repositories_user_github_repo_uq').on(t.userId, t.githubRepoId)],
);

export const indexJobs = pgTable(
  'index_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references((): AnyPgColumn => repositories.id, { onDelete: 'cascade' }),
    status: indexJobStatus('status').notNull().default('queued'),
    commitSha: text('commit_sha'),
    embeddingModel: text('embedding_model').notNull(),
    // Fixed at job creation together with embedding_model; picks the Qdrant collection.
    embeddingDims: integer('embedding_dims').notNull().default(768),
    filesTotal: integer('files_total').notNull().default(0),
    filesDone: integer('files_done').notNull().default(0),
    // Null for jobs from before embeddings existed (Phase 3A); those never count as indexed.
    chunksTotal: integer('chunks_total'),
    embeddedChunks: integer('embedded_chunks').notNull().default(0),
    // "Generating wiki" step progress (pages of this job's wiki run).
    wikiPagesTotal: integer('wiki_pages_total'),
    wikiPagesDone: integer('wiki_pages_done').notNull().default(0),
    // Id of the pipeline step that is running (or failed); see services/index-steps.ts.
    currentStep: text('current_step'),
    // Run statistics: embedding calls, rate-limit hits, timings.
    stats: jsonb('stats')
      .$type<IndexJobStats>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('index_jobs_repo_created_idx').on(t.repoId, t.createdAt),
    // At most one queued/running job per repo, enforced by the database.
    uniqueIndex('index_jobs_one_active_per_repo')
      .on(t.repoId)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

/**
 * Chunks produced by the "Processing files" step, waiting to be embedded. Rows are
 * deleted when the job finishes or fails; vectors + payload then live in Qdrant.
 */
export const indexChunks = pgTable(
  'index_chunks',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => indexJobs.id, { onDelete: 'cascade' }),
    /** Deterministic Qdrant point id (uuid v5 of repo, commit, path, start line). */
    pointId: uuid('point_id').notNull(),
    filePath: text('file_path').notNull(),
    startLine: integer('start_line').notNull(),
    endLine: integer('end_line').notNull(),
    language: text('language').notNull(),
    symbol: text('symbol'),
    chunkType: text('chunk_type').notNull(),
    text: text('text').notNull(),
    embeddedAt: timestamp('embedded_at', { withTimezone: true }),
  },
  (t) => [
    unique('index_chunks_job_point_uq').on(t.jobId, t.pointId),
    index('index_chunks_job_pending_idx').on(t.jobId, t.embeddedAt),
  ],
);

/**
 * One wiki generation for an index job: run automatically at the end of indexing
 * (trigger "index") or on demand (trigger "regenerate", same job, no re-embedding).
 * The wiki shown for a repo is the newest `done` run of its last successful job.
 */
export const wikiRuns = pgTable(
  'wiki_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    indexJobId: uuid('index_job_id')
      .notNull()
      .references(() => indexJobs.id, { onDelete: 'cascade' }),
    trigger: text('trigger').$type<'index' | 'regenerate'>().notNull(),
    status: wikiRunStatus('status').notNull().default('running'),
    pagesTotal: integer('pages_total'),
    pagesDone: integer('pages_done').notNull().default(0),
    /** The validated outline ({ pages: [...] }) once the outline step succeeded. */
    outline: jsonb('outline'),
    stats: jsonb('stats')
      .$type<WikiRunStats>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('wiki_runs_job_started_idx').on(t.indexJobId, t.startedAt),
    // One wiki generation per repo at a time.
    uniqueIndex('wiki_runs_one_running_per_repo')
      .on(t.repoId)
      .where(sql`${t.status} = 'running'`),
  ],
);

export const wikiPages = pgTable(
  'wiki_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    indexJobId: uuid('index_job_id')
      .notNull()
      .references(() => indexJobs.id, { onDelete: 'cascade' }),
    wikiRunId: uuid('wiki_run_id')
      .notNull()
      .references(() => wikiRuns.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    parentSlug: text('parent_slug'),
    position: integer('position').notNull().default(0),
    contentMd: text('content_md').notNull(),
    /** Code the page was written from: paths + line ranges (context blocks and excerpts). */
    sourceFiles: jsonb('source_files')
      .$type<SourceRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    meta: jsonb('meta').$type<WikiPageMeta>(),
    createdAt: createdAt(),
  },
  (t) => [unique('wiki_pages_run_slug_uq').on(t.wikiRunId, t.slug)],
);

export const chatThreads = pgTable(
  'chat_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('chat_threads_user_repo_updated_idx').on(t.userId, t.repoId, t.updatedAt)],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => chatThreads.id, { onDelete: 'cascade' }),
    role: chatRole('role').notNull(),
    content: text('content').notNull(),
    sources: jsonb('sources')
      .$type<SourceRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Assistant only: generation model that answered (e.g. gemini-3.8-flash). */
    model: text('model'),
    /** Assistant only: indexed commit the sources point at (for GitHub links). */
    commitSha: text('commit_sha'),
    /** Assistant only: ids of the user memories used to personalise the answer. */
    memoryIds: jsonb('memory_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('chat_messages_thread_created_idx').on(t.threadId, t.createdAt)],
);
