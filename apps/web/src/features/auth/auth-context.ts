import { createContext, useContext } from 'react';
import type { AuthUser } from '@autowiki/shared';

export const ME_QUERY_KEY = ['auth', 'me'] as const;

export type AuthContextValue = {
  user: AuthUser | null;
  isLoading: boolean;
  /** Network or server failure (not a 401). */
  error: Error | null;
  signInUrl: string;
  signOut: () => Promise<void>;
  isSigningOut: boolean;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
