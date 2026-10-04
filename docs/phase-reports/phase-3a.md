# Phase 3A Report

## Summary

Repos can now be indexed on demand. An Inngest pipeline runs mark-running → resolve-commit → list-files (filtered) → index-batch-N (fetch and chunk with tree-sitter) → finalize. There's no embedding or Qdrant upsert yet; that's Phase 3B. Every GitHub call goes through `githubFetch`. Permanent failures (repo deleted or access lost, empty repo, sign-in expired) fail the job immediately with a clear message, rate limits wait for GitHub's reset time, and other errors retry. The repo page shows each index state (never indexed, queued/running, done, failed, re-index) with a live step list provided by the server. There's also an Index history tab, an "Indexing" section in the sidebar, and chat-page gating. I tested it end to end on 4 of your real repos.

## Files created / changed

**Server: indexing core**

- `apps/server/src/indexing/file-filter.ts` — which files to index: skipped dirs, lockfiles, secrets (`.env*` except templates, keys), minified/generated files, types we can read, 512 KB size cap, 5000-file cap, binary/minified content check
- `apps/server/src/indexing/languages.ts` — per-language tree-sitter config (TS, TSX, JS, Python, Go, Rust, Java, C#, Ruby, PHP, C/C++, Bash), extension → language map
- `apps/server/src/indexing/parser.ts` — loads web-tree-sitter grammars once and reuses them
- `apps/server/src/indexing/chunker.ts` — chunks code by its syntax tree (functions, classes, `Class.method`, doc comments attached, oversized classes split into members, long functions split into windows, loose code grouped into blocks); Markdown by heading; other text by paragraph. Chunks never overlap, so `startLine` is unique within a file.
- `apps/server/src/indexing/point-id.ts` — RFC 4122 UUID v5 and `chunkPointId(repoId, commitSha, filePath, startLine)`
- `apps/server/src/indexing/errors.ts` — `classifyIndexError`: fail now, wait until the rate-limit reset, or retry
- `apps/server/src/indexing/indexing.test.ts` — 16 tests: filter, binary check, UUID v5 reference vector, point ids, chunker across 6 languages plus Markdown, YAML/CRLF, syntax errors
- `apps/server/src/indexing/pipeline.test.ts` — 6 tests: error classification, step states, progress

**Server: pipeline and API**

- `apps/server/src/inngest/functions/index-repo.ts` — the Inngest function: steps, one run per repo at a time, 3 retries, `onFailure` marks the job failed, validates the event payload
- `apps/server/src/inngest/index.ts` — registers `index-repo`
- `apps/server/src/services/index-steps.ts` — the ordered step list (server-owned), per-step states, weighted progress
- `apps/server/src/services/index-jobs.ts` — create (one active job per repo, safe under races), read and list with an ownership check, active jobs, step and progress updates, fail, expiry of stale queued jobs
- `apps/server/src/services/github-index.ts` — `resolveRepoHead` (looks the repo up by its stable GitHub id, so renames don't break it), `listTree`, `fetchBlobText`, `RepoAccessLostError` / `RepoEmptyError`
- `apps/server/src/services/github-api.ts` — `GithubRateLimitError` now carries `retryAt`
- `apps/server/src/services/repo-status.ts`, `repos.ts` — status now includes `latestJobId`, `activeJobId` and weighted progress
- `apps/server/src/routes/index-jobs.ts` — `POST /api/repos/:id/index`, `GET /api/repos/:id/index-jobs`, `GET /api/index-jobs/:id`, `GET /api/index-jobs/active`
- `apps/server/src/app.ts` — mounts the new routes
- `apps/server/src/db/schema.ts`, `apps/server/drizzle/0003_index_job_steps.sql` — `index_jobs.current_step`, plus a partial unique index allowing one active job per repo
- `apps/server/src/scripts/dev-chunks.ts`, root `package.json` — `npm run dev:chunks`
- `apps/server/package.json` — `web-tree-sitter`, `@vscode/tree-sitter-wasm`

**Shared**

- `packages/shared/src/index-jobs.ts` — job, step, list and active-job schemas
- `packages/shared/src/repos.ts` — `latestJobId`, `activeJobId` on the repo status

**Web**

- `apps/web/src/features/index-jobs/api.ts` — `useIndexJob` (polls every 2.5s while active, including in background tabs), `useRepoIndexJobs`, `useActiveIndexJobs`, `useStartIndex`, `useRefreshWhenJobEnds`
- `apps/web/src/features/index-jobs/components.tsx` — `StepList`, `IndexProgressPanel` (elapsed time, commit, progress bar), `IndexFailedPanel` (error, failing step, Retry), `JobStatusBadge`, `JobDuration`
- `apps/web/src/features/index-jobs/sidebar-indexing.tsx` — the sidebar "Indexing" section
- `apps/web/src/features/index-jobs/format.ts` — `shortSha`
- `apps/web/src/lib/use-now.ts` — ticking clock and duration formatting
- `apps/web/src/pages/repo-page.tsx` — all five action states, re-index note, Wiki empty state with an Index button, Index history tab
- `apps/web/src/pages/chat-page.tsx` — picker listing only indexed repos; "Index this repo first" state; never shows the chat UI for an unindexed repo
- `apps/web/src/components/sidebar.tsx` — Indexing section; scrolls when tall
- `apps/web/src/features/repos/api.ts` — dashboard polls while any repo is indexing
- `apps/web/src/pages/placeholder-pages.tsx`, `app/router.tsx` — chat route moved to its own page

**Docs / config**

- `CLAUDE.md` — `index_jobs.current_step`, the one-active-job index, steps owned by the server
- `.env.example` — `EMBEDDING_MODEL=gemini-embedding-2`, with a note on when it was verified
- `README.md` — `dev:chunks`

## How to run / test

```bash
npm run infra:up
npm run db:migrate                 # applies 0003_index_job_steps
npm run dev                        # app + API
npm run inngest:dev                # REQUIRED for indexing (second terminal)
npm test                           # 56 tests
npm run dev:chunks -- <repoId|owner/repo> <path/in/repo> [--ref <sha>] [--text]
npm run dev:chunks -- local <path/on/disk> [--text]
npm run typecheck && npm run lint && npm run build
```

Example output:

```
npm run dev:chunks -- Rajaryan1726/Auto-Git-Wikki apps/server/src/services/repo-sync.ts
# Rajaryan1726/Auto-Git-Wikki @ main : apps/server/src/services/repo-sync.ts
language: typescript | chunks: 5
│ 1 │ '1-22'   │ 22  │ 'block'    │ ''                 │
│ 2 │ '24-28'  │ 5   │ 'function' │ 'grantAccessUrl'   │
│ 3 │ '30-34'  │ 5   │ 'function' │ 'chunk'            │
│ 4 │ '36-46'  │ 11  │ 'function' │ 'mergeSkippedOrgs' │
│ 5 │ '48-150' │ 103 │ 'function' │ 'syncUserRepos'    │
```

## Acceptance criteria

- **Index API** — **PASS**. `POST /api/repos/:id/index` returns 202 with the job. A second POST while one is active returns 200 with the same job id; the database also enforces this, so racing requests can't create two. `GET /api/index-jobs/:id` returns the job with its ordered `steps[]`, `currentStep`, `progress` and `filesDone/filesTotal`. `GET /api/repos/:id/index-jobs` returns the history. All of them check ownership and answer 404 otherwise.
- **Inngest pipeline (fetch + chunk only, no embedding)** — **PASS**. Real runs on your account:

  | Repo                 | Files indexed | Chunks | Skipped by filter                    |
  | -------------------- | ------------- | ------ | ------------------------------------ |
  | Auto-Git-Wikki       | 93            | 301    | 5 unsupported, 1 secret, 1 lockfile  |
  | Advanced-RAG         | 240           | 1,497  | 16 unsupported, 2 lockfiles, 1 empty |
  | NLP_PROJECT          | 75            | 374    | 24 unsupported, 2 lockfiles          |
  | Custom-Memory-Engine | 53            | 357    | 5 unsupported, 1 lockfile            |

  Chunk counts are logged per batch and per job. Nothing was embedded or upserted.

- **Index/Re-index button enabled** — **PASS**.
- **Progress UI (polling, Indexing N%, failed state with error)** — **PASS**. Recorded live in the browser: Queued → Resolving latest commit → Listing & filtering files → Processing files (0/75 → 25/75 → 50/75) → done, with elapsed time, commit sha and 7% → 37% → 67% → done. Polling stops once the job ends.
- **Index history tab** — **PASS**. It shows status, time, commit link, files, duration, and for failures the error plus the step it failed on.
- **Tests for the filter, chunker and point ids** — **PASS**. 22 new tests, 56 in total, all passing. Point ids match the RFC 4122 v5 reference vector, are deterministic, change when any input changes, and separators can't be confused.
- **`npm run dev:chunks`** — **PASS**. It works with an AutoWiki repo id or `owner/repo`, plus a `local` mode for files on disk.
- **Extra 1: repo deleted or access lost → clear failure, no endless retries** — **PASS**. A repo whose GitHub id no longer exists failed in **2 seconds with no retries**, at step "Resolving latest commit", with the message "The repository was deleted or AutoWiki lost access to it while indexing. Sync your repositories and try again." If a file goes missing mid-job, the repo is re-checked by id and the job fails the same way if it's gone. Expired sign-in fails with "Sign in again, then retry indexing"; an empty repo fails with its own message. A rate limit waits until GitHub's reset time, up to 65 minutes, then fails. Covered by unit tests; the mid-job path was not forced live.
- **Extra 2: `githubFetch` for every GitHub call; no tokens in step output** — **PASS**. Each step builds its own GitHub client from `userId`, and step outputs hold only ids, paths, blob shas and counts. A scan of the server and Inngest logs found 0 token-like strings.
- **Extra 3: Gemini embedding model verified** — **DONE**, see the next section.
- **Repo page action states (all checked in the browser, light and dark, at 375px and 1280px):**
  - **1. Never indexed** — **PASS**. Only the "Index repository" primary button shows, in the header and in the Wiki tab empty state. "Chat with repo" appears nowhere.
  - **2. Queued/running** — **PASS**. A disabled "Indexing…" button with a spinner, and an "Indexing progress" panel with the server's step list (done = check, current = spinner + highlight, pending = muted), elapsed time and commit sha once resolved. Polls every 2.5s and stops when finished. Steps come from `INDEX_STEPS` on the server and are stored in `index_jobs.current_step` (migration 0003, in CLAUDE.md).
  - **3. Done** — **PASS**. "Chat with repo" (primary) and "Re-index" (secondary), plus the collapsed line "Indexed · 0bd0bf3 · just now".
  - **4. Failed** — **PASS**, forced with the deleted-repo job. The panel shows "Indexing failed at 'Resolving latest commit'", the message and a Retry button. No Chat, since there was no earlier index.
  - **5. Re-index** — **PASS**. Chat stays visible with "Re-indexing — answers use the previous version until it finishes", and the panel runs. It ends without flicker; I found and fixed a brief flash of the never-indexed state.
  - **6a. Sidebar Indexing section** — **PASS**. Each active repo with its percent and a mini bar, linking to its page; hidden when nothing runs. Visible in the stacked mobile sidebar too.
  - **6b. `/chat?repo=<never indexed>`** — **PASS**. Shows "Index this repo first" with an Index button, or "Indexing N% — view progress" if a job is running. Never the chat UI.
  - **6c. Chat repo picker** — **PASS**. Lists only repos with a successful index (3 at the time of the check).
- **Typecheck, lint, build** — **PASS**. 0 errors, 0 lint problems, build succeeds.

## Gemini embedding model (verified 2026-10-04, for Phase 3B)

Checked against the official docs ([Embeddings guide](https://ai.google.dev/gemini-api/docs/embeddings), [Gemini Embedding 2 model page](https://ai.google.dev/gemini-api/docs/models/gemini-embedding-2)):

| Item                 | `gemini-embedding-2` (use this)                                                                                                      | `gemini-embedding-001` (previous)                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Status               | Stable / GA (April 2026), recommended                                                                                                | Still available                                                    |
| Input limit          | 8,192 tokens                                                                                                                         | 2,048 tokens                                                       |
| Output dims          | 128–3072, default 3072; recommended 768 / 1536 / 3072                                                                                | Same range                                                         |
| Dimension param (JS) | `config: { outputDimensionality: 768 }`                                                                                              | Same                                                               |
| Normalization        | Re-normalized automatically for non-default dims                                                                                     | Must normalize manually if not 3072                                |
| Task type            | **Put in the text as a prefix**: document `title: {title} \| text: {content}`; code query `task: code retrieval \| query: {content}` | `taskType` param (`RETRIEVAL_DOCUMENT`, `CODE_RETRIEVAL_QUERY`, …) |
| SDK                  | `@google/genai` → `ai.models.embedContent({ model, contents, config })`                                                              | Same                                                               |
| Compatibility        | Embedding spaces are **incompatible**; switching models means re-embedding everything                                                |                                                                    |

Decisions for 3B:

- **The env default is now `EMBEDDING_MODEL=gemini-embedding-2`** with `EMBEDDING_DIMS=768`, so the collection stays `code_gemini_768`. No vectors exist yet, so the switch costs nothing. It's recorded per job in `index_jobs.embedding_model`, and this phase's jobs already store `gemini-embedding-2`.
- **Batching caveat:** the docs say passing several `contents` to one `embedContent` call returns **one combined embedding**, since the model is multimodal. 3B must get one vector per chunk, by using the batch endpoint with one request per chunk or by running calls concurrently. I'll confirm the exact batch request shape against the SDK in 3B.
- Documents will be embedded as `title: <file path> | text: <chunk>`, and queries with `task: code retrieval | query: …`.

## Decisions & deviations

- **`prompts/phase-3-ingestion.md` doesn't exist**, same as before. I worked from your two pasted messages.
- **Tree-sitter grammars:** `tree-sitter-wasms` doesn't load in current `web-tree-sitter` (0.27), because it was built for an old ABI. I switched to `@vscode/tree-sitter-wasm` (Microsoft, built with tree-sitter CLI 0.25, ABI 14–15), which loads all 13 grammars I tested. It has no Kotlin, Swift or Dart grammar, so those files are chunked as text.
- **Chunk limits:** at most 120 lines and 6,000 characters per chunk; loose code grouped into blocks of about 60 lines; a single pathological line is cut at 8,000 characters. Chunks never overlap, which keeps point ids unique.
- **Files:** up to 5,000 per job (logged when truncated), 25 per Inngest step, 5 parallel downloads. Files are fetched by **blob sha**, so a retried step sees exactly the same content.
- **Lookup by GitHub id:** `resolve-commit` uses `GET /repositories/{id}` rather than the name, so renamed or transferred repos keep working; the stored `full_name` and `default_branch` are refreshed.
- **One active job per repo**: a partial unique index plus a per-repo Inngest concurrency limit of 1. A second click returns the active job.
- **Progress is weighted by step** (queued 0, resolve 3, list 4, files 90, finalize 3) and capped at 99% until done. Repo cards, the sidebar and the panel all use the same formula. Phase 3B will add an "Embedding & saving" step and rebalance the weights.
- **`.env` templates are indexed** (`.env.example`, `.sample`, `.template`, `.dist`); every other `.env*` file is treated as a secret and skipped.
- **Queued jobs that never start** (e.g. the Inngest dev server isn't running) are marked failed after 10 minutes with a hint to start `npm run inngest:dev`, so the repo isn't stuck behind "Indexing…" forever.
- **Polling continues in background tabs** while a job is active, so progress is current when you come back. The idle sidebar poll pauses in hidden tabs.
- **3A finalize marks the job done and sets `last_indexed_job_id`.** That makes the repo show as Indexed and enables "Chat with repo", even though no vectors exist until 3B and the chat UI arrives in Phase 4.

## Known issues / TODO

- **The Inngest dev server must be running** for indexing (`npm run inngest:dev`). During testing, the CLI I'd started earlier stopped processing after its background task ended, so I restarted it. A job queued during that gap would have expired after 10 minutes as described above.
- **3A "done" isn't searchable yet.** No embeddings exist until 3B, so the Indexed badge currently means "fetched and chunked".
- Mid-job access loss is handled in code (the blob-missing check) and unit-tested, but wasn't forced live; that would require deleting a repo during a run.
- Large functions over 120 lines are split into line windows, and nested inner functions aren't chunked separately.
- `@vscode/tree-sitter-wasm` adds about 22 MB to `node_modules` (server only).
- `npm audit` still lists the drizzle-kit dev-dependency advisories.

## Env vars added

None new. Changed the default value of `EMBEDDING_MODEL` to `gemini-embedding-2` in `.env.example` and in your local `.env`.
