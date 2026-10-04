import type { RepoIndexStatus, RepoSummary } from '@autowiki/shared';

export function statusLabel(status: RepoIndexStatus): string {
  switch (status.state) {
    case 'indexed':
      return 'Indexed';
    case 'indexing':
      return `Indexing ${status.progress ?? 0}%`;
    case 'failed':
      return 'Index failed';
    case 'not_indexed':
      return 'Not indexed';
  }
}

/** "Updated X ago" uses the last push; updated_at also moves on stars and settings edits. */
export function repoUpdatedAt(repo: RepoSummary): string | null {
  return repo.githubPushedAt ?? repo.githubUpdatedAt;
}
