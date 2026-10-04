import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createSseParser,
  messageListResponseSchema,
  threadListResponseSchema,
  threadResponseSchema,
  type ChatSource,
  type ChatStreamEvent,
} from '@autowiki/shared';
import { API_URL, ApiRequestError, apiFetch } from '../../lib/api';

export const chatKeys = {
  threads: (repoId: string) => ['chat', 'threads', repoId] as const,
  messages: (threadId: string) => ['chat', 'messages', threadId] as const,
};

export function useThreads(repoId: string | null) {
  return useQuery({
    queryKey: chatKeys.threads(repoId ?? ''),
    queryFn: async () =>
      threadListResponseSchema.parse(await apiFetch<unknown>(`/api/repos/${repoId}/threads`))
        .threads,
    enabled: Boolean(repoId),
  });
}

export function useThreadMessages(threadId: string | null) {
  return useQuery({
    queryKey: chatKeys.messages(threadId ?? ''),
    queryFn: async () =>
      messageListResponseSchema.parse(await apiFetch<unknown>(`/api/threads/${threadId}/messages`)),
    enabled: Boolean(threadId),
    retry: false,
  });
}

export function useCreateThread(repoId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () =>
      threadResponseSchema.parse(
        await apiFetch<unknown>(`/api/repos/${repoId}/threads`, { method: 'POST', body: {} }),
      ).thread,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.threads(repoId) }),
  });
}

export function useDeleteThread(repoId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (threadId: string) =>
      apiFetch<void>(`/api/threads/${threadId}`, { method: 'DELETE' }),
    onSuccess: (_data, threadId) => {
      queryClient.removeQueries({ queryKey: chatKeys.messages(threadId) });
      return queryClient.invalidateQueries({ queryKey: chatKeys.threads(repoId) });
    },
  });
}

export type StreamHandlers = {
  onSources: (sources: ChatSource[], commitSha: string) => void;
  onToken: (text: string) => void;
  /** The model failed mid-answer; discard the text so far (a fallback restarts it). */
  onReset: () => void;
  onDone: (messageId: string, model: string) => void;
  onError: (code: string, message: string) => void;
};

/**
 * POST /api/threads/:id/ask and dispatch the SSE events as they arrive.
 * Resolves when the stream ends; rejects with AbortError when `signal` aborts.
 */
export async function streamAsk(
  threadId: string,
  question: string,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_URL}/api/threads/${threadId}/ask`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code: string; message: string };
    } | null;
    throw new ApiRequestError(
      res.status,
      body?.error?.code ?? 'HTTP_ERROR',
      body?.error?.message ?? `Request failed with ${res.status}`,
      body,
    );
  }

  const parser = createSseParser();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let finished = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const msg of parser.feed(decoder.decode(value, { stream: true }))) {
      const e = { event: msg.event, data: JSON.parse(msg.data) } as ChatStreamEvent;
      if (e.event === 'sources') handlers.onSources(e.data.sources, e.data.commitSha);
      else if (e.event === 'token') handlers.onToken(e.data.text);
      else if (e.event === 'reset') handlers.onReset();
      else if (e.event === 'done') {
        finished = true;
        handlers.onDone(e.data.messageId, e.data.model);
      } else if (e.event === 'error') {
        finished = true;
        handlers.onError(e.data.code, e.data.message);
      }
    }
  }
  if (!finished)
    handlers.onError('STREAM_CLOSED', 'The connection closed before the answer finished.');
}

/** GitHub link to the exact lines at the indexed commit. */
export function sourceUrl(fullName: string, commitSha: string, s: Omit<ChatSource, 'n'>): string {
  const path = s.path.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${fullName}/blob/${commitSha}/${path}#L${s.startLine}-L${s.endLine}`;
}
