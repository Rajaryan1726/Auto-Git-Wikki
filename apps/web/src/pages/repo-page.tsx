import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  FileCode2,
  GitBranch,
  History,
  Info,
  LoaderCircle,
  MessageSquare,
  RefreshCw,
  SearchX,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import type { IndexJob, RepoSummary } from '@autowiki/shared';
import {
  isActiveJob,
  useIndexJob,
  useRefreshWhenJobEnds,
  useRepoIndexJobs,
  useStartIndex,
} from '../features/index-jobs/api';
import {
  IndexFailedPanel,
  IndexProgressPanel,
  JobDuration,
  JobStatusBadge,
} from '../features/index-jobs/components';
import { shortSha } from '../features/index-jobs/format';
import { useRepo } from '../features/repos/api';
import { LanguageDot, VisibilityPill } from '../features/repos/components';
import { repoUpdatedAt } from '../features/repos/format';
import { ApiRequestError } from '../lib/api';
import { relativeTime } from '../lib/time';
import { buttonClass } from '../lib/ui';
import { ConfirmDialog } from '../components/confirm-dialog';
import { RefetchErrorBanner } from '../components/refetch-error';
import { useToast } from '../components/toast-context';
import { useDeleteRepoData } from '../features/account/api';
import { FilesPanel } from '../features/repos/files-panel';
import { WikiPanel } from '../features/wiki/wiki-panel';

/** Everything the page needs to know about indexing, derived from repo + latest job. */
type IndexView = {
  job: IndexJob | undefined;
  /** An earlier index finished successfully (its data stays valid during a re-index). */
  hasIndex: boolean;
  active: boolean;
  failed: boolean;
  start: () => void;
  isStarting: boolean;
  startError: Error | null;
};

function useIndexView(repo: RepoSummary): IndexView {
  const job = useIndexJob(repo.status.latestJobId).data;
  useRefreshWhenJobEnds(job);
  const startIndex = useStartIndex(repo.id);
  const toast = useToast();
  const active = job ? isActiveJob(job) : repo.status.state === 'indexing';
  const failed = !active && (job ? job.status === 'failed' : repo.status.state === 'failed');
  return {
    job,
    // A just-finished job counts before the repo summary has been refetched (no flash).
    hasIndex: repo.status.commitSha !== null || job?.searchable === true,
    active,
    failed,
    start: () =>
      startIndex.mutate(undefined, {
        onSuccess: () => toast.info('Indexing started.'),
      }),
    isStarting: startIndex.isPending,
    startError: startIndex.error,
  };
}

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

function IndexButton({ view, label }: { view: IndexView; label: string }) {
  return (
    <button
      type="button"
      onClick={view.start}
      disabled={view.isStarting}
      className={buttonClass.primary}
    >
      {view.isStarting ? (
        <LoaderCircle size={16} className="animate-spin" aria-hidden />
      ) : (
        <Sparkles size={16} aria-hidden />
      )}
      {label}
    </button>
  );
}

/** Header buttons for each index state. */
function RepoActions({ repo, view }: { repo: RepoSummary; view: IndexView }) {
  const navigate = useNavigate();
  const chat = (
    <button
      type="button"
      onClick={() => navigate(`/chat?repo=${repo.id}`)}
      className={buttonClass.primary}
    >
      <MessageSquare size={16} aria-hidden />
      Chat with repo
    </button>
  );

  if (view.active) {
    return (
      <>
        <button type="button" disabled className={buttonClass.secondary}>
          <LoaderCircle size={16} className="animate-spin" aria-hidden />
          Indexing…
        </button>
        {view.hasIndex && chat}
      </>
    );
  }
  if (view.failed) return view.hasIndex ? chat : null; // Retry lives in the failure panel
  if (view.hasIndex) {
    return (
      <>
        <button
          type="button"
          onClick={view.start}
          disabled={view.isStarting}
          className={buttonClass.secondary}
        >
          <RefreshCw
            size={16}
            aria-hidden
            className={view.isStarting ? 'animate-spin' : undefined}
          />
          Re-index
        </button>
        {chat}
      </>
    );
  }
  return <IndexButton view={view} label="Index repository" />;
}

