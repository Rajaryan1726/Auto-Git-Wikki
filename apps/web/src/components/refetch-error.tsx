import { CircleAlert, RotateCw } from 'lucide-react';
import { buttonClass } from '../lib/ui';

/**
 * Shown when a refetch failed but older data is still on screen (TanStack Query keeps
 * it): the page stays usable, and the user learns it may be out of date.
 */
export function RefetchErrorBanner({
  query,
  what = 'data',
}: {
  query: {
    isError: boolean;
    data: unknown;
    error: Error | null;
    refetch: () => unknown;
    isFetching: boolean;
  };
  what?: string;
}) {
  if (!query.isError || query.data === undefined) return null;
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-danger-soft px-4 py-2.5 text-sm text-danger"
    >
      <CircleAlert size={18} className="shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        Could not refresh the {what}; showing the last loaded version.
        {query.error?.message && <span className="opacity-80"> ({query.error.message})</span>}
      </p>
      <button
        type="button"
        onClick={() => void query.refetch()}
        disabled={query.isFetching}
        className={buttonClass.secondary}
      >
        <RotateCw size={16} aria-hidden className={query.isFetching ? 'animate-spin' : ''} />
        Retry
      </button>
    </div>
  );
}
