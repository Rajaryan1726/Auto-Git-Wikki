import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { env } from './env.js';

/**
 * Structured logging (pino). Rules: never log tokens, secrets, cookies, file contents,
 * chat text or memory facts. Log ids, counts, timings and model names instead.
 * In development the output is pretty-printed; elsewhere it is one JSON object per line.
 */
export const logger: Logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
  base: { service: 'autowiki-api' },
  // Belt and braces: drop anything secret-shaped that slips into a log object.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.token',
      '*.accessToken',
      '*.refreshToken',
      '*.apiKey',
      '*.password',
      '*.secret',
    ],
    censor: '[redacted]',
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { singleLine: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});

/** Child logger for one subsystem, e.g. logger.child({ module: 'index' }). */
export function moduleLogger(module: string): Logger {
  return logger.child({ module });
}

/** Path without the query string: OAuth callbacks carry `code` / `state` there. */
function pathOnly(url: string | undefined): string {
  return (url ?? '').split('?')[0] ?? '';
}

/** The full request path (Express rewrites req.url inside mounted routers). */
function fullPath(req: IncomingMessage): string {
  return pathOnly((req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url);
}

/**
 * Request logging with a request id (incoming `X-Request-Id` if sane, else a UUID),
 * echoed in the `X-Request-Id` response header. Inngest's frequent calls log at debug.
 */
export const httpLogger = pinoHttp({
  logger,
  genReqId(req: IncomingMessage, res: ServerResponse) {
    const incoming = req.headers['x-request-id'];
    const id =
      typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  serializers: {
    req: (req: { id: string; method: string; url: string }) => ({
      id: req.id,
      method: req.method,
      path: pathOnly(req.url),
    }),
    res: (res: { statusCode: number }) => ({ status: res.statusCode }),
  },
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (fullPath(req).startsWith('/api/inngest')) return 'debug';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${fullPath(req)} ${res.statusCode}`,
  customErrorMessage: (req, res) => `${req.method} ${fullPath(req)} ${res.statusCode}`,
});
