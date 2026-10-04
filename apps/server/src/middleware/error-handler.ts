import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ApiError } from '@autowiki/shared';
import { HttpError } from '../lib/http-error.js';

function body(code: string, message: string): ApiError {
  return { error: { code, message } };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(body('NOT_FOUND', `Route not found: ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json(body(err.code, err.message));
    return;
  }
  if (err instanceof ZodError) {
    const message = err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
    res.status(400).json(body('VALIDATION_ERROR', message));
    return;
  }
  // express.json() parse failures
  if (
    typeof err === 'object' &&
    err !== null &&
    'type' in err &&
    err.type === 'entity.parse.failed'
  ) {
    res.status(400).json(body('INVALID_JSON', 'Request body is not valid JSON'));
    return;
  }

  console.error('[error]', err instanceof Error ? (err.stack ?? err.message) : err);
  res.status(500).json(body('INTERNAL_ERROR', 'Something went wrong'));
};
