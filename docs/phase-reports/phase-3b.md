# Phase 3B Report

## Summary

Indexing now embeds every chunk and saves it in Qdrant, so the repos can be searched. The pipeline is: process files → **Embedding & saving** (a new server-provided step) → `cleanup-old-points` → finalize. The Gemini free tier ran out on its daily embedding quota partway through the re-index, so at your request embeddings are now **provider-configurable**; the active model is OpenAI `text-embedding-3-small` @ 768. Gemini `gemini-embedding-2` is still fully supported and tested. All 4 repos are indexed: **2,484 chunks** in `code_text_embedding_3_small_768`. `dev:search` returns relevant code for all 12 test queries. A repo now counts as Indexed only once its embeddings are complete.

## Files created / changed

**Server: embeddings and search**

- `apps/server/src/services/embedding-format.ts` — per-provider text formats (Gemini's documented task prefixes; OpenAI uses path + code) and `providerForModel()`
- `apps/server/src/services/embeddings.ts` — Gemini embedder (`batchEmbedContents` / `embedContent`) and OpenAI embedder (`/v1/embeddings`); dimension checks and L2 normalization; 429 handling (Gemini `RetryInfo` + quota ids; OpenAI `retry-after` / `x-ratelimit-reset-*`; `insufficient_quota` treated as fatal); one throttle per provider; `embedderFor`, `embedSizing`
- `apps/server/src/services/embedding-errors.ts` — `EmbeddingRateLimitError` (with `retryAt` and quota ids), `EmbeddingFatalError`
- `apps/server/src/lib/throttle.ts` — limiter per process: weighted requests per minute, optional tokens per minute, concurrency, and a shared 429 pause capped at 2 minutes
- `apps/server/src/services/qdrant.ts` — `collectionNameFor(model, dims)`, `ensureCollection`, batched `upsertPoints`, `deleteStaleRepoPoints` (keeps only this job's points), `deleteRepoPointsOutside` (other models' collections), `existingPointTexts` / `claimPoints` (reuse), `searchRepoPoints`
- `apps/server/src/services/search.ts` — `searchRepo()`: model, dims, collection and commit always come from the repo's **last successful job**, never from env
- `apps/server/src/scripts/dev-search.ts`, root `package.json` — `npm run dev:search`

**Server: pipeline**

- `apps/server/src/inngest/functions/index-repo.ts` — chunks staged in `index_chunks`, then `count-chunks`, `embed-batch-N` (reuse identical points; embed the rest; save per group), rate limits via `step.sleep` (long waits fail clearly), `cleanup-old-points` (after all batches, guarded), and `finalize` (stats, sets `last_indexed_job_id`, deletes staging rows). Each step stops if its job is no longer running.
- `apps/server/src/services/index-steps.ts` — new step `embed` ("Embedding & saving", progress shown as "N / M chunks"); weights rebalanced
- `apps/server/src/services/index-jobs.ts` — `isSearchableJob`, new fields in API responses; jobs created with `embedding_model` + `embedding_dims` fixed; failing a job deletes its staging rows
- `apps/server/src/services/repo-status.ts`, `repos.ts` — legacy jobs without vectors never count as indexed
- `apps/server/src/indexing/errors.ts` — embedding errors classified
- `apps/server/src/indexing/chunker.ts` — **tiny-block folding**: code blocks under 100 non-blank characters (divider comments, a trailing `export default`) merge into a neighbour
- `apps/server/src/db/schema.ts`, `drizzle/0004_embeddings.sql` — `index_jobs.embedding_dims`, `chunks_total`, `embedded_chunks`, `stats`; new `index_chunks` table; data fix un-indexing the 6 Phase 3A jobs
- `apps/server/src/lib/env.ts`, `src/index.ts` — per-provider throttle env vars; startup ensures the env model's collection

**Tests (86 total, all passing)**

- `apps/server/src/services/embedding-format.test.ts` — 9 tests: exact documented Gemini strings, `title: none`, literal `$&`/`$1`, provider mapping, OpenAI formats
- `apps/server/src/services/embeddings.test.ts` — 12 tests: batching, ordering, no `task_type`, dimension and count checks, 429 handling for both providers, missing or bad keys, batch never larger than the per-minute budget, OpenAI duration parsing
- `apps/server/src/lib/throttle.test.ts` — 7 tests: requests per minute, per-item weighting, tokens per minute, pause, concurrency, failure release
- `apps/server/src/indexing/{indexing,pipeline}.test.ts`, `services/github-repos.test.ts`, `repo-sync.integration.test.ts` — updated for the new step and legacy rule, plus a tiny-block folding test

**Web**

- `apps/web/src/pages/repo-page.tsx` — "Indexed" and Chat only for `searchable` jobs; history shows "N/M chunks embedded" or "no vectors" for legacy jobs
- `packages/shared/src/index-jobs.ts` — `embeddingDims`, `chunksTotal`, `embeddedChunks`, `searchable`, `stats`

**Docs / config**

- `CLAUDE.md` — embedding provider rule, collection naming, query rule, `index_job_id` payload, cleanup across collections, throttles, new columns and `index_chunks`
- `.env.example` — `EMBEDDING_MODEL=text-embedding-3-small`, per-provider throttle vars
- `README.md` — `dev:search`

## How to run / test

```bash
npm run db:migrate                 # applies 0004_embeddings
npm run dev
npm run inngest:dev                # required for indexing
npm test                           # 86 tests
npm run dev:search -- Rajaryan1726/Advanced-RAG "how does the retriever rerank search results?" --k 5 [--text]
npm run dev:chunks -- local apps/server/src/indexing/chunker.ts
npm run typecheck && npm run lint && npm run build
```

Index from the UI (repo page → Index / Re-index) or with `POST /api/repos/:id/index`.

## Acceptance criteria

- **1. Task-type formats (Gemini), in one module with tests** — **PASS**. `services/embedding-format.ts` uses the exact documented strings ([docs](https://ai.google.dev/gemini-api/docs/embeddings), checked 2026-10-04):
  - document / code chunk: `title: {title} | text: {content}`, with `title: none` when there's no title (our title is `path (symbol)`)
  - code-retrieval query: `task: code retrieval | query: {content}`
  - `task_type` is never sent; a test checks the request bodies. The docs: "You cannot use the task_type field for the gemini-embedding-2 model."
  - A test caught a real bug: `String.replace` expanded `$&` inside code. It's fixed with function replacers.
  - The OpenAI equivalents (no task prefixes; path + blank line + code; raw query) are in the same module and tested too.
- **2. Batching tested before choosing** — **PASS**, tested live on 2026-10-04:
  - `batchEmbedContents` with 3 separate requests returned **3 separate 768-dim, unit-norm embeddings**, so batching works and is used.
  - **Documented maximum: 100 requests per batch.** 101 was rejected with "at most 100 requests can be in one batch".
  - Important: **Gemini meters per text, not per call.** Two 60-text batches in one minute → the second got 429 `EmbedContentRequestsPerMinutePerUserPerProjectPerModel-FreeTier`, limit **100**. So the throttle counts texts.
  - For contrast, `embedContent` with several plain strings returns one aggregated vector (per the docs), which is why each text is a separate request object.
- **3. Rate limits (throttle, Retry-After, RetryAfterError / step.sleep, no provider switch mid-job)** — **PASS**:
  - one throttle per provider per process: `GEMINI_EMBED_MAX_RPM` (texts per minute), `OPENAI_EMBED_MAX_RPM` / `_TPM`, `EMBED_CONCURRENCY`
  - a 429 reads `Retry-After`, Gemini `RetryInfo.retryDelay` or OpenAI `x-ratelimit-reset-*`; the embed step returns `rate_limited` and the workflow calls `step.sleep`, then continues where it stopped; GitHub rate limits still use `RetryAfterError`
  - waits over 15 minutes (e.g. a daily quota) fail the job with a clear message, and saved vectors are reused on retry
  - **bug found live and fixed:** a 429 with an 11.6 h delay paused the shared throttle for every job. The shared pause is now capped at 2 minutes; long waits are decided per job.
  - a job never changes model or provider: both are stored at creation and used for every step.
- **4. `outputDimensionality` = `EMBEDDING_DIMS` (768); vectors normalized** — **PASS**. Gemini gets `outputDimensionality: 768` and OpenAI `dimensions: 768`. Every vector is checked for length 768 and L2-normalized before upsert (live norm = 1.0000).
- **5. Collection includes the model id; old one deleted; queries use the job's model** — **PASS**. Collections are `code_gemini_embedding_2_768` and `code_text_embedding_3_small_768`; startup creates the env model's collection. The old `code_gemini_768` was confirmed empty (0 points) and **deleted**. `searchRepo` takes model, dims, collection and commit from the repo's last successful job. CLAUDE.md is updated.
- **6. Upsert (deterministic ids, full payload, batches); cleanup only after all batches** — **PASS**. Upserts go out in batches of 100 with uuid v5 ids and the full CLAUDE.md payload plus `index_job_id`. `cleanup-old-points` runs only after the embed loop finishes, and deletes this repo's points not written by this job (older commits or old chunk boundaries) plus the repo's points in other models' collections.
  - Verified: after the final run the collection holds **exactly 2,484 points = sum of chunks_total**.
  - Re-indexing the same commit reused all 357 chunks with **0 embedding calls** and left the point count unchanged.
  - Switching to OpenAI removed all 810 Gemini points (the Gemini collection is now 0).
- **7. Only fully embedded jobs count as Indexed; `embedded_chunks` shown** — **PASS**. Migration 0004 un-indexed the 6 Phase 3A jobs and labelled them "Indexed before embeddings existed (no vectors)…". `searchable` = done + `chunks_total` set, and it's used by repo status, the Chat gate and search. History shows "339/339 chunks embedded" or "no vectors" for legacy jobs. Checked in the browser.
- **8. Re-run the same 4 repos + `dev:search`, 3 queries each** — **PASS** (OpenAI, final run after the chunker fix):

  | Repo                 | Commit  | Files | Chunks    | Embedding calls | Reused | 429s | Time   |
  | -------------------- | ------- | ----- | --------- | --------------- | ------ | ---- | ------ |
  | Advanced-RAG         | d907275 | 240   | 1367/1367 | 6               | 1244   | 0    | 38.6 s |
  | Auto-Git-Wikki       | a7520e2 | 118   | 449/449   | 2               | 437    | 0    | 16.0 s |
  | Custom-Memory-Engine | 0bd0bf3 | 53    | 339/339   | 2               | 322    | 0    | 10.0 s |
  | NLP_PROJECT          | 6595632 | 75    | 329/329   | 2               | 286    | 0    | 11.7 s |

  The 4 jobs ran in parallel, **41 s wall time** in total. Top results (score, path:lines, symbol):

  | Repo                 | Query                                         | #1                                                                | #2                                                                    | #3                                                                  |
  | -------------------- | --------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
  | Auto-Git-Wikki       | where is the GitHub OAuth callback handled…?  | 0.566 `docs/phase-reports/phase-1.md:3-5`                         | 0.544 `services/github-oauth.ts:1-9`                                  | 0.542 `services/github-oauth.ts:31-40` buildAuthorizeUrl            |
  | Auto-Git-Wikki       | how are GitHub access tokens encrypted…?      | 0.546 `docs/phase-reports/phase-1.md:3-5`                         | 0.526 `services/github-token.ts:36-148`                               | 0.524 `services/users.ts:8-16` tokenColumns                         |
  | Auto-Git-Wikki       | how does the chunker split code…?             | 0.547 `indexing/chunker.ts:1-48`                                  | 0.536 `indexing/chunker.ts:378-403` chunkFile                         | 0.520 `indexing/chunker.ts:329-376` chunkText                       |
  | NLP_PROJECT          | how is a claim verified and given a verdict?  | 0.442 `backend/verifier.py:190-198` compute_scores                | 0.432 `frontend/src/lib/types.ts:6-16` Claim                          | 0.423 `backend/verifier.py:78-89` \_decide                          |
  | NLP_PROJECT          | where are the FastAPI endpoints defined?      | 0.522 `backend/main.py:1-33`                                      | 0.511 `backend/main.py:58-59`                                         | 0.412 `BUILD_PROMPT.md:82-91` "7. API (FastAPI)"                    |
  | NLP_PROJECT          | how are retrieved passages reranked?          | 0.404 `backend/verifier.py:98-129` verify_claims                  | 0.367 `backend/reranker.py:21-34` rerank_many                         | 0.359 `README.md:68-101` "2. How it works"                          |
  | Custom-Memory-Engine | how does the engine decide add/update/delete? | 0.525 `src/memory/MemoryEngine.js:141-260` createMemoryEngine     | 0.505 `src/memory/MemoryEngine.js:261-380`                            | 0.503 `README.md:48-53`                                             |
  | Custom-Memory-Engine | how are facts extracted from a conversation?  | 0.629 `src/memory/extractor.js:34-66` extractFacts                | 0.581 `src/memory/prompts.js:4-59`                                    | 0.552 `scripts/runtime.js:22-23` extractFacts                       |
  | Custom-Memory-Engine | how are embeddings created for memories?      | 0.532 `src/memory/MemoryEngine.js:67-80` storeCandidates          | 0.523 `CLAUDE.md:1-5`                                                 | 0.510 `src/llm/embed.js:9-53` createEmbedder                        |
  | Advanced-RAG         | how are documents split into chunks…?         | 0.611 `backend/src/chunking/text-chunker.js:13-18` chunkDocuments | 0.569 `text-chunker.js:1-11`                                          | 0.565 `text-chunker.js:21-24`                                       |
  | Advanced-RAG         | how does the retriever rerank search results? | 0.589 `backend/src/retrieval/rerank.js:1-24`                      | 0.576 `rerank.js:60-67`                                               | 0.548 `rerank.js:26-58` reciprocalRankFusion                        |
  | Advanced-RAG         | how is a YouTube video ingested?              | 0.563 `backend/src/routes/ingest.routes.js:161-201`               | 0.547 `Frontend/src/pages/UploadPage.jsx:28-124` YoutubeIngestSection | 0.529 `queue/workers/ingestion-worker.js:158-207` processYoutubeJob |

  Every query returns the relevant code in its top 3.
  - Before the chunker fix, single-line divider comments (`# ---- claims`, `// ---- engine ----`) ranked #1 for 3 queries. After the fix they're gone and results improved: for example, the verdict query now returns `compute_scores` / `_decide`.
  - **Honest miss:** for "OAuth callback", `routes/auth.ts`, where the callback actually verifies the state, isn't in the top 3. The phase-report docs and the OAuth service rank higher.

- **Typecheck / lint / build** — **PASS**. 0 errors, 0 lint problems; build succeeds.

### Embedding totals (this phase)

- **Final run:** 2,484 chunks in the index; 194 newly embedded and 2,290 reused; **12 OpenAI calls**; **0 429s**; 41 s wall time.
- **All OpenAI runs together:** 5,530 chunks processed (3 full runs + 1 same-commit reuse check); **34 OpenAI calls**; 2,646 reused; **0 429s**.
- **Gemini, before the switch:**
  - 1,080 chunks embedded in pipeline jobs (810 of them in the main re-index), plus about 115 texts in API tests.
  - **12 Gemini 429s in total:** 2 per-minute 429s in my manual quota probes; then 7 in the pipeline before the fix, including the 11.6 h daily-quota delay that froze everything; then 3 daily-quota 429s after the fix, which each failed their job cleanly.

## Decisions & deviations

- **Embedding provider switched to OpenAI (your instruction).** This changes CLAUDE.md, which said OpenAI was for text generation only; CLAUDE.md is updated. The provider is derived from the model id, and each job keeps the model it was created with, so nothing mixes. Gemini stays a supported option. Switch back by setting `EMBEDDING_MODEL=gemini-embedding-2` and re-indexing; reuse avoids re-embedding identical text within the same collection.
- **OpenAI document format** is `path (symbol)` + blank line + code, and queries are raw. OpenAI doesn't document task prefixes ([guide](https://developers.openai.com/api/docs/guides/embeddings)). `text-embedding-3-small` vectors come normalized; we check and re-normalize anyway.
- **Measured Gemini free-tier limits for `gemini-embedding-2`** (the docs only point to AI Studio): **100 texts per minute** and about **1,000 texts per day**, counted per text even inside a batch. Throttle defaults: `GEMINI_EMBED_MAX_RPM=90`, and batches are never larger than the per-minute budget.
- **REST instead of an SDK.** I called both providers' REST APIs directly. That gives full control over batching, `Retry-After` and quota details, and it's exactly the `batchEmbedContents` endpoint you asked me to test. It also adds no dependency.
- **`index_chunks` staging table.** It separates "Processing files" from "Embedding & saving", makes embedding resumable per group, and lets retries embed only what's left. Rows are deleted when the job finishes or fails.
- **`index_job_id` added to the point payload.** Cleanup deletes "points of this repo not written by this job". That covers your "different commit_sha" rule and also old chunk boundaries within the same commit.
- **Reuse of existing vectors.** A pending chunk whose point id already exists in the same collection with identical text is relabelled to the new job, not re-embedded. This made the retry after the quota failure, and same-commit re-indexes, nearly free.
- **Chunker improvement:** tiny-block folding cut noise chunks by 205 (8%) and improved search rankings; a test covers it. This changed the 3A expectation that an import header becomes its own chunk.
- **Legacy jobs:** 3A jobs keep `status = done` for history but carry `chunks_total = NULL`, never count as indexed, and are labelled "no vectors".
- **`prompts/phase-3-ingestion.md` doesn't exist**; I worked from your messages.

## Known issues / TODO

- **Retrieval quality is decent but not tuned.** Phase-report Markdown can outrank code for "where is X" questions (e.g. the OAuth callback). Phase 4 could down-weight docs or mix in keyword search when citing code.
- **The Gemini key is on the free tier**: 100 texts/min and about 1,000/day, so it's only practical for small repos without billing.
- `MemoryEngine.js:141-380` is one long function split into 120-line windows, which is acceptable but coarse. Nested functions aren't separate chunks (noted in 3A).
- **Dev-process note:** background tasks in this session have a 2-hour limit. The dev server and Inngest may need restarting by hand (`npm run dev`, `npm run inngest:dev`), and Inngest's dev state is in memory, so restarting it drops queued runs. A job queued during a restart expires after 10 minutes with a hint.
- `npm audit`: the drizzle-kit dev-dependency advisories are unchanged.

## Env vars added

- `EMBED_CONCURRENCY` (default 2)
- `GEMINI_EMBED_MAX_RPM` (90, texts per minute), `GEMINI_EMBED_BATCH_SIZE` (100), `GEMINI_EMBED_MAX_TPM` (0 = off)
- `OPENAI_EMBED_MAX_RPM` (500, calls per minute), `OPENAI_EMBED_MAX_TPM` (900000), `OPENAI_EMBED_BATCH_SIZE` (128)
- Changed default: `EMBEDDING_MODEL=text-embedding-3-small` (`EMBEDDING_DIMS=768` unchanged). `OPENAI_API_KEY` is now used for embeddings.
