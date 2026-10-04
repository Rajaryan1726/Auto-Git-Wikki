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
