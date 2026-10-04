# Phase 2 Report

## Summary

The dashboard now lists your real GitHub repositories from our DB. Search and the four filters run on the server, cards have status badges, and there are loading, empty and error states. There's also a repo detail page with a header card and tabs. Sync follows pagination, reports rate limits clearly, and skips orgs that block access instead of failing. It deletes repos only after a complete, non-partial fetch, and checks each one by id first. Also added: global re-auth handling (`GITHUB_REAUTH_REQUIRED` signs you out and redirects to `/login?error=session_expired`), and a `github_pushed_at` column that drives "Updated X ago".

## Files created / changed

- `apps/server/src/db/schema.ts` — `repositories.github_pushed_at`, `users.repos_synced_at`, index `index_jobs(repo_id, created_at)`
- `apps/server/drizzle/0002_repo_sync.sql` (+ meta) — migration for the above
- `apps/server/src/services/github-api.ts` — `Link` pagination parsing, rate-limit detection (primary and secondary), `ensureGithubOk`, `mapWithConcurrency`
- `apps/server/src/services/github-repos.ts` — `listUserRepos` (paginated `/user/repos`, never silently partial), `findRestrictedOrgs` (OAuth-restricted and SSO orgs, best effort), `checkRepoPresence` (by id), SSO header parsing
- `apps/server/src/services/repo-sync.ts` — `syncUserRepos`: upsert only changed rows, safe removals, skipped-org summary, Qdrant cleanup for removed repos
- `apps/server/src/services/repo-status.ts` — `deriveIndexStatus` (indexing > failed > indexed > not indexed)
- `apps/server/src/services/repos.ts` — `listReposForUser` (search, filters, latest-job status) and `getRepoForUser` (ownership enforced)
- `apps/server/src/services/qdrant.ts` — `deleteRepoPoints(repoId)`
- `apps/server/src/services/users.ts` — `getReposSyncedAt`
- `apps/server/src/routes/repos.ts` — `GET /api/repos`, `POST /api/repos/sync`, `GET /api/repos/:id`; auto-sync on first load; one sync per user at a time
- `apps/server/src/app.ts` — mounts `/api/repos`
- `apps/server/src/services/github-repos.test.ts` — 7 unit tests (pagination, rate limits, parsing, SSO header, status derivation)
- `apps/server/src/services/repo-sync.integration.test.ts` — 9 DB tests (insert/update/remove, partial-fetch safety, SSO, restricted orgs, search and filters, ownership)
- `packages/shared/src/repos.ts` — repo, status, list, sync and detail schemas and types
- `apps/web/src/features/repos/api.ts` — `useRepos`, `useRepo`, `useSyncRepos`, `useLastSyncSummary`
- `apps/web/src/features/repos/components.tsx` — `RepoCard`, `StatusBadge`, `IndexProgress`, `VisibilityPill`, `LanguageDot`, `RepoCardSkeleton`
- `apps/web/src/features/repos/format.ts` — status labels; `repoUpdatedAt` (pushed_at first)
- `apps/web/src/features/repos/sync-notice.tsx` — dismissible notice about skipped orgs or repos, with a GitHub access link
- `apps/web/src/pages/repositories-page.tsx` — dashboard: sync button with loading state, search (debounced, kept in the URL), filter pills, grid, skeletons, empty, filtered-empty, indexed-empty and error states with retry
- `apps/web/src/pages/repo-page.tsx` — repo page: breadcrumb, header card, disabled Index/Re-index, "Chat with repo", accessible tabs
- `apps/web/src/pages/placeholder-pages.tsx` — the chat placeholder shows the selected repo pill; old RepoPage stub removed
- `apps/web/src/lib/{time,languages,ui}.ts` — relative time, language colors with a neutral fallback, shared button and pill classes
- `apps/web/src/features/auth/auth-provider.tsx`, `auth-context.ts`, `route-guards.tsx` — re-auth handling with `endReason`; session clearing fixed (see Decisions)
- `apps/web/src/main.tsx` — global 401 handling moved into AuthProvider
- `apps/web/src/pages/login-page.tsx` — `session_expired` message
- `apps/web/src/app/router.tsx` — new repo page
- `CLAUDE.md` — schema: `github_pushed_at`, `repos_synced_at`, job index, removal rule

