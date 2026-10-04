import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  CircleAlert,
  FolderGit2,
  LoaderCircle,
  MessageSquare,
  Plus,
  SendHorizontal,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import type { ChatSource, RepoSummary } from '@autowiki/shared';
import { PageHeader, Placeholder } from '../components/page-header';
import {
  chatKeys,
  streamAsk,
  useCreateThread,
  useDeleteThread,
  useThreadMessages,
  useThreads,
} from '../features/chat/api';
import { AssistantMessage, StreamError, UserBubble } from '../features/chat/message-view';
import { shortSha } from '../features/index-jobs/format';
import { useStartIndex } from '../features/index-jobs/api';
import { useRepo, useRepos } from '../features/repos/api';
import { ApiRequestError } from '../lib/api';
import { relativeTime } from '../lib/time';
import { buttonClass } from '../lib/ui';

const NEW_THREAD = 'new';

const SUGGESTIONS = [
  'What does this project do?',
  'How is the code organized?',
  'Where is the main entry point?',
  'How do I run it locally?',
];

// ---------------------------------------------------------------- repo selection

function RepoSwitcher({ selectedId }: { selectedId: string | null }) {
  const repos = useRepos('', 'indexed');
  const navigate = useNavigate();
  const list = repos.data?.repos ?? [];
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-semibold tracking-wide text-muted uppercase">
        Repository
      </span>
      <select
        value={selectedId ?? ''}
        onChange={(e) => navigate(`/chat?repo=${e.target.value}`)}
        className="min-h-11 w-full rounded-md border border-border bg-raised px-3 font-mono text-sm"
      >
        {!selectedId && <option value="">Choose an indexed repository</option>}
        {selectedId && !list.some((r) => r.id === selectedId) && (
          <option value={selectedId}>(not indexed)</option>
        )}
        {list.map((r) => (
          <option key={r.id} value={r.id}>
            {r.fullName}
          </option>
        ))}
      </select>
    </label>
  );
}

