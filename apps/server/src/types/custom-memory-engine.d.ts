// Minimal types for the parts of custom-memory-engine (plain JS) that AutoWiki uses.
// Only services/memory.ts imports the engine.
declare module 'custom-memory-engine' {
  export type EngineCategory =
    'identity' | 'progress' | 'weak_topic' | 'preference' | 'goal' | 'other';

  export type EngineMemory = {
    id: string;
    text: string;
    score?: number;
    category: EngineCategory;
    metadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
    state: 'active' | 'archived';
  };

  export type EngineAddResult = {
    results: { id: string | null; text: string; event: string; previousText?: string }[];
  };

  export type EngineChatFn = (args: {
    system?: string;
    user: string;
    json?: boolean;
    temperature?: number;
    model?: string;
  }) => Promise<unknown>;

  /** v0.2.0 injection: texts -> one vector per text, in order. */
  export type EngineEmbedFn = (texts: string[]) => Promise<number[][]>;

  /** v0.2.0: messages never contain fact text; details may. */
  export type EngineLogger = { warn(message: string, details?: Record<string, unknown>): void };

  export type EngineConfig = {
    // apiKey / chatModel / embeddingModel are optional when chat and embed are injected.
    openai: { apiKey?: string; chatModel?: string; embeddingModel?: string; embeddingDim: number };
    qdrant: { url: string; apiKey?: string };
    collection: string;
    scoreThreshold?: number;
  };

  export type MemoryEngine = {
    collection: string;
    add(
      messages: { role: 'user' | 'assistant'; content: string }[],
      opts: {
        userId: string;
        metadata?: Record<string, unknown>;
        /** Shown to the extractor as context only; never extracted from. */
        contextMessages?: { role: 'user' | 'assistant'; content: string }[];
      },
    ): Promise<EngineAddResult>;
    search(
      query: string,
      opts: {
        userId: string;
        limit?: number;
        category?: EngineCategory | EngineCategory[];
        scoreThreshold?: number;
      },
    ): Promise<{ results: EngineMemory[] }>;
    getAll(opts: {
      userId: string;
      category?: EngineCategory | EngineCategory[];
      includeArchived?: boolean;
    }): Promise<{ results: EngineMemory[] }>;
    get(
      id: string,
      opts: { userId: string; includeArchived?: boolean },
    ): Promise<EngineMemory | null>;
    delete(id: string, opts: { userId: string }): Promise<void>;
    deleteAll(opts: { userId: string }): Promise<void>;
  };

  export function createMemoryEngine(opts: {
    config: EngineConfig;
    collection?: string;
    extraction?: 'llm' | 'naive';
    dedupe?: boolean;
    llm?: { chat: EngineChatFn; embed: EngineEmbedFn };
    logger?: EngineLogger;
  }): MemoryEngine;

  export const CATEGORIES: EngineCategory[];
}
