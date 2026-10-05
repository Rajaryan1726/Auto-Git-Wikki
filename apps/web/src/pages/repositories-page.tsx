import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CircleAlert, FolderGit2, RefreshCw, Search, SearchX } from 'lucide-react';
import { repoFilters, type RepoFilter } from '@autowiki/shared';
import { PageHeader } from '../components/page-header';
import { useLastSyncSummary, useRepos, useSyncRepos } from '../features/repos/api';
import { RepoCard, RepoCardSkeleton } from '../features/repos/components';
import { SyncNotice } from '../features/repos/sync-notice';
import { ApiRequestError } from '../lib/api';
import { relativeTime } from '../lib/time';
import { RefetchErrorBanner } from '../components/refetch-error';
import { buttonClass } from '../lib/ui';

const FILTER_LABELS: Record<RepoFilter, string> = {
  all: 'All',
  public: 'Public',
  private: 'Private',
  indexed: 'Indexed',
};

function parseFilter(value: string | null): RepoFilter {
  return repoFilters.includes(value as RepoFilter) ? (value as RepoFilter) : 'all';
}

/** Keeps the search box responsive while only hitting the API after typing pauses. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

function SyncButton({ onClick, isPending }: { onClick: () => void; isPending: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={isPending} className={buttonClass.primary}>
      <RefreshCw size={16} aria-hidden className={isPending ? 'animate-spin' : undefined} />
      {isPending ? 'Syncing…' : 'Sync from GitHub'}
    </button>
  );
}

function errorText(error: Error): { title: string; message: string } {
  if (error instanceof ApiRequestError && error.code === 'GITHUB_RATE_LIMITED') {
    return { title: 'GitHub rate limit reached', message: error.message };
  }
  if (error instanceof ApiRequestError && error.code === 'GITHUB_API_ERROR') {
    return { title: 'GitHub is not responding', message: error.message };
  }
  return { title: 'Could not load repositories', message: error.message };
}

function StateCard({
  icon: Icon,
  title,
  children,
  tone = 'neutral',
}: {
  icon: typeof FolderGit2;
  title: string;
  children: React.ReactNode;
  tone?: 'neutral' | 'danger';
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : undefined}
      className="flex flex-col items-center rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center"
    >
      <span
        className={`mb-4 flex h-12 w-12 items-center justify-center rounded-full ${
          tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-soft text-muted'
        }`}
      >
        <Icon size={22} aria-hidden />
      </span>
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-1 max-w-md text-sm text-muted">{children}</div>
    </div>
  );
}

export function RepositoriesPage() {
  const [params, setParams] = useSearchParams();
  const filter = parseFilter(params.get('filter'));
  const [search, setSearch] = useState(params.get('q') ?? '');
  const q = useDebounced(search.trim(), 250);

  // Mirror the debounced search into the URL so it survives reloads and back/forward.
  useEffect(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (q) next.set('q', q);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [q, setParams]);

  const setFilter = (value: RepoFilter) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === 'all') next.delete('filter');
        else next.set('filter', value);
        return next;
      },
      { replace: true },
    );

  const repos = useRepos(q, filter);
  const sync = useSyncRepos();
  const lastSync = useLastSyncSummary();
  const [dismissedSyncAt, setDismissedSyncAt] = useState<string | null>(null);
  const notice = lastSync && lastSync.syncedAt !== dismissedSyncAt ? lastSync : null;

  const runSync = () => sync.mutate();

  const list = repos.data?.repos ?? [];
  const isFiltered = Boolean(q) || filter !== 'all';

  return (
    <>
      <PageHeader
        title="Repositories"
        subtitle="Your GitHub repositories. Index one to generate its wiki and chat with it."
        actions={<SyncButton onClick={runSync} isPending={sync.isPending} />}
      />

      {notice && (
        <SyncNotice summary={notice} onDismiss={() => setDismissedSyncAt(notice.syncedAt)} />
      )}

      {sync.error && (
        <p
          role="alert"
          className="mb-6 flex items-start gap-2 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">Sync failed.</span> {errorText(sync.error).message}
          </span>
        </p>
      )}

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center">
        <label className="relative block flex-1 lg:max-w-sm">
          <span className="sr-only">Search repositories</span>
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repositories"
            maxLength={100}
            className="min-h-11 w-full rounded-md border border-border bg-raised py-2 pr-3 pl-9 text-sm placeholder:text-muted focus:border-accent-text focus:outline-none"
          />
        </label>
        <div role="group" aria-label="Filter repositories" className="flex flex-wrap gap-2">
          {repoFilters.map((value) => {
            const active = value === filter;
            return (
              <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(value)}
                className={`min-h-11 rounded-full border px-4 text-sm font-medium transition-colors ${
                  active
                    ? 'border-accent bg-accent text-on-accent'
                    : 'border-border bg-raised text-muted hover:bg-soft hover:text-text'
                }`}
              >
                {FILTER_LABELS[value]}
              </button>
            );
          })}
        </div>
      </div>

      {repos.data && (
        <p className="mb-4 text-sm text-muted" aria-live="polite">
          {list.length} repositor{list.length === 1 ? 'y' : 'ies'}
          {repos.data.lastSyncedAt && <> · Last synced {relativeTime(repos.data.lastSyncedAt)}</>}
        </p>
      )}

      <RefetchErrorBanner query={repos} what="repository list" />

      {repos.isPending ? (
        <div
          className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3"
          role="status"
          aria-label="Loading repositories"
        >
          {Array.from({ length: 6 }, (_, i) => (
            <RepoCardSkeleton key={i} />
          ))}
        </div>
      ) : repos.error && !repos.data ? (
        <StateCard icon={CircleAlert} title={errorText(repos.error).title} tone="danger">
          <p>{errorText(repos.error).message}</p>
          <button
            type="button"
            onClick={() => void repos.refetch()}
            disabled={repos.isFetching}
            className={`${buttonClass.secondary} mt-4`}
          >
            <RefreshCw
              size={16}
              aria-hidden
              className={repos.isFetching ? 'animate-spin' : undefined}
            />
            Try again
          </button>
        </StateCard>
      ) : list.length === 0 && filter === 'indexed' && !q ? (
        <StateCard icon={FolderGit2} title="No indexed repositories yet">
          <p>Open a repository and index it to generate its wiki.</p>
          <button
            type="button"
            onClick={() => setFilter('all')}
            className={`${buttonClass.secondary} mt-4`}
          >
            Show all repositories
          </button>
        </StateCard>
      ) : list.length === 0 && isFiltered ? (
        <StateCard icon={SearchX} title="No matching repositories">
          <p>Nothing matches your search and filter.</p>
          <button
            type="button"
            onClick={() => {
              setSearch('');
              setFilter('all');
            }}
            className={`${buttonClass.secondary} mt-4`}
          >
            Clear filters
          </button>
        </StateCard>
      ) : list.length === 0 ? (
        <StateCard icon={FolderGit2} title="No repositories yet">
          <p>We did not find any repositories on your GitHub account. Create one, then sync.</p>
          <div className="mt-4">
            <SyncButton onClick={runSync} isPending={sync.isPending} />
          </div>
        </StateCard>
      ) : (
        <ul
          className={`grid gap-4 sm:grid-cols-2 xl:grid-cols-3 ${repos.isFetching ? 'opacity-70' : ''}`}
        >
          {list.map((repo) => (
            <li key={repo.id}>
              <RepoCard repo={repo} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