## How to run / test

```bash
npm run infra:up
npm run db:migrate            # applies 0002_repo_sync
npm run dev                   # http://localhost:5173 — sign in; the first load auto-syncs
npm test                      # 34 tests (needs infra up for the integration tests)
npm run typecheck
npm run lint
npm run build
```

API, with the session cookie:

```bash
curl -b "aw_session=..." "http://localhost:4000/api/repos?filter=private&q=rag"
curl -b "aw_session=..." -X POST http://localhost:4000/api/repos/sync
curl -b "aw_session=..." http://localhost:4000/api/repos/<id>
```

## Acceptance criteria

- After login, the dashboard lists the user's real repos including private ones — **PASS**. Your account (`Rajaryan1726`) auto-synced on first load in 1.3s: 13 repos, 2 private (`RAG-projects`, `ai-meeting-copilot`) and 11 public, including repos owned by other users where you're a collaborator. The browser showed all 13 cards with Private badges on the right two.
- Sync picks up a newly created GitHub repo — **PASS (simulated) / please confirm for real**. An integration test adds a new repo to the fake GitHub listing and sync inserts it (`added: 1`). On your account, a second real sync reported `+0 ~0 -0`, which confirms upserts don't duplicate. I didn't create a repo on your GitHub account, since that's an outward action; see the note below.
- Search and all four filters work (server-side) — **PASS**. Over HTTP: all = 13, public = 11, private = 2, indexed = 0, `q=rag` = 2, `q=RAG&filter=private` = 1. A bad filter returns 400 `VALIDATION_ERROR`. In the UI, the pills set `aria-pressed` and update `?filter=`, search is debounced into `?q=`, and every change triggers a new API request. The integration test covers case-insensitive search, literal `%`/`_`, and the indexed filter with a real `done` job.
- A user cannot open another user's repo by id (404) — **PASS**. A second test user requesting your repo id got 404 `REPO_NOT_FOUND`, and their list was empty. A malformed id and a random UUID also return 404. Signed out returns 401. Also covered by the integration test.
- Responsive at phone width; works in light and dark; typecheck and lint pass — **PASS**. At 375px in light and dark (dashboard and repo page): one column, no horizontal overflow, all buttons and links at least 44px. At 1280px: 3 columns of equal-height cards with the sticky sidebar. Typecheck reports 0 errors, lint 0 problems; tests pass 34/34 and build passes.
- Extra 1 — re-auth handling — **PASS**. Tested end to end with a test user holding a revoked token. The first load auto-synced, GitHub returned 401, the server answered `GITHUB_REAUTH_REQUIRED`, and the frontend called logout, cleared the cookie and redirected to `/login?error=session_expired` with the message "Your session expired or GitHub access was revoked. Sign in again to continue." Normal sign-out still goes to `/login` with no message.
- Extra 2 — org repos skipped, never fatal — **PASS**. Integration tests: an OAuth-restricted org (403 "OAuth App access restrictions") and a malformed item are reported as `skipped: { repos: 1, orgs: [{ login: 'locked-org' }], count: 2 }` while the sync succeeds. In the UI, the notice lists the orgs, links to the GitHub access page, survives filter changes and can be dismissed. Your real account has no restricted orgs, so I tested the UI with an injected sync response.
- Extra 3 — removals only after a complete fetch — **PASS**. Integration tests: a removed repo is deleted after a complete fetch. A failed page 2 deletes nothing; it would otherwise have removed 4 repos. SSO-partial results delete nothing. A repo missing from the list but still found at `/repositories/:id` is kept.
- Extra 4 — `github_pushed_at` — **PASS**. Added in migration 0002 and in CLAUDE.md. Your real data is populated; for example `Auto-Git-Wikki` was pushed 09:29:57 UTC (the Phase 1 push), and the card shows "Updated 15 minutes ago". Cards and the repo header use pushed_at and fall back to updated_at.

