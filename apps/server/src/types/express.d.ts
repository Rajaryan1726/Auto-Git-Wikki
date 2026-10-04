import type { AuthUser } from '@autowiki/shared';

declare global {
  namespace Express {
    interface Request {
      /** Set by `requireAuth`. */
      user?: AuthUser;
    }
  }
}

export {};
