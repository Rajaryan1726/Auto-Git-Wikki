import type { RepoIndexStatus } from '@autowiki/shared';
import { jobProgress } from './index-steps.js';

export type JobRow = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  currentStep: string | null;
  chunksTotal: number | null;
  embeddedChunks: number;
  wikiPagesTotal: number | null;
  wikiPagesDone: number;
  commitSha: string | null;
  filesTotal: number;
  filesDone: number;
  error: string | null;
  finishedAt: Date | null;
  startedAt: Date | null;
  createdAt: Date;
};

/**
 * "Code changed since last index": the repo was pushed to after the last successful
 * index started (that job resolved the commit at its start). Shared by the repo cards,
 * the repo page and the wiki tab.
 */
export function isStale(
  pushedAt: Date | null | undefined,
  indexedJob: Pick<JobRow, 'startedAt' | 'createdAt'> | null | undefined,
): boolean {
  if (!pushedAt || !indexedJob) return false;
  return pushedAt.getTime() > (indexedJob.startedAt ?? indexedJob.createdAt).getTime();
}

/**
 * Derives the badge state from the last successful job and the most recent job:
 * an active job wins, then a failed latest attempt, then the last successful index.
 */
export function deriveIndexStatus(
  lastIndexed: JobRow | null | undefined,
  latest: JobRow | null | undefined,
  pushedAt: Date | null = null,
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
    stale: isStale(pushedAt, done),
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
