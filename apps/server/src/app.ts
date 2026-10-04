import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './lib/env.js';
import { authRouter } from './routes/auth.js';
import { repoThreadsRouter, threadsRouter } from './routes/chat.js';
import { healthRouter } from './routes/health.js';
import { indexJobsRouter, repoIndexRouter } from './routes/index-jobs.js';
import { reposRouter } from './routes/repos.js';
import { repoWikiRouter } from './routes/wiki.js';
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
  app.use('/api/auth', authRouter);
  app.use('/api/repos', repoIndexRouter);
  app.use('/api/repos', reposRouter);
  app.use('/api/index-jobs', indexJobsRouter);
  app.use('/api/repos', repoThreadsRouter);
  app.use('/api/repos', repoWikiRouter);
  app.use('/api/threads', threadsRouter);
  app.use('/api/inngest', inngestHandler);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
