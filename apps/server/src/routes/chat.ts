import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import {
  askBodySchema,
  createThreadBodySchema,
  formatSseEvent,
  type ChatStreamEvent,
} from '@autowiki/shared';
import { HttpError } from '../lib/http-error.js';
import { currentUser, requireAuth } from '../middleware/require-auth.js';
import {
  DEFAULT_THREAD_TITLE,
  createThread,
  deleteThread,
  getThreadForUser,
  insertMessage,
  listMessages,
  listThreads,
  serializeMessage,
  serializeThread,
  setThreadTitle,
  titleFromQuestion,
} from '../services/chat.js';
import { prepareAnswer, streamAnswer, HISTORY_TURNS } from '../services/rag.js';
import { aboutUserSection } from '../services/memory-context.js';
import { recallForQuestion } from '../services/memory.js';
import { inngest } from '../inngest/client.js';
import {
  CHAT_TURN_COMPLETED_EVENT,
  type ChatTurnCompletedData,
} from '../inngest/functions/memory.js';
import { getRepoForUser } from '../services/repos.js';

const idSchema = z.uuid();

function parseId(value: unknown): string | null {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function notIndexed(): HttpError {
  return new HttpError(
    409,
    'REPO_NOT_INDEXED',
    'This repository has not been indexed yet. Index it first, then chat with it.',
  );
}

/** The user's repo, and only if it has a successful (searchable) index. */
async function indexedRepo(req: Request, repoIdParam: unknown) {
  const id = parseId(repoIdParam);
  const repo = id ? await getRepoForUser(currentUser(req).id, id) : null;
  if (!repo) throw new HttpError(404, 'REPO_NOT_FOUND', 'Repository not found');
  if (!repo.status.commitSha) throw notIndexed();
  return repo;
}

async function ownedThread(req: Request) {
  const id = parseId(req.params.id);
  const row = id ? await getThreadForUser(currentUser(req).id, id) : null;
  if (!row) throw new HttpError(404, 'THREAD_NOT_FOUND', 'Chat thread not found');
  return row;
}

// ---------------------------------------------------------------- /api/repos/:id/threads

export const repoThreadsRouter = Router();
repoThreadsRouter.use(requireAuth);

repoThreadsRouter.post('/:id/threads', async (req, res) => {
  const repo = await indexedRepo(req, req.params.id);
  const body = createThreadBodySchema.parse(req.body ?? {});
  const thread = await createThread(currentUser(req).id, repo.id, body.title);
  res.status(201).json({ thread: serializeThread(thread) });
});

repoThreadsRouter.get('/:id/threads', async (req, res) => {
  const id = parseId(req.params.id);
  const repo = id ? await getRepoForUser(currentUser(req).id, id) : null;
  if (!repo) throw new HttpError(404, 'REPO_NOT_FOUND', 'Repository not found');
  const threads = await listThreads(currentUser(req).id, repo.id);
  res.json({ threads: threads.map(serializeThread) });
});

// ---------------------------------------------------------------- /api/threads

export const threadsRouter = Router();
threadsRouter.use(requireAuth);

threadsRouter.get('/:id/messages', async (req, res) => {
  const { thread } = await ownedThread(req);
  const messages = await listMessages(thread.id);
  res.json({ thread: serializeThread(thread), messages: messages.map(serializeMessage) });
});

threadsRouter.delete('/:id', async (req, res) => {
  const { thread } = await ownedThread(req);
  await deleteThread(thread.id);
  res.status(204).end();
});

function send(res: Response, e: ChatStreamEvent): void {
  res.write(formatSseEvent(e.event, e.data));
}

/**
 * POST /api/threads/:id/ask  { question }  →  text/event-stream
 * Events: sources → token* → done | error. The user message is saved immediately; the
 * assistant message (text + sources + model) when the stream finishes, or with what was
 * generated so far if the client stops it.
 *
 * User memory: looked up in parallel with retrieval (hard timeout, never blocks the
 * answer), added as an "About the user" system-prompt section, and the finished turn is
 * sent to the background memory function (not for stopped or failed answers).
 */
threadsRouter.post('/:id/ask', async (req, res) => {
  const { thread, repo: threadRepo } = await ownedThread(req);
  const { question } = askBodySchema.parse(req.body);
  await indexedRepo(req, thread.repoId); // 409 before the stream opens

  const previous = await listMessages(thread.id);
  // Retry after an error: reuse the unanswered user message instead of duplicating it.
  const last = previous[previous.length - 1];
  const isRetry = last?.role === 'user' && last.content === question;
  const history = (isRetry ? previous.slice(0, -1) : previous)
    .slice(-HISTORY_TURNS)
    .map((m) => ({ role: m.role, content: m.content }));
  const userMessage = isRetry
    ? last
    : await insertMessage({ threadId: thread.id, role: 'user', content: question });
  if (thread.title === DEFAULT_THREAD_TITLE && !previous.some((m) => m.role === 'user')) {
    await setThreadTitle(thread.id, titleFromQuestion(question));
  }

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });

  let text = '';
  let model: string | null = null;
  let sources: Awaited<ReturnType<typeof prepareAnswer>>['sources'] = [];
  let commitSha: string | null = null;
  const userId = currentUser(req).id;
  try {
    const started = Date.now();
    let retrievalMs = 0;
    const preparing = prepareAnswer({
      repoId: thread.repoId,
      repoFullName: threadRepo.fullName,
      question,
      history,
    }).finally(() => (retrievalMs = Date.now() - started));
    // Memory runs alongside retrieval and may take at most MEMORY_RECALL_TIMEOUT_MS more.
    const [prepared, recall] = await Promise.all([
      preparing,
      recallForQuestion(userId, question, { after: preparing }),
    ]);
    // Time memory added on top of retrieval (they run in parallel).
    const memoryWaitMs = Math.max(0, Date.now() - started - retrievalMs);
    const memoryIds = recall.memories.map((m) => m.id);
    const aboutUser = aboutUserSection(recall.memories);
    if (aboutUser) prepared.system = `${prepared.system}\n\n${aboutUser}`;
    sources = prepared.sources;
    commitSha = prepared.commitSha;
    send(res, {
      event: 'sources',
      data: { sources, commitSha, userMessageId: userMessage.id },
    });

    const failed: string[] = [];
    for await (const e of streamAnswer(prepared, abort.signal)) {
      if (e.type === 'model') {
        model = e.model;
        failed.push(...e.skipped.map((m) => `${m} (breaker open)`));
        failed.push(...e.failures.map((f) => f.model));
      } else if (e.type === 'token') {
        text += e.text;
        send(res, { event: 'token', data: { text: e.text } });
      } else {
        // Primary failed mid-answer: the client clears its text, the fallback restarts.
        failed.push(e.failedModel);
        text = '';
        send(res, {
          event: 'reset',
          data: { reason: 'The model failed mid-answer; retrying with a fallback model.' },
        });
      }
    }

    const saved = await insertMessage({
      threadId: thread.id,
      role: 'assistant',
      content: text,
      sources,
      model,
      commitSha,
      memoryIds,
    });
    console.log(
      `[chat] thread ${thread.id}: answered by ${model}` +
        ` | memory: ${memoryIds.length} used, lookup ${recall.ms} ms (retrieval ${retrievalMs} ms, added ${memoryWaitMs} ms)` +
        (recall.error ? ` (skipped: ${recall.error})` : '') +
        (failed.length ? ` (fallback after ${failed.join(', ')})` : '') +
        ` | query: ${prepared.rewritten ? `rewritten -> "${prepared.searchQuery}"` : 'as asked'}` +
        ` | ${sources.length} sources`,
    );
    send(res, {
      event: 'done',
      data: { messageId: saved.id, model: model ?? 'unknown', memoryCount: memoryIds.length },
    });
    if (recall.enabled) {
      // Fire and forget: learning about the user never delays or affects the answer.
      const data: ChatTurnCompletedData = { userId, threadId: thread.id, messageId: saved.id };
      inngest.send({ name: CHAT_TURN_COMPLETED_EVENT, data }).catch((err: unknown) => {
        console.warn(
          '[memory] could not enqueue the turn:',
          err instanceof Error ? err.message : 'unknown error',
        );
      });
    }
  } catch (err) {
    if (abort.signal.aborted) {
      // Client pressed stop: keep what was generated so far.
      if (text.trim()) {
        await insertMessage({
          threadId: thread.id,
          role: 'assistant',
          content: `${text}\n\n_(stopped)_`,
          sources,
          model,
          commitSha,
        });
      }
      console.log(`[chat] thread ${thread.id}: stopped by the client`);
    } else {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[chat] thread ${thread.id}: answer failed: ${message}`);
      const code = err instanceof HttpError ? err.code : 'ANSWER_FAILED';
      send(res, {
        event: 'error',
        data: {
          code,
          message:
            err instanceof HttpError
              ? err.message
              : 'The answer could not be generated. Please try again.',
        },
      });
    }
  } finally {
    if (!res.writableEnded) res.end();
  }
});
