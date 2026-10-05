import { Router } from 'express';
import type { DeletionReport, UsageResponse } from '@autowiki/shared';
import { SESSION_COOKIE, clearOptions, sessionCookieOptions } from '../lib/cookies.js';
import { currentUser, requireAuth } from '../middleware/require-auth.js';
import { deleteAccount } from '../services/data-deletion.js';
import { getUsage } from '../services/usage.js';

/** /api/me — usage and account deletion (settings live in routes/memories.ts). */
export const accountRouter = Router();
accountRouter.use(requireAuth);

/** Today's AI tokens by feature vs the budget, and counts vs each limit. */
accountRouter.get('/usage', async (req, res) => {
  const body: UsageResponse = await getUsage(currentUser(req).id);
  res.json(body);
});

/** Deletes the account and everything about the user, then signs them out. */
accountRouter.delete('/', async (req, res) => {
  const report: DeletionReport = await deleteAccount(currentUser(req).id);
  res.clearCookie(SESSION_COOKIE, clearOptions(sessionCookieOptions));
  res.json(report);
});
