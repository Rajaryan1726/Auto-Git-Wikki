import { useQuery } from '@tanstack/react-query';
import { healthResponseSchema, type HealthResponse } from '@autowiki/shared';
import { ApiRequestError, apiFetch } from '../../lib/api';

async function fetchHealth(): Promise<HealthResponse> {
  try {
    return healthResponseSchema.parse(await apiFetch<unknown>('/api/health'));
  } catch (err) {
    // The endpoint returns 503 with a full body when a dependency is down.
    if (err instanceof ApiRequestError && err.status === 503) {
      const parsed = healthResponseSchema.safeParse(err.body);
      if (parsed.success) return parsed.data;
    }
    throw err;
  }
}

export function useHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: fetchHealth,
    refetchInterval: 15_000,
    retry: false,
  });
}
