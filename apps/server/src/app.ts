import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './lib/env.js';
import { healthRouter } from './routes/health.js';
import { inngestHandler } from './inngest/index.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  // Inngest payloads can be large (step state), so allow more than the default 100kb.
  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  app.use('/api/health', healthRouter);
  app.use('/api/inngest', inngestHandler);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
