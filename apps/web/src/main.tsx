import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';
import { ThemeProvider } from './app/theme';
import { router } from './app/router';
import { ME_QUERY_KEY } from './features/auth/auth-context';
import { AuthProvider } from './features/auth/auth-provider';
import { ApiRequestError } from './lib/api';
import './styles/index.css';

// A 401 from any API call means the session is gone; clearing the user sends RequireAuth to /login.
function handleUnauthenticated(err: unknown): void {
  if (err instanceof ApiRequestError && err.status === 401) {
    queryClient.setQueryData(ME_QUERY_KEY, null);
  }
}

const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleUnauthenticated }),
  mutationCache: new MutationCache({ onError: handleUnauthenticated }),
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
