import { Link, Outlet } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { useAuth } from '../features/auth/auth-context';
import { AppLayout } from './app-layout';
import { SiteFooter } from './site-footer';
import { ThemeToggle } from './theme-toggle';

/** Header + footer for visitors who are not signed in (pricing and policy pages). */
function VisitorLayout() {
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-6 md:px-8">
      <header className="mb-8 flex items-center justify-between gap-4">
        <Link to="/pricing" className="flex min-h-11 items-center gap-2 rounded-md">
          <span className="flex h-8 w-8 items-center justify-center rounded-sm bg-accent font-heading text-base font-bold text-on-accent">
            A
          </span>
          <span className="font-heading text-lg font-semibold">AutoWiki</span>
        </Link>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Link
            to="/login"
            className="inline-flex min-h-11 items-center rounded-md border border-border bg-raised px-4 text-sm font-medium hover:bg-soft"
          >
            Sign in
          </Link>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <SiteFooter />
    </div>
  );
}

/** Public pages: inside the app layout when signed in, a simple layout otherwise. */
export function PublicLayout() {
  const { user, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted" role="status">
        <LoaderCircle size={24} className="animate-spin" aria-hidden />
        <span className="sr-only">Loading</span>
      </div>
    );
  }
  return user ? <AppLayout /> : <VisitorLayout />;
}
