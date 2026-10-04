import { serve } from 'inngest/express';
import type { RequestHandler } from 'express';
import { inngest } from './client.js';
import { hello } from './functions/hello.js';

export const functions = [hello];

export const inngestHandler: RequestHandler = serve({ client: inngest, functions });
