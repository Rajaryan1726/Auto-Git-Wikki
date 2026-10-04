/** Gemini answered 429; `retryAt` comes from Retry-After or the RetryInfo detail. */
export class EmbeddingRateLimitError extends Error {
  constructor(
    readonly retryAt: Date,
    message = 'Gemini embedding rate limit reached.',
    /** Quota ids reported by Gemini, e.g. ...PerDay... for a daily limit. */
    readonly quotaIds: string[] = [],
  ) {
    super(message);
    this.name = 'EmbeddingRateLimitError';
  }
}

/** Configuration or request problems that a retry cannot fix (bad key, bad request). */
export class EmbeddingFatalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingFatalError';
  }
}