function RepoPicker() {
  const repos = useRepos('', 'indexed');
  if (repos.isPending) {
    return (
      <div className="h-24 animate-pulse rounded-lg bg-soft" role="status" aria-label="Loading" />
    );
  }
  const list = repos.data?.repos ?? [];
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
              className="flex min-h-11 flex-col gap-1 rounded-md border border-border bg-surface px-4 py-3 transition-colors hover:bg-raised"
            >
              <span className="font-mono text-sm font-medium [overflow-wrap:anywhere]">
                {repo.fullName}
              </span>
              {repo.status.lastIndexedAt && (
                <span className="text-xs text-muted">
                  Indexed {relativeTime(repo.status.lastIndexedAt)}
                </span>
              )}
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
        <span className="font-mono text-text">{repo.fullName}</span> has not been indexed yet.
        Answers come from the indexed code, so index it before asking questions.
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
          Index now
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

// ---------------------------------------------------------------- thread list

function ThreadList({
  repoId,
  selected,
  onSelect,
  disabled,
}: {
  repoId: string;
  selected: string | null;
  onSelect: (threadId: string) => void;
  disabled: boolean;
}) {
  const threads = useThreads(repoId);
  const remove = useDeleteThread(repoId);
  const list = threads.data ?? [];

  const del = (id: string, title: string) => {
    if (!window.confirm(`Delete the chat “${title}”? This cannot be undone.`)) return;
    remove.mutate(id, { onSuccess: () => id === selected && onSelect(NEW_THREAD) });
  };

  return (
    <section aria-labelledby="threads-title">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 id="threads-title" className="text-xs font-semibold tracking-wide text-muted uppercase">
          Recent chats
        </h2>
        <button
          type="button"
          onClick={() => onSelect(NEW_THREAD)}
          disabled={disabled}
          className={`${buttonClass.secondary} min-h-9 px-3`}
        >
          <Plus size={14} aria-hidden />
          New chat
        </button>
      </div>
      {threads.isPending ? (
        <div className="space-y-2" role="status" aria-label="Loading chats">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-11 animate-pulse rounded-md bg-soft" />
          ))}
        </div>
      ) : list.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted">
          No chats yet. Ask a question to start one.
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto lg:max-h-[calc(100vh-20rem)]">
          {list.map((t) => {
            const active = t.id === selected;
            return (
              <li key={t.id} className="group flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onSelect(t.id)}
                  disabled={disabled}
                  aria-current={active ? 'true' : undefined}
                  className={`flex min-h-11 min-w-0 flex-1 flex-col justify-center rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                    active ? 'bg-accent-soft text-accent-text' : 'hover:bg-soft'
                  }`}
                >
                  <span className="truncate font-medium">{t.title}</span>
                  <span className="text-xs text-muted">{relativeTime(t.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => del(t.id, t.title)}
                  disabled={disabled || remove.isPending}
                  aria-label={`Delete chat ${t.title}`}
                  title="Delete chat"
                  className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted hover:bg-danger-soft hover:text-danger"
                >
                  <Trash2 size={16} aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- conversation

type Pending = {
  /** Thread the answer belongs to (null until a new thread is created). */
  threadId: string | null;
  question: string;
  text: string;
  sources: ChatSource[];
  commitSha: string | null;
  status: 'streaming' | 'error';
  error?: string;
  /** Id of the saved assistant message once the stream is done. */
  doneId?: string;
};

function Composer({
  onSend,
  onStop,
  streaming,
}: {
  onSend: (q: string) => void;
  onStop: () => void;
  streaming: boolean;
}) {
  const [value, setValue] = useState('');
  const submit = () => {
    const q = value.trim();
    if (!q || streaming) return;
    onSend(q);
    setValue('');
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="flex items-end gap-2 rounded-lg border border-border bg-raised p-2 focus-within:border-accent-text"
    >
      <label className="sr-only" htmlFor="chat-input">
        Ask a question about this repository
      </label>
      <textarea
        id="chat-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={streaming}
        rows={Math.min(6, Math.max(1, value.split('\n').length))}
        placeholder={
          streaming
            ? 'Answering…'
            : 'Ask about the code…  (Enter to send, Shift+Enter for a new line)'
        }
        className="max-h-48 min-h-11 flex-1 resize-none bg-transparent px-2 py-2.5 text-sm placeholder:text-muted focus:outline-none disabled:opacity-60"
      />
      {streaming ? (
        <button
          type="button"
          onClick={onStop}
          aria-label="Stop generating"
          title="Stop"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-text hover:bg-soft"
        >
          <Square size={16} aria-hidden />
        </button>
      ) : (
        <button
          type="submit"
          disabled={!value.trim()}
          aria-label="Send"
          title="Send"
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-accent text-on-accent hover:opacity-90 disabled:opacity-50"
        >
          <SendHorizontal size={18} aria-hidden />
        </button>
      )}
    </form>
  );
}

function Conversation({
  repo,
  threadId,
  onThreadCreated,
  onStreamingChange,
}: {
  repo: RepoSummary;
  threadId: string | null;
  onThreadCreated: (id: string) => void;
  onStreamingChange: (streaming: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const messages = useThreadMessages(threadId);
  const createThread = useCreateThread(repo.id);
  const [pending, setPending] = useState<Pending | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const list = messages.data?.messages ?? [];
  // Only show the pending answer in its own thread, and not once its saved copy is listed.
  const visible =
    pending &&
    pending.threadId === threadId &&
    !(pending.doneId && list.some((m) => m.id === pending.doneId))
      ? pending
      : null;
  const streaming = pending?.status === 'streaming';

  useEffect(() => onStreamingChange(streaming), [streaming, onStreamingChange]);
  // Stop any stream when leaving the page.
  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [visible?.text, visible?.status, messages.data?.messages.length]);

  const refresh = async (tid: string) => {
    await Promise.all([
      queryClient.refetchQueries({ queryKey: chatKeys.messages(tid) }),
      queryClient.invalidateQueries({ queryKey: chatKeys.threads(repo.id) }),
    ]);
  };

  const ask = async (question: string) => {
    let tid = threadId;
    setPending({
      threadId: tid,
      question,
      text: '',
      sources: [],
      commitSha: null,
      status: 'streaming',
    });
    try {
      if (!tid) {
        const created = (await createThread.mutateAsync()).id;
        tid = created;
        setPending((p) => p && { ...p, threadId: created });
        onThreadCreated(created);
      }
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const threadIdForStream = tid;
      await streamAsk(
        threadIdForStream,
        question,
        {
          onSources: (sources, commitSha) => setPending((p) => p && { ...p, sources, commitSha }),
          onToken: (t) => setPending((p) => p && { ...p, text: p.text + t }),
          onDone: (messageId) => {
            setPending((p) => p && { ...p, doneId: messageId });
            void refresh(threadIdForStream).then(() => setPending(null));
          },
          onError: (_code, message) =>
            setPending((p) => p && { ...p, status: 'error', error: message }),
        },
        ctrl.signal,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Stopped: the server keeps the partial answer; show the saved version.
        if (tid) await refresh(tid);
        setPending(null);
        return;
      }
      const message =
        err instanceof ApiRequestError || err instanceof Error
          ? err.message
          : 'Something went wrong';
      setPending((p) => p && { ...p, status: 'error', error: message });
    } finally {
      abortRef.current = null;
      if (tid) void queryClient.invalidateQueries({ queryKey: chatKeys.threads(repo.id) });
    }
  };

  // The server saves the question right away; don't show it twice.
  const last = list[list.length - 1];
  const showPendingQuestion =
    visible && !(last?.role === 'user' && last.content === visible.question);
  const link = (sources: ChatSource[], commitSha: string | null) => ({
    fullName: repo.fullName,
    commitSha,
    sources,
  });

  if (threadId && messages.error) {
    return (
      <p
        role="alert"
        className="flex items-center gap-2 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger"
      >
        <CircleAlert size={18} aria-hidden />
        {messages.error instanceof ApiRequestError && messages.error.status === 404
          ? 'This chat no longer exists.'
          : messages.error.message}
      </p>
    );
  }

  const empty = list.length === 0 && !visible;
  return (
    <section aria-label="Conversation" className="flex min-h-[60vh] flex-col">
      <div className="flex-1 space-y-6 pb-4" aria-live="polite">
        {threadId && messages.isPending ? (
          <div className="space-y-3" role="status" aria-label="Loading messages">
            <div className="ml-auto h-10 w-1/2 animate-pulse rounded-lg bg-soft" />
            <div className="h-24 w-4/5 animate-pulse rounded-lg bg-soft" />
          </div>
        ) : empty ? (
          <div className="flex flex-col items-center px-4 py-10 text-center">
            <MessageSquare size={24} className="mb-3 text-accent-text" aria-hidden />
            <h2 className="text-lg font-semibold">Ask anything about {repo.name}</h2>
            <p className="mt-1 max-w-md text-sm text-muted">
              Answers are grounded in the indexed code and cite the files and lines they use.
            </p>
            <div className="mt-5 flex flex-wrap justify-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => void ask(s)}
                  className="min-h-11 rounded-full border border-border bg-raised px-4 text-sm hover:border-accent-text/50 hover:text-accent-text"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          list.map((m) =>
            m.role === 'user' ? (
              <UserBubble key={m.id} text={m.content} />
            ) : (
              <AssistantMessage
                key={m.id}
                text={m.content}
                link={link(m.sources, m.commitSha)}
                model={m.model}
              />
            ),
          )
        )}
        {visible && (
          <>
            {showPendingQuestion && <UserBubble text={visible.question} />}
            {(visible.status === 'streaming' || visible.text) && (
              <AssistantMessage
                text={visible.text}
                link={link(visible.sources, visible.commitSha)}
                streaming={visible.status === 'streaming'}
              />
            )}
            {visible.status === 'error' && (
              <StreamError
                message={visible.error ?? 'The answer could not be generated.'}
                onRetry={() => void ask(visible.question)}
              />
            )}
          </>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="sticky bottom-0 bg-bg pt-2 pb-1">
        <Composer
          onSend={(q) => void ask(q)}
          onStop={() => abortRef.current?.abort()}
          streaming={streaming}
        />
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- page

function RepoChat({ repo }: { repo: RepoSummary }) {
  const [params, setParams] = useSearchParams();
  const threadParam = params.get('thread');
  const threads = useThreads(repo.id);
  const [streaming, setStreaming] = useState(false);

  const setThread = (id: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('thread', id);
        return next;
      },
      { replace: true },
    );

  // "Chat with repo" opens the most recent chat, or a new one when there is none.
  const firstThread = threads.data?.[0]?.id;
  useEffect(() => {
    if (!threadParam && threads.data) setThread(firstThread ?? NEW_THREAD);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadParam, threads.data, firstThread]);

  const threadId = threadParam && threadParam !== NEW_THREAD ? threadParam : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(240px,280px)_minmax(0,1fr)]">
      <aside className="flex flex-col gap-5">
        <RepoSwitcher selectedId={repo.id} />
        <ThreadList
          repoId={repo.id}
          selected={threadParam}
          onSelect={setThread}
          disabled={streaming}
        />
      </aside>
      <div className="min-w-0">
        <header className="mb-4 flex flex-wrap items-center gap-2 border-b border-border pb-3">
          <Link
            to={`/repos/${repo.id}`}
            className="inline-flex min-h-9 items-center rounded-full border border-border bg-raised px-3 font-mono text-sm hover:border-accent-text/50"
          >
            {repo.fullName}
          </Link>
          {repo.status.commitSha && (
            <span className="text-xs text-muted">
              indexed at <span className="font-mono">{shortSha(repo.status.commitSha)}</span>
            </span>
          )}
        </header>
        <Conversation
          repo={repo}
          threadId={threadId}
          onThreadCreated={setThread}
          onStreamingChange={setStreaming}
        />
      </div>
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
  if (!repo.data.status.commitSha) {
    return (
      <div className="grid gap-6 lg:grid-cols-[minmax(240px,280px)_minmax(0,1fr)]">
        <aside>
          <RepoSwitcher selectedId={repo.data.id} />
        </aside>
        <IndexFirst repo={repo.data} />
      </div>
    );
  }
  return <RepoChat repo={repo.data} />;
}

export function ChatPage() {
  const [params] = useSearchParams();
  const repoId = params.get('repo');
  return (
    <>
      <PageHeader title="Chat" subtitle="Ask questions about an indexed repository." />
      {repoId ? (
        <SelectedRepo repoId={repoId} />
      ) : (
        <div className="grid gap-4">
          <h2 className="text-sm font-semibold text-muted">Choose a repository</h2>
          <RepoPicker />
          <Placeholder>Pick a repository to start chatting.</Placeholder>
        </div>
      )}
    </>
  );
}
