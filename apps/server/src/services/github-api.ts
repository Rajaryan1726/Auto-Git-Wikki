import { HttpError } from '../lib/http-error.js';

export const GITHUB_API_ORIGIN = 'https://api.github.com';

/** A GitHub API call already authorized as one user; `path` is relative to the API origin. */
export type GithubFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** Returns the `rel="next"` URL from a GitHub `Link` header, as a path relative to the API. */
export function parseNextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1]) {
      const url = new URL(match[1]);
      return url.origin === GITHUB_API_ORIGIN ? `${url.pathname}${url.search}` : null;
    }
  }
  return null;
}

function minutesUntil(epochSeconds: number, now: number): number {
  return Math.max(1, Math.ceil((epochSeconds * 1000 - now) / 60_000));
}

/**
 * Detects primary (`x-ratelimit-remaining: 0`) and secondary (`retry-after`) rate limits.
 * Returns an HttpError to throw, or null if the response is not rate limited.
 */
export function rateLimitError(res: Response, now = Date.now()): HttpError | null {
  if (res.status !== 403 && res.status !== 429) return null;

  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  if (remaining === '0' && Number.isFinite(reset) && reset > 0) {
    const minutes = minutesUntil(reset, now);
    return new HttpError(
      429,
      'GITHUB_RATE_LIMITED',
      `GitHub API rate limit reached. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  }

  const retryAfter = Number(res.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    const minutes = Math.max(1, Math.ceil(retryAfter / 60));
    return new HttpError(
      429,
      'GITHUB_RATE_LIMITED',
      `GitHub is temporarily limiting requests. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    );
  }
  return null;
}

/** Throws a clear HttpError for any non-2xx GitHub response. */
export function ensureGithubOk(res: Response, context: string): void {
  if (res.ok) return;
  const limited = rateLimitError(res);
  if (limited) throw limited;
  throw new HttpError(502, 'GITHUB_API_ERROR', `GitHub request failed (${context}: ${res.status})`);
}

export function logRateLimit(res: Response): void {
  const remaining = Number(res.headers.get('x-ratelimit-remaining'));
  if (Number.isFinite(remaining) && remaining < 100) {
    console.warn(`[github] rate limit low: ${remaining} requests remaining`);
  }
}

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
