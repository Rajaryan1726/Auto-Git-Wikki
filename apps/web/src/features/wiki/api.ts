import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { wikiPageResponseSchema, wikiResponseSchema, type WikiResponse } from '@autowiki/shared';
import { apiFetch } from '../../lib/api';

export const wikiKeys = {
  all: ['wiki'] as const,
  tree: (repoId: string) => ['wiki', 'tree', repoId] as const,
  page: (repoId: string, slug: string) => ['wiki', 'page', repoId, slug] as const,
};

export function wikiPath(repoId: string, slug: string): string {
  return `/repos/${repoId}/wiki/${slug}`;
}

/** Page tree + generation state; polls while a generation is running. */
export function useWiki(repoId: string, enabled = true) {
  return useQuery({
    queryKey: wikiKeys.tree(repoId),
    queryFn: async () =>
      wikiResponseSchema.parse(await apiFetch<unknown>(`/api/repos/${repoId}/wiki`)),
    enabled,
    refetchInterval: (query) => (query.state.data?.wiki.state === 'generating' ? 2500 : false),
  });
}

export function useWikiPage(repoId: string, slug: string | null, generatedAt: string | null) {
  return useQuery({
    // generatedAt in the key: a regenerated wiki never shows a cached page of the old one.
    queryKey: [...wikiKeys.page(repoId, slug ?? ''), generatedAt],
    queryFn: async () =>
      wikiPageResponseSchema.parse(
        await apiFetch<unknown>(`/api/repos/${repoId}/wiki/${encodeURIComponent(slug ?? '')}`),
      ).page,
    enabled: Boolean(slug),
    retry: false,
  });
}

export function useRegenerateWiki(repoId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      wikiResponseSchema.parse(
        await apiFetch<unknown>(`/api/repos/${repoId}/wiki/regenerate`, { method: 'POST' }),
      ),
    onSuccess: (data: WikiResponse) => queryClient.setQueryData(wikiKeys.tree(repoId), data),
  });
}
