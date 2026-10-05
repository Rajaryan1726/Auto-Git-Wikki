/**
 * User memory (Phase 4.5): the ONLY module that talks to custom-memory-engine.
 *
 * The engine is used as an unmodified dependency (pinned to a commit). Its LLM and
 * embedding clients are injected (`createMemoryEngine({ llm: { chat, openai } })`):
 *   chat   -> llm.ts generateText (primary/fallback models + circuit breaker)
 *   openai -> an object with only `embeddings.create`, backed by our configured embedder
 * Memories live in their own Qdrant collection (`user_memories_<model>_<dims>`), every
 * point scoped by userId. Only facts about the USER, from the user's own messages.
 */
import { eq } from 'drizzle-orm';
import {
  createMemoryEngine,
  type EngineChatFn,
  type EngineMemory,
  type EngineOpenAILike,
  type MemoryEngine,
} from 'custom-memory-engine';
import type { MemoryCategory, UserMemory } from '@autowiki/shared';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { env } from '../lib/env.js';
import { embedderFor } from './embeddings.js';
import { generateText } from './llm.js';
import {
  memorySourceMessages,
  mergeMemories,
  recallWithFallback,
  type RecalledMemory,
  type TurnMessage,
} from './memory-context.js';
import { collectionNameFor } from './qdrant.js';
import { parseJsonObject } from './wiki-content.js';

/** Preferences are always used (they shape every answer), up to this many. */
const MAX_PREFERENCES = 5;

/** `user_memories_<sanitized embedding model>_<dims>`, never a code collection. */
export function memoryCollectionName(model: string, dims: number): string {
  return collectionNameFor(model, dims).replace(/^code_/, 'user_memories_');
}

/** The engine's chat client, routed through our generation stack. */
export const engineChat: EngineChatFn = async ({ system, user, json }) => {
  const { text } = await generateText({
    system: system ?? '',
    messages: [{ role: 'user', content: user }],
    json,
    maxOutputTokens: 4000,
  });
  return json ? parseJsonObject(text) : text;
};

/** The only part of the OpenAI SDK the engine uses once a client is injected. */
function engineEmbeddings(): EngineOpenAILike {
  const embedder = embedderFor(env.EMBEDDING_MODEL, env.EMBEDDING_DIMS);
  return {
    embeddings: {
      async create({ input }) {
        // A single text is the engine's search query (or one fact): embedQuery shares the
        // vector chat retrieval just computed for the same question (memoized).
        const vectors =
          input.length === 1
            ? [await embedder.embedQuery(input[0]!)]
            : await embedder.embedDocuments(input);
        return { data: vectors.map((embedding, index) => ({ index, embedding })) };
      },
    },
  };
}

let engine: MemoryEngine | null = null;

function getEngine(): MemoryEngine {
  if (!engine) {
    engine = createMemoryEngine({
      config: {
        // Required by the engine's config check; not used, because the LLM and embedding
        // clients are injected below.
        openai: {
          apiKey: env.OPENAI_API_KEY ?? 'injected-client',
          chatModel: env.GEN_MODEL_PRIMARY,
          embeddingModel: env.EMBEDDING_MODEL,
          embeddingDim: env.EMBEDDING_DIMS,
        },
        qdrant: {
          url: env.QDRANT_URL,
          ...(env.QDRANT_API_KEY ? { apiKey: env.QDRANT_API_KEY } : {}),
        },
        collection: memoryCollectionName(env.EMBEDDING_MODEL, env.EMBEDDING_DIMS),
      },
      llm: { chat: engineChat, openai: engineEmbeddings() },
    });
  }
  return engine;
}

/** Test hook: use a stub engine. */
export function setMemoryEngineForTests(stub: MemoryEngine | null): void {
  engine = stub;
}

/**
 * Creates the memory collection and payload indexes at startup (the engine does this on
 * first use, which would otherwise make the first chat lookup hit its timeout).
 */
