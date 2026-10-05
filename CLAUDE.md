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
  memory_enabled (bool, default true; false = no memory extraction and no retrieval),
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
  wiki_pages_total (int, nullable), wiki_pages_done (int)  -- "Generating wiki" step progress,
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

wiki_runs      -- one wiki generation for an index job (Phase 5)
  id (uuid pk), repo_id (fk, cascade), index_job_id (fk, cascade),
  trigger ('index' | 'regenerate'), status (enum: running | done | failed),
  pages_total (int, nullable), pages_done (int), outline (jsonb, validated outline),
  stats (jsonb: tokens, models, durations, hallucination-check counts), error (text),
  started_at, finished_at
  index (index_job_id, started_at)
  unique index (repo_id) where status = 'running'  -- one wiki generation per repo
  -- The wiki shown for a repo = newest done run of its last successful index job.

wiki_pages
  id (uuid pk), repo_id (fk), index_job_id (fk), wiki_run_id (fk wiki_runs, cascade),
  slug, title, parent_slug (nullable), position (int), content_md (text),
  source_files (jsonb: [{ path, startLine, endLine }]),
  meta (jsonb: model, input/output tokens, ms, fallbackFrom, badPathsFirstDraft, removedPaths),
  created_at
  unique (wiki_run_id, slug)

chat_threads
  id (uuid pk), user_id (fk), repo_id (fk), title, created_at, updated_at

chat_messages
  id (uuid pk), thread_id (fk chat_threads, cascade), role (enum: user | assistant),
  content (text), sources (jsonb: [{ n, path, startLine, endLine }]),
  model (text, nullable; assistant: generation model that answered),
  commit_sha (text, nullable; assistant: indexed commit the sources point at),
  memory_ids (jsonb string[], default []; assistant: user memories used for the answer),
  created_at
  index (thread_id, created_at); chat_threads has index (user_id, repo_id, updated_at)

llm_usage      -- per-call LLM tokens, for the daily budget (Phase 6)
  id (bigint identity pk), user_id (fk users, cascade),
  feature ('chat' | 'rewrite' | 'wiki' | 'memory'), model, input_tokens, output_tokens, created_at
  index (user_id, created_at)

billing_plans  -- Razorpay plans created by `npm run billing:sync-plans` (Phase 8)
  id (uuid pk), mode ('test' | 'live'), plan ('starter' | 'pro' | 'max'), amount_paise,
  razorpay_plan_id (unique), created_at
  unique (mode, plan, amount_paise)

subscriptions
  id (uuid pk), user_id (fk users, cascade), plan, razorpay_subscription_id (unique),
  razorpay_plan_id, razorpay_customer_id, status (enum: created | authenticated | active |
  pending | halted | cancelled | completed | expired), current_period_start,
  current_period_end, cancel_at_period_end (bool), replaces_subscription_id (plan change),
  start_at (scheduled downgrade), checkout_verified_at, ended_at,
  last_event_at (newest webhook applied), created_at, updated_at
  index (user_id, created_at)

billing_events -- every accepted webhook (idempotency + audit); no user id, kept on account deletion
  id (bigint identity pk), event_id (unique, x-razorpay-event-id), type,
  razorpay_subscription_id, razorpay_payment_id, amount_paise, status,
  period_start, period_end, event_created_at, received_at

payments       -- payment history (upserted from webhooks)
  id (uuid pk), user_id (fk, cascade), razorpay_payment_id (unique), razorpay_subscription_id,
  plan, amount_paise, currency, status, method, paid_at, created_at, updated_at

quota_events   -- plan quota ledger: one row per re-index (index / re-index / regenerate) or asked question
  id (bigint identity pk), user_id (fk, cascade), kind ('reindex' | 'chat'), created_at
  index (user_id, kind, created_at)
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

## Chat / RAG conventions

