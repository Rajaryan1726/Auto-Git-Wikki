/**
 * Per-provider circuit breaker for quota / rate-limit errors. When a provider answers 429
 * (e.g. the Gemini free-tier quota), it is marked unavailable until its retry time, clamped
 * to [minOpenMs, maxOpenMs], and callers route straight to the fallback during that window
 * instead of failing on the primary first for every request. Per process, in memory.
 */
export type BreakerOptions = {
  minOpenMs?: number;
  maxOpenMs?: number;
  now?: () => number;
  log?: (message: string) => void;
};

export const BREAKER_MIN_OPEN_MS = 60_000;
export const BREAKER_MAX_OPEN_MS = 60 * 60_000;

export class CircuitBreaker {
  private readonly openUntil = new Map<string, number>();
  private readonly minOpenMs: number;
  private readonly maxOpenMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(opts: BreakerOptions = {}) {
    this.minOpenMs = opts.minOpenMs ?? BREAKER_MIN_OPEN_MS;
    this.maxOpenMs = opts.maxOpenMs ?? BREAKER_MAX_OPEN_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  /** True while `key` is unavailable. Closes (and logs it) once the window has passed. */
  isOpen(key: string): boolean {
    const until = this.openUntil.get(key);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.openUntil.delete(key);
    this.log(`[llm] circuit breaker CLOSED for ${key} (retry window passed)`);
    return false;
  }

  /** When `key` becomes available again, or null if it is not open. */
  openUntilTime(key: string): Date | null {
    return this.isOpen(key) ? new Date(this.openUntil.get(key)!) : null;
  }

  /** Opens the breaker after a quota / rate-limit error. */
  trip(key: string, retryAfterMs: number | null, reason: string): void {
    const ms = Math.min(this.maxOpenMs, Math.max(this.minOpenMs, retryAfterMs ?? 0));
    const until = this.now() + ms;
    const wasOpen = this.isOpen(key);
    // Keep the later deadline if several requests trip it at once.
    this.openUntil.set(key, Math.max(until, this.openUntil.get(key) ?? 0));
    if (!wasOpen) {
      this.log(
        `[llm] circuit breaker OPEN for ${key} for ${Math.round(ms / 1000)}s ` +
          `(until ${new Date(until).toISOString()}): ${reason.slice(0, 160)}`,
      );
    }
  }

  /** A request on `key` succeeded: close it if it was open (e.g. tried as a last resort). */
  succeed(key: string): void {
    if (this.openUntil.delete(key)) {
      this.log(`[llm] circuit breaker CLOSED for ${key} (request succeeded)`);
    }
  }

  reset(): void {
    this.openUntil.clear();
  }
}

/** Parses "37s", "1.5s", "200ms" (Google RetryInfo.retryDelay style) into milliseconds. */
export function parseDelay(value: string | undefined | null): number | null {
  if (!value) return null;
  const m = /^\s*([\d.]+)\s*(ms|s|m|h)?\s*$/.exec(value);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] ?? 's';
  const factor = unit === 'ms' ? 1 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 1000;
  return Math.round(n * factor);
}

/**
 * Retry hint of a rate-limited response: `retry-after-ms` / `retry-after` headers, Google's
 * RetryInfo.retryDelay, or "retry in 37.5s" / "try again in 20s" in the message.
 */
export function retryAfterMsFrom(
  headers: Headers | null,
  body: { error?: { message?: string; details?: { retryDelay?: string }[] } } | null,
): number | null {
  const ms = headers?.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const after = headers?.get('retry-after');
  if (after) {
    if (/^\d+(\.\d+)?$/.test(after.trim())) return Math.round(Number(after) * 1000);
    const date = Date.parse(after);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  for (const d of body?.error?.details ?? []) {
    const parsed = parseDelay(d.retryDelay);
    if (parsed !== null) return parsed;
  }
  const inMessage = /(?:retry|try again) in ([\d.]+\s*(?:ms|s|m|h)?)/i.exec(
    body?.error?.message ?? '',
  );
  return inMessage ? parseDelay(inMessage[1]) : null;
}

/** Quota / rate-limit errors open the breaker; other failures (bad key, 5xx) do not. */
export function isQuotaError(status: number | null, message: string): boolean {
  return (
    status === 429 || /RESOURCE_EXHAUSTED|exceeded your current quota|rate limit/i.test(message)
  );
}
