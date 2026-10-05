import { env } from './lib/env.js';
import { createApp } from './app.js';
import { pool } from './db/client.js';
import { defaultCollectionName, ensureDefaultCollection } from './services/qdrant.js';
import { warmUpMemory } from './services/memory.js';

import { moduleLogger } from './lib/logger.js';

const log = moduleLogger('index');

async function main(): Promise<void> {
  try {
    await ensureDefaultCollection();
  } catch (err) {
    // Keep serving so /api/health can report the problem; retry happens on next restart.
    log.error(
      { err: err instanceof Error ? err.message : err },
      `[qdrant] could not ensure collection ${defaultCollectionName}`,
    );
  }

  // Not awaited: memory is best-effort and must never delay startup.
  void warmUpMemory();

  const server = createApp().listen(env.PORT, () => {
    log.info(`[server] listening on http://localhost:${env.PORT}`);
  });

  const shutdown = (signal: string) => {
    log.info(`[server] ${signal} received, shutting down`);
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
