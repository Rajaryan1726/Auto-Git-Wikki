import { NavLink } from 'react-router-dom';
import { LoaderCircle } from 'lucide-react';
import { useActiveIndexJobs } from './api';

/** Lists repos with a running/queued job; renders nothing when idle. */
export function SidebarIndexing() {
  const { data: jobs } = useActiveIndexJobs();
  if (!jobs?.length) return null;

  return (
    <section aria-labelledby="sidebar-indexing-title" className="border-t border-border pt-4">
      <h2
        id="sidebar-indexing-title"
        className="mb-2 flex items-center gap-2 px-3 text-xs font-semibold tracking-wide text-muted uppercase"
      >
        <LoaderCircle size={12} className="animate-spin" aria-hidden />
        Indexing
      </h2>
      <ul className="flex flex-col gap-1">
        {jobs.map((job) => (
          <li key={job.id}>
            <NavLink
              to={`/repos/${job.repo.id}`}
              className={({ isActive }) =>
                `flex min-h-11 flex-col justify-center gap-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  isActive ? 'bg-accent-soft text-accent-text' : 'hover:bg-soft'
                }`
              }
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-xs" title={job.repo.fullName}>
                  {job.repo.name}
                </span>
                <span className="shrink-0 text-xs text-muted tabular-nums">{job.progress}%</span>
              </span>
              <span
                aria-hidden
                className="block h-1 w-full overflow-hidden rounded-full bg-warning-soft"
              >
                <span
                  className="block h-full rounded-full bg-warning"
                  style={{ width: `${job.progress}%` }}
                />
              </span>
            </NavLink>
          </li>
        ))}
      </ul>
    </section>
  );
}
