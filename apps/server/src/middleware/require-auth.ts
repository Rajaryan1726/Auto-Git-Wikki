import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AuthUser } from '@autowiki/shared';
import { SESSION_COOKIE } from '../lib/cookies.js';
import { HttpError } from '../lib/http-error.js';
import { verifySessionToken } from '../services/session.js';
import { findAuthUserById } from '../services/users.js';

/** Resolves the signed-in user from the session cookie, or null. */
export async function getSessionUser(req: Request): Promise<AuthUser | null> {
  const token: unknown = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== 'string' || !token) return null;
  const userId = await verifySessionToken(token);
  return userId ? findAuthUserById(userId) : null;
}

export const requireAuth: RequestHandler = async (
  req: Request,
  _res: Response,
  next: NextFunction,
) => {
  const user = await getSessionUser(req);
  if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  req.user = user;
  next();
};

/** For handlers mounted behind `requireAuth`. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required');
  return req.user;
}
