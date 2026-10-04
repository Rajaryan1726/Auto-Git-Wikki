/**
 * How texts are written before embedding, per provider. Index time and query time MUST
 * use the same provider's formats, or vectors are not comparable.
 *
 * Gemini (gemini-embedding-2) does not accept `task_type`/`title` request fields; the task
 * instruction goes into the text. Source (verified 2026-10-04):
 * https://ai.google.dev/gemini-api/docs/embeddings
 *   document: "title: {title} | text: {content}"   ("If there is no title, use title: none.")
 *   code retrieval query: "task: code retrieval | query: {content}"
 *
 * OpenAI (text-embedding-3-*) has no task prefixes; documents carry their file path as a
 * plain first line for context and queries are embedded as-is.
 * Source: https://developers.openai.com/api/docs/guides/embeddings
 */

export type EmbeddingProvider = 'gemini' | 'openai';

export const DOCUMENT_FORMAT = 'title: {title} | text: {content}';
export const CODE_QUERY_FORMAT = 'task: code retrieval | query: {content}';

/** Which provider serves a model id. Unknown ids are rejected rather than guessed. */
export function providerForModel(model: string): EmbeddingProvider {
  const id = model.replace(/^models\//, '');
  if (/^gemini-|^embedding-\d|^text-embedding-00\d/.test(id)) return 'gemini';
  if (/^text-embedding-(3-|ada-)/.test(id)) return 'openai';
  throw new Error(`Unknown embedding model "${model}": cannot tell which provider serves it.`);
}

/** Titles are single-line and short; Gemini's format uses " | " as a separator. */
function cleanTitle(title: string | null | undefined): string {
  return (title ?? '').replace(/\s+/g, ' ').trim();
}

export function chunkTitle(filePath: string, symbol: string | null): string {
  return symbol ? `${filePath} (${symbol})` : filePath;
}

/** Document text for a code/doc chunk; the title carries file path and symbol. */
export function formatDocument(
  content: string,
  title?: string | null,
  provider: EmbeddingProvider = 'gemini',
): string {
  const t = cleanTitle(title);
  if (provider === 'openai') return t ? `${t}\n\n${content}` : content;
  // Function replacers: a plain string replacement would expand `$&` / `$1` found in code.
  return DOCUMENT_FORMAT.replace('{title}', () => t || 'none').replace('{content}', () => content);
}

/** Query text for searching code at question time. */
export function formatCodeQuery(query: string, provider: EmbeddingProvider = 'gemini'): string {
  const q = query.trim();
  return provider === 'openai' ? q : CODE_QUERY_FORMAT.replace('{content}', () => q);
}
