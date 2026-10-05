/**
 * Local development only: a session token for an existing user without going through
 * GitHub OAuth (used to test the UI when the browser has no GitHub sign-in).
 *
 * Safety rules (tested in dev-session.test.ts):
 *  - refuses to run when NODE_ENV=production, before touching the database;
 *  - only `scripts/dev-session.ts` calls it; no HTTP route imports it, and outside this
 *    module only the OAuth callback (routes/auth.ts) creates session tokens.
 */
import { eq, or } from 'drizzle-orm';
import { db } from '../db/client.js';
import { users } from '../db/schema.js';
import { env } from '../lib/env.js';
import { createSessionToken } from './session.js';

export class DevOnlyError extends Error {
  constructor(what: string) {
    super(`${what} is a local development tool and refuses to run with NODE_ENV=production.`);
    this.name = 'DevOnlyError';
  }
}

export function assertNotProduction(what: string, nodeEnv: string = env.NODE_ENV): void {
  if (nodeEnv === 'production') throw new DevOnlyError(what);
}

/** Session token for the user with this id or GitHub username. */
export async function createDevSession(
  userIdOrUsername: string,
  nodeEnv: string = env.NODE_ENV,
): Promise<{ token: string; userId: string; username: string }> {
  assertNotProduction('dev:session', nodeEnv);
  const isUuid = /^[0-9a-f-]{36}$/i.test(userIdOrUsername);
  const [user] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(
      isUuid
        ? or(eq(users.id, userIdOrUsername), eq(users.username, userIdOrUsername))
        : eq(users.username, userIdOrUsername),
    )
    .limit(1);
  if (!user) throw new Error(`No user "${userIdOrUsername}". Sign in once with GitHub first.`);
  return { token: await createSessionToken(user.id), userId: user.id, username: user.username };
}
