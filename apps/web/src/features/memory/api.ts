import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  memoryListResponseSchema,
  userSettingsResponseSchema,
  type MemoryListResponse,
} from '@autowiki/shared';
import { apiFetch } from '../../lib/api';

export const memoryKeys = { list: ['memories'] as const };

export function useMemories() {
  return useQuery({
    queryKey: memoryKeys.list,
    queryFn: async () => memoryListResponseSchema.parse(await apiFetch<unknown>('/api/memories')),
  });
}

export function useSetMemoryEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (memoryEnabled: boolean) =>
      userSettingsResponseSchema.parse(
        await apiFetch<unknown>('/api/me/settings', { method: 'PATCH', body: { memoryEnabled } }),
      ).settings,
    onSuccess: (settings) =>
      queryClient.setQueryData<MemoryListResponse>(
        memoryKeys.list,
        (old) => old && { ...old, enabled: settings.memoryEnabled },
      ),
  });
}

export function useDeleteMemory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/memories/${id}`, { method: 'DELETE' }),
    onSuccess: (_d, id) =>
      queryClient.setQueryData<MemoryListResponse>(
        memoryKeys.list,
        (old) => old && { ...old, memories: old.memories.filter((m) => m.id !== id) },
      ),
  });
}

export function useForgetEverything() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiFetch<void>('/api/memories', { method: 'DELETE' }),
    onSuccess: () =>
      queryClient.setQueryData<MemoryListResponse>(
        memoryKeys.list,
        (old) => old && { ...old, memories: [] },
      ),
  });
}
