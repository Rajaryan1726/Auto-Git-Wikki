import { Router } from 'express';
import { z } from 'zod';
import {
  userSettingsBodySchema,
  type MemoryListResponse,
  type UserSettingsResponse,
} from '@autowiki/shared';
import { HttpError } from '../lib/http-error.js';
import { currentUser, requireAuth } from '../middleware/require-auth.js';
import {
  deleteAllMemories,
  deleteMemory,
  isMemoryEnabled,
  listMemories,
  setMemoryEnabled,
} from '../services/memory.js';

function unavailable(err: unknown): HttpError {
  console.error('[memory] engine error:', err instanceof Error ? err.message : err);
  return new HttpError(503, 'MEMORY_UNAVAILABLE', 'The memory service is unavailable right now.');
}

/** /api/memories — what AutoWiki remembers about the signed-in user. */
export const memoriesRouter = Router();
memoriesRouter.use(requireAuth);

memoriesRouter.get('/', async (req, res) => {
  const userId = currentUser(req).id;
  const enabled = await isMemoryEnabled(userId);
  let memories;
  try {
    memories = await listMemories(userId);
  } catch (err) {
    throw unavailable(err);
  }
  const body: MemoryListResponse = { enabled, memories };
  res.json(body);
});

/** Forget everything (all memories and their history, archived ones included). */
memoriesRouter.delete('/', async (req, res) => {
  try {
    await deleteAllMemories(currentUser(req).id);
  } catch (err) {
    throw unavailable(err);
  }
  res.status(204).end();
});

memoriesRouter.delete('/:id', async (req, res) => {
  const id = z.uuid().safeParse(req.params.id);
  let deleted = false;
  if (id.success) {
    try {
      deleted = await deleteMemory(currentUser(req).id, id.data);
    } catch (err) {
      throw unavailable(err);
    }
  }
  if (!deleted) throw new HttpError(404, 'MEMORY_NOT_FOUND', 'Memory not found');
  res.status(204).end();
});

/** /api/me — the signed-in user's settings. */
export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get('/settings', async (req, res) => {
  const body: UserSettingsResponse = {
    settings: { memoryEnabled: await isMemoryEnabled(currentUser(req).id) },
  };
  res.json(body);
});

meRouter.patch('/settings', async (req, res) => {
  const { memoryEnabled } = userSettingsBodySchema.parse(req.body);
  const userId = currentUser(req).id;
  await setMemoryEnabled(userId, memoryEnabled);
  const body: UserSettingsResponse = { settings: { memoryEnabled } };
  res.json(body);
});
