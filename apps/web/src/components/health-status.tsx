import { CircleCheck, CircleX, LoaderCircle, RefreshCw } from 'lucide-react';
import type { ServiceStatus } from '@autowiki/shared';
import { useHealth } from '../features/health/use-health';

function ServiceRow({ name, status }: { name: string; status: ServiceStatus }) {
  const ok = status.status === 'ok';
  return (
    <li className="flex items-center justify-between gap-4 rounded-md border border-border bg-raised px-4 py-3">
      <span className="font-medium">{name}</span>
      <span
        className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
          ok ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'
        }`}
      >
        {ok ? <CircleCheck size={14} aria-hidden /> : <CircleX size={14} aria-hidden />}
        {ok ? `ok · ${status.latencyMs ?? 0} ms` : (status.message ?? 'error')}
      </span>
    </li>
  );
}

export function HealthStatus() {
  const { data, error, isPending, isFetching, refetch } = useHealth();

  return (
    <section className="rounded-lg border border-border bg-surface p-5" aria-live="polite">
      <div className="mb-4 flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold">System status</h2>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="inline-flex min-h-11 items-center gap-2 rounded-md border border-border bg-raised px-4 text-sm font-medium hover:bg-soft disabled:opacity-60"
        >
          <RefreshCw size={16} aria-hidden className={isFetching ? 'animate-spin' : undefined} />
          Refresh
        </button>
      </div>

      {isPending && (
        <p className="flex items-center gap-2 text-muted">
          <LoaderCircle size={16} className="animate-spin" aria-hidden /> Checking services...
        </p>
      )}

      {error && !data && (
        <p className="rounded-md bg-danger-soft px-4 py-3 text-sm text-danger">
          Could not reach the API server: {error.message}
        </p>
      )}

      {data && (
        <ul className="grid gap-2">
          <ServiceRow name="PostgreSQL" status={data.services.database} />
          <ServiceRow name="Qdrant" status={data.services.qdrant} />
        </ul>
      )}
    </section>
  );
}
