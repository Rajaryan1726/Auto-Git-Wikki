<div align="center">

# AutoWiki

**Turn any GitHub repository into an AI-written wiki you can chat with.**

[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![Express](https://img.shields.io/badge/Express-5-000000?logo=express&logoColor=white)](https://expressjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white)](https://www.postgresql.org/)
[![Qdrant](https://img.shields.io/badge/Qdrant-vectors-DC244C?logo=qdrant&logoColor=white)](https://qdrant.tech/)
[![Inngest](https://img.shields.io/badge/Inngest-jobs-111111)](https://www.inngest.com/)
[![OpenAI](https://img.shields.io/badge/OpenAI-embeddings-412991)](https://openai.com/api/)
[![Razorpay](https://img.shields.io/badge/Razorpay-subscriptions-0C2451?logo=razorpay&logoColor=white)](https://razorpay.com/)

<img src="docs/images/chat-demo.gif" alt="Asking AutoWiki how GitHub tokens are stored; the answer streams in with numbered citations and source chips" width="900">

</div>

## What it does

- **Sign in with GitHub** and see all your repositories, public and private (OAuth, tokens encrypted with AES-256-GCM).
- **Index a repo in the background**: files are parsed with tree-sitter, embedded and stored in Qdrant, with a live step-by-step progress view.
- **Get an AI-written wiki**: overview, architecture, setup and module pages, generated from the indexed code with source links.
- **Chat with the code**: streamed answers grounded in retrieved code, with `[n]` citations that link to exact files and line ranges at the indexed commit.
- **Personal memory and plans**: AutoWiki remembers how you like explanations (only from your own messages, and you can view or delete everything), and monthly plans run on Razorpay Subscriptions.

## Screenshots

| Repositories                                                                             | Wiki                                                                         |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| ![Repositories dashboard with status badges](docs/images/dashboard-light.png)            | ![Wiki tab with page list and a code block](docs/images/repo-wiki-light.png) |
| **Chat with citations**                                                                  | **Live indexing**                                                            |
| ![Chat answer with highlighted code and source chips](docs/images/chat-light.png)        | ![Indexing progress with the step list](docs/images/indexing-light.png)      |
| **Settings: memory and usage**                                                           | **Plans**                                                                    |
| ![Settings with remembered preferences and usage meters](docs/images/settings-light.png) | ![Pricing page with three plans](docs/images/pricing-light.png)              |

<details>
<summary><b>Dark mode</b></summary>

| Repositories                                       | Wiki                                             |
| -------------------------------------------------- | ------------------------------------------------ |
| ![Dashboard, dark](docs/images/dashboard-dark.png) | ![Wiki, dark](docs/images/repo-wiki-dark.png)    |
| ![Chat, dark](docs/images/chat-dark.png)           | ![Indexing, dark](docs/images/indexing-dark.png) |
| ![Settings, dark](docs/images/settings-dark.png)   | ![Pricing, dark](docs/images/pricing-dark.png)   |

</details>

<details>
<summary><b>Mobile (390 px)</b></summary>

| Dashboard                                                                                  | Chat                                                                             |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| <img src="docs/images/mobile-dashboard-light.png" alt="Mobile dashboard" width="300">      | <img src="docs/images/mobile-chat-light.png" alt="Mobile chat" width="300">      |
| <img src="docs/images/mobile-dashboard-dark.png" alt="Mobile dashboard, dark" width="300"> | <img src="docs/images/mobile-chat-dark.png" alt="Mobile chat, dark" width="300"> |

</details>

## How it works

![AutoWiki architecture](docs/images/architecture.png)

<details>
<summary>Mermaid source</summary>

```mermaid
flowchart LR
  WEB["Web app<br/>React + Vite + TanStack Query"]
  subgraph API["API server (Express)"]
    ROUTES["Routes<br/>auth · repos · index · wiki<br/>chat · memories · billing"]
    SERVICES["Services<br/>github · search · rag · wiki<br/>memory · billing · llm"]
  end
  subgraph JOBS["Background jobs (Inngest)"]
    WORKER["Inngest server<br/>queue + retries"]
    INN["Functions<br/>index-repo · regenerate-wiki<br/>remember-chat-turn · billing"]
  end
  subgraph Data["Storage"]
    PG[("PostgreSQL<br/>users, repos, jobs, wiki,<br/>chats, usage, subscriptions")]
    QD[("Qdrant<br/>code_* collections<br/>user_memories_*")]
  end
  subgraph External["External services"]
    GH["GitHub API<br/>OAuth, repos, git trees/blobs"]
    LLM["Gemini → OpenAI fallback<br/>(circuit breaker)"]
    EMB["OpenAI embeddings"]
    RZP["Razorpay<br/>Subscriptions + Checkout"]
  end

  WEB -- "JSON + SSE" --> ROUTES
  ROUTES --> SERVICES
  ROUTES -- "events" --> WORKER
  WORKER --> INN
  INN --> SERVICES
  SERVICES --> PG
  SERVICES --> QD
  SERVICES --> GH
  SERVICES --> LLM
  SERVICES --> EMB
  SERVICES --> RZP
  RZP -. "signed webhooks" .-> ROUTES
```

</details>

From a GitHub repo to a cited answer:

1. **List files.** The GitHub Trees API returns the whole tree at the latest commit in one call.
2. **Filter.** Skips vendored and build folders, lockfiles, secrets (`.env*` except templates), binary or minified files and anything over 512 KB.
3. **Chunk by syntax.** web-tree-sitter splits code in about a dozen languages (TypeScript, JavaScript, Python, Go, Rust, Java, C#, …) into functions, classes and blocks; other files such as Markdown and YAML are split at blank lines.
4. **Embed.** OpenAI `text-embedding-3-small` at 768 dimensions. On re-index, chunks whose text didn't change reuse their vectors.
5. **Store.** Qdrant, one collection per embedding model and size, with payload indexes on repo, commit and job.
6. **Retrieve.** Follow-up questions are rewritten into standalone queries. The top 30 dense hits are re-scored with keyword boosts on path, symbol and text (weighted by rarity, with a penalty for docs), then merged into at most 10 context blocks.
7. **Answer.** The model answers only from the numbered context and streams over SSE with `[n]` citations. Each citation maps to a file and line range at the indexed commit.
8. **Write the wiki.** A validated 5–12 page outline, then one page at a time from the same retrieval path. A hallucination check flags file paths that don't exist in the index and retries the page once.

## Engineering highlights

- **Idempotent indexing.** Qdrant point ids are UUID v5 of repo + commit + path + line, so retries overwrite instead of duplicating. Older points are removed only after every embed batch of the new job succeeds.
- **One embedding model per job.** The model and dimensions are fixed when a job starts, and each model gets its own collection. Queries always use the model of the repo's last successful index, never the current setting.
- **Single-use GitHub refresh tokens, safely.** Refreshes run under a `SELECT … FOR UPDATE` row lock and re-read the token after acquiring it. A concurrency test with a fake GitHub that rejects reused tokens proves it.
- **Streaming with mid-answer fallback.** SSE events `sources → token* → done`. If the primary model fails, even mid-answer, the fallback takes over (a `reset` event clears the partial text). A per-provider circuit breaker skips a provider that is over quota.
- **Prompt-injection defences.** Repository text is wrapped as untrusted data that the model must not follow. Memory learns only from the user's own messages (redacted), never from code, wiki or assistant text.
- **Cost control.** Plan quotas, a daily per-user token budget recorded per LLM call, global safety limits, and request rate limits. Checks run before work starts, so an answer is never cut off mid-stream.
- **Payments done carefully.** Razorpay webhooks are the source of truth. Signatures are checked over the raw body, deliveries are idempotent on the event id, out-of-order events are handled, and amounts are decided on the server only.
- **Real data deletion.** "Delete repo data" and "Delete my account" remove rows in Postgres and vectors in Qdrant (memories included). Both report counts before and after.

## Evaluation

All numbers come from the [phase reports](docs/phase-reports).

**Retrieval** (`npm run eval:retrieval`, `npm run eval:retrieval:heldout`):

| Query set                                                      | Ranking   | hit@3  | MRR@10 |
| -------------------------------------------------------------- | --------- | ------ | ------ |
| Tuned set: 13 queries, **used to tune the re-scoring weights** | dense     | 92.3%  | 0.637  |
|                                                                | re-scored | 100.0% | 0.808  |
| Held-out set: 15 new queries, never used for tuning            | dense     | 86.7%  | 0.739  |
|                                                                | re-scored | 86.7%  | 0.809  |

On unseen questions, re-scoring improves ranking (MRR) but not hit@3. The two misses are vocabulary mismatches, which is why hybrid BM25 search is on the roadmap.

**Wiki:**

- 9 of 9 spot-checked claims (3 per repo, 3 repos) matched the code at the indexed commit.
- Across 49 generated pages, the file-path check flagged 5 pages (10%). All 5 were fixed by one retry, so no link had to be removed.

**Memory** (`npm run eval:memory`): 7 cases × 5 runs, **35/35 passed**. The cases cover storing a skill level, updating it instead of duplicating it, ignoring code and secrets, ignoring a README that says "the user is an admin", the off switch, and latency.

**Tests:** 200 server tests (unit + Postgres integration). Typecheck, lint and build are clean.

## My memory engine

The user memory runs on my own library, [Custom-Memory-Engine](https://github.com/Rajaryan1726/Custom-Memory-Engine). It extracts facts, decides whether to add, update or delete them, and stores them in Qdrant.

AutoWiki's integration eval found a real weakness. Updating a skill level ("Actually, I'm comfortable with TypeScript now") passed only 1 of 5 runs, because the previous message was being re-extracted. The fixes went into the engine as v0.2.0: context-only messages, plus injected `chat` / `embed` functions and a logger. That case now passes 5 of 5.

## Tech stack

| Area     | Technology                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------- |
| Frontend | React 18, Vite, React Router, TanStack Query, Tailwind CSS v4, react-markdown + highlight.js            |
| Backend  | Node.js 20, Express 5, zod, pino, helmet                                                                |
| Data     | PostgreSQL 16 with Drizzle ORM, Qdrant                                                                  |
| AI       | Gemini (primary) and OpenAI (fallback) for generation, OpenAI `text-embedding-3-small`, web-tree-sitter |
| Jobs     | Inngest (step functions, retries, concurrency keys)                                                     |
| Payments | Razorpay Subscriptions and Checkout                                                                     |
| Tooling  | npm workspaces, strict TypeScript, ESLint, Prettier, `node:test`, Playwright, Docker Compose            |

## Quick start

You need Node.js 20.12+, Docker, a GitHub OAuth App and an OpenAI API key.

```bash
git clone https://github.com/Rajaryan1726/Auto-Git-Wikki.git
cd Auto-Git-Wikki
npm install
cp .env.example .env        # fill in the GitHub, session, encryption and OpenAI values
npm run infra:up            # PostgreSQL + Qdrant
npm run db:migrate
```

Then run both processes, each in its own terminal:

```bash
npm run dev                 # web on http://localhost:5173, API on http://localhost:4000
```

```bash
npm run inngest:dev         # background jobs, dashboard on http://localhost:8288
```

Indexing and chat need a plan. For local use, add your GitHub login to `COMP_GITHUB_LOGINS` in `.env`.

The full setup, every npm script and every environment variable are in **[docs/SETUP.md](docs/SETUP.md)**. Payments are covered in [docs/BILLING.md](docs/BILLING.md).

## Project structure

```text
apps/
  web/               React app: pages, features (repos, wiki, chat, memory, billing), components
  server/            Express API
    src/routes/      HTTP endpoints (zod-validated)
    src/services/    GitHub, retrieval, LLM, wiki, memory, billing, usage
    src/indexing/    file filter, tree-sitter chunking, point ids
    src/inngest/     background functions (index, wiki, memory, billing)
    drizzle/         SQL migrations
    eval/            retrieval eval sets
packages/
  shared/            zod schemas and types used by web and server
docs/                setup, billing, phase reports, images
scripts/             screenshot capture
```

## Roadmap

- Hybrid search (BM25 + dense) for vocabulary mismatches
- Production deployment
- Automatic re-index on push (GitHub webhooks)
- Cross-links between wiki pages
- GitHub App installation instead of an OAuth App

## Built with

I designed and directed this project and used [Claude Code](https://claude.com/claude-code) as an AI pair programmer. Each phase's goals, decisions and verification are written up in [docs/phase-reports](docs/phase-reports).

## Author

**Raj Aryan**: [GitHub](https://github.com/Rajaryan1726) · [Blog](https://rajaryan1726.hashnode.dev) · LinkedIn: https://www.linkedin.com/in/raj-aryan-0765a231a/

## License

© 2026 Raj Aryan. All rights reserved. The code is published for portfolio and reference purposes. No license is granted to use, copy, modify or distribute it without permission.