function IndexedLine({ repo, job }: { repo: RepoSummary; job: IndexJob | undefined }) {
  const fromJob = job?.searchable ? job : null;
  const sha = repo.status.commitSha ?? fromJob?.commitSha ?? null;
  const at = repo.status.lastIndexedAt ?? fromJob?.finishedAt ?? null;
  if (!sha) return null;
  return (
    <p className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-border pt-4 text-sm text-muted">
      <CircleCheck size={16} className="text-success" aria-hidden />
      <span className="font-medium text-success">Indexed</span>·
      <a
        href={`${repo.htmlUrl}/commit/${sha}`}
        target="_blank"
        rel="noreferrer"
        className="font-mono text-text hover:underline"
      >
        {shortSha(sha)}
      </a>
      {at && <>· {relativeTime(at)}</>}
    </p>
  );
}

/** Deletes vectors, wiki, chats and jobs of this repo, after a styled confirmation. */
function DeleteRepoData({ repo }: { repo: RepoSummary }) {
  const [open, setOpen] = useState(false);
  const del = useDeleteRepoData(repo.id);
  const toast = useToast();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`${buttonClass.ghost} text-danger hover:text-danger`}
      >
        <Trash2 size={16} aria-hidden />
        Delete repo data
      </button>
      <ConfirmDialog
        open={open}
        title={`Delete the data of ${repo.name}?`}
        confirmLabel="Delete repo data"
        busy={del.isPending}
        error={del.error?.message ?? null}
        onCancel={() => setOpen(false)}
        onConfirm={
          () =>
            // mutateAsync, not per-call callbacks: this button unmounts as soon as the repo has
            // no data left, and TanStack Query skips callbacks of unmounted observers.
            void del
              .mutateAsync()
              .then((report) => {
                setOpen(false);
                const b = report.before;
                toast.success(
                  `Deleted ${b.qdrantCodePoints ?? 0} vectors, ${b.wikiPages ?? 0} wiki pages, ` +
                    `${b.chatThreads ?? 0} chats and ${b.indexJobs ?? 0} index jobs.`,
                );
              })
              .catch(() => undefined) // shown in the dialog via del.error
        }
      >
        This removes the index (vectors), the wiki, every chat about this repository and its index
        history. The repository stays in your list and can be indexed again. Nothing on GitHub is
        changed.
      </ConfirmDialog>
    </>
  );
}

function RepoHeader({ repo, view }: { repo: RepoSummary; view: IndexView }) {
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
            </div>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <RepoActions repo={repo} view={view} />
          {!view.active && (view.hasIndex || view.job) && <DeleteRepoData repo={repo} />}
        </div>
      </div>
      {!view.active && !view.failed && <IndexedLine repo={repo} job={view.job} />}
      {repo.status.stale && !view.active && (
        <p
          role="status"
          className="mt-4 flex flex-wrap items-center gap-3 rounded-lg bg-warning-soft px-4 py-3 text-sm text-warning"
        >
          <TriangleAlert size={18} className="shrink-0" aria-hidden />
          <span className="flex-1">Code changed since last index.</span>
          <button
            type="button"
            onClick={view.start}
            disabled={view.isStarting}
            className={buttonClass.secondary}
          >
            <RefreshCw size={16} aria-hidden />
            Re-index
          </button>
        </p>
      )}
      {!view.hasIndex && !view.active && !view.failed && (
        <p className="mt-4 border-t border-border pt-4 text-sm text-muted">
          Not indexed yet. Index this repository to generate its wiki and chat with it.
        </p>
      )}
    </section>
  );
}

function IndexStatusArea({ view }: { view: IndexView }) {
  return (
    <>
      {view.startError && (
        <p
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <CircleAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
          {view.startError.message}
        </p>
      )}
      {view.active && view.hasIndex && (
        <p className="mt-4 flex items-start gap-2 rounded-lg border border-border bg-raised px-4 py-3 text-sm text-muted">
          <Info size={18} className="mt-0.5 shrink-0" aria-hidden />
          Re-indexing — answers use the previous version until it finishes.
        </p>
      )}
      {view.active && view.job && <IndexProgressPanel job={view.job} />}
      {view.failed && view.job && (
        <IndexFailedPanel job={view.job} onRetry={view.start} isRetrying={view.isStarting} />
      )}
    </>
  );
}

