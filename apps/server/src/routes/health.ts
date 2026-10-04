import { Router } from 'express';
import type { HealthResponse, ServiceStatus } from '@autowiki/shared';
import { pingDatabase } from '../db/client.js';
import { pingQdrant } from '../services/qdrant.js';

const CHECK_TIMEOUT_MS = 3000;

async function check(fn: () => Promise<void>): Promise<ServiceStatus> {
  const start = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timed out')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return { status: 'ok', latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    return { status: 'error', message: err instanceof Error ? err.message : 'unknown error' };
  } finally {
    clearTimeout(timer);
  }
}

export const healthRouter = Router();

healthRouter.get('/', async (_req, res) => {
  const [database, qdrant] = await Promise.all([check(pingDatabase), check(pingQdrant)]);
  const allOk = database.status === 'ok' && qdrant.status === 'ok';
  const response: HealthResponse = {
    status: allOk ? 'ok' : 'degraded',
    services: { database, qdrant },
    timestamp: new Date().toISOString(),
  };
  res.status(allOk ? 200 : 503).json(response);
});
