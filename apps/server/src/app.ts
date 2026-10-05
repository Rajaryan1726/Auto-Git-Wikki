import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { env } from './lib/env.js';
import { httpLogger } from './lib/logger.js';
import { authRouter } from './routes/auth.js';
import { accountRouter } from './routes/account.js';
import { repoThreadsRouter, threadsRouter } from './routes/chat.js';
import { healthRouter } from './routes/health.js';
import { indexJobsRouter, repoIndexRouter } from './routes/index-jobs.js';
import { reposRouter } from './routes/repos.js';
import { repoWikiRouter } from './routes/wiki.js';
import { meRouter, memoriesRouter } from './routes/memories.js';
import { inngestHandler } from './inngest/index.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

/** JSON bodies of the app's own endpoints are small (largest: a 4,000-character question). */
const API_JSON_LIMIT = '100kb';
/** Inngest step state can be large. */
const INNGEST_JSON_LIMIT = '10mb';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  // Behind a proxy in production, so req.ip (used by the auth rate limit) is the client.
  if (env.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use(httpLogger);
  // JSON API only: no HTML is served, so a strict CSP costs nothing.
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  // Only the web app's origin may call the API with cookies.
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));

  // Inngest has its own, larger body limit and is mounted before the API parser.
  app.use('/api/inngest', express.json({ limit: INNGEST_JSON_LIMIT }), inngestHandler);

  app.use(express.json({ limit: API_JSON_LIMIT }));
  app.use(cookieParser());

  app.use('/api/health', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/repos', repoIndexRouter);
  app.use('/api/repos', reposRouter);
  app.use('/api/index-jobs', indexJobsRouter);
  app.use('/api/repos', repoThreadsRouter);
  app.use('/api/repos', repoWikiRouter);
  app.use('/api/memories', memoriesRouter);
  app.use('/api/me', meRouter);
  app.use('/api/me', accountRouter);
  app.use('/api/threads', threadsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
