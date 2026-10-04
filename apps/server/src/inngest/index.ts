import { serve } from 'inngest/express';
import type { RequestHandler } from 'express';
import { inngest } from './client.js';
import { hello } from './functions/hello.js';
import { indexRepo } from './functions/index-repo.js';

export const functions = [hello, indexRepo];

export const inngestHandler: RequestHandler = serve({ client: inngest, functions });
