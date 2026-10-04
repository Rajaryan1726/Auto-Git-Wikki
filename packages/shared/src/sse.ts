/**
 * Server-Sent Events helpers shared by the API (formatting) and the web app (parsing),
 * plus the chat stream event contract.
 */

/** One SSE event: `event:` name and JSON `data:`. */
export function formatSseEvent(event: string, data: unknown): string {
  // JSON.stringify never emits raw newlines, so the data always fits on one `data:` line.
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export type SseMessage = { event: string; data: string };

/**
 * Incremental SSE parser: feed it text as it arrives, get back complete events.
 * Handles CRLF, multi-line data, comments and events split across chunks.
 */
export function createSseParser() {
  let buffer = '';
  return {
    feed(chunk: string): SseMessage[] {
      buffer += chunk.replace(/\r\n?/g, '\n');
      const out: SseMessage[] = [];
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (!line || line.startsWith(':')) continue;
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
          if (field === 'event') event = value;
          else if (field === 'data') data.push(value);
        }
        if (data.length) out.push({ event, data: data.join('\n') });
      }
      return out;
    },
  };
}

// ---- chat stream contract: sources, then tokens, then done | error ----

export type ChatSource = {
  /** 1-based number used by [n] markers in the answer. */
  n: number;
  path: string;
  startLine: number;
  endLine: number;
};

export type ChatStreamEvent =
  | { event: 'sources'; data: { sources: ChatSource[]; commitSha: string; userMessageId: string } }
  | { event: 'token'; data: { text: string } }
  | { event: 'done'; data: { messageId: string; model: string } }
  | { event: 'error'; data: { code: string; message: string } };
