import { useEffect, useRef, type ReactNode } from 'react';
import { Link, Navigate } from 'react-router-dom';
import {
  BookOpen,
  ChevronDown,
  CircleAlert,
  FileCode2,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import type { RepoSummary, WikiPageSummary, WikiResponse, WikiSource } from '@autowiki/shared';
import { ApiRequestError } from '../../lib/api';
import { relativeTime } from '../../lib/time';
import { buttonClass } from '../../lib/ui';
import { sourceUrl } from '../chat/api';
import { MarkdownView } from '../chat/message-view';
import { shortSha } from '../index-jobs/format';
import { useRegenerateWiki, useWiki, useWikiPage, wikiPath } from './api';

/** What the wiki tab needs from the repo page's index state. */
export type WikiIndexView = {
  hasIndex: boolean;
  active: boolean;
  failed: boolean;
  start: () => void;
  isStarting: boolean;
};

function Panel({ icon: Icon, children }: { icon: typeof BookOpen; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-surface px-6 py-12 text-center text-sm text-muted">
      <Icon size={22} aria-hidden className="mb-3" />
      {children}
    </div>
  );
}

function Notice({
  tone,
  icon: Icon,
  children,
  action,
}: {
  tone: 'warning' | 'danger' | 'info';
  icon: typeof BookOpen;
  children: ReactNode;
  action?: ReactNode;
}) {
  const toneClass =
    tone === 'danger'
      ? 'bg-danger-soft text-danger'
      : tone === 'warning'
        ? 'bg-warning-soft text-warning'
        : 'border border-border bg-raised text-muted';
  return (
    <div
      role={tone === 'info' ? 'status' : 'alert'}
      className={`mb-4 flex flex-wrap items-center gap-3 rounded-lg px-4 py-3 text-sm ${toneClass}`}
    >
      <Icon
        size={18}
        className={`shrink-0 ${Icon === LoaderCircle ? 'animate-spin' : ''}`}
        aria-hidden
      />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</div>
      {action}
    </div>
  );
}

function PagesProgress({ done, total }: { done: number; total: number | null }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="w-full max-w-xs">
      <div
        role="progressbar"
        aria-label="Wiki generation progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 w-full overflow-hidden rounded-full bg-warning-soft"
      >
        <div
          className="h-full rounded-full bg-warning transition-[width]"
          style={{ width: `${total ? Math.max(4, pct) : 4}%` }}
        />
      </div>
      <p className="mt-2 font-mono text-xs">
        {total ? `${done} / ${total} pages` : 'Planning the pages…'}
      </p>
    </div>
  );
}

