import { Link, useSearchParams } from 'react-router-dom';
import { CircleAlert, FolderGit2, LoaderCircle, MessageSquare, Sparkles } from 'lucide-react';
import type { RepoSummary } from '@autowiki/shared';
import { PageHeader, Placeholder } from '../components/page-header';
import { useStartIndex } from '../features/index-jobs/api';
import { useRepo, useRepos } from '../features/repos/api';
import { LanguageDot } from '../features/repos/components';
import { ApiRequestError } from '../lib/api';
import { relativeTime } from '../lib/time';
import { buttonClass } from '../lib/ui';

/** Only repos with a successful index can be chatted with. */
function RepoPicker({ selectedId }: { selectedId: string | null }) {
  const repos = useRepos('', 'indexed');
  if (repos.isPending) {
    return (
      <div className="h-24 animate-pulse rounded-lg bg-soft" role="status" aria-label="Loading" />
    );
  }
  if (repos.error)
    return <Placeholder>Could not load repositories: {repos.error.message}</Placeholder>;
  const list = repos.data.repos;
  if (list.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center">
        <FolderGit2 size={22} className="mb-3 text-muted" aria-hidden />
        <h2 className="font-semibold">No indexed repositories yet</h2>
        <p className="mt-1 text-sm text-muted">Index a repository first, then chat with it here.</p>
        <Link to="/" className={`${buttonClass.secondary} mt-4`}>
          Go to repositories
        </Link>
      </div>
    );
  }
  return (
    <nav aria-label="Indexed repositories">
      <ul className="grid gap-2 sm:grid-cols-2">
        {list.map((repo) => (
          <li key={repo.id}>
            <Link
              to={`/chat?repo=${repo.id}`}
              aria-current={repo.id === selectedId ? 'page' : undefined}
              className={`flex min-h-11 flex-col gap-1 rounded-md border px-4 py-3 transition-colors ${
                repo.id === selectedId
                  ? 'border-accent-text bg-accent-soft'
                  : 'border-border bg-surface hover:bg-raised'
              }`}
            >
              <span className="font-mono text-sm font-medium [overflow-wrap:anywhere]">
                {repo.fullName}
              </span>
              <span className="flex gap-3 text-xs text-muted">
                <LanguageDot language={repo.language} />
                {repo.status.lastIndexedAt && (
                  <span>Indexed {relativeTime(repo.status.lastIndexedAt)}</span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function IndexFirst({ repo }: { repo: RepoSummary }) {
  const start = useStartIndex(repo.id);
  const indexing = repo.status.state === 'indexing';
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center">
      <Sparkles size={22} className="mb-3 text-accent-text" aria-hidden />
      <h2 className="text-lg font-semibold">Index this repo first</h2>
      <p className="mt-1 max-w-md text-sm text-muted">
        <span className="font-mono text-text">{repo.fullName}</span> has not been indexed yet. Chat
        answers come from the indexed code, so index it before asking questions.
      </p>
      {indexing ? (
        <Link to={`/repos/${repo.id}`} className={`${buttonClass.secondary} mt-4`}>
          <LoaderCircle size={16} className="animate-spin" aria-hidden />
          Indexing {repo.status.progress ?? 0}% — view progress
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => start.mutate()}
          disabled={start.isPending}
          className={`${buttonClass.primary} mt-4`}
        >
          {start.isPending ? (
            <LoaderCircle size={16} className="animate-spin" aria-hidden />
          ) : (
            <Sparkles size={16} aria-hidden />
          )}
          Index repository
        </button>
      )}
      {start.error && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {start.error.message}
        </p>
      )}
    </div>
  );
}

function SelectedRepo({ repoId }: { repoId: string }) {
  const repo = useRepo(repoId);
  if (repo.isPending) {
    return (
      <div className="h-40 animate-pulse rounded-lg bg-soft" role="status" aria-label="Loading" />
    );
  }
  if (repo.error) {
    const notFound = repo.error instanceof ApiRequestError && repo.error.status === 404;
    return (
      <p
        role="alert"
        className="flex items-center gap-2 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger"
      >
        <CircleAlert size={18} aria-hidden />
        {notFound ? 'Repository not found.' : repo.error.message}
      </p>
    );
  }
  // Never show the chat UI for a repo without a successful index.
  if (!repo.data.status.commitSha) return <IndexFirst repo={repo.data} />;
  return (
    <section className="rounded-lg border border-border bg-surface p-5">
      <p className="mb-4 inline-flex rounded-full border border-border bg-raised px-3 py-1 font-mono text-sm">
        {repo.data.fullName}
      </p>
      <Placeholder>
        <span className="inline-flex items-center gap-2">
          <MessageSquare size={16} aria-hidden />
          Chat with this repository will appear here.
        </span>
      </Placeholder>
    </section>
  );
}

export function ChatPage() {
  const [params] = useSearchParams();
  const repoId = params.get('repo');
  return (
    <>
      <PageHeader title="Chat" subtitle="Ask questions about an indexed repository." />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div>
          <h2 className="mb-3 text-sm font-semibold text-muted">Indexed repositories</h2>
          <RepoPicker selectedId={repoId} />
        </div>
        <div>
          {repoId ? (
            <SelectedRepo repoId={repoId} />
          ) : (
            <Placeholder>Pick a repository to start chatting.</Placeholder>
          )}
        </div>
      </div>
    </>
  );
}
