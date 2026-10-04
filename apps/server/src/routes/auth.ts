import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type Response } from 'express';
import { z } from 'zod';
import type { LoginErrorCode } from '@autowiki/shared';
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  clearOptions,
  oauthStateCookieOptions,
  sessionCookieOptions,
} from '../lib/cookies.js';
import { env } from '../lib/env.js';
import { currentUser, requireAuth } from '../middleware/require-auth.js';
import {
  GithubOAuthError,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGithubUser,
} from '../services/github-oauth.js';
import { createSessionToken } from '../services/session.js';
import { upsertGithubUser } from '../services/users.js';

export const authRouter = Router();

function redirectToLogin(res: Response, error: LoginErrorCode): void {
  res.clearCookie(OAUTH_STATE_COOKIE, clearOptions(oauthStateCookieOptions));
  res.redirect(`${env.WEB_ORIGIN}/login?error=${error}`);
}

function statesMatch(expected: unknown, received: string | undefined): boolean {
  if (typeof expected !== 'string' || !expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

authRouter.get('/github', (_req, res) => {
  let url: string;
  const state = randomBytes(32).toString('base64url');
  try {
    url = buildAuthorizeUrl(state);
  } catch (err) {
    if (err instanceof GithubOAuthError && err.code === 'not_configured') {
      console.error('[auth] GitHub OAuth is not configured');
      redirectToLogin(res, 'not_configured');
      return;
    }
    throw err;
  }
  res.cookie(OAUTH_STATE_COOKIE, state, oauthStateCookieOptions);
  res.redirect(url);
});

const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});

authRouter.get('/github/callback', async (req, res) => {
  const parsed = callbackQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    redirectToLogin(res, 'oauth_failed');
    return;
  }
  const { code, state, error } = parsed.data;

  // Verify state first so a forged callback cannot even trigger the denial path.
  if (!statesMatch(req.cookies?.[OAUTH_STATE_COOKIE], state)) {
    console.warn('[auth] rejected OAuth callback: missing or mismatched state');
    redirectToLogin(res, 'invalid_state');
    return;
  }
  if (error) {
    redirectToLogin(res, error === 'access_denied' ? 'access_denied' : 'oauth_failed');
    return;
  }
  if (!code) {
    redirectToLogin(res, 'oauth_failed');
    return;
  }

  try {
    const tokens = await exchangeCodeForToken(code);
    const githubUser = await fetchGithubUser(tokens.accessToken);
    const user = await upsertGithubUser(githubUser, tokens);
    const session = await createSessionToken(user.id);

    res.clearCookie(OAUTH_STATE_COOKIE, clearOptions(oauthStateCookieOptions));
    res.cookie(SESSION_COOKIE, session, sessionCookieOptions);
    console.log(
      `[auth] signed in ${user.username}` +
        (tokens.accessTokenExpiresAt ? ' (expiring token)' : ' (non-expiring token)'),
    );
    res.redirect(`${env.WEB_ORIGIN}/`);
  } catch (err) {
    const reason = err instanceof GithubOAuthError ? err.code : 'unexpected';
    console.error(`[auth] GitHub sign-in failed: ${reason}`);
    if (!(err instanceof GithubOAuthError)) console.error(err);
    redirectToLogin(res, 'oauth_failed');
  }
});

authRouter.get('/me', requireAuth, (req, res) => {
  res.json({ user: currentUser(req) });
});

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, clearOptions(sessionCookieOptions));
  res.status(204).end();
});
