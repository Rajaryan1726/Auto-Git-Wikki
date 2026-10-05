import { useMemo, useState } from 'react';
import { CircleAlert, FileCode2, Search } from 'lucide-react';
import type { RepoSummary } from '@autowiki/shared';
import { RefetchErrorBanner } from '../../components/refetch-error';
import { useRepoFiles } from '../account/api';
import { shortSha } from '../index-jobs/format';

const MAX_SHOWN = 500;

/** Repo page "Files" tab: the files of the last successful index, linked to GitHub. */
export function FilesPanel({ repo, hasIndex }: { repo: RepoSummary; hasIndex: boolean }) {
  const files = useRepoFiles(repo.id, hasIndex);
  const [q, setQ] = useState('');
  const shown = useMemo(() => {
    const list = files.data?.files ?? [];
    const needle = q.trim().toLowerCase();
    return needle ? list.filter((f) => f.toLowerCase().includes(needle)) : list;
  }, [files.data, q]);

  const panel =
    'rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center text-sm text-muted';
  if (!hasIndex) {
    return (
      <div className={`${panel} flex flex-col items-center`}>
        <FileCode2 size={22} aria-hidden className="mb-3" />
        Indexed files are listed here after the first index.
      </div>
    );
  }
  if (files.isPending) {
    return (
      <div className="space-y-2" role="status" aria-label="Loading files">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-9 animate-pulse rounded-md bg-soft" />
        ))}
      </div>
    );
  }
  if (files.error && !files.data) {
    return (
      <div
        role="alert"
        className="flex items-center gap-2 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger"
      >
        <CircleAlert size={18} aria-hidden />
        Could not load the indexed files: {files.error.message}
      </div>
    );
  }
  const data = files.data!;
  const sha = data.commitSha;
  return (
    <div>
      <RefetchErrorBanner query={files} what="file list" />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          {data.files.length.toLocaleString('en-US')} indexed files
          {sha && (
            <>
              {' '}
              at <span className="font-mono text-text">{shortSha(sha)}</span>
            </>
          )}
        </p>
        <label className="relative w-full sm:w-72">
          <span className="sr-only">Filter files</span>
          <Search
            size={16}
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter by path…"
            className="min-h-11 w-full rounded-md border border-border bg-raised pr-3 pl-9 text-sm placeholder:text-muted"
          />
        </label>
      </div>
      {shown.length === 0 ? (
        <p className={panel}>
          {data.files.length === 0 ? 'No indexed files.' : 'No file matches the filter.'}
        </p>
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
          {shown.slice(0, MAX_SHOWN).map((path) => (
            <li key={path}>
              <a
                href={
                  sha
                    ? `${repo.htmlUrl}/blob/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`
                    : undefined
                }
                target="_blank"
                rel="noreferrer"
                className="flex min-h-10 items-center gap-2 px-4 py-2 font-mono text-xs hover:bg-raised hover:text-accent-text"
              >
                <FileCode2 size={14} aria-hidden className="shrink-0 text-muted" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{path}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {shown.length > MAX_SHOWN && (
        <p className="mt-2 text-xs text-muted">
          Showing the first {MAX_SHOWN} of {shown.length.toLocaleString('en-US')}; filter to narrow
          down.
        </p>
      )}
    </div>
  );
}
