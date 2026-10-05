import { Link } from 'react-router-dom';
import { Globe, Lock, TriangleAlert } from 'lucide-react';
import type { RepoIndexStatus, RepoSummary } from '@autowiki/shared';
import { languageColor } from '../../lib/languages';
import { relativeTime } from '../../lib/time';
import { pillClass } from '../../lib/ui';
import { repoUpdatedAt, statusLabel } from './format';

export function VisibilityPill({ isPrivate }: { isPrivate: boolean }) {
  const Icon = isPrivate ? Lock : Globe;
  return (
    <span className={`${pillClass} shrink-0 gap-1 border-border text-muted`}>
      <Icon size={12} aria-hidden />
      {isPrivate ? 'Private' : 'Public'}
    </span>
  );
}

export function LanguageDot({ language }: { language: string | null }) {
  if (!language) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-border"
        style={{ backgroundColor: languageColor(language) }}
      />
      {language}
    </span>
  );
}

const STATUS_STYLES: Record<RepoIndexStatus['state'], string> = {
  indexed: 'border-transparent bg-success-soft text-success',
  indexing: 'border-transparent bg-warning-soft text-warning',
  not_indexed: 'border-transparent bg-soft text-muted',
  failed: 'border-transparent bg-danger-soft text-danger',
};

export function StatusBadge({
  status,
  showCommit = false,
}: {
  status: RepoIndexStatus;
  showCommit?: boolean;
}) {
  return (
    <span
      className={`${pillClass} shrink-0 gap-1.5 ${STATUS_STYLES[status.state]}`}
      title={status.state === 'failed' && status.error ? status.error : undefined}
    >
      {statusLabel(status)}
      {showCommit && status.commitSha && (
        <span className="font-mono opacity-80">· {status.commitSha.slice(0, 7)}</span>
      )}
    </span>
  );
}

export function IndexProgress({ progress }: { progress: number }) {
  return (
    <div
      role="progressbar"
      aria-label="Indexing progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progress}
      className="h-1.5 w-full overflow-hidden rounded-full bg-warning-soft"
    >
      <div className="h-full rounded-full bg-warning" style={{ width: `${progress}%` }} />
    </div>
  );
}

export function RepoCard({ repo }: { repo: RepoSummary }) {
  return (
    <Link
      to={`/repos/${repo.id}`}
      className="group flex h-full flex-col gap-3 rounded-lg border border-border bg-surface p-5 transition-colors hover:border-accent-text/40 hover:bg-raised"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 font-mono text-[15px] leading-snug font-medium [overflow-wrap:anywhere] group-hover:text-accent-text">
          {repo.name}
        </h2>
        <VisibilityPill isPrivate={repo.isPrivate} />
      </div>
      <p className="line-clamp-2 text-sm text-muted">
        {repo.description ?? <span className="italic">No description</span>}
      </p>
      <div className="mt-auto flex flex-col gap-3 pt-1">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <LanguageDot language={repo.language} />
            <span>Updated {relativeTime(repoUpdatedAt(repo))}</span>
          </div>
          <StatusBadge status={repo.status} />
        </div>
        {repo.status.state === 'indexing' && <IndexProgress progress={repo.status.progress ?? 0} />}
        {repo.status.stale && repo.status.state !== 'indexing' && (
          <p className="flex items-center gap-1.5 text-xs text-warning">
            <TriangleAlert size={13} aria-hidden className="shrink-0" />
            Code changed since last index
          </p>
        )}
      </div>
    </Link>
  );
}

export function RepoCardSkeleton() {
  return (
    <div
      className="flex h-40 flex-col gap-3 rounded-lg border border-border bg-surface p-5"
      aria-hidden
    >
      <div className="flex justify-between gap-3">
        <div className="h-4 w-2/5 animate-pulse rounded bg-soft" />
        <div className="h-4 w-14 animate-pulse rounded-full bg-soft" />
      </div>
      <div className="h-3 w-full animate-pulse rounded bg-soft" />
      <div className="h-3 w-3/4 animate-pulse rounded bg-soft" />
      <div className="mt-auto flex justify-between">
        <div className="h-3 w-1/3 animate-pulse rounded bg-soft" />
        <div className="h-4 w-20 animate-pulse rounded-full bg-soft" />
      </div>
    </div>
  );
}
