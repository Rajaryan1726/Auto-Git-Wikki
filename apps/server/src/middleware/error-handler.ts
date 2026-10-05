import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@autowiki/shared';
import { SESSION_COOKIE, clearOptions, sessionCookieOptions } from '../lib/cookies.js';
import { HttpError } from '../lib/http-error.js';

function body(code: string, message: string): ApiError {
  return { error: { code, message } };
}

/** Errors after which the session is useless: the client must sign in again. */
const SESSION_ENDING = new Set(['GITHUB_REAUTH_REQUIRED', 'UNAUTHENTICATED']);

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(body('NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) {
    // Clear a dead session (revoked GitHub access, expired / invalid session token).
    if (SESSION_ENDING.has(err.code) && req.cookies?.[SESSION_COOKIE]) {
      res.clearCookie(SESSION_COOKIE, clearOptions(sessionCookieOptions));
    }
    if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
    res.status(err.status).json(body(err.code, err.message));
    return;
  }
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    res.status(400).json(body('VALIDATION_ERROR', message));
    return;
  }
  // express.json() failures: invalid JSON, body over the size limit.
  if (typeof err === 'object' && err !== null && 'type' in err) {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json(body('INVALID_JSON', 'Request body is not valid JSON'));
      return;
    }
    if (err.type === 'entity.too.large') {
      res.status(413).json(body('PAYLOAD_TOO_LARGE', 'Request body is too large'));
      return;
    }
  }

  req.log.error({ err }, 'unhandled error');
  res.status(500).json(body('INTERNAL_ERROR', 'Something went wrong'));
};
