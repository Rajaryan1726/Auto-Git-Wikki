import { NonRetriableError } from 'inngest';
import { and, asc, eq, lte } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { chatMessages, chatThreads } from '../../db/schema.js';
import { rememberTurn } from '../../services/memory.js';
import { inngest } from '../client.js';

export const CHAT_TURN_COMPLETED_EVENT = 'chat/turn.completed';
export type ChatTurnCompletedData = { userId: string; threadId: string; messageId: string };
const eventDataSchema = z.object({ userId: z.uuid(), threadId: z.uuid(), messageId: z.uuid() });

/**
 * The messages of a finished turn: the thread up to and including the answered message,
 * only if the thread belongs to the user. rememberTurn keeps just the user's own words.
 */
async function loadTurn(data: ChatTurnCompletedData) {
  const [answer] = await db
    .select({ createdAt: chatMessages.createdAt, userId: chatThreads.userId })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
    .where(and(eq(chatMessages.id, data.messageId), eq(chatMessages.threadId, data.threadId)))
    .limit(1);
  if (!answer || answer.userId !== data.userId) return null;
  return db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(eq(chatMessages.threadId, data.threadId), lte(chatMessages.createdAt, answer.createdAt)),
    )
    .orderBy(asc(chatMessages.createdAt));
}

/**
 * Learns about the user after an answer finished: extract → decide (ADD / UPDATE /
 * DELETE / NOOP) → apply, in the background. One run per user at a time so two turns
 * cannot both add the same fact. Only counts are returned/logged, never message text.
 */
export const rememberChatTurn = inngest.createFunction(
  {
    id: 'remember-chat-turn',
    triggers: [{ event: CHAT_TURN_COMPLETED_EVENT }],
    retries: 2,
    concurrency: [{ key: 'event.data.userId', limit: 1 }],
  },
  async ({ event, step }) => {
    const parsed = eventDataSchema.safeParse(event.data);
    if (!parsed.success) throw new NonRetriableError('Invalid chat turn event payload.');
    return step.run('remember-turn', async () => {
      const thread = await loadTurn(parsed.data);
      if (!thread) return { status: 'skipped', reason: 'message not found for this user' };
      const result = await rememberTurn({
        userId: parsed.data.userId,
        thread,
        metadata: { threadId: parsed.data.threadId, sessionId: parsed.data.threadId },
      });
      console.log(
        `[memory] user ${parsed.data.userId} turn ${parsed.data.messageId}: ${result.status}` +
          ('events' in result ? ` ${JSON.stringify(result.events)}` : ''),
      );
      return result;
    });
  },
);
