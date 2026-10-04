import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  repoDetailResponseSchema,
  repoListResponseSchema,
  repoSyncResponseSchema,
  type RepoFilter,
  type SyncSummary,
} from '@autowiki/shared';
import { apiFetch } from '../../lib/api';

export const reposKeys = {
  all: ['repos'] as const,
  list: (q: string, filter: RepoFilter) => ['repos', 'list', { q, filter }] as const,
  detail: (id: string) => ['repos', 'detail', id] as const,
};

// Outside the 'repos' prefix so invalidating repo lists does not reset it.
const LAST_SYNC_KEY = ['repo-sync', 'last'] as const;

function rememberSync(queryClient: QueryClient, summary: SyncSummary): void {
  queryClient.setQueryData(LAST_SYNC_KEY, summary);
}

/** Summary of the most recent sync in this session (manual or automatic first-login sync). */
export function useLastSyncSummary(): SyncSummary | null {
  const query = useQuery<SyncSummary | null>({
    queryKey: LAST_SYNC_KEY,
    queryFn: () => null,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return query.data ?? null;
}

export function useRepos(q: string, filter: RepoFilter) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: reposKeys.list(q, filter),
    queryFn: async () => {
      const params = new URLSearchParams({ filter });
      if (q) params.set('q', q);
      const data = repoListResponseSchema.parse(await apiFetch<unknown>(`/api/repos?${params}`));
      if (data.autoSync) rememberSync(queryClient, data.autoSync);
      return data;
    },
    placeholderData: keepPreviousData,
    retry: false,
  });
}

export function useRepo(id: string | undefined) {
  return useQuery({
    queryKey: reposKeys.detail(id ?? ''),
    queryFn: async () =>
      repoDetailResponseSchema.parse(await apiFetch<unknown>(`/api/repos/${id}`)).repo,
    enabled: Boolean(id),
    retry: false,
  });
}

export function useSyncRepos() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      repoSyncResponseSchema.parse(await apiFetch<unknown>('/api/repos/sync', { method: 'POST' })),
    onSuccess: ({ summary }) => {
      rememberSync(queryClient, summary);
      return queryClient.invalidateQueries({ queryKey: reposKeys.all });
    },
  });
}
