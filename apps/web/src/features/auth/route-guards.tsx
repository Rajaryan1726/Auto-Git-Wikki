import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
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
  const { user, isLoading, error } = useAuth();
  const location = useLocation();
  if (isLoading) return <FullPageSpinner />;
  if (!user && error) return <AuthUnavailable message={error.message} />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

/** Keeps signed-in users away from /login. */
export function RedirectIfAuthed() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <FullPageSpinner />;
  if (user) return <Navigate to="/" replace />;
  return <Outlet />;
}
