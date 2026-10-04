# Phase 1 Report

## Summary

GitHub sign-in works end to end. The OAuth flow uses a CSRF `state` cookie. Tokens are encrypted with AES-256-GCM, and the session is an httpOnly 7-day JWT cookie, with `/api/auth/me`, logout and `requireAuth`. Expiring GitHub user tokens are supported: the refresh token and both expiry times are stored encrypted, and `getGithubToken()` / `githubFetch()` refresh automatically on expiry or on a 401. A row lock means only one refresh can run at a time across processes. On the frontend there is an AuthProvider, route guards, a redesigned login page, and a sidebar footer that shows the full username.

## Files created / changed

- `apps/server/src/db/schema.ts` — users table: added `github_token_expires_at`, `github_refresh_token_enc`, `github_refresh_token_expires_at`
- `apps/server/drizzle/0001_github_refresh_tokens.sql` (+ meta) — migration for the three new columns
- `apps/server/src/lib/crypto.ts` — `encryptToken` / `decryptToken` (AES-256-GCM, `v1:iv:tag:ciphertext`)
- `apps/server/src/lib/crypto.test.ts` — 9 unit tests: round trip, IV uniqueness, wrong key, tampered data/tag, malformed input
- `apps/server/src/lib/token-expiry.ts` (+ `.test.ts`) — `isExpired()` with a 5-minute refresh margin
- `apps/server/src/lib/cookies.ts` — cookie names, TTLs, options (httpOnly, SameSite=Lax, Secure in production)
- `apps/server/src/services/session.ts` — HS256 JWT sign/verify (`jose`), 7-day expiry
- `apps/server/src/services/github-oauth.ts` — authorize URL, code exchange, refresh grant, `GET /user`
- `apps/server/src/services/users.ts` — user upsert (tokens always encrypted), lookup, `tokenColumns()`
- `apps/server/src/services/github-token.ts` — `getGithubToken(userId)`, `githubFetch()` (401 refresh + retry once), `createGithubTokenService()` factory, locking
- `apps/server/src/services/github-token.integration.test.ts` — 5 concurrency tests against real Postgres with a fake single-use-refresh-token GitHub
- `apps/server/src/middleware/require-auth.ts` — `requireAuth`, `getSessionUser`, `currentUser`
- `apps/server/src/routes/auth.ts` — `GET /api/auth/github`, `GET /api/auth/github/callback`, `GET /api/auth/me`, `POST /api/auth/logout`
- `apps/server/src/types/express.d.ts` — `req.user` typing
- `apps/server/src/app.ts` — mounts `/api/auth`
- `apps/server/tsconfig.build.json`, `apps/server/package.json` — build excludes tests; `test` script (`node --test` + tsx); `jose` dependency
- `packages/shared/src/auth.ts` — `authUserSchema`, `LoginErrorCode`
- `apps/web/src/features/auth/auth-context.ts` — `useAuth`, `ME_QUERY_KEY`
- `apps/web/src/features/auth/auth-provider.tsx` — `/api/auth/me` query, sign-out mutation that clears the query cache
- `apps/web/src/features/auth/route-guards.tsx` — `RequireAuth`, `RedirectIfAuthed`
- `apps/web/src/app/router.tsx` — protected app routes, guarded `/login`
- `apps/web/src/main.tsx` — AuthProvider; any 401 from an API call clears the user, which redirects to `/login`
- `apps/web/src/pages/login-page.tsx` — logo, pitch, "Continue with GitHub", error area for every `?error=` code
- `apps/web/src/components/user-menu.tsx` — 36px avatar, full username (wraps, never truncated, has `title`), "Signed in with GitHub", sign-out icon button
- `apps/web/src/components/theme-toggle.tsx` — new `full` variant (icon + "Light mode"/"Dark mode", 44px)
- `apps/web/src/components/sidebar.tsx` — footer: theme toggle row, divider, user row
- `apps/web/package.json` — `zod` declared (used directly)
- `CLAUDE.md` — users table updated with the new columns and the "only refresh through `github-token.ts`" rule
- `README.md`, root `package.json` — `npm test`, OAuth App settings

