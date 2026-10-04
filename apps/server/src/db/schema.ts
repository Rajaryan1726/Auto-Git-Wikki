import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export type SourceRef = { path: string; startLine: number; endLine: number };

export const indexJobStatus = pgEnum('index_job_status', ['queued', 'running', 'done', 'failed']);
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
    lastIndexedJobId: uuid('last_indexed_job_id').references((): AnyPgColumn => indexJobs.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique('repositories_user_github_repo_uq').on(t.userId, t.githubRepoId)],
);

export const indexJobs = pgTable('index_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  repoId: uuid('repo_id')
    .notNull()
    .references((): AnyPgColumn => repositories.id, { onDelete: 'cascade' }),
  status: indexJobStatus('status').notNull().default('queued'),
  commitSha: text('commit_sha'),
  embeddingModel: text('embedding_model').notNull(),
  filesTotal: integer('files_total').notNull().default(0),
  filesDone: integer('files_done').notNull().default(0),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
});

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
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    parentSlug: text('parent_slug'),
    position: integer('position').notNull().default(0),
    contentMd: text('content_md').notNull(),
    sourceFiles: jsonb('source_files')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [unique('wiki_pages_job_slug_uq').on(t.indexJobId, t.slug)],
);

export const chatThreads = pgTable('chat_threads', {
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
});

export const chatMessages = pgTable('chat_messages', {
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
  createdAt: createdAt(),
});
