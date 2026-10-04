# Phase 5 Report

## Summary

Indexing now ends with a **"Generating wiki"** step. It plans a 5–12 page outline from the indexed file list, README and manifests (strict JSON, validated with zod, one retry), then writes each page from the same retrieval path chat uses, plus short excerpts of the page's files. Every page goes through a file-path hallucination check before it is saved. A wiki failure never fails the index. `POST /api/repos/:id/wiki/regenerate` rebuilds only the wiki, with no re-embedding. The repo page has a real Wiki tab: nested table of contents, Markdown article with highlighted code, source chips, deep links, and generating / failed / stale / not-indexed states. A per-provider **circuit breaker** now sends generation calls straight to the fallback while Gemini is over quota.

## Files created / changed

**Server**

- `apps/server/src/services/circuit-breaker.ts` (new) — `CircuitBreaker` (open until the retry time, clamped to 60 s–1 h; logs OPEN/CLOSED), `retryAfterMsFrom` (headers, Google `RetryInfo`, "retry in Ns"), `isQuotaError`
- `apps/server/src/services/llm.ts` — breaker routing (`routeModels`, `generationBreaker`), trips on quota errors before and during streaming; token usage from both providers (`onUsage`, `GeneratedText.usage`); JSON mode (`json: true`); `skipped` models reported
- `apps/server/src/services/wiki-content.ts` (new, pure) — outline schema + `validateOutline`, `orderPages`, `formatFileTree` (collapses deep dirs), `pickReadme` / `pickManifests`, `excerptFromChunks`, outline / page / retry prompts, `cleanPageMarkdown`, `extractPathMentions` / `findUnknownPaths` / `unlinkPaths`, `mergeSourceRefs`
- `apps/server/src/services/wiki.ts` (new) — runs (`startWikiRun`, one per repo, stale-run expiry, supersede), `generateOutline`, `generatePage`, `finishRun` (stats + per-page logging), reads for the API
- `apps/server/src/inngest/functions/wiki.ts` (new) — `runWikiSteps` (`wiki-outline` → `wiki-page-<slug>` ×3 in parallel → `wiki-finish`; never throws) and the `regenerate-wiki` function
- `apps/server/src/inngest/functions/index-repo.ts` — `wiki-start` + wiki steps after `cleanup-old-points`; `finalize` sets the "Finishing" step and prunes wiki runs of older jobs
- `apps/server/src/inngest/index.ts` — registers `regenerate-wiki`
- `apps/server/src/routes/wiki.ts` (new) — `GET /api/repos/:id/wiki`, `GET /api/repos/:id/wiki/:slug`, `POST /api/repos/:id/wiki/regenerate`; `app.ts` mounts it
- `apps/server/src/services/search.ts` — `searchRepo(…, { jobId })` searches a specific, fully embedded job (the wiki runs before the job becomes the repo's last index)
- `apps/server/src/services/qdrant.ts` — `listIndexedFiles`, `fileChunks` (scroll by repo + commit)
- `apps/server/src/services/rag-context.ts` — `UNTRUSTED_CONTEXT_RULES` shared by chat and wiki
- `apps/server/src/services/index-steps.ts` — new `wiki` step ("Generating wiki", detail "N / M pages"); weights rebalanced
- `apps/server/src/db/schema.ts`, `drizzle/0006_wiki.sql` — `wiki_runs` table, `wiki_pages.wiki_run_id` + `meta`, unique `(wiki_run_id, slug)`, `index_jobs.wiki_pages_total/done`
- `apps/server/src/routes/chat.ts`, `scripts/dev-ask.ts` — log models skipped by the breaker
- `apps/server/src/scripts/dev-wiki.ts` (new) — `npm run dev:wiki`
- Tests: `circuit-breaker.test.ts` (6), `wiki-content.test.ts` (15), `llm.test.ts` (+4: breaker, usage), `pipeline.test.ts` (+1 wiki step), updated progress expectations

**Shared**

- `packages/shared/src/wiki.ts` (new) — `WikiStatus`, `WikiResponse`, `WikiPage`, `wikiSlugSchema`

**Web**

- `apps/web/src/features/wiki/api.ts` (new) — `useWiki` (polls while generating), `useWikiPage`, `useRegenerateWiki`, `wikiPath`
- `apps/web/src/features/wiki/wiki-panel.tsx` (new) — TOC (sticky list on desktop, collapsible menu on mobile), article, source chips, notices, all states
- `apps/web/src/features/chat/message-view.tsx` — `MarkdownView` shared by chat and wiki (citations optional)
- `apps/web/src/pages/repo-page.tsx`, `app/router.tsx` — Wiki tab uses the new panel; route `/repos/:id/wiki/:slug`
- `apps/web/src/features/index-jobs/api.ts` — a finished index also refreshes the wiki
- `apps/web/src/styles/index.css` — `.wiki-article` typography

**Docs**: `CLAUDE.md` (schema, "Wiki conventions", "LLM circuit breaker"), `README.md` (`dev:wiki`), `package.json` (`dev:wiki`)

## How to run / test

```bash
npm run db:migrate                     # applies 0006_wiki
npm run dev                            # + npm run inngest:dev
# Repo page → Re-index: the progress panel shows "Generating wiki (N / M pages)"
# Wiki tab → /repos/<id>/wiki/<slug>; "Regenerate wiki" in the article header
npm run dev:wiki -- Auto-Git-Wikki                 # outline, per-page model/tokens/time, path-check counts
npm run dev:wiki -- Custom-Memory-Engine --regenerate
npm run dev:wiki -- NLP_PROJECT --page architecture
npm test && npm run typecheck && npm run lint && npm run build
```

Failure test used here: start the API with `GEN_MODEL_PRIMARY=gemini-does-not-exist GEN_MODEL_FALLBACK=gpt-does-not-exist npm run dev`, re-index a repo, restart normally, then chat and press Retry in the Wiki tab.

## Acceptance criteria

- **Indexing a real repo produces 5–12 sensible pages that render correctly** — **PASS**. Auto-Git-Wikki 9, NLP_PROJECT 8, Custom-Memory-Engine 7 (8 in the first regeneration), Advanced-RAG 10. All outlines were valid on the first attempt. Checked in the browser at 1366 px (light) and 375 px (dark): TOC, headings, tables, highlighted code that scrolls on its own, source chips, no horizontal page scroll (scrollWidth 375).
- **Page content uses real paths/symbols (3 claims per repo)** — **PASS**, 9/9 claims match the code at the indexed commit (see "Spot-checked claims").
- **Regenerate wiki works without re-embedding** — **PASS**. Run from the UI and from `dev:wiki --regenerate`. The `regenerate-wiki` function has no embed step; the logs show only `[wiki]` lines and no embedding calls, and the index job and Qdrant points are untouched. While it runs, the previous version stays visible under "Regenerating the wiki (N / M pages)", then switches to the new version by itself.
- **A wiki failure leaves chat working** — **PASS**. With both generation models broken, Advanced-RAG's outline failed after 4 attempts. The log shows `wiki … failed`, then `[index] job c8a8175a… done: … wiki failed`. The job is `done` and searchable. After restarting with the real models, `dev:ask` on Advanced-RAG answered the RRF question. The Wiki tab showed "Wiki generation failed" with the error and "The index itself is fine: chat still works", and **Retry** generated 10 pages.
- **Circuit breaker: with Gemini over quota, requests go straight to the fallback** — **PASS**. Gemini's free tier is still exhausted (429). In each server process the first generation call got the 429, which logged `circuit breaker OPEN for gemini for 3600s`. Every later call that hour (4 outlines and 19 pages in the last process) went straight to `gpt-6-luna` with **no Gemini request**, logged as "(after gemini-3.8-flash)" meaning skipped. The two OPEN lines in the log each follow a server restart (the breaker is in memory). Unit tests cover open/close, the clamps, both providers, "a bad key does not trip it" and "all open → still tried".
- **Typecheck, lint and tests pass** — **PASS**: 0 type errors, 0 lint problems, **138/138 tests**, build OK.

### Other checks

- **Progress step** — PASS. During the Auto-Git-Wikki re-index the server-provided steps read `… Embedding & saving: done (799 / 799 chunks) · Generating wiki: current (0 / 9 pages) · Finishing: pending` at 80%, rendered by the existing panel unchanged.
- **States** — PASS: not indexed (Index CTA), index without a wiki ("Generate wiki", Auto-Git-Wikki before re-indexing), generating with no previous wiki (progress bar + skeleton), regenerating (old pages + notice), failed (danger panel + Retry), stale (warning + Re-index; shown when `github_pushed_at` is newer than the job's start).
- **Deep links** — PASS: `/repos/:id/wiki/:slug`; the TOC links update the URL; a slug that isn't in the current wiki (e.g. after a regeneration renamed pages) redirects to the first page.
- **One generation per repo** — enforced by a partial unique index; a second regenerate request returns the running one (200), and the API answers 409 `INDEX_IN_PROGRESS` while the repo is being indexed.

## Generated outlines

**Auto-Git-Wikki @ 4905159** (re-indexed at the latest commit, the Phase 5 UI checkpoint)

1. Overview — README.md, package.json, CLAUDE.md
2. Architecture — CLAUDE.md, apps/server/src/index.ts, app.ts, apps/web/src/main.tsx, packages/shared/src/index.ts, docker-compose.yml
3. Setup & run — README.md, .env.example, docker-compose.yml, package.json ×3
4. Database & persistence — db/schema.ts, db/client.ts, drizzle.config.ts, migrations 0000 / 0004 / 0006
5. API & GitHub integration — app.ts, routes/auth.ts, routes/repos.ts, require-auth.ts, github-oauth.ts, github-token.ts, …
6. Repository indexing — repo-sync.ts, github-index.ts, parser.ts, chunker.ts, file-filter.ts, index-jobs.ts, index-repo.ts, dev-chunks.ts
7. Search, chat & wiki — embeddings.ts, qdrant.ts, search.ts, rag.ts, chat.ts, wiki.ts, inngest/functions/wiki.ts, eval-retrieval.ts
8. Web application — router.tsx, app-layout.tsx, auth-provider.tsx, the three pages, message-view.tsx, wiki-panel.tsx
9. Shared contracts — packages/shared/src/{index,auth,repos,index-jobs,chat,wiki}.ts, package.json

**NLP_PROJECT @ 6595632**

1. Overview — README.md
2. Architecture — README.md, backend/main.py, pipeline.py, db.py, vector_store.py, docker-compose.yml
3. Setup & run — README.md, backend/.env.example, package.json files, requirements.txt, docker-compose.yml, download_models.py
4. Summarization pipeline — pipeline.py, preprocessing.py, prompts.py, llm_service.py, main.py
5. Factuality checking — pipeline.py, vector_store.py, reranker.py, verifier.py, eval/score_labels.py
6. Persistence and correction memory — db.py, vector_store.py, memory_service.py, pipeline.py, config.py
7. Web frontend — frontend/src/App.tsx, lib/api.ts, lib/types.ts, InputPanel / OutputPanel / ClaimList / HistoryPanel
8. Evaluation and tests — backend/eval/_.py, backend/tests/test__.py

**Custom-Memory-Engine @ 0bd0bf3** (current version, regenerated from the UI)

1. Overview — README.md, package.json
2. Architecture — src/index.js, src/memory/MemoryEngine.js, src/config/index.js, src/llm/client.js, src/llm/embed.js, src/stores/vectorStore.js
3. Setup & run — README.md, .env.example, docker-compose.yml, package.json, scripts/check-setup.js, scripts/playground.js
4. Memory extraction and updates — extractor.js, decider.js, prompts.js, messages.js, MemoryEngine.js, tests/extraction-cases*.json
5. Context and retrieval — context.js, vectorStore.js, tests/retrieval-cases.json, eval-context.js, eval-retrieval.js
6. Qdrant storage — vectorStore.js, docker-compose.yml, test-vector-store.js, check-library.js
7. Evaluation — eval-full-report.js, eval-extraction.js, eval-retrieval.js, eval-update.js, eval-mem0-compare.js, held-out cases, eval docs

All pages are top-level: the model chose no nesting for these repos. Nesting by `parentSlug` is supported and unit-tested.

## Spot-checked claims (verified against the code at the indexed commit)

| Repo                 | Claim in the wiki                                                                                                                     | Code                                                 | Result |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------ |
| Auto-Git-Wikki       | `db/client.ts` builds a pool from `env.DATABASE_URL` and `pingDatabase()` runs `select 1`                                             | `client.ts:6`, `:10-11`                              | ✔      |
| Auto-Git-Wikki       | `drizzle.config.ts` throws "DATABASE_URL is not set…" and writes migrations to `./drizzle` (strict)                                   | `drizzle.config.ts:10, 16, 18`                       | ✔      |
| Auto-Git-Wikki       | OAuth uses scopes `read:user repo`, callback `${SERVER_URL}/api/auth/github/callback`, state checked with `statesMatch`, logout → 204 | `github-oauth.ts:7, 9`; `routes/auth.ts:30, 69, 110` | ✔      |
| NLP_PROJECT          | Snippet `search_many(doc_id, queries, config.RETRIEVE_TOP_K)` → `rerank_many(…, config.RERANK_TOP_K)`                                 | `backend/verifier.py:104-106` (exact)                | ✔      |
| NLP_PROJECT          | Defaults: top 10 candidates, top 3 reranked                                                                                           | `backend/config.py:31-32`                            | ✔      |
| NLP_PROJECT          | No chunk ≥ `MIN_RERANK_SCORE` → abstain: verdict `unsupported`, confidence 0, no NLI                                                  | `verifier.py:109-116`                                | ✔      |
| Custom-Memory-Engine | Six categories `identity, progress, weak_topic, preference, goal, other`                                                              | `src/memory/prompts.js:1`                            | ✔      |
| Custom-Memory-Engine | Decider uses short ids `m1…` and temperature 0; an active fact's DELETE becomes an UPDATE                                             | `src/memory/decider.js:28, 35, 41, 90`               | ✔      |
| Custom-Memory-Engine | Actions applied in order DELETE → UPDATE → ADD; DELETE archives with an `ARCHIVE` history entry                                       | `src/memory/MemoryEngine.js:235, 242`                | ✔      |

## Hallucination check (file paths)

| Run                                       | Pages  | Pages retried for unknown paths | Paths flagged                                              | Pages with paths removed after retry |
| ----------------------------------------- | ------ | ------------------------------- | ---------------------------------------------------------- | ------------------------------------ |
| Custom-Memory-Engine (regenerate, CLI)    | 8      | 1                               | `tests/results`                                            | 0                                    |
| Custom-Memory-Engine (index)              | 7      | 1                               | 1                                                          | 0                                    |
| NLP_PROJECT (index)                       | 8      | 1                               | `backend/.env`, `backend/.venv`                            | 0                                    |
| Custom-Memory-Engine (regenerate, UI)     | 7      | 0                               | —                                                          | 0                                    |
| Advanced-RAG (Retry after forced failure) | 10     | 0                               | —                                                          | 0                                    |
| Auto-Git-Wikki (index)                    | 9      | 2                               | `repo/index.requested`, `dist/index.js`, `dist/index.d.ts` | 0                                    |
| **Total**                                 | **49** | **5 (10%)**                     | **8**                                                      | **0**                                |

The retry fixed every flagged page, so no text was un-linked. Most flagged paths were **real but not indexed** (`.env`, `.venv`, `dist/` build output and `tests/results` are excluded from indexing on purpose). `repo/index.requested` is an Inngest event name: a false positive, because its last segment looks like a file extension.

## Time and token usage (wiki generation only; every page by `gpt-6-luna`, Gemini skipped by the breaker)

| Run                                  | Pages  | Wall time     | Input tokens    | Output tokens   |
| ------------------------------------ | ------ | ------------- | --------------- | --------------- |
| Auto-Git-Wikki (index)               | 9      | 192 s         | 112,946         | 20,426          |
| NLP_PROJECT (index)                  | 8      | 211 s         | 88,800          | 18,864          |
| Custom-Memory-Engine (index)         | 7      | 152 s         | 75,229          | 16,646          |
| Custom-Memory-Engine (regenerate ×2) | 8 + 7  | 168 s + 155 s | 90,152 + 68,780 | 17,170 + 16,986 |
| Advanced-RAG (Retry)                 | 10     | 227 s         | 102,982         | 20,851          |
| **Total (6 successful runs)**        | **49** | **1,105 s**   | **538,889**     | **110,943**     |

Per page, typically about 8–11k input and 1.5–2.5k output tokens, and 14–25 s; a page that needs the path retry costs about 2×. The outline step takes 10–18 s and about 3–6k input tokens. Output tokens include the model's reasoning tokens.

## Decisions & deviations

- **New `wiki_runs` table and `wiki_pages.wiki_run_id` / `meta` (schema deviation, recorded in CLAUDE.md).** The CLAUDE.md schema keyed pages by `(index_job_id, slug)`, which can't hold a regeneration of the same job next to the version still on screen, or a failed run's error. Runs carry status, progress, outline, stats and error; the partial unique index enforces one generation per repo. `index_jobs.wiki_pages_total/done` feed the "Generating wiki" step detail. `source_files` now stores `{ path, startLine, endLine }` (the table was empty).
- **Wiki before `finalize`, as asked.** `searchRepo` gained a `jobId` option so pages can retrieve from the new job before it becomes the repo's last index. It is the same function, not a second retrieval path. Chat keeps using the previous index until `finalize`.
- **A run is `done` only if every page succeeds.** Otherwise it is `failed` with the first error, and the previous wiki (if any) stays visible.
- **Path check scope.** Inline code and link targets are checked; fenced code is not (import paths in snippets aren't claims). Bare names without a slash (`res.json`) are skipped as too ambiguous; slash values that don't look like paths (`text/event-stream`, `owner/repo`) are skipped unless they have a file extension or start with a top-level directory of the repo.
- **Indexed file list comes from Qdrant** (a payload scroll), and so do the README, manifests and excerpts (rebuilt from chunks). No GitHub calls and no tokens are needed during wiki generation.
- **Breaker per provider, in memory, per process**, as specified. When every provider is open, all are tried anyway rather than failing without a request.
- **JSON mode** for the outline (`responseMimeType` on Gemini, `json_object` on OpenAI), plus tolerant parsing.
- **Pages run 3 at a time** (parallel Inngest steps). Each page is its own step with Inngest's retries; a run that hasn't finished after 60 minutes is treated as dead.
- **Testing UI without GitHub sign-in.** The browser pane's GitHub session had expired, so I minted a local dev session token with the app's own `createSessionToken` (localhost only) instead of entering GitHub credentials.
- **Leftover dev processes.** Stopping the background dev task on Windows left its child processes (concurrently/tsx/tsc/vite) running and holding ports; I stopped them by PID after checking their command lines.

## Known issues / TODO

- **Gemini's free tier is still exhausted**, so every wiki page and outline here came from `gpt-6-luna`. The breaker keeps this to one failed Gemini call per process per hour.
- **Path-check false positives** for names like `repo/index.requested`, and real-but-unindexed files (`.env`, `dist/…`) count as unknown. The retry handled all of them; a list of known non-file identifiers or the full GitHub tree would reduce retries.
- **No in-wiki links between pages** (the prompt forbids them, to keep the path check simple). Cross-links would need slug-aware link handling.
- **A regeneration can rename slugs**, so old deep links redirect to the first page instead of the "same" page.
- **Wiki generation cost**: about 75–113k input tokens per repo. A cheaper page model or a smaller context could be configured if needed.
- The breaker resets on server restart (in memory, by design); a shared store would be needed with several server processes.
- Screenshots in the browser pane timed out several times during testing; those checks were done through DOM queries instead.

## Env vars added

None. The wiki uses `GEN_MODEL_PRIMARY` / `GEN_MODEL_FALLBACK`; the breaker limits (60 s / 1 h) are constants.