const TABS = [
  { id: 'wiki', label: 'Wiki', icon: BookOpen },
  { id: 'files', label: 'Files', icon: FileCode2 },
  { id: 'history', label: 'Index history', icon: History },
] as const;
type TabId = (typeof TABS)[number]['id'];

function EmptyPanel({ icon: Icon, children }: { icon: typeof BookOpen; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center text-sm text-muted">
      <Icon size={22} aria-hidden className="mb-3" />
      {children}
    </div>
  );
}

function HistoryPanel({ repo }: { repo: RepoSummary }) {
  const jobs = useRepoIndexJobs(repo.id);
  if (jobs.isPending) {
    return (
      <div className="space-y-2" role="status" aria-label="Loading index history">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-md bg-soft" />
        ))}
      </div>
    );
  }
  if (jobs.error) {
    return <EmptyPanel icon={CircleAlert}>Could not load history: {jobs.error.message}</EmptyPanel>;
  }
  if (jobs.data.length === 0) return <EmptyPanel icon={History}>No index runs yet.</EmptyPanel>;

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
      {jobs.data.map((job) => (
        <li
          key={job.id}
          className="grid gap-x-4 gap-y-1 px-4 py-3 text-sm sm:grid-cols-[7rem_1fr_auto] sm:items-center"
        >
          <span>
            <JobStatusBadge job={job} />
          </span>
          <div className="min-w-0">
            <p className="flex flex-wrap gap-x-3 text-muted">
              <span title={new Date(job.createdAt).toLocaleString()}>
                {relativeTime(job.createdAt)}
              </span>
              {job.commitSha && (
                <a
                  href={`${repo.htmlUrl}/commit/${job.commitSha}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-text hover:underline"
                >
                  {shortSha(job.commitSha)}
                </a>
              )}
              <span>
                {job.filesDone}/{job.filesTotal} files
              </span>
              {job.chunksTotal !== null ? (
                <span>
                  {job.embeddedChunks}/{job.chunksTotal} chunks embedded
                </span>
              ) : (
                job.status === 'done' && <span>no vectors</span>
              )}
            </p>
            {job.status === 'done' && !job.searchable && job.error && (
              <p className="mt-0.5 text-xs text-warning">{job.error}</p>
            )}
            {job.status === 'failed' && job.error && (
              <p className="mt-0.5 text-xs text-danger [overflow-wrap:anywhere]">
                {job.currentStepLabel && <>At “{job.currentStepLabel}”: </>}
                {job.error}
              </p>
            )}
          </div>
          <span className="text-xs text-muted sm:text-right">
            <JobDuration job={job} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function RepoTabs({ repo, view }: { repo: RepoSummary; view: IndexView }) {
  const [params] = useSearchParams();
  const { slug } = useParams<{ slug?: string }>();
  const navigate = useNavigate();
  const active: TabId = TABS.some((t) => t.id === params.get('tab'))
    ? (params.get('tab') as TabId)
    : 'wiki';
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (id: TabId, focus = false) => {
    // Wiki keeps its page (deep link /repos/:id/wiki/:slug); other tabs use ?tab=.
    const base = id === 'wiki' && slug ? `/repos/${repo.id}/wiki/${slug}` : `/repos/${repo.id}`;
    navigate(id === 'wiki' ? base : `${base}?tab=${id}`, { replace: true });
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
        id={`panel-${active}`}
        aria-labelledby={`tab-${active}`}
        tabIndex={0}
        className="mt-4"
      >
        {active === 'wiki' && <WikiPanel repo={repo} view={view} slug={slug} />}
        {active === 'files' && <FilesPanel repo={repo} hasIndex={view.hasIndex} />}
        {active === 'history' && <HistoryPanel repo={repo} />}
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

function RepoView({
  repo,
  query,
}: {
  repo: RepoSummary;
  query: Parameters<typeof RefetchErrorBanner>[0]['query'];
}) {
  const view = useIndexView(repo);
  return (
    <>
      <Breadcrumb name={repo.name} />
      <RefetchErrorBanner query={query} what="repository" />
      <RepoHeader repo={repo} view={view} />
      <IndexStatusArea view={view} />
      <RepoTabs repo={repo} view={view} />
    </>
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

  if (repo.error && !repo.data) {
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

  return <RepoView repo={repo.data!} query={repo} />;
}
