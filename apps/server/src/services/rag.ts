import type { ChatSource } from '@autowiki/shared';
import { generateText, resilientStream, type AnswerEvent, type ChatTurn } from './llm.js';
import {
  CANDIDATE_POOL,
  REWRITE_SYSTEM_PROMPT,
  answerUserTurn,
  buildContext,
  cleanRewrittenQuery,
  rankHits,
  systemPrompt,
  type ContextBlock,
} from './rag-context.js';
import { searchRepo } from './search.js';

export { CANDIDATE_POOL, rankHits } from './rag-context.js';

/** Conversation turns used for rewriting and as chat history. */
export const HISTORY_TURNS = 6;

export type PreparedAnswer = {
  searchQuery: string;
  rewritten: boolean;
  rewriteModel: string | null;
  commitSha: string;
  blocks: ContextBlock[];
  sources: ChatSource[];
  system: string;
  messages: ChatTurn[];
};

/**
 * Standalone search query for a follow-up. The first message of a thread is used as-is;
 * if rewriting fails, the original question is used rather than failing the answer.
 */
export async function rewriteQuery(
  question: string,
  history: ChatTurn[],
): Promise<{ query: string; model: string | null }> {
  if (history.length === 0) return { query: question, model: null };
  try {
    const transcript = history
      .slice(-HISTORY_TURNS)
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 1500)}`)
      .join('\n\n');
    const { text, model } = await generateText({
      system: REWRITE_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Conversation:\n${transcript}\n\nFollow-up question: ${question}\n\nStandalone search query:`,
        },
      ],
      maxOutputTokens: 300,
    });
    return { query: cleanRewrittenQuery(text, question), model };
  } catch (err) {
    console.warn(
      '[rag] query rewrite failed, using the question as-is:',
      err instanceof Error ? err.message : err,
    );
    return { query: question, model: null };
  }
}

/** Rewrite → retrieve (repo's own embedding model via searchRepo) → re-score → context. */
export async function prepareAnswer(input: {
  repoId: string;
  repoFullName: string;
  question: string;
  history: ChatTurn[];
}): Promise<PreparedAnswer> {
  const { query, model: rewriteModel } = await rewriteQuery(input.question, input.history);
  // searchRepo picks the model, collection and commit of the repo's last successful job.
  const { hits, commitSha } = await searchRepo(input.repoId, query, CANDIDATE_POOL);
  const { blocks, sources } = buildContext(rankHits(query, hits));
  return {
    searchQuery: query,
    rewritten: query !== input.question,
    rewriteModel,
    commitSha,
    blocks,
    sources,
    system: systemPrompt(input.repoFullName, commitSha),
    messages: [
      ...input.history.slice(-HISTORY_TURNS),
      { role: 'user', content: answerUserTurn(input.question, blocks) },
    ],
  };
}

/**
 * The answer as events: primary model first; the OpenAI fallback takes over if the primary
 * fails before its first token, or mid-answer (then a `reset` event precedes the restart).
 */
export function streamAnswer(
  prepared: PreparedAnswer,
  signal?: AbortSignal,
): AsyncGenerator<AnswerEvent> {
  return resilientStream({
    system: prepared.system,
    messages: prepared.messages,
    maxOutputTokens: 4096,
    signal,
  });
}