## How to run / test

GitHub OAuth App settings for local dev (GitHub → Settings → Developer settings → OAuth Apps):

| Field                      | Value                                            |
| -------------------------- | ------------------------------------------------ |
| Homepage URL               | `http://localhost:5173`                          |
| Authorization callback URL | `http://localhost:4000/api/auth/github/callback` |

Then put the Client ID and Client Secret into `.env` as `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`.

```bash
npm run infra:up
npm run db:migrate          # applies 0001_github_refresh_tokens
npm run dev                 # open http://localhost:5173 -> Continue with GitHub
npm test                    # 18 tests (unit + concurrency integration; needs infra up)
npm run typecheck
npm run lint
npm run build
```

## Acceptance criteria

- Clicking "Continue with GitHub" completes login and lands on `/` with the username in the sidebar — **PASS**. You confirmed this with your real account (`Rajaryan1726`), and the server logged `signed in Rajaryan1726`.
- Refresh keeps the user signed in; sign-out returns to `/login` — **PASS**. You confirmed that refresh keeps you signed in. In the browser, sign-out cleared the cookie and redirected to `/login`, and loading `/` afterwards also redirected to `/login`. Signed in, `/login` redirects to `/`.
- The token in the DB is encrypted; tokens never appear in logs — **PASS**. In the DB, `github_access_token_enc` matches `v1:<iv>:<tag>:<ciphertext>` and contains no `gho_`/`ghu_` substring. A regex scan of the server log found 0 token-like strings. Logs record only usernames, user ids and error codes.
- Tampered or missing `state` is rejected — **PASS**. Missing state, forged state, and state without the cookie each redirect to `/login?error=invalid_state`. A denied authorization redirects to `?error=access_denied`, and a valid state with a bad code redirects to `?error=oauth_failed` (`bad_verification_code`).
- Encrypt/decrypt tests pass; typecheck and lint pass — **PASS**. `npm test` passes 18 of 18. Typecheck reports 0 errors, lint reports 0 problems, and build passes.
- Extra (requested): concurrent refresh can't reuse a refresh token — **PASS**. The integration tests start 10 parallel calls in one process and 10 calls across 5 simulated processes, plus concurrent 401 retries. GitHub was called exactly once each time, with 0 `bad_refresh_token` errors. I also confirmed the tests catch the bug: removing either the `FOR UPDATE` lock or the re-read after acquiring it makes 2 tests fail.
- Extra (requested): automatic refresh on expiry or 401 — **PASS, with a fake GitHub only**. Not tested with a real refresh token, because GitHub issued your app a non-expiring token (see Known issues). Tested against the real DB and the real GitHub endpoint: a valid token is returned; a non-expiring token is returned; an expired token with a bogus refresh token got `bad_refresh_token` from GitHub, giving `GITHUB_REAUTH_REQUIRED`; an expired refresh token or a missing refresh token gives `GITHUB_REAUTH_REQUIRED`; `githubFetch` on a 401 tried a refresh and then gave `GITHUB_REAUTH_REQUIRED`. The successful refresh-and-rotate path is covered by the integration tests with the fake.
- Extra (requested): sidebar footer — **PASS**. Measured with a 39-character username at 1280px and 375px in light and dark (4 setups). In all four the name is fully visible with no ellipsis and `overflow-wrap: anywhere`: 3 lines on desktop, 2 on mobile. It has weight 600 and a matching `title`. The sign-out `<button>` is 44×44 and never overlaps the name. The theme toggle is full width and 44px tall. The divider sits between the rows, the avatar is 36px, and there is no horizontal scroll. A fresh page load has no console errors.

## Decisions & deviations

