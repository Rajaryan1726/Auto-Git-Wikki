import { HttpError } from '../lib/http-error.js';
import { GithubRateLimitError } from '../services/github-api.js';
import { RepoAccessLostError, RepoEmptyError } from '../services/github-index.js';

export type IndexErrorDecision =
  /** Fail the job now with this user-facing message. */
  | { action: 'fail'; message: string }
  /** Wait until `retryAt`, then retry the step. */
  | { action: 'retry_at'; retryAt: Date; message: string }
  /** Normal Inngest retry with backoff. */
  | { action: 'retry'; message: string };

/** Longest we will wait for a GitHub rate limit to reset before giving up. */
const MAX_RATE_LIMIT_WAIT_MS = 65 * 60 * 1000;

/**
 * Decides how an error inside an indexing step is handled, so permanent problems
 * (repo gone, access lost, sign-in expired) fail fast instead of retrying forever.
 */
export function classifyIndexError(err: unknown, now = Date.now()): IndexErrorDecision {
  if (err instanceof RepoAccessLostError) {
    return {
      action: 'fail',
      message:
        'The repository was deleted or AutoWiki lost access to it while indexing. Sync your repositories and try again.',
    };
  }
  if (err instanceof RepoEmptyError) return { action: 'fail', message: err.message };
  if (err instanceof GithubRateLimitError) {
    if (err.retryAt.getTime() - now > MAX_RATE_LIMIT_WAIT_MS) {
      return { action: 'fail', message: err.message };
    }
    return { action: 'retry_at', retryAt: err.retryAt, message: err.message };
  }
  if (err instanceof HttpError && err.code === 'GITHUB_REAUTH_REQUIRED') {
    return {
      action: 'fail',
      message: 'GitHub authorization expired. Sign in again, then retry indexing.',
    };
  }
  const message = err instanceof Error ? err.message : 'Unknown error';
  return { action: 'retry', message: `Indexing failed: ${message}` };
}
