# Phase 0 Report

## Summary

This phase sets up a running skeleton: an npm-workspaces monorepo (`apps/web`, `apps/server`, `packages/shared`), Postgres 16 and Qdrant in docker-compose, the Drizzle schema with all six tables and both enums plus the first migration, and an Express server with env validation, CORS, an error handler, `/api/health`, Qdrant collection bootstrap and Inngest with a `hello` function. The frontend is a themed shell: the Wine & cream tokens in light and dark, a theme toggle that persists, a responsive sidebar layout, placeholder routes and a live health card.

## Files created / changed

- `package.json` — root workspaces and scripts (dev, build, lint, typecheck, db:_, infra:_, inngest:dev, format)
- `tsconfig.base.json` — shared strict TS config
- `eslint.config.js` — flat ESLint config (typescript-eslint, react-hooks, react-refresh, prettier)
- `.prettierrc.json`, `.prettierignore` — Prettier config
- `.editorconfig`, `.gitattributes`, `.gitignore` — editor/line-ending/ignore rules
- `docker-compose.yml` — Postgres 16 + Qdrant with named volumes, healthchecks, configurable host ports
- `.env.example` — every env var, no real values
- `README.md` — setup and script reference
- `packages/shared/src/errors.ts` — `{ error: { code, message } }` zod schema and type
- `packages/shared/src/health.ts` — health response schema and type
- `packages/shared/src/index.ts` — barrel export
- `apps/server/drizzle.config.ts` — drizzle-kit config (reads root `.env`)
- `apps/server/drizzle/0000_mushy_ben_parker.sql` — first migration (all tables and enums)
- `apps/server/src/lib/env.ts` — loads root `.env` and validates it with zod, exiting with a clear message on failure
- `apps/server/src/lib/http-error.ts` — typed HTTP error for routes
- `apps/server/src/db/schema.ts` — all tables and enums from CLAUDE.md
- `apps/server/src/db/client.ts` — pg pool + Drizzle instance + ping
- `apps/server/src/services/qdrant.ts` — Qdrant client, `ensureCodeCollection()` (cosine and payload indexes), ping
- `apps/server/src/inngest/client.ts` — Inngest client
- `apps/server/src/inngest/functions/hello.ts` — `hello` test function (event `test/hello`)
- `apps/server/src/inngest/index.ts` — Express serve handler and function list
- `apps/server/src/middleware/error-handler.ts` — 404 and central error handler (HttpError, ZodError, bad JSON, 500)
- `apps/server/src/routes/health.ts` — `GET /api/health` checks Postgres and Qdrant, with a 3s timeout each
- `apps/server/src/app.ts` — Express app (CORS with credentials, JSON, cookie-parser, routes)
- `apps/server/src/index.ts` — bootstrap: ensures the Qdrant collection, listens, shuts down cleanly
- `apps/web/index.html` — Google Fonts and an inline script that sets the theme before first paint
- `apps/web/vite.config.ts` — React and Tailwind v4 plugins; env read from the repo root
- `apps/web/public/favicon.svg` — app icon
- `apps/web/src/styles/index.css` — design tokens as CSS variables (light and dark) mapped to Tailwind via `@theme`
- `apps/web/src/app/theme.tsx`, `theme-context.ts` — ThemeProvider (OS default, toggle, localStorage, follows OS changes until the user picks)
- `apps/web/src/app/router.tsx` — routes `/`, `/overview`, `/repos/:id`, `/chat`, `/settings`, `/login`, 404
- `apps/web/src/main.tsx` — providers (Theme, TanStack Query, Router)
- `apps/web/src/lib/api.ts` — `apiFetch` wrapper (`credentials: 'include'`, JSON, typed errors)
- `apps/web/src/features/health/use-health.ts` — health query hook
- `apps/web/src/components/{app-layout,sidebar,theme-toggle,page-header,health-status}.tsx` — layout shell and health card
- `apps/web/src/pages/{repositories-page,placeholder-pages,login-page}.tsx` — placeholder pages
- `CLAUDE.md` — reformatted by Prettier (table alignment only, no content change)

## How to run / test

```bash
npm install
cp .env.example .env          # fill SESSION_JWT_SECRET + TOKEN_ENCRYPTION_KEY (commands in the file)
npm run infra:up
npm run db:migrate
npm run dev                   # http://localhost:5173 and http://localhost:4000/api/health
npm run inngest:dev           # second terminal, UI at http://localhost:8288
# trigger the test function:
curl -X POST http://localhost:8288/e/dev -H "Content-Type: application/json" -d '{"name":"test/hello","data":{"name":"AutoWiki"}}'
npm run typecheck
npm run lint
npm run build
```

## Acceptance criteria