- **Expiring tokens are optional in the code.** The token response is parsed for `expires_in`, `refresh_token` and `refresh_token_expires_in`. If they're missing, expiry is stored as `NULL` (never expires) and no refresh token is stored. The same code works whether or not GitHub issues expiring tokens.
- **Refresh locking.** There are two layers: (1) per process, concurrent callers for one user share a single in-flight refresh promise; (2) across processes, the refresh runs in a transaction with `SELECT … FOR UPDATE` on the user row and `lock_timeout = 20s`, and re-reads the token after taking the lock. If the token changed, it returns the new one without calling GitHub. If GitHub doesn't rotate the refresh token, the old one is kept. I chose a row lock over an advisory lock because the row is what's being updated, so the lock and the data can't drift apart.
- **`githubFetch` retries a 401 once** by calling `getGithubToken(userId, { staleToken })`. It only refreshes if the rejected token is still the stored one, so many parallel 401s cause a single refresh.
- **Unrecoverable token states** (no refresh token, expired refresh token, GitHub rejects the refresh) raise `401 GITHUB_REAUTH_REQUIRED`. In Phase 2 the frontend should send the user to `/login?error=session_expired`; the code already exists in `LoginErrorCode`.
- **JWT library:** `jose`, which is outside the listed stack. It's small, has no dependencies and is the standard choice; the alternative was hand-rolling HS256.
- **Test runner:** Node's built-in `node:test` through `tsx`, so no extra framework. The integration test skips itself if Postgres is unreachable.
- **State cookie** `aw_oauth_state` is httpOnly, Lax, scoped to `/api/auth/github`, lasts 10 minutes, is compared with `timingSafeEqual`, and is cleared on every outcome. State is checked before reading GitHub's `error` parameter, so a forged callback can't trigger the denial path.
- **Theme toggle label** names the mode it switches to: "Light mode" with a sun icon while dark, "Dark mode" with a moon icon while light. `aria-label` is "Switch to … mode".
- **The sidebar footer is visible on mobile too**, in the stacked header, so sign-out is always reachable. In Phase 0 it was hidden below `md`.
- **CLAUDE.md schema change** (requested): users now has `github_token_expires_at`, `github_refresh_token_enc`, `github_refresh_token_expires_at`.

## Known issues / TODO

- **Your OAuth App issued a non-expiring token.** After your login the DB row has no refresh token and `NULL` expiry, the token prefix is `gho_` (classic OAuth App token), and the server logged `(non-expiring token)`. GitHub currently supports expiring user tokens for **GitHub Apps** (`ghu_` tokens, setting "Expire user authorization tokens"). Classic OAuth Apps generally don't get them, even if a similar option appears. Nothing breaks: the token works, and refresh is ready if GitHub starts issuing expiring tokens. To test a real refresh you would need to switch to a GitHub App. With a GitHub App, `scope` is ignored and access comes from the App's configured permissions plus installation on your repos, which affects how Phase 2 lists repositories. I recommend staying on the OAuth App unless you want the GitHub App model.
- The real GitHub sign-in was done by you. I can't enter GitHub credentials, so the redirect round trip itself was verified by your report plus the server log and DB state.
- If GitHub accepts a refresh but the DB commit then fails, the new refresh token is lost and the user must sign in again. This is unavoidable with single-use tokens and rare in practice.
- The `inflight` refresh map is per process. Cross-process safety comes from the row lock.
- During testing, the background dev-server task hit its time limit while the actual Vite/tsx processes kept running, so a restart clashed on ports 4000 and 5173. If that happens, stop the old `node` processes and run `npm run dev` again.
- `npm audit` still shows the drizzle-kit dev-dependency advisories noted in Phase 0.

## Env vars added

None this phase. `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (already in `.env.example` since Phase 0) are now used. They stay optional at startup, and `/api/auth/github` redirects to `/login?error=not_configured` when they're missing.
