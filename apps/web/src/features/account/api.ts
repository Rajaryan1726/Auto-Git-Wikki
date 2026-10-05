import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  deletionReportSchema,
  repoFilesResponseSchema,
  usageResponseSchema,
} from '@autowiki/shared';
import { apiFetch } from '../../lib/api';
import { indexJobKeys } from '../index-jobs/api';
import { reposKeys } from '../repos/api';
import { wikiKeys } from '../wiki/api';

export const accountKeys = {
  usage: ['account', 'usage'] as const,
  files: (repoId: string) => ['repos', 'files', repoId] as const,
};

/** Today's AI tokens and counts vs the limits. */
export function useUsage() {
  return useQuery({
    queryKey: accountKeys.usage,
    queryFn: async () => usageResponseSchema.parse(await apiFetch<unknown>('/api/me/usage')),
    refetchInterval: 60_000,
  });
}

export function useRepoFiles(repoId: string, enabled: boolean) {
  return useQuery({
    queryKey: accountKeys.files(repoId),
    queryFn: async () =>
      repoFilesResponseSchema.parse(await apiFetch<unknown>(`/api/repos/${repoId}/files`)),
    enabled,
  });
}

/** Deletes vectors, wiki, chats and jobs of a repo (the repo stays, "Not indexed"). */
export function useDeleteRepoData(repoId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      deletionReportSchema.parse(
        await apiFetch<unknown>(`/api/repos/${repoId}/data`, { method: 'DELETE' }),
      ),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: reposKeys.all }),
        queryClient.invalidateQueries({ queryKey: indexJobKeys.all }),
        queryClient.invalidateQueries({ queryKey: wikiKeys.all }),
        queryClient.invalidateQueries({ queryKey: ['chat'] }),
        queryClient.invalidateQueries({ queryKey: accountKeys.usage }),
      ]),
  });
}

/** Deletes the account; the server clears the session. */
export function useDeleteAccount() {
  return useMutation({
    mutationFn: async () =>
      deletionReportSchema.parse(await apiFetch<unknown>('/api/me', { method: 'DELETE' })),
    onSuccess: () => {
      // Full reload: drops every cached query of the deleted account.
      window.location.assign('/login?notice=account_deleted');
    },
  });
}
