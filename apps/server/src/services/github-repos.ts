import { z } from 'zod';
import {
  ensureGithubOk,
  logRateLimit,
  mapWithConcurrency,
  parseNextLink,
  rateLimitError,
  type GithubFetch,
} from './github-api.js';

import { moduleLogger } from '../lib/logger.js';

const log = moduleLogger('github-repos');

const REPOS_PATH =
  '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=full_name&direction=asc';
/** 100 pages x 100 = 10k repos; beyond that the fetch is treated as incomplete. */
const MAX_PAGES = 100;

const githubRepoSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  full_name: z.string(),
  description: z.string().nullable().optional(),
  private: z.boolean(),
  default_branch: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  pushed_at: z.string().nullable().optional(),
});

export type GithubRepo = {
  githubRepoId: number;
  name: string;
  fullName: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string | null;
  language: string | null;
  githubUpdatedAt: Date | null;
  githubPushedAt: Date | null;
};

export type RepoListResult = {
  repos: GithubRepo[];
  /** Items GitHub returned that did not match the expected shape. */
  invalidCount: number;
  /** Org ids from `X-GitHub-SSO: partial-results; organizations=...`. */
  ssoOrgIds: string[];
  /** True only when every page was fetched; removals are unsafe otherwise. */
  complete: boolean;
};

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseGithubRepo(item: unknown): GithubRepo | null {
  const parsed = githubRepoSchema.safeParse(item);
  if (!parsed.success) return null;
  const r = parsed.data;
  return {
    githubRepoId: r.id,
    name: r.name,
    fullName: r.full_name,
    description: r.description ?? null,
    isPrivate: r.private,
    defaultBranch: r.default_branch ?? null,
    language: r.language ?? null,
    githubUpdatedAt: toDate(r.updated_at),
    githubPushedAt: toDate(r.pushed_at),
  };
}

/** Parses `X-GitHub-SSO: partial-results; organizations=1,2` (results hidden by SAML SSO). */
export function parseSsoPartialOrgs(header: string | null): string[] {
  if (!header || !/partial-results/i.test(header)) return [];
  const match = /organizations=([\d,\s]+)/i.exec(header);
  return match?.[1]
    ? match[1]
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

/**
 * Lists every repo the user can access (owner, collaborator, org member), following
 * pagination. Any page failure throws, so callers never act on a silently partial list.
 */
export async function listUserRepos(fetchGh: GithubFetch): Promise<RepoListResult> {
  const byId = new Map<number, GithubRepo>();
  const ssoOrgIds = new Set<string>();
  let invalidCount = 0;
  let path: string | null = REPOS_PATH;
  let pages = 0;

  while (path) {
    if (pages >= MAX_PAGES) {
      log.warn(`[github] stopped repo listing after ${MAX_PAGES} pages`);
      return {
        repos: [...byId.values()],
        invalidCount,
        ssoOrgIds: [...ssoOrgIds],
        complete: false,
      };
    }
    const res = await fetchGh(path);
    ensureGithubOk(res, 'list repositories');
    logRateLimit(res);
    pages++;

    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error('GitHub /user/repos did not return an array');
    for (const item of body) {
      const repo = parseGithubRepo(item);
      if (repo) byId.set(repo.githubRepoId, repo);
      else invalidCount++;
    }
    for (const id of parseSsoPartialOrgs(res.headers.get('x-github-sso'))) ssoOrgIds.add(id);
    path = parseNextLink(res.headers.get('link'));
  }

  return { repos: [...byId.values()], invalidCount, ssoOrgIds: [...ssoOrgIds], complete: true };
}

export type SkippedOrg = {
  id: number | null;
  login: string | null;
  reason: 'oauth_restricted' | 'sso_required';
};

const orgSchema = z.array(z.object({ id: z.number(), login: z.string() }).loose());

/**
 * Best effort: finds the user's organizations that block this OAuth app (or require SSO).
 * Never throws; a failure here must not fail the sync. Only orgs visible to the token
 * are checked (private memberships need the `read:org` scope).
 */
export async function findRestrictedOrgs(fetchGh: GithubFetch): Promise<SkippedOrg[]> {
  try {
    const res = await fetchGh('/user/orgs?per_page=100');
    if (!res.ok) return [];
    const orgs = orgSchema.safeParse(await res.json());
    if (!orgs.success) return [];

    const results = await mapWithConcurrency(
      orgs.data,
      5,
      async ({ id, login }): Promise<SkippedOrg | null> => {
        const probe = await fetchGh(`/orgs/${encodeURIComponent(login)}/repos?per_page=1&type=all`);
        if (probe.status !== 403 || rateLimitError(probe)) return null;
        const body = (await probe.json().catch(() => ({}))) as { message?: unknown };
        const message = typeof body.message === 'string' ? body.message : '';
        if (/OAuth App access restrictions/i.test(message)) {
          return { id, login, reason: 'oauth_restricted' };
        }
        if (/SAML|SSO/i.test(message) || probe.headers.has('x-github-sso')) {
          return { id, login, reason: 'sso_required' };
        }
        return null;
      },
    );
    return results.filter((r): r is SkippedOrg => r !== null);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : 'unknown error' },
      '[github] org access check failed',
    );
    return [];
  }
}

export type RepoPresence = 'exists' | 'gone' | 'unknown';

/**
 * Confirms whether a repo is really gone (404, or 403 that is not a rate limit) by id.
 * Used before deleting, so a pagination shift during sync can never delete a live repo.
 */
export async function checkRepoPresence(
  fetchGh: GithubFetch,
  githubRepoId: number,
): Promise<RepoPresence> {
  try {
    const res = await fetchGh(`/repositories/${githubRepoId}`);
    if (res.ok) return 'exists';
    if (res.status === 404 || (res.status === 403 && !rateLimitError(res))) return 'gone';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
