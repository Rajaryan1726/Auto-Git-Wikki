import type { Request, RequestHandler } from 'express';
import { HttpError } from './http-error.js';

/**
 * Sliding-window request limiter, in memory and per process (enough for one API server;
 * several servers would need a shared store such as Redis).
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private sweepAt = 0;

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records a hit for `key`; ok=false (and nothing recorded) when the window is full. */
  hit(key: string): { ok: boolean; retryAfterMs: number; remaining: number } {
    const t = this.now();
    this.sweep(t);
    const recent = (this.hits.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { ok: false, retryAfterMs: this.windowMs - (t - recent[0]!), remaining: 0 };
    }
    recent.push(t);
    this.hits.set(key, recent);
    return { ok: true, retryAfterMs: 0, remaining: this.limit - recent.length };
  }

  /** Drops idle keys now and then so the map cannot grow without bound. */
  private sweep(t: number): void {
    if (t < this.sweepAt) return;
    this.sweepAt = t + this.windowMs;
    for (const [key, list] of this.hits) {
      if (list.every((x) => t - x >= this.windowMs)) this.hits.delete(key);
    }
  }
}

/**
 * Express middleware: `limit` requests per `windowMs` per key (the user id behind
 * requireAuth, else the client IP). Over the limit → 429 RATE_LIMITED + Retry-After.
 */
export function rateLimit(opts: {
  name: string;
  limit: number;
  windowMs?: number;
  key?: (req: Request) => string;
  message?: string;
}): RequestHandler {
  const limiter = new SlidingWindowLimiter(opts.limit, opts.windowMs ?? 60_000);
  const keyOf = opts.key ?? ((req: Request) => req.user?.id ?? req.ip ?? 'unknown');
  return (req, _res, next) => {
    const result = limiter.hit(`${opts.name}:${keyOf(req)}`);
    if (result.ok) return next();
    const seconds = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    next(
      new HttpError(
        429,
        'RATE_LIMITED',
        opts.message ?? `Too many requests. Please wait ${seconds} s and try again.`,
        seconds,
      ),
    );
  };
}
