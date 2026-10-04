import { useCallback, useMemo, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { authUserSchema, type AuthUser } from '@autowiki/shared';
import { API_URL, ApiRequestError, apiFetch } from '../../lib/api';
import { AuthContext, ME_QUERY_KEY, type AuthContextValue } from './auth-context';

const meResponseSchema = z.object({ user: authUserSchema });

async function fetchMe(): Promise<AuthUser | null> {
  try {
    return meResponseSchema.parse(await apiFetch<unknown>('/api/auth/me')).user;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 401) return null;
    throw err;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const me = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    staleTime: 5 * 60 * 1000,
    retry: (count, err) => !(err instanceof ApiRequestError) && count < 2,
  });

  const logout = useMutation({
    mutationFn: () => apiFetch<void>('/api/auth/logout', { method: 'POST' }),
    onSettled: () => {
      // Drop every cached query so nothing from the previous user survives.
      queryClient.clear();
      queryClient.setQueryData(ME_QUERY_KEY, null);
    },
  });

  const signOut = useCallback(async () => {
    await logout.mutateAsync().catch(() => undefined);
  }, [logout]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: me.data ?? null,
      isLoading: me.isPending,
      error: me.error,
      signInUrl: `${API_URL}/api/auth/github`,
      signOut,
      isSigningOut: logout.isPending,
    }),
    [me.data, me.isPending, me.error, signOut, logout.isPending],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
