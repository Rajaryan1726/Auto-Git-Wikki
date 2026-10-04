import { ThemeToggle } from '../components/theme-toggle';

export function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="absolute top-4 right-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm rounded-lg border border-border bg-surface p-8 text-center">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-md bg-accent font-heading text-xl font-bold text-on-accent">
          A
        </span>
        <h1 className="text-2xl font-semibold">Sign in to AutoWiki</h1>
        <p className="mt-2 text-sm text-muted">
          Generate wikis and chat with your GitHub repositories.
        </p>
        <button
          type="button"
          disabled
          className="mt-6 inline-flex min-h-11 w-full items-center justify-center rounded-md bg-accent px-4 font-medium text-on-accent disabled:opacity-60"
        >
          Continue with GitHub
        </button>
        <p className="mt-3 text-xs text-muted">GitHub sign-in is not available yet.</p>
      </div>
    </div>
  );
}