export async function warmUpMemory(): Promise<void> {
  try {
    await getEngine().getAll({ userId: 'warm-up' });
    console.log(
      `[memory] ready (collection ${memoryCollectionName(env.EMBEDDING_MODEL, env.EMBEDDING_DIMS)})`,
    );
  } catch (err) {
    console.warn(
      '[memory] warm-up failed (chat works without memory):',
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------- settings

export async function isMemoryEnabled(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ enabled: users.memoryEnabled })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.enabled ?? false;
}

export async function setMemoryEnabled(userId: string, enabled: boolean): Promise<void> {
  await db.update(users).set({ memoryEnabled: enabled }).where(eq(users.id, userId));
}

// ---------------------------------------------------------------- write

export type RememberResult =
  | { status: 'disabled' | 'nothing_to_learn' }
  | { status: 'done'; events: Record<string, number>; ids: string[] };

/**
 * Learns from one chat turn. Only the user's own messages (current + previous) are
 * passed, after secret redaction; assistant answers and repo context never are.
 */
export async function rememberTurn(input: {
  userId: string;
  thread: TurnMessage[];
  metadata?: Record<string, unknown>;
}): Promise<RememberResult> {
  if (!(await isMemoryEnabled(input.userId))) return { status: 'disabled' };
  const messages = memorySourceMessages(input.thread);
  if (messages.length === 0) return { status: 'nothing_to_learn' };
  const { results } = await getEngine().add(messages, {
    userId: input.userId,
    metadata: input.metadata ?? {},
  });
  const events: Record<string, number> = {};
  for (const r of results) events[r.event] = (events[r.event] ?? 0) + 1;
  return {
    status: 'done',
    events,
    ids: results.filter((r) => r.id && r.event !== 'NOOP').map((r) => r.id!),
  };
}

// ---------------------------------------------------------------- read

const toRecalled = (m: EngineMemory): RecalledMemory => ({
  id: m.id,
  text: m.text,
  category: m.category,
});

export type Recall = {
  enabled: boolean;
  memories: RecalledMemory[];
  ms: number;
  /** Why no memories were used: timeout / error (memory is best-effort). */
  error: string | null;
};

/**
 * Memories for one question: the top question-relevant ones plus the user's preferences.
 * Hard time limit (MEMORY_RECALL_TIMEOUT_MS), counted from when `opts.after` settles (the
 * parallel retrieval in chat; now by default): on timeout or error the answer is generated
 * without memory, so memory adds at most that long to an answer.
 */
export async function recallForQuestion(
  userId: string,
  question: string,
  opts: { timeoutMs?: number; after?: Promise<unknown> } = {},
): Promise<Recall> {
  const timeoutMs = opts.timeoutMs ?? env.MEMORY_RECALL_TIMEOUT_MS;
  const started = Date.now();
  let error: string | null = null;
  const result = await recallWithFallback(
    async () => {
      if (!(await isMemoryEnabled(userId))) return { enabled: false, memories: [] };
      const e = getEngine();
      const [relevant, preferences] = await Promise.all([
        // Top N by similarity, no threshold: a user has few memories, and background facts
        // ("beginner with TypeScript") score low against code questions yet still matter.
        e.search(question, { userId, limit: env.MEMORY_RECALL_LIMIT }),
        e.getAll({ userId, category: 'preference' }),
      ]);
      const prefs = [...preferences.results]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_PREFERENCES);
      return {
        enabled: true,
        memories: mergeMemories(relevant.results.map(toRecalled), prefs.map(toRecalled)),
      };
    },
    timeoutMs,
    { enabled: true, memories: [] as RecalledMemory[] },
    (err) => {
      error = err instanceof Error ? err.message : String(err);
    },
    opts.after,
  );
  return { ...result, ms: Date.now() - started, error };
}

// ---------------------------------------------------------------- settings page

function toUserMemory(m: EngineMemory): UserMemory {
  return {
    id: m.id,
    text: m.text,
    category: m.category as MemoryCategory,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt ?? m.createdAt,
  };
}

/** Active memories, most recently updated first. */
export async function listMemories(userId: string): Promise<UserMemory[]> {
  const { results } = await getEngine().getAll({ userId });
  return results.map(toUserMemory).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Hard delete of one memory (point + its history). False if it is not this user's. */
export async function deleteMemory(userId: string, id: string): Promise<boolean> {
  const e = getEngine();
  const existing = await e.get(id, { userId, includeArchived: true });
  if (!existing) return false;
  await e.delete(id, { userId });
  return true;
}

/** Hard delete of everything remembered about the user, archived memories included. */
export async function deleteAllMemories(userId: string): Promise<void> {
  await getEngine().deleteAll({ userId });
}

/** Archived + active count, for checks and the eval. */
export async function countMemories(userId: string, includeArchived = true): Promise<number> {
  const { results } = await getEngine().getAll({ userId, includeArchived });
  return results.length;
}

export async function allMemoriesRaw(userId: string): Promise<EngineMemory[]> {
  return (await getEngine().getAll({ userId, includeArchived: true })).results;
}