- Retrieval for chat always goes through `searchRepo` (repo's last successful job: model, collection, commit). Never embed queries with the env model.
- Pipeline (`services/rag.ts`): rewrite follow-ups into a standalone query (generation model, last 6 messages; skipped for the first message) → `searchRepo` top 30 → `rankHits` re-scoring (keyword boosts on path/symbol/text weighted by rarity, docs penalty unless the question is about setup/docs/project) → `buildContext` (merge same-file neighbours, ≤10 blocks, 24k chars) → stream. Pure parts live in `services/rag-context.ts` and are unit-tested; `npm run eval:retrieval` measures hit@3/MRR on `apps/server/eval/retrieval-set.json`.
- Repository text is untrusted: the system prompt wraps it in `<context>` and tells the model to treat it as data and ignore any instructions inside it.
- Generation: `GEN_MODEL_PRIMARY` (Gemini) then `GEN_MODEL_FALLBACK` (OpenAI). The fallback takes over on any primary failure before the first token, and also mid-answer (SSE `reset` event, the client discards the partial text). The answering model is stored on the message.
- Ask stream (`POST /api/threads/:id/ask`, SSE): `sources` → `token`* (→ `reset` → `token`*) → `done` | `error`. The user message is saved immediately; the assistant message when the stream ends (or the partial text, marked "(stopped)", when the client stops it).

## Wiki conventions (Phase 5)

- The wiki is generated at the end of `index-repo` (after `cleanup-old-points`, before `finalize`; step "Generating wiki") and on demand by `POST /api/repos/:id/wiki/regenerate` (`regenerate-wiki` function, same steps, no re-embedding). Steps live in `inngest/functions/wiki.ts`: `wiki-outline` → `wiki-page-<slug>` (3 in parallel) → `wiki-finish`.
- A wiki failure never fails the index: the run is marked failed, the job still finishes `done` and stays searchable.
- Outline: indexed file list (from Qdrant), README and manifests → strict JSON, validated with zod (`services/wiki-content.ts`): 5–12 pages, Overview / Architecture / Setup & run required, one nesting level, unknown file paths dropped. One retry with the validation errors.
- Pages reuse the chat retrieval path (`searchRepo` with the job id → `rankHits` → `buildContext`) plus short excerpts of the page's files; the same untrusted-context rules as chat (`UNTRUSTED_CONTEXT_RULES`).
- Hallucination check: file paths in backticks / link targets that match no indexed file or directory → one retry listing them; leftovers are un-linked and counted in `wiki_pages.meta`.
- Pure helpers (outline validation, prompts, path check) are unit-tested; orchestration is `services/wiki.ts`.

## User memory conventions (Phase 4.5)

- Uses the user's own engine `custom-memory-engine` v0.2.0 (GitHub dependency pinned to commit `08d7140`), unmodified. Only `services/memory.ts` imports it; everything else talks to that adapter.
- Injected via `createMemoryEngine({ llm: { chat, embed }, logger })`: chat → `llm.ts` `generateText` (fallback + breaker), embed → our `embedderFor(EMBEDDING_MODEL, EMBEDDING_DIMS)`; config carries only `openai.embeddingDim` (= `EMBEDDING_DIMS`). The logger prints the engine's message plus counts of its details, never fact text. Own Qdrant collection `user_memories_<model>_<dims>` (never a code collection); every point scoped by `userId`.
- **User-level facts only, from the user's own messages only.** `memoryTurnInput` passes only the current user message as `messages` and the previous user message as `contextMessages` (context only, never extracted), both after `redactSecrets`; assistant answers, code context and wiki text are never a source (prompt-injection defence).
- Write: after a finished answer (not stopped / errored, memory enabled) the ask route sends `chat/turn.completed`; `remember-chat-turn` (concurrency key userId, limit 1) runs extract → decide → apply. Fire and forget.
- Read: `recallForQuestion` (top `MEMORY_RECALL_LIMIT` by similarity + preferences) runs in parallel with retrieval; its `MEMORY_RECALL_TIMEOUT_MS` limit starts when retrieval finishes, so memory adds at most that much latency. Timeout / error → answer without memory. Query embeddings are memoised for 60 s, so the lookup reuses retrieval's vector.
- Prompt: `aboutUserSection` is appended after the rules: tailoring only, never evidence, never cited, never overrides grounding / untrusted-context rules. Used ids are saved in `chat_messages.memory_ids`; the UI shows "Personalised using N memories" → Settings.
- API: `GET/DELETE /api/memories`, `DELETE /api/memories/:id` (hard delete incl. history), `GET/PATCH /api/me/settings`. `npm run eval:memory` runs the scripted cases.

## LLM circuit breaker

- `services/circuit-breaker.ts`, used by `llm.ts` for every generation call (chat, query rewrite, wiki). A quota / rate-limit error (429, RESOURCE_EXHAUSTED) opens that provider's breaker until its retry time, clamped to 60 s – 1 h; while open, calls skip it and go straight to the next model. If every provider is open they are all tried anyway. Opening and closing are logged. In memory, per process.

## Limits, security and observability (Phase 6)

- **Per-user limits** (env `LIMIT_*`) and a **daily LLM token budget** (`LLM_DAILY_TOKEN_BUDGET`), checked in `services/usage.ts` BEFORE new work starts (ask, index, wiki regenerate; the wiki step and memory learning skip themselves when the budget is gone). An answer that has started is never cut off. Daily counters reset at 00:00 UTC; the chat limit is a rolling hour. Errors: 429 `LIMIT_REACHED` / `AI_BUDGET_EXHAUSTED` with a user-facing message.
- **Usage recording**: every provider-reported usage goes to `llm_usage` from `llm.ts` (`GenerateRequest.usage`, or the async context `withUsageContext` for memory-engine calls). New LLM call sites must pass the payer.
- **Rate limits**: `lib/rate-limit.ts` (in-memory sliding window): auth per IP; index, wiki regenerate and ask per user → 429 `RATE_LIMITED` + `Retry-After`. API JSON bodies ≤ 100 KB (Inngest 10 MB on its own route).
- **Revoked GitHub access**: `githubFetch` clears the stored tokens when GitHub rejects a token that cannot be refreshed; `requireAuth` then answers `GITHUB_REAUTH_REQUIRED` and the error handler clears the session cookie on every route.
- **Dev session**: `npm run dev:session` (`services/dev-session.ts`) is the only non-OAuth way to mint a session; it refuses `NODE_ENV=production` and no HTTP code imports it (tested).
- **Security headers**: helmet (strict CSP for the JSON API); CORS only for `WEB_ORIGIN` with credentials; cookies httpOnly, SameSite=Lax, Secure in production.
- **Data deletion**: `services/data-deletion.ts` (repo data: Qdrant points in all code collections, wiki, chats, jobs; account: everything incl. memories and `llm_usage`). Both return before/after counts.
- **Logging**: pino (`lib/logger.ts`, `moduleLogger(name)`), request ids via pino-http (`X-Request-Id`). Log ids, counts, timings, models — never tokens, secrets, file contents, chat text or memory facts. Structured events: `index job done`, `chat answer`, `wiki run finished`.

## Billing (Phase 8)

- Razorpay Subscriptions; details, setup and going live in `docs/BILLING.md`. Plans, prices
  (integer paise) and quotas: `PLANS` in `packages/shared/src/billing.ts` — the only source.
  Amounts and Razorpay plan ids are decided on the server; the client sends a plan key only.
- Pure logic in `services/billing-core.ts` (signatures, state machine, entitlement, gates; unit
  tested); DB + flows in `services/billing.ts`; REST calls in `services/razorpay.ts`.
- Checkout verify: `HMAC_SHA256(razorpay_payment_id + "|" + subscription_id, key_secret)`; it only
  marks the subscription "confirming". **Webhooks are the source of truth**:
  `/api/billing/webhook` with a raw body parser before the JSON parser, signature over the raw
  body, idempotent on `x-razorpay-event-id` (event row + state change in one transaction),
  out-of-order safe (status only from newer events, terminal never moves back, periods only
  forward).
- Access: active / pending (banner) / cancelled until period end → can work; halted, ended,
  no plan → no new indexing, regeneration or chat (data stays readable). `COMP_GITHUB_LOGINS` →
  Max, "Complimentary", calendar-month quotas.
- Gates: `assertPlanAllows(user, 'reindex' | 'chat', { repoId })` BEFORE the Phase 6 limits; 402
  `PLAN_REQUIRED` | `SUBSCRIPTION_INACTIVE` | `QUOTA_REACHED` | `REPO_SLOTS_FULL` (web shows a
  /pricing link). Count with `recordQuota` only when work was actually created (not for an
  already-running job, not for a chat retry). Quotas count `quota_events` since the period start.
- Plan changes = a new subscription (Razorpay cannot change the plan of UPI / e-mandate /
  domestic-card subscriptions): upgrade now (old cancelled when the new one activates), downgrade
  with `start_at` = period end (old cancelled at cycle end when the new one authenticates); the
  Inngest function `billing-retire-replaced-subscription` does the cancelling.

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
