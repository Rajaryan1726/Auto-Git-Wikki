import type { CookieOptions } from 'express';
import { env } from './env.js';

export const SESSION_COOKIE = 'aw_session';
export const OAUTH_STATE_COOKIE = 'aw_oauth_state';

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const OAUTH_STATE_TTL_SECONDS = 10 * 60;

const base: CookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.NODE_ENV === 'production',
};

export const sessionCookieOptions: CookieOptions = {
  ...base,
  path: '/',
  maxAge: SESSION_TTL_SECONDS * 1000,
};

export const oauthStateCookieOptions: CookieOptions = {
  ...base,
  path: '/api/auth/github',
  maxAge: OAUTH_STATE_TTL_SECONDS * 1000,
};

/** Options for clearCookie must match path/flags but must not include maxAge. */
export function clearOptions({ maxAge: _maxAge, ...rest }: CookieOptions): CookieOptions {
  return rest;
}
