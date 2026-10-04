/** Refresh a little early so a token never expires mid-request. */
export const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/** True when `expiresAt` is within `skewMs` of now. A null expiry never expires. */
export function isExpired(
  expiresAt: Date | null,
  now: number = Date.now(),
  skewMs: number = EXPIRY_SKEW_MS,
): boolean {
  return expiresAt !== null && expiresAt.getTime() - skewMs <= now;
}
