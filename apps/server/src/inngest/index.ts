import { serve } from 'inngest/express';
import type { RequestHandler } from 'express';
import { inngest } from './client.js';
import { indexRepo } from './functions/index-repo.js';
import { retireReplacedSubscriptionFn } from './functions/billing.js';
import { rememberChatTurn } from './functions/memory.js';
import { regenerateWiki } from './functions/wiki.js';

export const functions = [
  indexRepo,
  regenerateWiki,
  rememberChatTurn,
  retireReplacedSubscriptionFn,
];

export const inngestHandler: RequestHandler = serve({ client: inngest, functions });
