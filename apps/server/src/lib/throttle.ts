/**
 * Per-process limiter for an external API: weighted requests per minute (a batch of N
 * items counts N, as Gemini meters embeddings per item), optional tokens per minute, max
 * concurrent calls, and a shared pause after a 429.
 */
export type ThrottleCost = { requests: number; tokens: number };

export type ThrottleOptions = {
  /** Budget of weighted requests per rolling minute. */
  maxPerMinute: number;
  concurrency: number;
  /** 0 or undefined disables the token budget. */
  maxTokensPerMinute?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const WINDOW_MS = 60_000;

export class Throttle {
  private readonly window: { at: number; requests: number; tokens: number }[] = [];
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  private pausedUntil = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: ThrottleOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Every caller waits until `until` (used when the API answers 429). */
  pauseUntil(until: number): void {
    this.pausedUntil = Math.max(this.pausedUntil, until);
  }

  /** Runs `fn` once a concurrency slot and a rate-limit slot are free. */
  async run<T>(cost: ThrottleCost, fn: () => Promise<T>): Promise<T> {
    await this.acquireSlot();
    try {
      await this.acquireRate(cost);
      return await fn();
    } finally {
      this.releaseSlot();
    }
  }

  private async acquireSlot(): Promise<void> {
    if (this.active < this.opts.concurrency) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // hand the slot over directly
    } else {
      this.active--;
    }
  }

  private async acquireRate({ requests, tokens }: ThrottleCost): Promise<void> {
    const tpm = this.opts.maxTokensPerMinute ?? 0;
    for (;;) {
      const now = this.now();
      if (now < this.pausedUntil) {
        await this.sleep(this.pausedUntil - now);
        continue;
      }
      while (this.window.length && this.window[0]!.at <= now - WINDOW_MS) this.window.shift();
      const usedRequests = this.window.reduce((n, e) => n + e.requests, 0);
      const usedTokens = this.window.reduce((n, e) => n + e.tokens, 0);
      // A single oversized call is still allowed through on an empty window.
      const empty = this.window.length === 0;
      const underRpm = empty || usedRequests + requests <= this.opts.maxPerMinute;
      const underTpm = tpm <= 0 || empty || usedTokens + tokens <= tpm;
      if (underRpm && underTpm) {
        this.window.push({ at: now, requests, tokens });
        return;
      }
      await this.sleep(Math.max(1, this.window[0]!.at + WINDOW_MS - now));
    }
  }
}
