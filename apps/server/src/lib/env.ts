import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  WEB_ORIGIN: z.url(),
  SERVER_URL: z.url(),

  DATABASE_URL: z.string().min(1),
  QDRANT_URL: z.url(),
  QDRANT_API_KEY: optionalString,

  INNGEST_EVENT_KEY: optionalString,
  INNGEST_SIGNING_KEY: optionalString,

  // Not used until the auth / LLM phases, so optional for now.
  GITHUB_CLIENT_ID: optionalString,
  GITHUB_CLIENT_SECRET: optionalString,
  GEMINI_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,

  SESSION_JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),

  GEN_MODEL_PRIMARY: z.string().min(1),
  GEN_MODEL_FALLBACK: z.string().min(1),

  // User memory (Phase 4.5): hard limit for the per-question lookup; on timeout the
  // answer is generated without memory.
  MEMORY_RECALL_TIMEOUT_MS: z.coerce.number().int().positive().max(5000).default(800),
  MEMORY_RECALL_LIMIT: z.coerce.number().int().positive().max(20).default(5),

  // Per-user limits and cost control (Phase 6). Daily counters reset at 00:00 UTC.
  LIMIT_MAX_INDEXED_REPOS: z.coerce.number().int().positive().default(10),
  LIMIT_INDEX_JOBS_PER_DAY: z.coerce.number().int().positive().default(20),
  LIMIT_WIKI_REGENERATIONS_PER_DAY: z.coerce.number().int().positive().default(10),
  LIMIT_CHAT_MESSAGES_PER_HOUR: z.coerce.number().int().positive().default(60),
  /** Repos with more indexable files than this are refused (after filtering). */
  LIMIT_MAX_REPO_FILES: z.coerce.number().int().positive().default(2000),
  /** Input + output tokens per user per UTC day, across chat, rewrite, wiki and memory. */
  LLM_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(1_000_000),

  // Request rate limits (per minute; auth per IP, the rest per user).
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_INDEX_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_WIKI_PER_MIN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_ASK_PER_MIN: z.coerce.number().int().positive().default(20),
  // Billing (Phase 8): Razorpay Subscriptions. Without the keys, nobody can subscribe
  // (complimentary users still work).
  RAZORPAY_KEY_ID: optionalString,
  RAZORPAY_KEY_SECRET: optionalString,
  RAZORPAY_WEBHOOK_SECRET: optionalString,
  /** GitHub logins (comma-separated, case-insensitive) that get the Max plan for free. */
  COMP_GITHUB_LOGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  /** Monthly billing cycles of a new subscription (Razorpay needs a finite total_count). */
  BILLING_TOTAL_COUNT: z.coerce.number().int().min(2).max(120).default(60),
  /** pino log level. */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  EMBEDDING_MODEL: z.string().min(1),
  EMBEDDING_DIMS: z.coerce.number().int().min(128).max(3072),

  // Embedding throttles (per server process, one per provider).
  EMBED_CONCURRENCY: z.coerce.number().int().positive().max(16).default(2),
  // Gemini meters embeddings per TEXT: texts/minute (free tier for gemini-embedding-2: 100).
  GEMINI_EMBED_MAX_RPM: z.coerce.number().int().positive().default(90),
  GEMINI_EMBED_BATCH_SIZE: z.coerce.number().int().positive().max(100).default(100),
  /** Optional tokens-per-minute cap (estimated as chars / 4); 0 disables it. */
  GEMINI_EMBED_MAX_TPM: z.coerce.number().int().min(0).default(0),
  // OpenAI meters per CALL and per token.
  OPENAI_EMBED_MAX_RPM: z.coerce.number().int().positive().default(500),
  OPENAI_EMBED_MAX_TPM: z.coerce.number().int().min(0).default(900_000),
  /** Texts per /v1/embeddings call (API max 2048 inputs and 300k tokens per request). */
  OPENAI_EMBED_BATCH_SIZE: z.coerce.number().int().positive().max(2048).default(128),
});

export type Env = z.infer<typeof envSchema>;

/** Loads the repo-root `.env` (if present) without overriding real env vars. */
function loadRootEnvFile(): void {
  const path = fileURLToPath(new URL('../../../../.env', import.meta.url));
  if (existsSync(path)) process.loadEnvFile(path);
}

function loadEnv(): Env {
  loadRootEnvFile();
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    console.error(
      `\nInvalid environment configuration:\n${lines.join('\n')}\n\n` +
        'Copy .env.example to .env at the repo root and fill in the missing values.\n',
    );
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
