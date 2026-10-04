import { z } from 'zod';

export const authUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  avatarUrl: z.string().nullable(),
});

export type AuthUser = z.infer<typeof authUserSchema>;

/** Values of `?error=` that the server may append when redirecting to /login. */
export const loginErrorCodes = [
  'access_denied',
  'invalid_state',
  'oauth_failed',
  'not_configured',
  'session_expired',
] as const;

export type LoginErrorCode = (typeof loginErrorCodes)[number];
