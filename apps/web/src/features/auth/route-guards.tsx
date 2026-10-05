import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { ApiRequestError } from '../../lib/api';
import { useAuth } from './auth-context';

function FullPageSpinner() {
  return (
    <div className="flex min-h-screen items-center justify-center text-muted" role="status">
      <LoaderCircle size={24} className="animate-spin" aria-hidden />
      <span className="sr-only">Loading</span>
    </div>
  );
}

function AuthUnavailable({ message }: { message: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <p className="max-w-md rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">
        Could not reach the API server: {message}
      </p>
    </div>
  );
}

/** Renders child routes only for signed-in users; otherwise redirects to /login. */
export function RequireAuth() {
  const { user, isLoading, error, endReason } = useAuth();
  const location = useLocation();
  if (isLoading) return <FullPageSpinner />;
  // Revoked GitHub access is a session end, not an outage: the provider is signing out.
  const reauth = error instanceof ApiRequestError && error.code === 'GITHUB_REAUTH_REQUIRED';
  if (!user && error && !reauth && !endReason) return <AuthUnavailable message={error.message} />;
  if (!user && reauth && !endReason) return <FullPageSpinner />;
  if (!user) {
    const to = endReason ? `/login?error=${endReason}` : '/login';
    return <Navigate to={to} replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}

/** Keeps signed-in users away from /login. */
export function RedirectIfAuthed() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <FullPageSpinner />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}
