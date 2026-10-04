import { z } from 'zod';
import { env } from '../lib/env.js';

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API_URL = 'https://api.github.com';
export const GITHUB_SCOPES = 'read:user repo';

export const githubCallbackUrl = `${env.SERVER_URL}/api/auth/github/callback`;

export class GithubOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GithubOAuthError';
  }
}

function oauthCredentials(): { clientId: string; clientSecret: string } {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new GithubOAuthError(
      'not_configured',
      'GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be set',
    );
  }
  return { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET };
}

export function buildAuthorizeUrl(state: string): string {
  const { clientId } = oauthCredentials();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', githubCallbackUrl);
  url.searchParams.set('scope', GITHUB_SCOPES);
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');
  return url.toString();
}

const tokenSuccessSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  scope: z.string().optional(),
  // Present only when the app uses expiring user tokens.
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.number().optional(),
});

const tokenErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

export type GithubTokenSet = {
  accessToken: string;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
};

function secondsFromNow(seconds: number | undefined, now: number): Date | null {
  return seconds === undefined ? null : new Date(now + seconds * 1000);
}

async function requestToken(params: Record<string, string>): Promise<GithubTokenSet> {
  const { clientId, clientSecret } = oauthCredentials();
  const now = Date.now();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  if (!res.ok) {
    throw new GithubOAuthError(
      'token_request_failed',
      `GitHub token endpoint returned ${res.status}`,
    );
  }
  // GitHub returns 200 with an `error` field for OAuth failures.
  const json: unknown = await res.json();
  const failure = tokenErrorSchema.safeParse(json);
  if (failure.success) {
    throw new GithubOAuthError(
      failure.data.error,
      failure.data.error_description ?? failure.data.error,
    );
  }
  const data = tokenSuccessSchema.parse(json);
  return {
    accessToken: data.access_token,
    accessTokenExpiresAt: secondsFromNow(data.expires_in, now),
    refreshToken: data.refresh_token ?? null,
    refreshTokenExpiresAt: secondsFromNow(data.refresh_token_expires_in, now),
  };
}

export function exchangeCodeForToken(code: string): Promise<GithubTokenSet> {
  return requestToken({ code, redirect_uri: githubCallbackUrl });
}

export function refreshAccessToken(refreshToken: string): Promise<GithubTokenSet> {
  return requestToken({ grant_type: 'refresh_token', refresh_token: refreshToken });
}

const githubUserSchema = z.object({
  id: z.number().int(),
  login: z.string(),
  avatar_url: z.string().nullable().optional(),
});

export type GithubUser = z.infer<typeof githubUserSchema>;

export async function fetchGithubUser(accessToken: string): Promise<GithubUser> {
  const res = await fetch(`${API_URL}/user`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'autowiki',
    },
  });
  if (!res.ok) {
    throw new GithubOAuthError('user_fetch_failed', `GitHub /user returned ${res.status}`);
  }
  return githubUserSchema.parse(await res.json());
}
