import { useSearchParams } from 'react-router-dom';
import { CircleAlert } from 'lucide-react';
import type { LoginErrorCode } from '@autowiki/shared';
import { ThemeToggle } from '../components/theme-toggle';
import { useAuth } from '../features/auth/auth-context';

const ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  access_denied: 'You cancelled the GitHub authorization. Sign in again when you are ready.',
  invalid_state: 'Your sign-in link expired or was invalid. Please try again.',
  oauth_failed: 'GitHub sign-in failed. Please try again.',
  not_configured: 'GitHub sign-in is not configured on the server.',
  session_expired: 'Your session expired or GitHub access was revoked. Sign in again to continue.',
};

function errorMessage(code: string | null): string | null {
  if (!code) return null;
  return code in ERROR_MESSAGES
    ? ERROR_MESSAGES[code as LoginErrorCode]
    : ERROR_MESSAGES.oauth_failed;
}

function GithubMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden fill="currentColor">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

export function LoginPage() {
  const { signInUrl } = useAuth();
  const [params] = useSearchParams();
  const message = errorMessage(params.get('error'));

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4 py-10">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <main className="w-full max-w-sm rounded-lg border border-border bg-surface p-8">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex h-10 w-10 items-center justify-center rounded-md bg-accent font-heading text-lg font-bold text-on-accent">
            A
          </span>
          <span className="font-heading text-xl font-semibold">AutoWiki</span>
        </div>
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="mt-2 text-muted">
          Turn any of your GitHub repositories into a living wiki you can chat with.
        </p>

        <div aria-live="polite">
          {message && (
            <p
              role="alert"
              className="mt-5 flex gap-2 rounded-md bg-danger-soft px-3 py-2.5 text-sm text-danger"
            >
              <CircleAlert size={18} className="mt-px shrink-0" aria-hidden />
              {message}
            </p>
          )}
        </div>

        <a
          href={signInUrl}
          className="mt-6 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 font-medium text-on-accent transition-opacity hover:opacity-90"
        >
          <GithubMark />
          Continue with GitHub
        </a>
        <p className="mt-4 text-xs text-muted">
          AutoWiki asks for read access to your profile and repositories, including private ones.
        </p>
      </main>
    </div>
  );
}
