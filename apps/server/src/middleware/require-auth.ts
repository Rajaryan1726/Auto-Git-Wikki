import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthUser } from '@autowiki/shared';
import { SESSION_COOKIE } from '../lib/cookies.js';
import { HttpError } from '../lib/http-error.js';
import { verifySessionToken } from '../services/session.js';
import { reauthRequired } from '../services/github-token.js';
import { findSessionUser } from '../services/users.js';

/** Resolves the signed-in user from the session cookie, or null. */
export async function getSessionUser(
  req: Request,
): Promise<(AuthUser & { hasGithubAccess: boolean }) | null> {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || !token) return null;
  const userId = await verifySessionToken(token);
  return userId ? findSessionUser(userId) : null;
}

/**
 * Requires a valid session AND a GitHub token: once GitHub access was revoked (tokens
 * cleared by github-token.ts), every request answers GITHUB_REAUTH_REQUIRED and the error
 * handler clears the session cookie, so the web app goes to the login page.
 */
export const requireAuth: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const user = await getSessionUser(req);
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  if (!user.hasGithubAccess) throw reauthRequired();
  req.user = { id: user.id, username: user.username, avatarUrl: user.avatarUrl };
  next();
};

/** For handlers mounted behind `requireAuth`. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  return req.user;
}
