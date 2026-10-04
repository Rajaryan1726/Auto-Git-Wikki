import { useRef, type KeyboardEvent } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  ChevronRight,
  ExternalLink,
  FileCode2,
  GitBranch,
  History,
  MessageSquare,
  RefreshCw,
  SearchX,
} from 'lucide-react';
import type { RepoSummary } from '@autowiki/shared';
import { useRepo } from '../features/repos/api';
import {
  IndexProgress,
  LanguageDot,
  StatusBadge,
  VisibilityPill,
} from '../features/repos/components';
import { repoUpdatedAt } from '../features/repos/format';
import { ApiRequestError } from '../lib/api';
import { relativeTime } from '../lib/time';
import { buttonClass } from '../lib/ui';

const TABS = [
  {
    id: 'wiki',
    label: 'Wiki',
    icon: BookOpen,
    empty: 'No wiki yet. Index this repository to generate its wiki.',
  },
  {
    id: 'files',
    label: 'Files',
    icon: FileCode2,
    empty: 'Indexed files will be listed here after the first index.',
  },
  {
    id: 'history',
    label: 'Index history',
    icon: History,
    empty: 'No index runs yet.',
  },
] as const;
type TabId = (typeof TABS)[number]['id'];

function Breadcrumb({ name }: { name?: string }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-4 text-sm text-muted">
      <ol className="flex flex-wrap items-center gap-1">
        <li>
          <Link to="/" className="text-accent-text hover:underline">
            Repositories
          </Link>
        </li>
        {name && (
          <li className="flex min-w-0 items-center gap-1" aria-current="page">
            <ChevronRight size={14} aria-hidden />
            <span className="font-mono [overflow-wrap:anywhere]">{name}</span>
          </li>
        )}
      </ol>
    </nav>
  );
}

function RepoHeader({ repo }: { repo: RepoSummary }) {
  const navigate = useNavigate();
  const indexed = repo.status.state === 'indexed' || repo.status.commitSha !== null;
  return (
    <section className="rounded-lg border border-border bg-surface p-5 md:p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex min-w-0 gap-4">
          <span
            aria-hidden
            className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-accent font-heading text-xl font-bold text-on-accent"
          >
            {repo.name.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <h1 className="font-mono text-xl font-semibold [overflow-wrap:anywhere] md:text-2xl">
              {repo.name}
            </h1>
            <p className="mt-0.5 font-mono text-xs text-muted [overflow-wrap:anywhere]">
              {repo.fullName}
            </p>
            <p className="mt-2 text-sm text-muted">
              {repo.description ?? <span className="italic">No description</span>}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
              <VisibilityPill isPrivate={repo.isPrivate} />
              <LanguageDot language={repo.language} />
              {repo.defaultBranch && (
                <span className="inline-flex items-center gap-1 font-mono">
                  <GitBranch size={13} aria-hidden />
                  {repo.defaultBranch}
                </span>
              )}
              <span>Updated {relativeTime(repoUpdatedAt(repo))}</span>
              <a
                href={repo.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent-text hover:underline"
              >
                View on GitHub
                <ExternalLink size={12} aria-hidden />
              </a>
              <StatusBadge status={repo.status} showCommit />
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {/* Indexing is wired up in Phase 3. */}
          <button
            type="button"
            disabled
            title="Indexing is not available yet"
            className={buttonClass.secondary}
          >
            <RefreshCw size={16} aria-hidden />
            {indexed ? 'Re-index' : 'Index'}
          </button>
          <button
            type="button"
            onClick={() => navigate(`/chat?repo=${repo.id}`)}
            className={buttonClass.primary}
          >
            <MessageSquare size={16} aria-hidden />
            Chat with repo
          </button>
        </div>
      </div>
      {repo.status.state === 'indexing' && (
        <div className="mt-5">
          <IndexProgress progress={repo.status.progress ?? 0} />
        </div>
      )}
    </section>
  );
}

function RepoTabs() {
  const [params, setParams] = useSearchParams();
  const active: TabId = TABS.some((t) => t.id === params.get('tab'))
    ? (params.get('tab') as TabId)
    : 'wiki';
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (id: TabId, focus = false) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id === 'wiki') next.delete('tab');
        else next.set('tab', id);
        return next;
      },
      { replace: true },
    );
    if (focus) tabRefs.current[id]?.focus();
  };

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === active);
    const moves: Record<string, number> = {
      ArrowRight: (i + 1) % TABS.length,
      ArrowLeft: (i - 1 + TABS.length) % TABS.length,
      Home: 0,
      End: TABS.length - 1,
    };
    const target = moves[e.key];
    if (target === undefined) return;
    e.preventDefault();
    select(TABS[target]!.id, true);
  };

  const tab = TABS.find((t) => t.id === active)!;

  return (
    <section className="mt-6">
      <div
        role="tablist"
        aria-label="Repository sections"
        onKeyDown={onKeyDown}
        className="flex gap-1 overflow-x-auto shadow-[inset_0_-1px_0_var(--border)]"
      >
        {TABS.map(({ id, label, icon: Icon }) => {
          const selected = id === active;
          return (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[id] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${id}`}
              aria-selected={selected}
              aria-controls={`panel-${id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(id)}
              className={`inline-flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-4 text-sm font-medium transition-colors ${
                selected
                  ? 'border-accent-text text-accent-text'
                  : 'border-transparent text-muted hover:text-text'
              }`}
            >
              <Icon size={16} aria-hidden />
              {label}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`panel-${tab.id}`}
        aria-labelledby={`tab-${tab.id}`}
        tabIndex={0}
        className="mt-4 rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center text-sm text-muted"
      >
        <tab.icon size={22} aria-hidden className="mx-auto mb-3" />
        {tab.empty}
      </div>
    </section>
  );
}

function HeaderSkeleton() {
  return (
    <div
      className="rounded-lg border border-border bg-surface p-6"
      role="status"
      aria-label="Loading repository"
    >
      <div className="flex gap-4">
        <div className="h-12 w-12 animate-pulse rounded-md bg-soft" />
        <div className="flex-1 space-y-3">
          <div className="h-5 w-1/3 animate-pulse rounded bg-soft" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-soft" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-soft" />
        </div>
      </div>
    </div>
  );
}

export function RepoPage() {
  const { id } = useParams<{ id: string }>();
  const repo = useRepo(id);

  if (repo.isPending) {
    return (
      <>
        <Breadcrumb />
        <HeaderSkeleton />
      </>
    );
  }

  if (repo.error) {
    const notFound = repo.error instanceof ApiRequestError && repo.error.status === 404;
    return (
      <>
        <Breadcrumb />
        <div
          role="alert"
          className="flex flex-col items-center rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center"
        >
          <SearchX size={24} aria-hidden className="mb-3 text-muted" />
          <h1 className="text-lg font-semibold">
            {notFound ? 'Repository not found' : 'Could not load repository'}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {notFound
              ? 'It may have been removed from GitHub, or it belongs to another account.'
              : repo.error.message}
          </p>
          <Link to="/" className={`${buttonClass.secondary} mt-4`}>
            Back to repositories
          </Link>
        </div>
      </>
    );
  }

  return (
    <>
      <Breadcrumb name={repo.data.name} />
      <RepoHeader repo={repo.data} />
      <RepoTabs />
    </>
  );
}
