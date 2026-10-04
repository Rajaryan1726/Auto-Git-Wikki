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

  /** Only `embeddings.create` is used by the engine when a client is injected. */
  export type EngineOpenAILike = {
    embeddings: {
      create(args: {
        model: string;
        input: string[];
      }): Promise<{ data: { index: number; embedding: number[] }[] }>;
    };
  };

  export type EngineConfig = {
    openai: { apiKey: string; chatModel: string; embeddingModel: string; embeddingDim: number };
    qdrant: { url: string; apiKey?: string };
    collection: string;
    scoreThreshold?: number;
  };

  export type MemoryEngine = {
    collection: string;
    add(
      messages: { role: 'user' | 'assistant'; content: string }[],
      opts: { userId: string; metadata?: Record<string, unknown> },
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
    llm?: { chat: EngineChatFn; openai: EngineOpenAILike };
  }): MemoryEngine;

  export const CATEGORIES: EngineCategory[];
}
