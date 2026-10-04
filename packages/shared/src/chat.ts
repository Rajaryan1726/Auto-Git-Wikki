import { z } from 'zod';

export const chatThreadSchema = z.object({
  id: z.string(),
  repoId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChatThread = z.infer<typeof chatThreadSchema>;

export const chatSourceSchema = z.object({
  n: z.number(),
  path: z.string(),
  startLine: z.number(),
  endLine: z.number(),
});

export const chatMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  sources: z.array(chatSourceSchema),
  /** Assistant only: the model that answered. */
  model: z.string().nullable(),
  /** Assistant only: commit the sources point at. */
  commitSha: z.string().nullable(),
  createdAt: z.string(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;

export const createThreadBodySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

export const askBodySchema = z.object({
  question: z.string().trim().min(1, 'Ask a question').max(4000),
});
export type AskBody = z.infer<typeof askBodySchema>;

export const threadResponseSchema = z.object({ thread: chatThreadSchema });
export const threadListResponseSchema = z.object({ threads: z.array(chatThreadSchema) });
export const messageListResponseSchema = z.object({
  thread: chatThreadSchema,
  messages: z.array(chatMessageSchema),
});
export type MessageListResponse = z.infer<typeof messageListResponseSchema>;
