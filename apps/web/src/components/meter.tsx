/** Labelled usage bar: accent below 80 %, warning from 80 %, danger when full. */
export function Meter({
  label,
  used,
  limit,
  unit,
}: {
  label: string;
  used: number;
  limit: number;
  unit?: string;
}) {
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const full = used >= limit;
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
        <span>{label}</span>
        <span className={`font-mono text-xs ${full ? 'text-danger' : 'text-muted'}`}>
          {used.toLocaleString('en-US')} / {limit.toLocaleString('en-US')}
          {unit ? ` ${unit}` : ''}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-soft"
      >
        <div
          className={`h-full rounded-full ${full ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-accent'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
