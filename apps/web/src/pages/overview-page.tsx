import { Link } from 'react-router-dom';
import { CircleAlert, FolderGit2, Gauge, RefreshCw, TriangleAlert } from 'lucide-react';
import type { RepoSummary } from '@autowiki/shared';
import { HealthStatus } from '../components/health-status';
import { PageHeader } from '../components/page-header';
import { RefetchErrorBanner } from '../components/refetch-error';
import { useUsage } from '../features/account/api';
import { useRepos } from '../features/repos/api';
import { buttonClass } from '../lib/ui';

function Stat({ label, value, to }: { label: string; value: number; to?: string }) {
  const body = (
    <>
      <p className="font-heading text-3xl font-semibold">{value}</p>
      <p className="mt-1 text-sm text-muted">{label}</p>
    </>
  );
  return to ? (
    <Link
      to={to}
      className="rounded-lg border border-border bg-surface p-5 transition-colors hover:border-accent-text/40 hover:bg-raised"
    >
      {body}
    </Link>
  ) : (
    <div className="rounded-lg border border-border bg-surface p-5">{body}</div>
  );
}

function RepoStats({ repos }: { repos: RepoSummary[] }) {
  const indexed = repos.filter((r) => r.status.commitSha !== null);
  const stale = indexed.filter((r) => r.status.stale);
  const indexing = repos.filter((r) => r.status.state === 'indexing');
  const failed = repos.filter((r) => r.status.state === 'failed');
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Repositories" value={repos.length} to="/" />
        <Stat label="Indexed" value={indexed.length} to="/?filter=indexed" />
        <Stat label="Indexing now" value={indexing.length} />
        <Stat label="Code changed since index" value={stale.length} />
      </div>
      {(stale.length > 0 || failed.length > 0) && (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {[
            ...failed.map((r) => ['failed', r] as const),
            ...stale.map((r) => ['stale', r] as const),
          ].map(([kind, r]) => (
            <li key={`${kind}-${r.id}`}>
              <Link
                to={`/repos/${r.id}`}
                className="flex min-h-12 items-center gap-3 px-4 py-2 text-sm hover:bg-raised"
              >
                {kind === 'failed' ? (
                  <CircleAlert size={16} className="shrink-0 text-danger" aria-hidden />
                ) : (
                  <TriangleAlert size={16} className="shrink-0 text-warning" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate font-mono">{r.fullName}</span>
                <span className="shrink-0 text-xs text-muted">
                  {kind === 'failed' ? 'Index failed' : 'Code changed since last index'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function UsageCard() {
  const usage = useUsage();
  const t = usage.data?.tokens;
  const pct = t ? Math.min(100, Math.round((t.used / t.budget) * 100)) : 0;
  return (
    <section
      aria-labelledby="usage-card-title"
      className="rounded-lg border border-border bg-surface p-5"
    >
      <h2 id="usage-card-title" className="flex items-center gap-2 font-semibold">
        <Gauge size={18} aria-hidden className="text-accent-text" />
        AI usage today
      </h2>
      {usage.isPending ? (
        <div
          className="mt-4 h-10 animate-pulse rounded bg-soft"
          role="status"
          aria-label="Loading usage"
        />
      ) : !t ? (
        <p role="alert" className="mt-3 text-sm text-danger">
          Could not load usage{usage.error ? `: ${usage.error.message}` : ''}.
        </p>
      ) : (
        <>
          <p className="mt-3 font-mono text-sm">
            {t.used.toLocaleString('en-US')} / {t.budget.toLocaleString('en-US')} tokens
          </p>
          <div
            role="progressbar"
            aria-label="AI tokens used today"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="mt-2 h-2 overflow-hidden rounded-full bg-soft"
          >
            <div
              className={`h-full rounded-full ${pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-accent'}`}
              style={{ width: `${pct}%` }}
            />
          </div>
          <Link
            to="/settings#usage"
            className="mt-3 inline-flex min-h-11 items-center text-sm text-accent-text hover:underline"
          >
            Usage details and limits
          </Link>
        </>
      )}
    </section>
  );
}

export function OverviewPage() {
  const repos = useRepos('', 'all');
  return (
    <>
      <PageHeader
        title="Overview"
        subtitle="Your repositories, AI usage and service health at a glance."
      />
      <RefetchErrorBanner query={repos} what="repositories" />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div>
          {repos.isPending ? (
            <div
              className="grid grid-cols-2 gap-3 sm:grid-cols-4"
              role="status"
              aria-label="Loading overview"
            >
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="h-24 animate-pulse rounded-lg bg-soft" />
              ))}
            </div>
          ) : repos.error && !repos.data ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-3 rounded-lg bg-danger-soft p-5 text-sm text-danger"
            >
              <p>Could not load your repositories: {repos.error.message}</p>
              <button
                type="button"
                onClick={() => void repos.refetch()}
                className={buttonClass.secondary}
              >
                <RefreshCw size={16} aria-hidden />
                Retry
              </button>
            </div>
          ) : repos.data!.repos.length === 0 ? (
            <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center text-sm text-muted">
              <FolderGit2 size={22} aria-hidden className="mb-3" />
              <p>No repositories yet. Sync them from GitHub on the Repositories page.</p>
              <Link to="/" className={`${buttonClass.primary} mt-4`}>
                Go to repositories
              </Link>
            </div>
          ) : (
            <RepoStats repos={repos.data!.repos} />
          )}
        </div>
        <div className="space-y-6">
          <UsageCard />
          <HealthStatus />
        </div>
      </div>
    </>
  );
}
