import { and, asc, desc, eq } from 'drizzle-orm';
import type { ChatMessage, ChatSource, ChatThread } from '@autowiki/shared';
import { db } from '../db/client.js';
import { chatMessages, chatThreads, repositories } from '../db/schema.js';

export const DEFAULT_THREAD_TITLE = 'New chat';

type ThreadRow = typeof chatThreads.$inferSelect;
type MessageRow = typeof chatMessages.$inferSelect;

export function serializeThread(t: ThreadRow): ChatThread {
  return {
    id: t.id,
    repoId: t.repoId,
    title: t.title,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export function serializeMessage(m: MessageRow): ChatMessage {
  return {
    id: m.id,
    threadId: m.threadId,
    role: m.role,
    content: m.content,
    // Older rows may lack `n`; number them in stored order.
    sources: (m.sources as Partial<ChatSource>[]).map((s, i) => ({
      n: s.n ?? i + 1,
      path: s.path ?? '',
      startLine: s.startLine ?? 0,
      endLine: s.endLine ?? 0,
    })),
    model: m.model,
    commitSha: m.commitSha,
    createdAt: m.createdAt.toISOString(),
  };
}

/** Short title from the first question: one line, at most ~60 chars on a word boundary. */
export function titleFromQuestion(question: string): string {
  const line = question.replace(/\s+/g, ' ').trim();
  if (line.length <= 60) return line || DEFAULT_THREAD_TITLE;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(' ');
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export async function createThread(userId: string, repoId: string, title?: string) {
  const [row] = await db
    .insert(chatThreads)
    .values({ userId, repoId, title: title ?? DEFAULT_THREAD_TITLE })
    .returning();
  return row!;
}

export async function listThreads(userId: string, repoId: string) {
  return db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.userId, userId), eq(chatThreads.repoId, repoId)))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(100);
}

/** Thread plus its repo, only if the thread belongs to `userId`. */
export async function getThreadForUser(userId: string, threadId: string) {
  const [row] = await db
    .select({
      thread: chatThreads,
      repo: { id: repositories.id, fullName: repositories.fullName },
    })
    .from(chatThreads)
    .innerJoin(repositories, eq(repositories.id, chatThreads.repoId))
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function deleteThread(threadId: string): Promise<void> {
  await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
}

export async function listMessages(threadId: string) {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt));
}

export async function insertMessage(values: {
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: ChatSource[];
  model?: string | null;
  commitSha?: string | null;
}) {
  const [row] = await db
    .insert(chatMessages)
    .values({
      threadId: values.threadId,
      role: values.role,
      content: values.content,
      sources: values.sources ?? [],
      model: values.model ?? null,
      commitSha: values.commitSha ?? null,
    })
    .returning();
  await db
    .update(chatThreads)
    .set({ updatedAt: new Date() })
    .where(eq(chatThreads.id, values.threadId));
  return row!;
}

export async function setThreadTitle(threadId: string, title: string): Promise<void> {
  await db.update(chatThreads).set({ title }).where(eq(chatThreads.id, threadId));
}
