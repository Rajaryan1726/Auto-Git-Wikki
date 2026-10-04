# Auto-Git-Wikki

Log in with GitHub, index a repository, and get an AI-generated wiki plus a RAG chat with file and line citations.

See [CLAUDE.md](CLAUDE.md) for the stack, schema, and design system, and [docs/phase-reports](docs/phase-reports) for build progress.

## Requirements

- Node.js 20.12+ (uses `process.loadEnvFile`)
- Docker (for PostgreSQL 16 and Qdrant)

## Getting started

```bash
npm install
cp .env.example .env        # then fill in secrets and GitHub OAuth app credentials
npm run infra:up            # Postgres + Qdrant
npm run db:migrate          # create tables
npm run dev                 # web on :5173, API on :4000
npm run inngest:dev         # Inngest dev UI on :8288 (separate terminal)
```

GitHub OAuth App settings for local dev: Homepage URL `http://localhost:5173`, Authorization callback URL `http://localhost:4000/api/auth/github/callback`.

If port 5432 or 6333 is already taken, change `POSTGRES_HOST_PORT` / `QDRANT_HOST_PORT` in `.env` and update `DATABASE_URL` / `QDRANT_URL` to match.

## Scripts

| Script                                  | What it does                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm run dev`                           | Shared types (watch) + API server + web app                                                  |
| `npm run build`                         | Build shared, server and web                                                                 |
| `npm run typecheck`                     | Type-check every workspace                                                                   |
| `npm run lint`                          | ESLint across the repo                                                                       |
| `npm test`                              | Server unit + integration tests (integration needs infra up)                                 |
| `npm run dev:chunks -- <repoId> <path>` | Print the chunks for one file (`local <path>` for a file on disk; `--text` shows chunk text) |
| `npm run format`                        | Prettier write                                                                               |
| `npm run db:generate`                   | Generate a Drizzle migration from the schema                                                 |
| `npm run db:migrate`                    | Apply pending migrations                                                                     |
| `npm run infra:up`                      | Start Postgres + Qdrant (waits until healthy)                                                |
| `npm run infra:down`                    | Stop the containers (data volumes are kept)                                                  |
| `npm run inngest:dev`                   | Start the Inngest dev server                                                                 |

## Layout

```
apps/web         React + Vite + Tailwind frontend
apps/server      Express API, Drizzle, Qdrant, Inngest
packages/shared  Types and zod schemas shared by both
```