- `npm run infra:up` starts Postgres and Qdrant; `npm run db:migrate` creates all tables — **PASS**. Both containers report healthy. `\dt` shows all 6 tables, and `\dT` shows `chat_role` and `index_job_status`.
- `npm run dev` starts web and server; `/api/health` reports DB and Qdrant as ok — **PASS**. It returns HTTP 200 with `{"status":"ok","services":{"database":{"status":"ok",...},"qdrant":{"status":"ok",...}}}`. On startup the server also created collection `code_gemini_768` and payload indexes on `repo_id` and `commit_sha`.
- Inngest dev server discovers the `hello` function and it runs when triggered — **PASS**. The dev server auto-discovered the app `autowiki` with function `autowiki-hello`. Sending `test/hello` produced a run with status `Completed`.
- Frontend shows the sidebar layout; theme toggle switches light/dark and survives refresh — **PASS**. Checked in a browser: the OS default (dark) applied, the toggle switched to light and stored it, and the theme stayed light after a full page load. At 375px the sidebar stacks on top and nothing overflows horizontally. There were no console errors, and both font families loaded.
- `npm run typecheck` and `npm run lint` pass — **PASS**. Both report 0 errors and 0 warnings. `npm run build` and `prettier --check` also pass.
- Extra: server fails fast on bad env — **PASS**. An invalid `WEB_ORIGIN` or `TOKEN_ENCRYPTION_KEY` prints each problem and exits with code 1.
- Extra: error JSON format — **PASS**. An unknown route returns `NOT_FOUND`, malformed JSON returns `INVALID_JSON`, and CORS returns `Access-Control-Allow-Origin: http://localhost:5173` with credentials.

## Decisions & deviations

- **React 18.3** as specified in CLAUDE.md, although React 19 is current. Other libraries use current majors: Vite 8, Tailwind 4 (CSS-first `@theme`, no `tailwind.config.js`), React Router 7, Express 5, zod 4, Inngest SDK 4, ESLint 10.
- **TypeScript 6.0**, not 7.0. typescript-eslint 8.71 only supports TS below 6.1.
- **Host ports are configurable** (`POSTGRES_HOST_PORT`, `QDRANT_HOST_PORT`). Another project's Qdrant already uses 6333 on this machine, so the local `.env` uses 6339. `.env.example` keeps the standard defaults.
- **No dotenv dependency.** The server uses Node's built-in `process.loadEnvFile` with a single repo-root `.env`. Real env vars take precedence. Vite reads the same file through `envDir`.
- **Env strictness:** `GITHUB_*`, `GEMINI_API_KEY`, `OPENAI_API_KEY` and the Inngest keys are optional for now because they aren't used until later phases. Everything else is required. `SESSION_JWT_SECRET` must be at least 32 characters, and `TOKEN_ENCRYPTION_KEY` must decode from base64 to exactly 32 bytes.
- **Qdrant collection name:** the provider is fixed as `gemini`, since OpenAI is generation-only. That gives `code_gemini_${EMBEDDING_DIMS}`, e.g. `code_gemini_768`. Payload indexes use the `keyword` type.
- **Inngest `isDev`** is set when `NODE_ENV !== 'production'`. Inngest SDK v4 defaults to cloud mode, so the server would otherwise not talk to the local dev server.
- **Health returns 503** with the same body when either dependency is down. The web client handles that and still renders per-service status.
- **Added an `/overview` route** because the sidebar nav has an "Overview" link. For now it is a placeholder with the health card.
- **`.env` holds generated local secrets** and is gitignored.
- **Extra env vars:** `NODE_ENV` (optional, default `development`), `VITE_API_URL` (web to API base URL), and the two host-port vars.
- **FK cascades:** child rows cascade on delete of their parent. `repositories.last_indexed_job_id` uses `ON DELETE SET NULL`.

## Known issues / TODO

- `npm audit` reports 6 vulnerabilities (5 moderate, 1 high) in transitive dev dependencies (drizzle-kit's esbuild-kit chain). They are not fixed because `audit fix --force` would downgrade packages. Revisit when drizzle-kit updates.
- Model ids in `.env.example` (`gemini-2.5-flash`, `gpt-4o-mini`, `gemini-embedding-001`) are placeholders. Check them against current official docs in the LLM/embedding phase. The `768` dims assume `gemini-embedding-001` with `outputDimensionality: 768`.
- The Inngest dev UI's event-runs API returned `output: ""` for the hello run even though the status was `Completed`. The return value is visible in the dev UI at http://localhost:8288.
- `npm run dev` does not start the Inngest dev server. Run `npm run inngest:dev` separately. This is intentional, so the downloaded CLI stays opt-in.
- The user slot in the sidebar is a "Not signed in" placeholder linking to `/login`. The login button is disabled until the auth phase.

## Env vars added

`DATABASE_URL`, `QDRANT_URL`, `QDRANT_API_KEY` (optional), `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`, `PORT`, `WEB_ORIGIN`, `SERVER_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_JWT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GEN_MODEL_PRIMARY`, `GEN_MODEL_FALLBACK`, `EMBEDDING_MODEL`, `EMBEDDING_DIMS`, plus `VITE_API_URL`, `POSTGRES_HOST_PORT`, `QDRANT_HOST_PORT` and `NODE_ENV` (optional).
