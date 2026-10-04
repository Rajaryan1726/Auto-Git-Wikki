import { env } from './lib/env.js';
import { createApp } from './app.js';
import { pool } from './db/client.js';
import { codeCollectionName, ensureCodeCollection } from './services/qdrant.js';

async function main(): Promise<void> {
  try {
    await ensureCodeCollection();
  } catch (err) {
    // Keep serving so /api/health can report the problem; retry happens on next restart.
    console.error(
      `[qdrant] could not ensure collection ${codeCollectionName}:`,
      err instanceof Error ? err.message : err,
    );
  }

  const server = createApp().listen(env.PORT, () => {
    console.log(`[server] listening on http://localhost:${env.PORT}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[server] ${signal} received, shutting down`);
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
