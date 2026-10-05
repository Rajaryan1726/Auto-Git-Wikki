import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { authUserSchema, type AuthUser, type LoginErrorCode } from '@autowiki/shared';
import { API_URL, ApiRequestError, apiFetch } from '../../lib/api';
import { AuthContext, ME_QUERY_KEY, type AuthContextValue } from './auth-context';

const meResponseSchema = z.object({ user: authUserSchema });

async function fetchMe(): Promise<AuthUser | null> {
  try {
    return meResponseSchema.parse(await apiFetch<unknown>('/api/auth/me')).user;
  } catch (err) {
    // No (valid) session: simply signed out. Revoked GitHub access is different: it is
    // rethrown so the session-end handler below explains it on the login page.
    if (
      err instanceof ApiRequestError &&
      err.status === 401 &&
      err.code !== 'GITHUB_REAUTH_REQUIRED'
    ) {
      return null;
    }
    throw err;
  }
}

/** Errors that mean the user must sign in again, wherever they come from. */
function sessionEndReason(err: unknown): LoginErrorCode | null {
  if (!(err instanceof ApiRequestError)) return null;
  if (err.code === 'GITHUB_REAUTH_REQUIRED') return 'session_expired';
  if (err.status === 401) return 'session_expired';
  return null;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [endReason, setEndReason] = useState<LoginErrorCode | null>(null);
  const ending = useRef(false);

  const me = useQuery({
    queryKey: ME_QUERY_KEY,
    queryFn: fetchMe,
    staleTime: 5 * 60 * 1000,
    retry: (count, err) => !(err instanceof ApiRequestError) && count < 2,
  });

  const clearSession = useCallback(() => {
    // Update the `me` query in place (queryClient.clear() would detach this provider's
    // observer, so the UI would never see the sign-out), then drop everything else so
    // nothing from the previous user survives.
    queryClient.setQueryData(ME_QUERY_KEY, null);
    queryClient.removeQueries({
      predicate: (query) => query.queryKey !== ME_QUERY_KEY && query.queryKey[0] !== 'auth',
    });
    queryClient.getMutationCache().clear();
  }, [queryClient]);

  const logout = useMutation({
    mutationFn: () => apiFetch<void>('/api/auth/logout', { method: 'POST' }),
    onSettled: clearSession,
  });

  const signOut = useCallback(async () => {
    setEndReason(null);
    await logout.mutateAsync().catch(() => undefined);
  }, [logout]);

  /** Server says the session (or the GitHub grant behind it) is gone: sign out and explain why. */
  const endSession = useCallback(
    async (reason: LoginErrorCode) => {
      if (ending.current) return;
      ending.current = true;
      setEndReason(reason);
      await apiFetch<void>('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
      clearSession();
      ending.current = false;
    },
    [clearSession],
  );

  // Watch every query and mutation for session-ending errors.
  useEffect(() => {
    const onError = (err: unknown) => {
      const reason = sessionEndReason(err);
      if (reason) void endSession(reason);
    };
    const unsubQueries = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    const unsubMutations = queryClient.getMutationCache().subscribe((event) => {
      if (event.type === 'updated' && event.action.type === 'error') onError(event.action.error);
    });
    return () => {
      unsubQueries();
      unsubMutations();
    };
  }, [queryClient, endSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: me.data ?? null,
      isLoading: me.isPending,
      error: me.error,
      // Only meaningful while signed out; a fresh sign-in makes it irrelevant.
      endReason: me.data ? null : endReason,
      signInUrl: `${API_URL}/api/auth/github`,
      signOut,
      isSigningOut: logout.isPending,
    }),
    [me.data, me.isPending, me.error, endReason, signOut, logout.isPending],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
