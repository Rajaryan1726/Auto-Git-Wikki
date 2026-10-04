import { ExternalLink, TriangleAlert, X } from 'lucide-react';
import type { SyncSummary } from '@autowiki/shared';

function describeSkipped(skipped: SyncSummary['skipped']): string {
  const parts: string[] = [];
  const named = skipped.orgs.map((o) => o.login).filter((l): l is string => Boolean(l));
  const unnamed = skipped.orgs.length - named.length;
  if (named.length) parts.push(`organization${named.length > 1 ? 's' : ''} ${named.join(', ')}`);
  if (unnamed)
    parts.push(`${unnamed} organization${unnamed > 1 ? 's that require' : ' that requires'} SSO`);
  if (skipped.repos) parts.push(`${skipped.repos} repositor${skipped.repos > 1 ? 'ies' : 'y'}`);
  return parts.length > 1
    ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
    : (parts[0] ?? '');
}

/** Shown when the last sync skipped org repos (OAuth app restrictions / SSO) or bad items. */
export function SyncNotice({
  summary,
  onDismiss,
}: {
  summary: SyncSummary;
  onDismiss: () => void;
}) {
  if (summary.skipped.count === 0) return null;
  return (
    <div
      role="status"
      className="mb-6 flex gap-3 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning"
    >
      <TriangleAlert size={18} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {summary.skipped.count} item{summary.skipped.count > 1 ? 's were' : ' was'} skipped during
          sync.
        </p>
        <p className="mt-0.5">
          AutoWiki could not read repositories from {describeSkipped(summary.skipped)}. Some
          organizations restrict OAuth app access; an organization owner may need to grant AutoWiki
          access in GitHub settings.
        </p>
        {summary.grantAccessUrl && (
          <a
            href={summary.grantAccessUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-flex min-h-11 items-center gap-1 font-medium underline underline-offset-2"
          >
            Review organization access on GitHub
            <ExternalLink size={14} aria-hidden />
          </a>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notice"
        className="-mt-1 -mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-warning/10"
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
