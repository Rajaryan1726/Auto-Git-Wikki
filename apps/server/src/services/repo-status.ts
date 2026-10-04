import type { RepoIndexStatus } from '@autowiki/shared';

export type JobRow = {
  status: 'queued' | 'running' | 'done' | 'failed';
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
  const done = lastIndexed?.status === 'done' ? lastIndexed : null;
  const base = {
    commitSha: done?.commitSha ?? null,
    lastIndexedAt: done?.finishedAt?.toISOString() ?? null,
  };

  if (latest && (latest.status === 'queued' || latest.status === 'running')) {
    const progress =
      latest.filesTotal > 0
        ? Math.min(100, Math.round((latest.filesDone / latest.filesTotal) * 100))
        : 0;
    return { state: 'indexing', progress, error: null, ...base };
  }
  if (latest?.status === 'failed') {
    return { state: 'failed', progress: null, error: latest.error, ...base };
  }
  if (done) return { state: 'indexed', progress: null, error: null, ...base };
  return { state: 'not_indexed', progress: null, error: null, ...base };
}
