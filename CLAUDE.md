# Auto Git Wiki — Project Context

Read this file fully before doing any work. It is the single source of truth for stack, schema, design and rules. If a phase prompt conflicts with this file, follow this file and mention the conflict in your phase report.

## Product

A web app where a user logs in with GitHub, sees all their repositories (public and private), indexes a repo on demand, and then gets:

1. An **AI-generated wiki** for the repo (overview, architecture, key modules, setup), built from the indexed code.
2. A **chat** that answers questions about the repo using RAG over the indexed code, with file + line citations.

Indexing is triggered **manually** by the user (an "Index" / "Re-index" button). No webhooks in v1.

## Stack (do not swap without asking)

- Monorepo with **npm workspaces**: `apps/web`, `apps/server`, `packages/shared` (shared TS types, zod schemas).
- Language: **TypeScript** everywhere, strict mode.
- **Frontend (`apps/web`)**: React 18, Vite, React Router, TanStack Query, Tailwind CSS.
- **Backend (`apps/server`)**: Node 20+, Express, zod for validation.
- **DB**: PostgreSQL 16 with **Drizzle ORM** + drizzle-kit migrations.
- **Vector DB**: Qdrant (`@qdrant/js-client-rest`).
- **Background jobs**: Inngest (Express serve handler at `/api/inngest`).
- **LLM / embeddings**: Text generation: Gemini primary, OpenAI fallback. **Embeddings: provider-configurable** (changed in Phase 3B at the user's request after the Gemini free-tier daily quota ran out): the provider follows the `EMBEDDING_MODEL` id (`gemini-*` → Gemini, `text-embedding-*` → OpenAI); the current default is OpenAI `text-embedding-3-small` @ 768. Model names come from env vars; check the current official docs for exact model ids instead of guessing.
- **Code parsing**: `web-tree-sitter` (WASM grammars) for AST-based chunking.
- Local infra via **docker-compose** (Postgres + Qdrant). Inngest dev server via `npx inngest-cli@latest dev`.

## Folder layout (target)

```
apps/
  web/        # React app
    src/{app,pages,components,features,lib,styles}
  server/     # Express API
    src/{routes,services,db,inngest,lib,middleware}
packages/
  shared/     # types + zod schemas used by both
docs/
  phase-reports/   # one report per phase (see Rules)
docker-compose.yml
.env.example
```

## Database schema (Drizzle, PostgreSQL)

```
users
  id (uuid pk), github_id (bigint unique), username, avatar_url,
  github_access_token_enc (text, AES-256-GCM encrypted),
  github_token_expires_at (timestamptz, nullable; null = token never expires),
  github_refresh_token_enc (text, AES-256-GCM encrypted, nullable),
  github_refresh_token_expires_at (timestamptz, nullable),
  repos_synced_at (timestamptz, nullable; null = never synced -> auto-sync on first dashboard load),
  created_at, updated_at
  -- Always get a token via getGithubToken(userId) / githubFetch() in
  -- services/github-token.ts: it refreshes expired tokens and retries once on 401.
  -- Refresh tokens are single-use: never refresh outside that service (it holds a
  -- SELECT ... FOR UPDATE row lock and re-reads the token after acquiring it).

repositories
  id (uuid pk), user_id (fk users), github_repo_id (bigint),
  full_name, name, description, is_private (bool), default_branch,
  language, github_updated_at,
  github_pushed_at (timestamptz, nullable; GitHub pushed_at = last push to any branch.
    Use it for "updated X ago" and stale-wiki detection; updated_at also changes on
    stars and settings edits),
  last_indexed_job_id (fk index_jobs, nullable),
  created_at, updated_at
  unique (user_id, github_repo_id)
  -- Sync deletes repos missing from GitHub ONLY after a complete, non-partial fetch.

index_jobs
  id (uuid pk), repo_id (fk repositories), status (enum: queued | running | done | failed),
  commit_sha, embedding_model, files_total (int), files_done (int),
  embedding_dims (int, default 768; fixed with embedding_model at job creation),
  chunks_total (int, nullable; null = Phase 3A job without vectors, never counts as indexed),
  embedded_chunks (int), stats (jsonb: embedCalls, rateLimitHits, rateLimitWaitMs, skippedFiles, durationMs),
  current_step (text, nullable; id of the running step, or the step it failed on.
    The ordered step list lives in apps/server/src/services/index-steps.ts and is
    returned by GET /api/index-jobs/:id, so the UI never hardcodes steps),
  error (text), started_at, finished_at, created_at
  index (repo_id, created_at)
  unique index (repo_id) where status in (queued, running)  -- one active job per repo

index_chunks   -- staging between "Processing files" and "Embedding & saving"; rows are
               -- deleted when the job finishes or fails
  id (bigint identity pk), job_id (fk index_jobs, cascade), point_id (uuid),
  file_path, start_line, end_line, language, symbol (nullable), chunk_type, text,
  embedded_at (nullable)
  unique (job_id, point_id), index (job_id, embedded_at)

wiki_pages
  id (uuid pk), repo_id (fk), index_job_id (fk), slug, title, parent_slug (nullable),
  position (int), content_md (text), source_files (jsonb), created_at
  unique (index_job_id, slug)

chat_threads
  id (uuid pk), user_id (fk), repo_id (fk), title, created_at, updated_at

chat_messages
  id (uuid pk), thread_id (fk chat_threads, cascade), role (enum: user | assistant),
  content (text), sources (jsonb: [{ path, startLine, endLine }]), created_at
```

## Qdrant conventions

- **One collection per embedding model + dims**, not per repo. Name: `code_<sanitized model id>_<dims>` (lowercase, non-alphanumerics → `_`), e.g. `gemini-embedding-2` @ 768 → `code_gemini_embedding_2_768` (`collectionNameFor()` in `services/qdrant.ts`). Startup creates the collection for the env model if missing, cosine distance.
- Payload per point: `repo_id`, `commit_sha`, `file_path`, `start_line`, `end_line`, `language`, `symbol` (nullable), `chunk_type` (function | class | block | text), `text`, `index_job_id` (the job that wrote it).
- Create keyword payload indexes on `repo_id`, `commit_sha` and `index_job_id`.
- Point id = deterministic UUID (v5) from `repo_id + commit_sha + file_path + start_line`, so retries are idempotent.
- **Never mix embedding models for one repo.** The model and dims are fixed when an index job is created (`index_jobs.embedding_model`, `index_jobs.embedding_dims`). Queries must take the model **and the collection** from the repo's last successful job (`services/search.ts`), never from the current env. If the embedding quota is hit, wait and retry (throttle + `step.sleep`); do NOT switch to another embedding provider mid-job.
- After all embed batches of a job succeed, `cleanup-old-points` deletes the repo's points that this job did not write (`index_job_id` ≠ job), which removes older commits.
- Embedding text formats live in `services/embedding-format.ts`, per provider: gemini-embedding-2 inlines the task instruction in the text (never send `task_type`); OpenAI embeds `path (symbol)` + blank line + code for documents and the raw question for queries. Index and query must use the same provider's formats.
- A successful job also deletes the repo's points from other collections (earlier embedding models), so each repo lives in exactly one collection.
- Throttles are per provider and per process: Gemini meters per text (`GEMINI_EMBED_MAX_RPM`), OpenAI per call and token (`OPENAI_EMBED_MAX_RPM` / `_TPM`). Re-indexing reuses existing points whose text is unchanged (no embedding call).

## Design system (Theme A — "Wine & cream")

Implement as CSS variables on `:root` and `[data-theme="dark"]`, mapped into Tailwind's theme (`bg-bg`, `text-muted`, etc.). Default to the OS preference, allow a manual toggle, persist the choice in localStorage.

| Token                       | Light             | Dark              |
| --------------------------- | ----------------- | ----------------- |
| bg                          | #F4ECDD           | #171213           |
| surface                     | #FBF7EF           | #1F1819           |
| raised                      | #FFFFFF           | #272021           |
| soft                        | #E8DCC6           | #2F2627           |
| border                      | #DCCFBB           | #3A2F30           |
| text                        | #2A1F1C           | #EDE3D2           |
| muted                       | #6B5D52           | #B7A89A           |
| accent (fills)              | #722F37           | #722F37           |
| accent-text (links, active) | #722F37           | #E2A3AA           |
| on-accent (text on accent)  | #FBF7EF           | #F4ECDD           |
| accent-soft (active nav bg) | #F0E2DE           | #3A2226           |
| success / success-soft      | #2F5E3C / #E1EBDC | #9CC5A4 / #22302A |
| warning / warning-soft      | #7A4F0E / #F3E5C8 | #E3B76A / #3A2E1A |
| danger / danger-soft        | #B42318 / #FBE3E0 | #F97066 / #3A1A17 |
| code-bg                     | #EFE5D3           | #120E0F           |

Fonts (Google Fonts): **Bricolage Grotesque** (headings), **IBM Plex Sans** (body), **IBM Plex Mono** (code, repo names, file paths).
Style: radius 10–16px, 1px borders, no gradients, no emoji, inline stroke icons (e.g. lucide-react). Buttons and touch targets at least 44px tall. Real `<button>`/`<a>`/`<label>` elements, visible focus states.

### Screens (from the approved mockup)

- **Layout**: left sidebar (logo "AutoWiki", nav: Overview, Repositories, Chat, Settings; theme toggle and user avatar/username at the bottom) + main content. Sidebar stacks on top on mobile.
- **Repositories (dashboard)**: title + subtitle, "Sync from GitHub" button, search input, filter pills (All / Public / Private / Indexed), responsive grid of repo cards. Card: repo name (mono), visibility pill, description, language dot, "updated X ago", status badge (Indexed = success, Indexing N% = warning + progress bar, Not indexed = soft/muted, Index failed = danger).
- **Repo page**: breadcrumb, header card (initial avatar in accent square, name, description, meta row, status badge with commit), buttons "Re-index" (secondary) and "Chat with repo" (primary), tabs (Wiki / Files / Index history), wiki layout = pages TOC on the left + article on the right with code blocks and "Sources" chips.
- **Chat**: recent threads list, header with repo pill, messages (user = accent bubble on the right; assistant = left with text, code blocks, "Sources" chips), suggestion chips, textarea + send icon button.

## Engineering rules

- Validate every request body/query with zod. Consistent error JSON: `{ error: { code, message } }`.
- Never log tokens, secrets or full file contents. Encrypt GitHub tokens with AES-256-GCM using `TOKEN_ENCRYPTION_KEY`.
- All config through env vars; keep `.env.example` updated with every new var (no real values).
- Keep functions small and typed; put GitHub, LLM, embedding and Qdrant access behind service modules in `apps/server/src/services/`.
- Add npm scripts for anything a human needs to run.

## Working rules for Claude Code

1. Work on **only the phase you are given**. Do not start the next phase.
2. Before starting, read the previous phase report in `docs/phase-reports/` (if any) and fix anything it lists as broken only if it blocks this phase.
3. If something is ambiguous or you need a dependency outside the stack above, choose the simplest option, and record the decision in the report.
4. At the end, write `docs/phase-reports/phase-<N>.md` and also print it in full in the chat, using this format:

```
# Phase <N> Report
## Summary            (2–4 lines)
## Files created / changed   (path — one-line purpose)
## How to run / test   (exact commands)
## Acceptance criteria (each one: PASS / FAIL / NOT TESTED + note)
## Decisions & deviations
## Known issues / TODO
## Env vars added
```