## Decisions & deviations

- **`prompts/phase-2-repos.md` doesn't exist** in the repo. I worked from the Phase 2 text you pasted.
- **Extra column `users.repos_synced_at`.** "First login (no repos in DB)" is implemented as "never synced". Using "no repos in DB" would re-sync on every load for a user who really has zero repos. `GET /api/repos` runs the sync inline when it's null, so the first dashboard load already has data. It's in CLAUDE.md.
- **Removal safety goes beyond the brief.** (1) Removals run only when every page loaded and GitHub didn't send `X-GitHub-SSO: partial-results`. SSO sessions expire temporarily, and deleting those repos would wipe their wikis and chats. (2) Each missing repo is re-checked with `GET /repositories/:id`, and only 404 or a non-rate-limit 403 counts as gone. That stops a pagination shift (a repo deleted on an earlier page while sync runs) from deleting a live repo. (3) Listing is sorted by `full_name` so pages are stable.
- **Removed repos cascade** in the DB (index jobs, wiki pages, chat threads). Their Qdrant points are deleted best effort.
- **Detecting restricted orgs.** `/user/repos` simply omits org repos that block the OAuth app; it doesn't return per-repo 403s. So each org from `/user/orgs` is probed with `GET /orgs/{org}/repos?per_page=1`, and the 403 message identifies OAuth restrictions or SSO. SSO-hidden orgs from the response header are counted too, without a name. Limitation: with the current `read:user repo` scopes, `/user/orgs` lists only public org memberships, so restricted orgs where your membership is private can't be named. Adding `read:org` would fix that, but needs re-consent, so I didn't change scopes.
- **Rate limits** → `429 GITHUB_RATE_LIMITED` with "Try again in N minutes". Other GitHub failures → `502 GITHUB_API_ERROR`. Both use the standard error JSON.
- **Index status** = active job (`Indexing N%` with a progress bar), then latest job failed (`Index failed`, error in the tooltip), then `last_indexed_job_id` done (`Indexed · sha`), then `Not indexed`. The **indexed filter** uses `last_indexed_job_id IS NOT NULL`.
- **Sync is per user and runs one at a time** within a process. Concurrent `POST /sync` or auto-sync calls share one result (React StrictMode double-fetches in dev). Unchanged rows aren't touched (`ON CONFLICT … DO UPDATE … WHERE … IS DISTINCT FROM`), so `updated_at` reflects real changes.
- **Session-clearing fix (Phase 1 bug I found while testing re-auth).** `queryClient.clear()` detached AuthProvider's `me` observer, so a forced sign-out didn't redirect. Normal sign-out only worked because it also navigated. The session is now cleared by updating `me` in place and removing other queries.
- **The skipped notice lives in the query cache**, so it survives filter changes, and is dismissed per sync.
- **The Health card moved off the dashboard** to Overview only, to match the mockup.
- The Index button is disabled with the title "Indexing is not available yet". "Chat with repo" goes to `/chat?repo=<id>`, which shows the repo name pill.

## Known issues / TODO

- **Please test with a real new repo**: create any repo on GitHub, click "Sync from GitHub", and it should appear first in the list. Delete it and sync again, and it should disappear.
- The sidebar stacks above the content below 768px, so on phones the user and theme rows push the dashboard down. This works and was approved in Phase 1, but a collapsible menu would be nicer later.
- If a refetch fails while data is cached (e.g. after changing filters), the stale list stays visible without an error banner. A first load or retry shows the full error state.
- Restricted orgs with private membership can't be named without the `read:org` scope (see Decisions).
- The repo page's Files and Index history tabs are placeholders (Phases 3–4).
- During testing, the Phase 1 dev server had exited on its own, so I stopped the stale Vite process and restarted `npm run dev`.

## Env vars added

None.
