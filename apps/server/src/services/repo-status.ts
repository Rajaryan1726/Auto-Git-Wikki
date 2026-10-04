import type { RepoIndexStatus } from '@autowiki/shared';
import { jobProgress } from './index-steps.js';

export type JobRow = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  currentStep: string | null;
  chunksTotal: number | null;
  embeddedChunks: number;
  commitSha: string | null;
  filesTotal: number;
  filesDone: number;
  error: string | null;
  finishedAt: Date | null;
};

/**
 * Derives the badge state from the last successful job and the most recent job:
 * an active job wins, then a failed latest attempt, then the last successful index.
 */
export function deriveIndexStatus(
  lastIndexed: JobRow | null | undefined,
  latest: JobRow | null | undefined,
): RepoIndexStatus {
  // Legacy 3A jobs (chunks_total null) finished without vectors and never count.
  const done =
    lastIndexed?.status === 'done' && lastIndexed.chunksTotal !== null ? lastIndexed : null;
  const active = latest && (latest.status === 'queued' || latest.status === 'running');
  const base = {
    commitSha: done?.commitSha ?? null,
    lastIndexedAt: done?.finishedAt?.toISOString() ?? null,
    latestJobId: latest?.id ?? null,
    activeJobId: active ? latest.id : null,
  };

  if (active) {
    return { state: 'indexing', progress: jobProgress(latest), error: null, ...base };
  }
  if (latest?.status === 'failed') {
    return { state: 'failed', progress: null, error: latest.error, ...base };
  }
  if (done) return { state: 'indexed', progress: null, error: null, ...base };
  return { state: 'not_indexed', progress: null, error: null, ...base };
}