function RegenerateButton({
  repoId,
  label,
  variant = 'secondary',
  disabled = false,
}: {
  repoId: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
}) {
  const regenerate = useRegenerateWiki(repoId);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={() => regenerate.mutate()}
        disabled={disabled || regenerate.isPending}
        className={buttonClass[variant]}
      >
        {regenerate.isPending ? (
          <LoaderCircle size={16} className="animate-spin" aria-hidden />
        ) : label === 'Retry' ? (
          <RotateCw size={16} aria-hidden />
        ) : (
          <Sparkles size={16} aria-hidden />
        )}
        {label}
      </button>
      {regenerate.error && (
        <span role="alert" className="text-xs text-danger">
          {regenerate.error.message}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- table of contents

function TocList({
  repoId,
  pages,
  current,
}: {
  repoId: string;
  pages: WikiPageSummary[];
  current: string;
}) {
  const top = pages.filter((p) => !p.parentSlug);
  const item = (p: WikiPageSummary, nested: boolean) => {
    const selected = p.slug === current;
    return (
      <Link
        to={wikiPath(repoId, p.slug)}
        aria-current={selected ? 'page' : undefined}
        className={`flex min-h-10 items-center rounded-md px-3 py-1.5 text-sm transition-colors ${
          nested ? 'pl-6' : ''
        } ${
          selected
            ? 'bg-accent-soft font-medium text-accent-text'
            : 'text-muted hover:bg-soft hover:text-text'
        }`}
      >
        {p.title}
      </Link>
    );
  };
  return (
    <ul className="flex flex-col gap-0.5">
      {top.map((p) => {
        const children = pages.filter((c) => c.parentSlug === p.slug);
        return (
          <li key={p.slug}>
            {item(p, false)}
            {children.length > 0 && (
              <ul className="mt-0.5 flex flex-col gap-0.5">
                {children.map((c) => (
                  <li key={c.slug}>{item(c, true)}</li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Toc({
  repoId,
  pages,
  current,
}: {
  repoId: string;
  pages: WikiPageSummary[];
  current: string;
}) {
  const title = pages.find((p) => p.slug === current)?.title ?? 'Pages';
  return (
    <>
      {/* Desktop: sticky list beside the article. */}
      <nav aria-label="Wiki pages" className="hidden lg:block">
        <div className="sticky top-4 rounded-lg border border-border bg-surface p-2">
          <p className="px-3 pt-1 pb-2 text-xs font-semibold tracking-wide text-muted uppercase">
            Pages
          </p>
          <TocList repoId={repoId} pages={pages} current={current} />
        </div>
      </nav>
      {/* Mobile: collapsed menu above the article. */}
      <details className="group rounded-lg border border-border bg-surface lg:hidden">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 px-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
          <span className="min-w-0 truncate">
            <span className="text-muted">Pages · </span>
            {title}
          </span>
          <ChevronDown
            size={16}
            aria-hidden
            className="shrink-0 text-muted transition-transform group-open:rotate-180"
          />
        </summary>
        <nav aria-label="Wiki pages" className="border-t border-border p-2">
          <TocList repoId={repoId} pages={pages} current={current} />
        </nav>
      </details>
    </>
  );
}

// ---------------------------------------------------------------- article

function WikiSourceChips({
  fullName,
  commitSha,
  sources,
}: {
  fullName: string;
  commitSha: string;
  sources: WikiSource[];
}) {
  if (sources.length === 0) return null;
  return (
    <section className="mt-8 border-t border-border pt-4" aria-labelledby="wiki-sources">
      <h3
        id="wiki-sources"
        className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase"
      >
        Sources
      </h3>
      <ul className="flex flex-wrap gap-1.5">
        {sources.map((s) => {
          const label = `${s.path} · L${s.startLine}–${s.endLine}`;
          return (
            <li key={`${s.path}:${s.startLine}`} className="max-w-full">
              <a
                href={sourceUrl(fullName, commitSha, s)}
                target="_blank"
                rel="noreferrer"
                title={label}
                className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md border border-border bg-raised px-2 py-1 font-mono text-xs text-text hover:border-accent-text/50 hover:text-accent-text"
              >
                <FileCode2 size={12} aria-hidden className="shrink-0 text-muted" />
                <span className="truncate">{label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ArticleSkeleton() {
  return (
    <div className="space-y-3" role="status" aria-label="Loading page">
      <div className="h-7 w-1/3 animate-pulse rounded bg-soft" />
      <div className="h-3 w-1/4 animate-pulse rounded bg-soft" />
      {[0, 1, 2, 3, 4].map((i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-soft"
          style={{ width: `${95 - i * 9}%` }}
        />
      ))}
      <div className="h-28 animate-pulse rounded-md bg-soft" />
    </div>
  );
}

function Article({
  repo,
  slug,
  generatedAt,
  firstSlug,
  regenerateDisabled,
}: {
  repo: RepoSummary;
  slug: string;
  generatedAt: string | null;
  firstSlug: string;
  regenerateDisabled: boolean;
}) {
  const page = useWikiPage(repo.id, slug, generatedAt);
  const ref = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    // Bring the new page into view when it is picked from the list (not on first load).
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [slug]);

  let body: ReactNode;
  if (page.isPending) body = <ArticleSkeleton />;
  else if (page.error) {
    const missing = page.error instanceof ApiRequestError && page.error.status === 404;
    body = (
      <div role="alert" className="py-8 text-center text-sm text-muted">
        <p>{missing ? 'This wiki page does not exist.' : page.error.message}</p>
        <Link to={wikiPath(repo.id, firstSlug)} className={`${buttonClass.secondary} mt-4`}>
          Go to the first page
        </Link>
      </div>
    );
  } else {
    const p = page.data;
    body = (
      <>
        <header className="mb-5 border-b border-border pb-4">
          <h2 className="font-heading text-2xl font-semibold">{p.title}</h2>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
              <Sparkles size={13} aria-hidden />
              Generated by AI from commit
              <a
                href={`${repo.htmlUrl}/commit/${p.commitSha}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-text hover:underline"
              >
                {shortSha(p.commitSha)}
              </a>
              {p.model && <span>· {p.model}</span>}
              <span>· {relativeTime(p.generatedAt)}</span>
            </p>
            <RegenerateButton
              repoId={repo.id}
              label="Regenerate wiki"
              variant="ghost"
              disabled={regenerateDisabled}
            />
          </div>
        </header>
        <MarkdownView text={p.contentMd} className="wiki-article" />
        <WikiSourceChips fullName={repo.fullName} commitSha={p.commitSha} sources={p.sources} />
      </>
    );
  }
  return (
    <article
      ref={ref}
      aria-live="polite"
      className="min-w-0 scroll-mt-4 rounded-lg border border-border bg-surface p-5 md:p-7"
    >
      {body}
    </article>
  );
}

function WikiSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-[15rem_1fr]" role="status" aria-label="Loading wiki">
      <div className="hidden space-y-2 rounded-lg border border-border bg-surface p-3 lg:block">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-8 animate-pulse rounded bg-soft" />
        ))}
      </div>
      <div className="rounded-lg border border-border bg-surface p-6">
        <ArticleSkeleton />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- panel

function StatusNotices({
  repo,
  data,
  view,
}: {
  repo: RepoSummary;
  data: WikiResponse;
  view: WikiIndexView;
}) {
  const { wiki } = data;
  return (
    <>
      {wiki.state === 'generating' && (
        <Notice tone="info" icon={LoaderCircle}>
          Regenerating the wiki (
          {wiki.pagesTotal ? `${wiki.pagesDone} / ${wiki.pagesTotal} pages` : 'planning the pages'}
          ). The previous version is shown until it finishes.
        </Notice>
      )}
      {wiki.state === 'failed' && (
        <Notice
          tone="danger"
          icon={CircleAlert}
          action={<RegenerateButton repoId={repo.id} label="Retry" disabled={view.active} />}
        >
          <p className="font-medium">Wiki generation failed — the previous version is shown.</p>
          {wiki.error && <p className="mt-0.5 text-xs opacity-90">{wiki.error}</p>}
        </Notice>
      )}
      {wiki.stale && !view.active && (
        <Notice
          tone="warning"
          icon={TriangleAlert}
          action={
            <button
              type="button"
              onClick={view.start}
              disabled={view.isStarting}
              className={buttonClass.secondary}
            >
              <RefreshCw size={16} aria-hidden className={view.isStarting ? 'animate-spin' : ''} />
              Re-index
            </button>
          }
        >
          Code changed since this wiki was generated.
        </Notice>
      )}
    </>
  );
}

export function WikiPanel({
  repo,
  view,
  slug,
}: {
  repo: RepoSummary;
  view: WikiIndexView;
  slug: string | undefined;
}) {
  const wiki = useWiki(repo.id, view.hasIndex);

  if (!view.hasIndex) {
    if (view.active) {
      return <Panel icon={BookOpen}>The wiki will appear here after indexing finishes.</Panel>;
    }
    return (
      <Panel icon={BookOpen}>
        <p>No wiki yet. Index this repository to generate its wiki.</p>
        {!view.failed && (
          <button
            type="button"
            onClick={view.start}
            disabled={view.isStarting}
            className={`${buttonClass.primary} mt-4`}
          >
            {view.isStarting ? (
              <LoaderCircle size={16} className="animate-spin" aria-hidden />
            ) : (
              <Sparkles size={16} aria-hidden />
            )}
            Index repository
          </button>
        )}
      </Panel>
    );
  }

  if (wiki.isPending) return <WikiSkeleton />;
  if (wiki.error) {
    return <Panel icon={CircleAlert}>Could not load the wiki: {wiki.error.message}</Panel>;
  }

  const data = wiki.data;
  const { pages } = data;
  if (pages.length === 0) {
    if (data.wiki.state === 'generating') {
      return (
        <div className="space-y-4">
          <Panel icon={LoaderCircle}>
            <p className="mb-4 font-medium text-text">Generating the wiki…</p>
            <PagesProgress done={data.wiki.pagesDone} total={data.wiki.pagesTotal} />
          </Panel>
          <WikiSkeleton />
        </div>
      );
    }
    if (data.wiki.state === 'failed') {
      return (
        <div
          role="alert"
          className="flex flex-col items-center rounded-lg bg-danger-soft px-6 py-10 text-center text-sm text-danger"
        >
          <CircleAlert size={22} aria-hidden className="mb-3" />
          <p className="font-medium">Wiki generation failed</p>
          {data.wiki.error && (
            <p className="mt-1 max-w-xl text-xs [overflow-wrap:anywhere]">{data.wiki.error}</p>
          )}
          <p className="mt-1 text-xs">The index itself is fine: chat still works.</p>
          <div className="mt-4">
            <RegenerateButton repoId={repo.id} label="Retry" disabled={view.active} />
          </div>
        </div>
      );
    }
    return (
      <Panel icon={BookOpen}>
        <p>This index has no wiki yet.</p>
        {view.active ? (
          <p className="mt-1">It will be generated when the current indexing finishes.</p>
        ) : (
          <div className="mt-4">
            <RegenerateButton repoId={repo.id} label="Generate wiki" variant="primary" />
          </div>
        )}
      </Panel>
    );
  }

  const firstSlug = pages[0]!.slug;
  // A slug that is not in this wiki (old link, or the outline changed on regeneration).
  if (slug && !pages.some((p) => p.slug === slug)) {
    return <Navigate to={wikiPath(repo.id, firstSlug)} replace />;
  }
  const current = slug ?? firstSlug;
  return (
    <div>
      <StatusNotices repo={repo} data={data} view={view} />
      <div className="grid items-start gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <Toc repoId={repo.id} pages={pages} current={current} />
        <Article
          repo={repo}
          slug={current}
          generatedAt={data.wiki.generatedAt}
          firstSlug={firstSlug}
          regenerateDisabled={view.active || data.wiki.state === 'generating'}
        />
      </div>
    </div>
  );
}
