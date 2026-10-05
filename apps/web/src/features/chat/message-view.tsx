import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Link } from 'react-router-dom';
import { CircleAlert, FileCode2, RotateCw, UserRound } from 'lucide-react';
import type { ChatSource } from '@autowiki/shared';
import { buttonClass } from '../../lib/ui';
import { sourceUrl } from './api';
import { CITE_PREFIX, fixFenceCitations, remarkCitations } from './citations';
import { PlansLink } from '../../components/error-with-upgrade';

type SourceLink = { fullName: string; commitSha: string | null; sources: ChatSource[] };

function citationHref(link: SourceLink, n: number): string | undefined {
  const s = link.sources.find((x) => x.n === n);
  return s && link.commitSha ? sourceUrl(link.fullName, link.commitSha, s) : undefined;
}

/**
 * Markdown with GFM and highlighted code, shared by chat answers and wiki pages.
 * With `citations`, [n] markers become small source links (chat).
 */
export function MarkdownView({
  text,
  citations,
  className = '',
}: {
  text: string;
  citations?: SourceLink;
  className?: string;
}) {
  const link = citations;
  const components: Components = {
    a({ href, children }) {
      if (link && href?.startsWith(CITE_PREFIX)) {
        const n = Number(href.slice(CITE_PREFIX.length));
        const s = link.sources.find((x) => x.n === n);
        const url = citationHref(link, n);
        const label = s ? `${s.path} lines ${s.startLine}–${s.endLine}` : `source ${n}`;
        return url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            title={label}
            aria-label={`Source ${n}: ${label}`}
            className="mx-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded bg-accent-soft px-1 align-text-top font-mono text-[11px] font-semibold text-accent-text no-underline hover:bg-accent hover:text-on-accent"
          >
            {children}
          </a>
        ) : (
          <sup className="font-mono text-[11px] text-muted">[{children}]</sup>
        );
      }
      return (
        <a href={href} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
  };
  return (
    <div className={`chat-markdown ${className}`}>
      <ReactMarkdown
        remarkPlugins={link ? [remarkGfm, remarkCitations] : [remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false, ignoreMissing: true }]]}
        components={components}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Assistant answer: Markdown + highlighted code; [n] markers become small source links. */
export function AnswerMarkdown({ text, link }: { text: string; link: SourceLink }) {
  return <MarkdownView text={fixFenceCitations(text)} citations={link} />;
}

/** "Sources" row: one chip per source, linking to the lines at the indexed commit. */
export function SourceChips({ link }: { link: SourceLink }) {
  if (link.sources.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Sources</p>
      <ul className="flex flex-wrap gap-1.5">
        {link.sources.map((s) => {
          const label = `${s.path} · L${s.startLine}–${s.endLine}`;
          const url = link.commitSha ? sourceUrl(link.fullName, link.commitSha, s) : undefined;
          return (
            <li key={s.n} className="max-w-full">
              <a
                href={url}
                target="_blank"
                rel="noreferrer"
                title={label}
                className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-md border border-border bg-raised px-2 py-1 font-mono text-xs text-text hover:border-accent-text/50 hover:text-accent-text"
              >
                <span className="font-semibold text-accent-text">{s.n}</span>
                <FileCode2 size={12} aria-hidden className="shrink-0 text-muted" />
                <span className="truncate">{label}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] rounded-lg rounded-br-sm bg-accent px-4 py-2.5 text-sm whitespace-pre-wrap text-on-accent [overflow-wrap:anywhere]">
        {text}
      </p>
    </div>
  );
}

export function AssistantMessage({
  text,
  link,
  model,
  memoryCount = 0,
  streaming = false,
}: {
  text: string;
  link: SourceLink;
  model?: string | null;
  /** User memories used to personalise this answer. */
  memoryCount?: number;
  streaming?: boolean;
}) {
  return (
    <div className="max-w-full">
      {text ? (
        <AnswerMarkdown text={text} link={link} />
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <span className="inline-flex gap-1" aria-hidden>
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:120ms]" />
            <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted [animation-delay:240ms]" />
          </span>
          {link.sources.length ? 'Writing the answer…' : 'Searching the code…'}
        </p>
      )}
      {streaming && text && (
        <span
          className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent-text align-middle"
          aria-hidden
        />
      )}
      <SourceChips link={link} />
      {!streaming && (model || memoryCount > 0) && (
        <p className="mt-2 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
          {model && <span>Answered by {model}</span>}
          {memoryCount > 0 && (
            <Link
              to="/settings#memory"
              className="inline-flex items-center gap-1 hover:text-accent-text hover:underline"
              title="See what AutoWiki remembers about you"
            >
              <UserRound size={11} aria-hidden />
              Personalised using {memoryCount} {memoryCount === 1 ? 'memory' : 'memories'}
            </Link>
          )}
        </p>
      )}
    </div>
  );
}

export function StreamError({
  message,
  onRetry,
  planLink = false,
}: {
  message: string;
  onRetry: () => void;
  planLink?: boolean;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger"
    >
      <CircleAlert size={18} className="shrink-0" aria-hidden />
      <span className="flex-1">
        {message}
        {planLink && (
          <>
            {' '}
            <PlansLink />
          </>
        )}
      </span>
      <button type="button" onClick={onRetry} className={buttonClass.secondary}>
        <RotateCw size={16} aria-hidden />
        Retry
      </button>
    </div>
  );
}
