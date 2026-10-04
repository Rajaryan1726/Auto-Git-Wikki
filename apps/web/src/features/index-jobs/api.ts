import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  activeIndexJobsResponseSchema,
  indexJobListResponseSchema,
  indexJobResponseSchema,
  type IndexJob,
} from '@autowiki/shared';
import { apiFetch } from '../../lib/api';
import { reposKeys } from '../repos/api';
import { wikiKeys } from '../wiki/api';

/** Poll interval while a job is queued or running. */
export const ACTIVE_POLL_MS = 2500;

export const indexJobKeys = {
  all: ['index-jobs'] as const,
  detail: (id: string) => ['index-jobs', 'detail', id] as const,
  forRepo: (repoId: string) => ['index-jobs', 'repo', repoId] as const,
  active: ['index-jobs', 'active'] as const,
};

export function isActiveJob(job: Pick<IndexJob, 'status'> | null | undefined): boolean {
  return job?.status === 'queued' || job?.status === 'running';
}

/** One job; polls every few seconds while it is active and stops when it finishes. */
export function useIndexJob(jobId: string | null | undefined) {
  return useQuery({
    queryKey: indexJobKeys.detail(jobId ?? ''),
    queryFn: async () =>
      indexJobResponseSchema.parse(await apiFetch<unknown>(`/api/index-jobs/${jobId}`)).job,
    enabled: Boolean(jobId),
    refetchInterval: (query) => (isActiveJob(query.state.data) ? ACTIVE_POLL_MS : false),
    // Keep polling in a background tab so progress is current when the user returns.
    refetchIntervalInBackground: true,
    retry: false,
  });
}

export function useRepoIndexJobs(repoId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: indexJobKeys.forRepo(repoId ?? ''),
    queryFn: async () =>
      indexJobListResponseSchema.parse(await apiFetch<unknown>(`/api/repos/${repoId}/index-jobs`))
        .jobs,
    enabled: Boolean(repoId) && enabled,
    refetchInterval: (query) => (query.state.data?.some(isActiveJob) ? ACTIVE_POLL_MS : false),
  });
}

/** Every active job of the user (sidebar). Polls fast while something runs. */
export function useActiveIndexJobs() {
  return useQuery({
    queryKey: indexJobKeys.active,
    queryFn: async () =>
      activeIndexJobsResponseSchema.parse(await apiFetch<unknown>('/api/index-jobs/active')).jobs,
    // Fast while something runs (even in a background tab); slow, foreground-only when idle.
    refetchInterval: (query) =>
      query.state.data?.length ? ACTIVE_POLL_MS : document.hidden ? false : 20_000,
    refetchIntervalInBackground: true,
  });
}

function invalidateIndexing(queryClient: ReturnType<typeof useQueryClient>) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: reposKeys.all }),
    queryClient.invalidateQueries({ queryKey: indexJobKeys.all }),
    // A finished index also brings a new wiki.
    queryClient.invalidateQueries({ queryKey: wikiKeys.all }),
  ]);
}

export function useStartIndex(repoId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      indexJobResponseSchema.parse(
        await apiFetch<unknown>(`/api/repos/${repoId}/index`, { method: 'POST' }),
      ).job,
    onSuccess: (job) => {
      queryClient.setQueryData(indexJobKeys.detail(job.id), job);
      return invalidateIndexing(queryClient);
    },
  });
}

/** Refreshes repo status, lists and history once a watched job finishes. */
export function useRefreshWhenJobEnds(job: IndexJob | undefined) {
  const queryClient = useQueryClient();
  const wasActive = useRef(false);
  useEffect(() => {
    if (!job) return;
    const active = isActiveJob(job);
    if (wasActive.current && !active) void invalidateIndexing(queryClient);
    wasActive.current = active;
  }, [job, queryClient]);
}
