import { CircleAlert, CircleCheck, CircleDot, CircleX, LoaderCircle, RotateCw } from 'lucide-react';
import type { IndexJob, IndexJobStep } from '@autowiki/shared';
import { relativeTime } from '../../lib/time';
import { buttonClass, pillClass } from '../../lib/ui';
import { formatDuration, useNow } from '../../lib/use-now';
import { IndexProgress } from '../repos/components';
import { isActiveJob } from './api';
import { shortSha } from './format';

function StepIcon({ state }: { state: IndexJobStep['state'] }) {
  switch (state) {
    case 'done':
      return <CircleCheck size={18} className="text-success" aria-hidden />;
    case 'current':
      return <LoaderCircle size={18} className="animate-spin text-accent-text" aria-hidden />;
    case 'failed':
      return <CircleX size={18} className="text-danger" aria-hidden />;
    case 'pending':
      return <CircleDot size={18} className="text-muted/60" aria-hidden />;
  }
}

const STEP_STATE_TEXT: Record<IndexJobStep['state'], string> = {
  done: 'done',
  current: 'in progress',
  failed: 'failed',
  pending: 'pending',
};

/** The server-provided step list; renders whatever steps the API returns. */
export function StepList({ steps }: { steps: IndexJobStep[] }) {
  return (
    <ol className="flex flex-col gap-1">
      {steps.map((step) => (
        <li
          key={step.id}
          aria-current={step.state === 'current' ? 'step' : undefined}
          className={`flex min-h-10 items-center gap-3 rounded-md px-3 text-sm ${
            step.state === 'current'
              ? 'bg-accent-soft font-medium text-accent-text'
              : step.state === 'failed'
                ? 'bg-danger-soft font-medium text-danger'
                : step.state === 'pending'
                  ? 'text-muted'
                  : 'text-text'
          }`}
        >
          <StepIcon state={step.state} />
          <span className="flex-1">
            {step.label}
            {step.detail && <span className="ml-1 font-mono text-xs">({step.detail})</span>}
          </span>
          <span className="sr-only">{STEP_STATE_TEXT[step.state]}</span>
        </li>
      ))}
    </ol>
  );
}

function elapsedMs(job: IndexJob, now: number): number {
  const start = new Date(job.startedAt ?? job.createdAt).getTime();
  const end = job.finishedAt ? new Date(job.finishedAt).getTime() : now;
  return end - start;
}

/** Live panel while a job is queued or running. */
export function IndexProgressPanel({ job }: { job: IndexJob }) {
  const now = useNow(isActiveJob(job));
  return (
    <section
      aria-labelledby="indexing-progress-title"
      className="mt-4 rounded-lg border border-border bg-surface p-5"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 id="indexing-progress-title" className="text-base font-semibold">
          Indexing progress
        </h2>
        <p className="flex flex-wrap gap-x-3 text-xs text-muted">
          <span>Elapsed {formatDuration(elapsedMs(job, now))}</span>
          {job.commitSha && (
            <span>
              Commit <span className="font-mono text-text">{shortSha(job.commitSha)}</span>
            </span>
          )}
        </p>
      </div>
      <div className="mb-4">
        <IndexProgress progress={job.progress} />
        <p className="mt-1 text-right text-xs text-muted" aria-live="polite">
          {job.progress}%
        </p>
      </div>
      <StepList steps={job.steps} />
    </section>
  );
}

/** Shown when the latest job failed: message, failing step, retry. */
export function IndexFailedPanel({
  job,
  onRetry,
  isRetrying,
}: {
  job: IndexJob;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  return (
    <section
      role="alert"
      className="mt-4 rounded-lg border border-danger/30 bg-danger-soft p-5 text-danger"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex gap-3">
          <CircleAlert size={20} className="mt-0.5 shrink-0" aria-hidden />
          <div>
            <h2 className="font-semibold">
              Indexing failed{job.currentStepLabel && <> at “{job.currentStepLabel}”</>}
            </h2>
            <p className="mt-1 text-sm">{job.error ?? 'Something went wrong.'}</p>
            {job.finishedAt && (
              <p className="mt-1 text-xs opacity-80">{relativeTime(job.finishedAt)}</p>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onRetry}
          disabled={isRetrying}
          className={`${buttonClass.secondary} shrink-0`}
        >
          <RotateCw size={16} aria-hidden className={isRetrying ? 'animate-spin' : undefined} />
          Retry
        </button>
      </div>
    </section>
  );
}

const JOB_STATUS_STYLE: Record<IndexJob['status'], string> = {
  done: 'border-transparent bg-success-soft text-success',
  running: 'border-transparent bg-warning-soft text-warning',
  queued: 'border-transparent bg-soft text-muted',
  failed: 'border-transparent bg-danger-soft text-danger',
};

const JOB_STATUS_LABEL: Record<IndexJob['status'], string> = {
  done: 'Done',
  running: 'Running',
  queued: 'Queued',
  failed: 'Failed',
};

export function JobStatusBadge({ job }: { job: IndexJob }) {
  return (
    <span className={`${pillClass} ${JOB_STATUS_STYLE[job.status]}`}>
      {JOB_STATUS_LABEL[job.status]}
      {job.status === 'running' && ` ${job.progress}%`}
    </span>
  );
}

export function JobDuration({ job }: { job: IndexJob }) {
  const now = useNow(isActiveJob(job));
  if (!job.startedAt) return <>—</>;
  return <>{formatDuration(elapsedMs(job, now))}</>;
}
