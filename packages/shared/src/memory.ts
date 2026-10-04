import { z } from 'zod';

export const memoryCategorySchema = z.enum([
  'identity',
  'progress',
  'weak_topic',
  'preference',
  'goal',
  'other',
]);
export type MemoryCategory = z.infer<typeof memoryCategorySchema>;

/** One thing AutoWiki remembers about the signed-in user (never about code). */
export const userMemorySchema = z.object({
  id: z.string(),
  text: z.string(),
  category: memoryCategorySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type UserMemory = z.infer<typeof userMemorySchema>;

export const memoryListResponseSchema = z.object({
  enabled: z.boolean(),
  memories: z.array(userMemorySchema),
});
export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;

export const userSettingsBodySchema = z.object({ memoryEnabled: z.boolean() });
export type UserSettingsBody = z.infer<typeof userSettingsBodySchema>;

export const userSettingsResponseSchema = z.object({
  settings: z.object({ memoryEnabled: z.boolean() }),
});
export type UserSettingsResponse = z.infer<typeof userSettingsResponseSchema>;
